import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { billId } = await request.json();
  const bill = await supabase.from("supplier_bills").select("*").eq("id", billId).maybeSingle();
  if (bill.error || !bill.data) return NextResponse.json({ error: "Bill not found" }, { status: 404 });

  const existing = await supabase.from("payment_voucher_items").select("payment_voucher_id").eq("supplier_bill_id", billId).limit(1);
  if (existing.data?.length) return NextResponse.json({ error: "A voucher already exists for this bill" }, { status: 409 });

  const supplier = bill.data.supplier_id ? await supabase.from("suppliers").select("supplier_name").eq("id", bill.data.supplier_id).maybeSingle() : { data: null };
  const number = await supabase.rpc("generate_payment_voucher_number", { p_entity_id: bill.data.entity_id });
  if (number.error) return NextResponse.json({ error: number.error.message }, { status: 403 });

  const voucher = await supabase.from("payment_vouchers").insert({
    entity_id: bill.data.entity_id,
    supplier_id: bill.data.supplier_id,
    voucher_number: number.data,
    payee: supplier.data?.supplier_name ?? "Manual payee",
    purpose: bill.data.description,
    total_amount: bill.data.outstanding_amount || bill.data.total_amount,
    status: "issued",
    issued_at: new Date().toISOString(),
    prepared_by: userData.user.id,
    remarks: bill.data.remarks,
  }).select("*").single();
  if (voucher.error) return NextResponse.json({ error: voucher.error.message }, { status: 400 });

  const item = await supabase.from("payment_voucher_items").insert({ payment_voucher_id: voucher.data.id, supplier_bill_id: bill.data.id, description: bill.data.bill_number ? `${bill.data.description} (${bill.data.bill_number})` : bill.data.description, amount: bill.data.outstanding_amount || bill.data.total_amount });
  if (item.error) return NextResponse.json({ error: item.error.message }, { status: 400 });

  await supabase.from("audit_logs").insert({ actor_user_id: userData.user.id, action: "payment_voucher_issued", entity_type: "payment_voucher", entity_id: bill.data.entity_id, payload: { voucher_id: voucher.data.id, voucher_number: number.data, bill_id: bill.data.id } });
  return NextResponse.json({ id: voucher.data.id, voucher_number: number.data });
}
