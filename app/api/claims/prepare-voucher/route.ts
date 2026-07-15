import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { claimId } = await request.json();
  if (!claimId) return NextResponse.json({ error: "Claim is required" }, { status: 400 });

  const claimRes = await supabase.from("claims").select("*").eq("id", claimId).maybeSingle();
  if (claimRes.error || !claimRes.data) return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  const claim = claimRes.data;
  if (claim.status !== "approved") return NextResponse.json({ error: "Only approved claims can create reimbursement vouchers" }, { status: 409 });
  if (claim.payment_voucher_id) return NextResponse.json({ error: "This claim already has a payment voucher" }, { status: 409 });
  if (Number(claim.net_payable_amount || 0) <= 0) return NextResponse.json({ error: "No net payable amount is due to the claimant" }, { status: 400 });

  const linesRes = await supabase.from("claim_lines").select("*").eq("claim_id", claimId).eq("is_excluded", false).order("sort_order");
  if (linesRes.error) return NextResponse.json({ error: linesRes.error.message }, { status: 400 });
  const lines = linesRes.data ?? [];
  if (!lines.length) return NextResponse.json({ error: "Claim has no payable lines" }, { status: 400 });

  const voucher = await supabase.from("payment_vouchers").insert({
    entity_id: claim.entity_id,
    claim_id: claim.id,
    source_type: "claim",
    source_id: claim.id,
    voucher_date: new Date().toISOString().slice(0, 10),
    payee: claim.claimant_name,
    purpose: `Reimbursement for ${claim.claim_number || "claim"} - ${claim.trip_or_business_purpose || claim.claim_type}`,
    total_amount: Number(claim.net_payable_amount || 0),
    currency: claim.currency || "MYR",
    payment_method: "bank_transfer",
    status: "draft",
    prepared_by: userData.user.id,
    voucher_source: "claim",
    remarks: "Generated from Staff & Director Claims module.",
    is_demo: false,
    data_origin: "manual",
  }).select("id").single();
  if (voucher.error) return NextResponse.json({ error: voucher.error.message }, { status: 400 });

  const itemRows = lines.map((line, index) => ({
    payment_voucher_id: voucher.data.id,
    claim_id: claim.id,
    claim_line_id: line.id,
    expense_category_id: line.expense_category_id,
    description: line.description,
    amount: Number(line.myr_converted_amount || line.amount || 0),
    sort_order: index + 1,
    is_demo: false,
    data_origin: "manual",
  }));
  const items = await supabase.from("payment_voucher_items").insert(itemRows);
  if (items.error) return NextResponse.json({ error: items.error.message }, { status: 400 });

  const reimbursement = await supabase.from("claim_reimbursements").insert({
    claim_id: claim.id,
    entity_id: claim.entity_id,
    payment_voucher_id: voucher.data.id,
    amount: Number(claim.net_payable_amount || 0),
    status: "prepared",
    created_by: userData.user.id,
  });
  if (reimbursement.error) return NextResponse.json({ error: reimbursement.error.message }, { status: 400 });

  const updated = await supabase.from("claims").update({
    payment_voucher_id: voucher.data.id,
    reimbursement_status: "voucher_draft",
    status: "payment_prepared",
    updated_by: userData.user.id,
  }).eq("id", claim.id).select("*").single();
  if (updated.error) return NextResponse.json({ error: updated.error.message }, { status: 400 });

  await supabase.from("claim_status_history").insert({
    claim_id: claim.id,
    from_status: claim.status,
    to_status: "payment_prepared",
    changed_by: userData.user.id,
    reason: "Reimbursement voucher draft created",
    metadata: { payment_voucher_id: voucher.data.id },
  });
  await supabase.from("audit_logs").insert({
    actor_user_id: userData.user.id,
    action: "claim_reimbursement_voucher_created",
    entity_type: "claim",
    entity_id: claim.entity_id,
    payload: { claim_id: claim.id, payment_voucher_id: voucher.data.id },
    data_origin: "manual",
  });

  return NextResponse.json({ claim: updated.data, paymentVoucherId: voucher.data.id });
}
