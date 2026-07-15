import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

const allowed: Record<string, string[]> = {
  draft: ["submitted", "archived"],
  submitted: ["under_review", "more_information_required", "rejected"],
  under_review: ["more_information_required", "checked", "rejected"],
  more_information_required: ["submitted", "archived"],
  checked: ["approved", "rejected"],
  approved: ["payment_prepared", "archived"],
  payment_prepared: ["reimbursed"],
  reimbursed: ["entered_in_sql_accounting"],
  entered_in_sql_accounting: ["archived"],
  rejected: ["archived"],
  archived: [],
};

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const claimId = String(body.claimId ?? "");
  const nextStatus = String(body.status ?? "");
  const reason = String(body.reason ?? "").trim();
  if (!claimId || !nextStatus) return NextResponse.json({ error: "Claim and status are required" }, { status: 400 });

  const claimRes = await supabase.from("claims").select("*").eq("id", claimId).maybeSingle();
  if (claimRes.error || !claimRes.data) return NextResponse.json({ error: "Claim not found" }, { status: 404 });
  const claim = claimRes.data;
  if (!allowed[claim.status]?.includes(nextStatus)) {
    return NextResponse.json({ error: `Cannot move claim from ${claim.status} to ${nextStatus}` }, { status: 409 });
  }
  if (["rejected", "more_information_required"].includes(nextStatus) && !reason) {
    return NextResponse.json({ error: "A reason is required for this status change" }, { status: 400 });
  }

  const profile = await supabase.from("app_profiles").select("role").eq("id", userData.user.id).maybeSingle();
  const update: Record<string, unknown> = { status: nextStatus, updated_by: userData.user.id };
  const actionType = actionFor(nextStatus);

  if (nextStatus === "submitted") {
    update.submitted_by = userData.user.id;
    update.submitted_at = new Date().toISOString();
    const number = await supabase.rpc("generate_claim_number", { p_claim_id: claimId });
    if (number.error) return NextResponse.json({ error: number.error.message }, { status: 403 });
  }
  if (nextStatus === "under_review") {
    update.status = "under_review";
  }
  if (nextStatus === "checked") {
    if (claim.claimant_user_id && claim.claimant_user_id === userData.user.id) {
      return NextResponse.json({ error: "A claimant cannot check their own claim" }, { status: 403 });
    }
    update.checked_by = userData.user.id;
    update.checked_at = new Date().toISOString();
  }
  if (nextStatus === "approved") {
    if (claim.claimant_user_id && claim.claimant_user_id === userData.user.id) {
      return NextResponse.json({ error: "A claimant cannot approve their own claim. Use a separate authorised approver or a formal director/board exception." }, { status: 403 });
    }
    update.approved_by = userData.user.id;
    update.approved_at = new Date().toISOString();
  }
  if (nextStatus === "payment_prepared") {
    update.reimbursement_status = "payment_prepared";
  }
  if (nextStatus === "reimbursed") {
    if (body.reimbursementDate && claim.approved_at && new Date(String(body.reimbursementDate)) < new Date(claim.approved_at)) {
      return NextResponse.json({ error: "Reimbursement date cannot be before approval date" }, { status: 400 });
    }
    update.reimbursement_status = "reimbursed";
    update.reimbursement_date = body.reimbursementDate || new Date().toISOString().slice(0, 10);
    update.payment_reference = String(body.paymentReference ?? claim.payment_reference ?? "").trim() || null;
  }
  if (nextStatus === "entered_in_sql_accounting") {
    if (!String(body.sqlReference ?? "").trim()) return NextResponse.json({ error: "SQL Accounting reference is required" }, { status: 400 });
    update.sql_accounting_entry_status = "entered";
    update.sql_accounting_reference = String(body.sqlReference).trim();
  }

  const result = await supabase.from("claims").update(update).eq("id", claimId).select("*").single();
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 400 });

  await supabase.from("claim_status_history").insert({
    claim_id: claimId,
    from_status: claim.status,
    to_status: nextStatus,
    changed_by: userData.user.id,
    reason: reason || null,
    metadata: { paymentReference: body.paymentReference, sqlReference: body.sqlReference },
  });
  await supabase.from("claim_review_actions").insert({
    claim_id: claimId,
    action_type: actionType,
    actor_user_id: userData.user.id,
    actor_role: profile.data?.role ?? null,
    notes: reason || null,
  });
  await supabase.from("audit_logs").insert({
    actor_user_id: userData.user.id,
    action: `claim_${nextStatus}`,
    entity_type: "claim",
    entity_id: claim.entity_id,
    payload: { claim_id: claimId, from_status: claim.status, to_status: nextStatus, reason },
    data_origin: "manual",
  });

  return NextResponse.json({ claim: result.data });
}

function actionFor(status: string) {
  if (status === "more_information_required") return "more_information_requested";
  return status === "submitted" || status === "checked" || status === "approved" || status === "rejected" || status === "payment_prepared" || status === "reimbursed" || status === "entered_in_sql_accounting"
    ? status
    : "under_review";
}
