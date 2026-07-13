import { NextResponse } from "next/server";
import { csvResponse, requireBankAccess } from "@/app/api/bank-imports/_shared";
import { statementMonthStart } from "@/lib/import/bank-statement";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const entityId = searchParams.get("entityId") ?? "";
  const bankAccountId = searchParams.get("bankAccountId") ?? "";
  const statementMonth = statementMonthStart(searchParams.get("statementMonth") ?? "");
  const format = searchParams.get("format") ?? "json";
  if (!entityId || !bankAccountId || !statementMonth) return NextResponse.json({ error: "Entity, bank account and statement month are required" }, { status: 400 });

  const access = await requireBankAccess(entityId, "read");
  if (access.error) return access.error;

  const tx = await access.supabase
    .from("bank_transactions_staff_safe")
    .select("id, direction, amount, reconciliation_status, is_reversal")
    .eq("entity_id", entityId)
    .eq("bank_account_id", bankAccountId)
    .eq("statement_month", statementMonth);
  if (tx.error) return NextResponse.json({ error: tx.error.message }, { status: 400 });

  const ids = (tx.data ?? []).map((row) => row.id);
  const allocations = ids.length
    ? await access.supabase.from("bank_reconciliation_allocations").select("bank_transaction_id, linked_record_type, allocated_amount, status").in("bank_transaction_id", ids)
    : { data: [], error: null };
  if (allocations.error) return NextResponse.json({ error: allocations.error.message }, { status: 400 });

  const summary = buildSummary(tx.data ?? [], allocations.data ?? []);
  if (format === "csv") return csvResponse(`bank-reconciliation-${statementMonth}.csv`, [summary]);
  return NextResponse.json(summary);
}

function buildSummary(transactions: any[], allocations: any[]) {
  const rows = transactions;
  const activeAllocations = allocations.filter((item) => item.status === "confirmed");
  const internalTransferIds = new Set(activeAllocations.filter((item) => item.linked_record_type === "internal_transfer").map((item) => item.bank_transaction_id));
  const bankChargeIds = new Set(activeAllocations.filter((item) => item.linked_record_type === "bank_charge").map((item) => item.bank_transaction_id));
  const totalDebits = sum(rows.filter((row) => row.direction === "debit"));
  const totalCredits = sum(rows.filter((row) => row.direction === "credit"));
  const matchedDebits = sum(rows.filter((row) => row.direction === "debit" && ["matched", "manually_matched"].includes(row.reconciliation_status)));
  const partiallyMatchedDebits = sum(rows.filter((row) => row.direction === "debit" && row.reconciliation_status === "partially_matched"));
  const unmatchedDebits = sum(rows.filter((row) => row.direction === "debit" && row.reconciliation_status === "unmatched"));
  const exceptions = rows.filter((row) => row.reconciliation_status === "exception").length;
  const matchedCount = rows.filter((row) => ["matched", "manually_matched"].includes(row.reconciliation_status)).length;
  return {
    total_debits: totalDebits.toFixed(2),
    total_credits: totalCredits.toFixed(2),
    matched_debits: matchedDebits.toFixed(2),
    partially_matched_debits: partiallyMatchedDebits.toFixed(2),
    unmatched_debits: unmatchedDebits.toFixed(2),
    internal_transfers: internalTransferIds.size,
    bank_charges: bankChargeIds.size,
    reversals: rows.filter((row) => row.is_reversal).length,
    exceptions,
    missing_supporting_documents: "",
    reconciliation_percentage: rows.length ? Math.round((matchedCount / rows.length) * 100) : 0,
  };
}

function sum(rows: any[]) {
  return rows.reduce((total, row) => total + Number(row.amount || 0), 0);
}
