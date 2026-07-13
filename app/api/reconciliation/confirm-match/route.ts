import { NextResponse } from "next/server";
import { requireBankAccess } from "@/app/api/bank-imports/_shared";

export async function POST(request: Request) {
  const body = await request.json();
  const bankTransactionId = String(body.bankTransactionId ?? "");
  const linkedRecordType = String(body.linkedRecordType ?? "");
  let linkedRecordId = String(body.linkedRecordId ?? "") || null;
  const allocatedAmount = Number(body.allocatedAmount || 0);
  const matchReason = String(body.matchReason ?? "");
  const overrideReason = String(body.overrideReason ?? "");
  const exceptionReason = String(body.exceptionReason ?? "");
  const exceptionCategory = String(body.exceptionCategory ?? "");
  const remarks = String(body.remarks ?? "");

  if (!bankTransactionId || !linkedRecordType || allocatedAmount <= 0) {
    return NextResponse.json({ error: "Bank transaction, linked record type and allocated amount are required" }, { status: 400 });
  }
  if (linkedRecordType === "recurring_obligation" && !exceptionReason) {
    return NextResponse.json({ error: "Direct matching to a recurring obligation is an exception. Provide a reason or generate the monthly bill first." }, { status: 400 });
  }

  const preflight = await requireBankAccess(undefined, "read");
  if (preflight.error) return preflight.error;
  const tx = await preflight.supabase.from("bank_transactions_staff_safe").select("*").eq("id", bankTransactionId).maybeSingle();
  if (tx.error || !tx.data) return NextResponse.json({ error: "Bank transaction not found" }, { status: 404 });

  const access = await requireBankAccess(tx.data.entity_id, "reconcile");
  if (access.error) return access.error;

  if (linkedRecordType === "manual_exception") {
    if (!exceptionReason || !exceptionCategory || !remarks) {
      return NextResponse.json({ error: "Manual exceptions require reason, category and remarks" }, { status: 400 });
    }
    const exception = await access.supabase.from("bank_manual_exceptions").insert({
      entity_id: tx.data.entity_id,
      bank_transaction_id: bankTransactionId,
      exception_reason: exceptionReason,
      category: exceptionCategory,
      remarks,
      created_by: access.user?.id,
    }).select("id").single();
    if (exception.error) return NextResponse.json({ error: exception.error.message }, { status: 400 });
    linkedRecordId = exception.data.id;
  }

  const allocation = await access.supabase.from("bank_reconciliation_allocations").insert({
    entity_id: tx.data.entity_id,
    bank_account_id: tx.data.bank_account_id,
    bank_transaction_id: bankTransactionId,
    linked_record_type: linkedRecordType,
    linked_record_id: linkedRecordId,
    allocated_amount: allocatedAmount,
    match_type: body.matchType || "manual",
    confidence_score: body.confidenceScore ?? null,
    match_reason: matchReason,
    exception_reason: exceptionReason || null,
    status: "suggested_match",
  }).select("id").single();
  if (allocation.error) return NextResponse.json({ error: allocation.error.message }, { status: 400 });

  const confirmed = await access.supabase.rpc("confirm_bank_reconciliation_allocation", {
    p_allocation_id: allocation.data.id,
    p_override_reason: overrideReason || null,
  });
  if (confirmed.error) return NextResponse.json({ error: confirmed.error.message }, { status: 400 });

  return NextResponse.json({ allocation: confirmed.data });
}
