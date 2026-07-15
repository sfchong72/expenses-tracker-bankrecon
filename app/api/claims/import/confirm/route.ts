import { createClient } from "@/lib/supabase/server";
import { fingerprintClaimLine, lastFourDigits, parseAmount, parseDate, validateClaimMapped } from "@/lib/import/claim-credit-card";
import { NextResponse } from "next/server";

type IncomingRow = {
  rowNumber: number;
  mapped: Record<string, unknown>;
  excluded?: boolean;
  duplicateDecision?: "pending" | "skip" | "import_as_new";
};

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const batchId = String(body.batchId ?? "");
  const claim = body.claim as Record<string, unknown>;
  const rows = (body.rows ?? []) as IncomingRow[];
  if (!batchId || !claim?.entity_id || !rows.length) return NextResponse.json({ error: "Batch, claim header and rows are required" }, { status: 400 });

  const batch = await supabase.from("claim_import_batches").select("*").eq("id", batchId).maybeSingle();
  if (batch.error || !batch.data) return NextResponse.json({ error: "Import batch not found" }, { status: 404 });
  if (["processing", "completed", "completed_with_errors", "archived"].includes(batch.data.status)) {
    return NextResponse.json({ error: `Batch cannot be confirmed because it is ${batch.data.status}` }, { status: 409 });
  }

  const statementMonth = String(batch.data.statement_month);
  const criticalErrors = rows.filter((row) => !row.excluded && validateClaimMapped(row.mapped, statementMonth).length);
  if (criticalErrors.length) return NextResponse.json({ error: "Exclude or correct rows with validation errors before confirming." }, { status: 400 });
  const unresolvedDuplicates = rows.filter((row) => !row.excluded && row.duplicateDecision === "pending");
  if (unresolvedDuplicates.length) return NextResponse.json({ error: "Resolve duplicate warnings before confirming." }, { status: 400 });

  await supabase.from("claim_import_batches").update({ status: "processing" }).eq("id", batchId);

  const savedClaim = await supabase.from("claims").insert({
    entity_id: batch.data.entity_id,
    claim_mode: "credit_card",
    claim_type: String(claim.claim_type ?? "personal_credit_card_claim"),
    claimant_user_id: cleanUuid(claim.claimant_user_id),
    claimant_name: cleanText(claim.claimant_name) || "Credit Card Claim",
    designation: cleanText(claim.designation),
    department: cleanText(claim.department),
    statement_date: parseDate(claim.statement_date) || statementMonth,
    statement_month: statementMonth,
    trip_or_business_purpose: cleanText(claim.trip_or_business_purpose) || "Monthly credit-card claim",
    remarks: cleanText(claim.remarks),
    created_by: userData.user.id,
    updated_by: userData.user.id,
    data_origin: "imported",
  }).select("id").single();
  if (savedClaim.error) {
    await supabase.from("claim_import_batches").update({ status: "failed", result_summary: { error: savedClaim.error.message } }).eq("id", batchId);
    return NextResponse.json({ error: savedClaim.error.message }, { status: 400 });
  }

  const importRows = await supabase.from("claim_import_rows").select("id, row_number").eq("claim_import_batch_id", batchId);
  const importRowMap = new Map((importRows.data ?? []).map((row) => [row.row_number, row.id]));
  let successful = 0;
  let skipped = 0;
  let failed = 0;
  const results: Record<string, unknown>[] = [];

  for (const row of rows) {
    const importRowId = importRowMap.get(row.rowNumber);
    if (!importRowId) {
      failed += 1;
      results.push({ rowNumber: row.rowNumber, status: "failed", message: "Import row not found" });
      continue;
    }
    if (row.excluded || row.duplicateDecision === "skip") {
      skipped += 1;
      await updateRow(supabase, importRowId, row, "skipped", row.excluded ? "Excluded by user" : "Skipped duplicate");
      results.push({ rowNumber: row.rowNumber, status: "skipped" });
      continue;
    }

    const mapped = row.mapped;
    const amount = Number(parseAmount(mapped.amount) ?? 0);
    const exchange = Number(parseAmount(mapped.exchange_rate) ?? 1) || 1;
    const line = await supabase.from("claim_lines").insert({
      claim_id: savedClaim.data.id,
      entity_id: batch.data.entity_id,
      client_key: `import-${row.rowNumber}`,
      line_type: "credit_card_transaction",
      expense_date: parseDate(mapped.transaction_date || mapped.statement_date),
      statement_date: parseDate(mapped.statement_date) || statementMonth,
      transaction_date: parseDate(mapped.transaction_date || mapped.statement_date),
      merchant_or_supplier: cleanText(mapped.merchant_or_supplier),
      invoice_or_receipt_number: cleanText(mapped.invoice_or_receipt_number),
      payment_method: cleanText(mapped.payment_method) || "credit_card",
      receipt_date: parseDate(mapped.receipt_date),
      cardholder_name: cleanText(mapped.cardholder_name),
      card_last_four: lastFourDigits(mapped.card_last_four),
      card_type: cleanText(mapped.card_type) || "personal",
      transaction_description: cleanText(mapped.transaction_description),
      business_purpose: cleanText(mapped.business_purpose),
      description: cleanText(mapped.transaction_description || mapped.merchant_or_supplier) || "Credit-card transaction",
      expense_category_id: cleanUuid(mapped.expense_category_id || mapped.expense_category),
      amount,
      tax_amount: Number(parseAmount(mapped.tax_amount) ?? 0),
      original_currency: cleanText(mapped.original_currency) || "MYR",
      exchange_rate: exchange,
      myr_converted_amount: amount * exchange,
      receipt_status: "missing",
      document_status: "missing",
      requires_receipt: true,
      duplicate_fingerprint: fingerprintClaimLine(batch.data.entity_id, statementMonth, mapped),
      sort_order: row.rowNumber,
    }).select("id").single();

    if (line.error) {
      failed += 1;
      await updateRow(supabase, importRowId, row, "failed", line.error.message);
      results.push({ rowNumber: row.rowNumber, status: "failed", message: line.error.message });
      continue;
    }

    successful += 1;
    await updateRow(supabase, importRowId, row, "imported_incomplete", "Imported; receipt/category review may still be needed", line.data.id);
    results.push({ rowNumber: row.rowNumber, status: "imported_incomplete", claimLineId: line.data.id });
  }

  await supabase.rpc("recalculate_claim_totals", { p_claim_id: savedClaim.data.id });
  const finalStatus = failed ? "completed_with_errors" : "completed";
  await supabase.from("claim_import_batches").update({
    status: finalStatus,
    successful_rows: successful,
    skipped_rows: skipped,
    failed_rows: failed,
    created_claim_id: savedClaim.data.id,
    result_summary: { results },
  }).eq("id", batchId);

  await supabase.from("audit_logs").insert({
    actor_user_id: userData.user.id,
    action: "credit_card_claim_import_confirmed",
    entity_type: "claim_import_batch",
    entity_id: batch.data.entity_id,
    payload: { batch_id: batchId, claim_id: savedClaim.data.id, successful, skipped, failed },
    data_origin: "manual",
  });

  return NextResponse.json({ status: finalStatus, claimId: savedClaim.data.id, successful, skipped, failed, results });
}

async function updateRow(
  supabase: Awaited<ReturnType<typeof createClient>>,
  id: string,
  row: IncomingRow,
  status: "imported_complete" | "imported_incomplete" | "skipped" | "failed",
  message: string,
  lineId?: string,
) {
  await supabase.from("claim_import_rows").update({
    mapped_data: row.mapped,
    excluded: Boolean(row.excluded),
    duplicate_decision: row.duplicateDecision || "pending",
    result_status: status,
    result_message: message,
    created_claim_line_id: lineId || null,
  }).eq("id", id);
}

function cleanText(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function cleanUuid(value: unknown) {
  const text = String(value ?? "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text) ? text : null;
}
