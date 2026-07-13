import { NextResponse } from "next/server";
import { inferBankMapping, mapBankRows, parseBankFile, parsePastedRows, sha256, statementMonthStart } from "@/lib/import/bank-statement";
import { requireBankAccess } from "@/app/api/bank-imports/_shared";

export const runtime = "nodejs";

const maxSize = 8 * 1024 * 1024;

export async function POST(request: Request) {
  const form = await request.formData();
  const entityId = String(form.get("entityId") ?? "");
  const bankAccountId = String(form.get("bankAccountId") ?? "");
  const statementMonth = statementMonthStart(String(form.get("statementMonth") ?? ""));
  const worksheetName = String(form.get("worksheet") ?? "");
  const preset = String(form.get("preset") ?? "generic").toLowerCase();
  const pastedRows = String(form.get("pastedRows") ?? "");

  if (!entityId || !bankAccountId || !statementMonth) {
    return NextResponse.json({ error: "Entity, bank account and statement month are required" }, { status: 400 });
  }

  const { supabase, user, canViewBalances, error } = await requireBankAccess(entityId, "import");
  if (error) return error;

  const account = await supabase
    .from("bank_accounts_staff_safe")
    .select("id, entity_id, bank_name, account_name")
    .eq("id", bankAccountId)
    .eq("entity_id", entityId)
    .maybeSingle();
  if (account.error || !account.data) {
    return NextResponse.json({ error: "Bank account does not belong to the selected entity or is not accessible" }, { status: 400 });
  }

  let fileType: "csv" | "xlsx" | "pasted_rows";
  let filename = "pasted-bank-rows.csv";
  let fileHash = "";
  let sheets;

  try {
    if (pastedRows.trim()) {
      fileType = "pasted_rows";
      fileHash = sha256(Buffer.from(pastedRows, "utf8"));
      sheets = parsePastedRows(pastedRows);
    } else {
      const file = form.get("file");
      if (!(file instanceof File)) return NextResponse.json({ error: "Upload a CSV/XLSX file or paste rows" }, { status: 400 });
      if (file.size <= 0 || file.size > maxSize) return NextResponse.json({ error: "Bank import files must be 1 byte to 8 MB. CSV is recommended for production imports." }, { status: 400 });
      filename = file.name;
      const bytes = Buffer.from(await file.arrayBuffer());
      fileHash = sha256(bytes);
      const head = bytes.slice(0, 4).toString("hex");
      const looksXlsx = head.startsWith("504b0304") && filename.toLowerCase().endsWith(".xlsx");
      const textSample = bytes.slice(0, Math.min(bytes.length, 512)).toString("utf8");
      const looksCsv = !textSample.includes("\u0000") && filename.toLowerCase().endsWith(".csv");
      if (!looksXlsx && !looksCsv) return NextResponse.json({ error: "Only real CSV and XLSX files are supported. CSV is recommended. PDF statements are not parsed in Phase 3A." }, { status: 400 });
      fileType = looksXlsx ? "xlsx" : "csv";
      sheets = parseBankFile(bytes, fileType, worksheetName);
    }
  } catch (err) {
    return NextResponse.json({
      error: err instanceof Error ? err.message : "Could not parse bank file. CSV is the recommended fallback.",
      xlsxLimitations: xlsxLimitations(),
    }, { status: 400 });
  }

  if (!sheets.length) return NextResponse.json({ error: "No readable worksheet found. CSV is the recommended fallback.", xlsxLimitations: xlsxLimitations() }, { status: 400 });
  const selected = sheets.find((sheet) => sheet.name === worksheetName) ?? sheets[0];
  const headers = Object.keys(selected.rows[0] ?? {});
  const mapping = inferBankMapping(headers);

  const duplicateBatch = await supabase
    .from("bank_import_batches_staff_safe")
    .select("id, filename, status, uploaded_at")
    .eq("bank_account_id", bankAccountId)
    .eq("statement_month", statementMonth)
    .eq("file_hash", fileHash)
    .neq("status", "discarded")
    .maybeSingle();
  if (duplicateBatch.data) {
    return NextResponse.json({
      error: "This same bank file appears to have been uploaded already for the selected account and statement month.",
      duplicateBatch: duplicateBatch.data,
    }, { status: 409 });
  }

  const existing = await supabase
    .from("bank_transactions_staff_safe")
    .select("duplicate_fingerprint")
    .eq("bank_account_id", bankAccountId)
    .eq("statement_month", statementMonth);
  if (existing.error) return NextResponse.json({ error: existing.error.message }, { status: 400 });

  const existingFingerprints = new Set((existing.data ?? []).map((row) => String(row.duplicate_fingerprint ?? "")).filter(Boolean));
  const rows = mapBankRows(selected.rows, mapping, existingFingerprints, bankAccountId);

  const batch = await supabase.from("bank_import_batches").insert({
    entity_id: entityId,
    bank_account_id: bankAccountId,
    statement_month: statementMonth,
    filename,
    file_type: fileType,
    file_hash: fileHash,
    worksheet_name: selected.name,
    uploaded_by: user?.id,
    status: "mapping",
    mapping_config: mapping,
    bank_preset: ["cimb", "public_bank"].includes(preset) ? preset : "generic",
    total_rows: rows.length,
  }).select("id").single();
  if (batch.error) return NextResponse.json({ error: batch.error.message }, { status: 400 });

  if (rows.length) {
    const inserted = await supabase.from("bank_import_rows").insert(rows.map((row) => ({
      bank_import_batch_id: batch.data.id,
      row_number: row.rowNumber,
      original_data: row.original,
      original_data_sanitized: row.originalSanitized,
      mapped_data: row.mapped,
      mapped_data_sanitized: row.mappedSanitized,
      validation_errors: row.validationErrors,
      duplicate_warnings: row.duplicateWarnings,
      excluded: row.excluded,
      duplicate_decision: row.duplicateWarnings.length ? "pending" : "import_as_new",
    })));
    if (inserted.error) return NextResponse.json({ error: inserted.error.message }, { status: 400 });
  }

  return NextResponse.json({
    batchId: batch.data.id,
    sheets: sheets.map((sheet) => ({ name: sheet.name, rowCount: sheet.rows.length })),
    selectedSheet: selected.name,
    headers,
    mapping,
    rows: canViewBalances ? rows : rows.map((row) => ({ ...row, original: row.originalSanitized, mapped: row.mappedSanitized })),
    xlsxLimitations: xlsxLimitations(),
    message: "Preview created. No production bank transactions are created until Confirm Import.",
  });
}

function xlsxLimitations() {
  return [
    "CSV is recommended for production bank imports.",
    "XLSX formulas are not calculated; only stored/cached values are read.",
    "Merged cells are not reliably supported.",
    "Preview and confirmation are required before any production records are created.",
  ];
}
