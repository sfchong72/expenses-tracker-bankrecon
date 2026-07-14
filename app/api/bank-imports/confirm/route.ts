import { NextResponse } from "next/server";
import { makeFingerprint, normaliseMapped, sanitizeRecord, statementMonthStart, validateMappedBankRow } from "@/lib/import/bank-statement";
import { requireBankAccess } from "@/app/api/bank-imports/_shared";

type IncomingRow = {
  id?: string;
  rowNumber: number;
  mapped: Record<string, unknown>;
  excluded?: boolean;
  duplicateDecision?: "pending" | "skip" | "import_as_new" | "review_manually";
};

export async function POST(request: Request) {
  const body = await request.json();
  const batchId = String(body.batchId ?? "");
  const rows = (body.rows ?? []) as IncomingRow[];
  const acknowledgeIncomplete = Boolean(body.acknowledgeReview);
  if (!batchId || !rows.length) return NextResponse.json({ error: "Batch and preview rows are required" }, { status: 400 });

  const preflight = await requireBankAccess(undefined, "read");
  if (preflight.error) return preflight.error;
  const { supabase, user } = preflight;

  const batch = await supabase.from("bank_import_batches_staff_safe").select("*").eq("id", batchId).maybeSingle();
  if (batch.error || !batch.data) return NextResponse.json({ error: "Bank import batch not found" }, { status: 404 });
  if (["processing", "completed", "completed_with_errors", "discarded", "archived"].includes(batch.data.status)) {
    return NextResponse.json({ error: `Batch cannot be confirmed because it is ${batch.data.status}` }, { status: 409 });
  }

  const access = await requireBankAccess(batch.data.entity_id, "import");
  if (access.error) return access.error;

  const unresolved = rows.filter((row) => !row.excluded && row.duplicateDecision === "pending");
  if (unresolved.length) return NextResponse.json({ error: "Resolve duplicate warnings before confirming import" }, { status: 400 });

  const importRows = await supabase
    .from("bank_import_rows_staff_safe")
    .select("id, row_number")
    .eq("bank_import_batch_id", batchId);
  if (importRows.error) return NextResponse.json({ error: importRows.error.message }, { status: 400 });
  const rowIds = new Map((importRows.data ?? []).map((row) => [row.row_number, row.id]));

  await supabase.from("bank_import_batches").update({ status: "processing" }).eq("id", batchId);

  const results: Record<string, unknown>[] = [];
  let successful = 0;
  let skipped = 0;
  let failed = 0;
  let reviewNeeded = 0;

  for (const row of rows) {
    const importRowId = rowIds.get(row.rowNumber);
    if (!importRowId) {
      failed += 1;
      results.push({ rowNumber: row.rowNumber, status: "failed", message: "Preview row not found" });
      continue;
    }

    if (row.excluded || row.duplicateDecision === "skip" || row.duplicateDecision === "review_manually") {
      skipped += 1;
      await updateRow(supabase, importRowId, row, "skipped", row.duplicateDecision === "review_manually" ? "Marked for manual review" : "Skipped by user");
      results.push({ rowNumber: row.rowNumber, status: "skipped", message: row.duplicateDecision === "review_manually" ? "Marked for manual review" : "Skipped by user" });
      continue;
    }

    const mapped = normaliseMapped(row.mapped);
    const validationErrors = validateMappedBankRow(mapped);
    if (validationErrors.length) {
      failed += 1;
      await updateRow(supabase, importRowId, row, "failed", validationErrors.join("; "), validationErrors);
      results.push({ rowNumber: row.rowNumber, status: "failed", message: validationErrors.join("; ") });
      continue;
    }

    if (!acknowledgeIncomplete && !String(mapped.reference_number ?? "").trim()) {
      reviewNeeded += 1;
    }

    const duplicateFingerprint = makeFingerprint(batch.data.bank_account_id, mapped);
    const payload = {
      entity_id: batch.data.entity_id,
      bank_account_id: batch.data.bank_account_id,
      transaction_date: mapped.transaction_date,
      transaction_time: mapped.transaction_time,
      value_date: mapped.value_date,
      description: mapped.description,
      additional_description: mapped.additional_description || null,
      reference_number: mapped.reference_number || null,
      bank_reference: mapped.reference_number || null,
      direction: mapped.direction,
      debit_amount: mapped.debit_amount,
      credit_amount: mapped.credit_amount,
      amount: mapped.amount,
      running_balance: mapped.running_balance,
      statement_month: statementMonthStart(String(batch.data.statement_month)),
      source_import_batch_id: batchId,
      source_import_row_id: importRowId,
      duplicate_fingerprint: duplicateFingerprint || null,
      reconciliation_status: "unmatched",
      data_origin: "imported",
      is_demo: false,
    };

    const inserted = await supabase.from("bank_transactions").insert(payload).select("id").single();
    if (inserted.error) {
      failed += 1;
      await updateRow(supabase, importRowId, row, "failed", inserted.error.message);
      results.push({ rowNumber: row.rowNumber, status: "failed", message: inserted.error.message });
      continue;
    }

    successful += 1;
    await updateRow(supabase, importRowId, row, "imported", "Imported", [], inserted.data.id);
    results.push({ rowNumber: row.rowNumber, status: "imported", bankTransactionId: inserted.data.id });
  }

  const finalStatus = failed ? "completed_with_errors" : "completed";
  await supabase.from("bank_import_batches").update({
    status: finalStatus,
    successful_rows: successful,
    skipped_rows: skipped,
    failed_rows: failed,
    result_summary: { results, reviewNeeded },
  }).eq("id", batchId);

  await supabase.from("audit_logs").insert({
    actor_user_id: user?.id,
    action: "bank_import_confirmed",
    entity_type: "bank_import_batch",
    entity_id: batchId,
    payload: { successful, skipped, failed, reviewNeeded },
    data_origin: "manual",
  });

  return NextResponse.json({ status: finalStatus, successful, skipped, failed, reviewNeeded, results });
}

async function updateRow(
  supabase: Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>,
  id: string,
  row: IncomingRow,
  status: "imported" | "skipped" | "failed",
  message: string,
  validationErrors: string[] = [],
  bankTransactionId?: string,
) {
  await supabase.from("bank_import_rows").update({
    mapped_data: row.mapped,
    mapped_data_sanitized: sanitizeRecord(row.mapped),
    excluded: Boolean(row.excluded),
    duplicate_decision: row.duplicateDecision || "import_as_new",
    validation_errors: validationErrors,
    result_status: status,
    result_message: message,
    bank_transaction_id: bankTransactionId || null,
  }).eq("id", id);
}
