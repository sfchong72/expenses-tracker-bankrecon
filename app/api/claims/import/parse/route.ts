import { createClient } from "@/lib/supabase/server";
import { fingerprintClaimLine, inferClaimMapping, mapClaimRows, parseClaimImportFile } from "@/lib/import/claim-credit-card";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const maxSize = 5 * 1024 * 1024;

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const form = await request.formData();
  const file = form.get("file");
  const worksheetName = String(form.get("worksheet") ?? "");
  const entityId = String(form.get("entity_id") ?? "");
  const statementMonth = monthStart(form.get("statement_month"));
  if (!(file instanceof File)) return NextResponse.json({ error: "Missing file" }, { status: 400 });
  if (!entityId || !statementMonth) return NextResponse.json({ error: "Entity and statement month are required" }, { status: 400 });
  if (file.size <= 0 || file.size > maxSize) return NextResponse.json({ error: "File must be 1 byte to 5 MB" }, { status: 400 });

  const bytes = Buffer.from(await file.arrayBuffer());
  const head = bytes.slice(0, 4).toString("hex");
  const looksXlsx = head.startsWith("504b0304");
  const textSample = bytes.slice(0, Math.min(bytes.length, 512)).toString("utf8");
  const looksCsv = !textSample.includes("\u0000");
  const lowerName = file.name.toLowerCase();
  let fileType: "csv" | "xlsx";
  if (looksXlsx && lowerName.endsWith(".xlsx")) fileType = "xlsx";
  else if (looksCsv && lowerName.endsWith(".csv")) fileType = "csv";
  else return NextResponse.json({ error: "Only real XLSX and CSV files are supported. File type did not match its extension." }, { status: 400 });

  const sheets = parseClaimImportFile(bytes, fileType);
  if (!sheets.length) return NextResponse.json({ error: "No readable worksheet found" }, { status: 400 });
  const selected = sheets.find((sheet) => sheet.name === worksheetName) ?? sheets[0];
  const headers = Object.keys(selected.rows[0] ?? {});
  const mapping = inferClaimMapping(headers);
  const preview = mapClaimRows(selected.rows, mapping, statementMonth);

  const fingerprints = preview.map((row) => fingerprintClaimLine(entityId, statementMonth, row.mapped));
  const duplicates = fingerprints.length
    ? await supabase.from("claim_lines").select("id, duplicate_fingerprint, description, amount, transaction_date, card_last_four").eq("entity_id", entityId).in("duplicate_fingerprint", fingerprints)
    : { data: [], error: null };
  if (duplicates.error) return NextResponse.json({ error: duplicates.error.message }, { status: 400 });

  const duplicateMap = new Map((duplicates.data ?? []).map((row) => [row.duplicate_fingerprint, row]));
  const rows = preview.map((row) => {
    const fp = fingerprintClaimLine(entityId, statementMonth, row.mapped);
    const existing = duplicateMap.get(fp);
    return {
      ...row,
      duplicateWarnings: existing ? [{ type: "credit_card_claim_line", existing }] : [],
    };
  });

  const batch = await supabase.from("claim_import_batches").insert({
    filename: file.name,
    file_type: fileType,
    worksheet_name: selected.name,
    entity_id: entityId,
    statement_month: statementMonth,
    uploaded_by: userData.user.id,
    status: "mapping",
    mapping_config: mapping,
    total_rows: rows.length,
    data_origin: "manual",
  }).select("id").single();
  if (batch.error) return NextResponse.json({ error: batch.error.message }, { status: 400 });

  if (rows.length) {
    const inserted = await supabase.from("claim_import_rows").insert(rows.map((row) => ({
      claim_import_batch_id: batch.data.id,
      row_number: row.rowNumber,
      original_data: row.original,
      mapped_data: row.mapped,
      validation_errors: row.validationErrors,
      duplicate_warnings: row.duplicateWarnings,
      duplicate_decision: row.duplicateWarnings.length ? "pending" : "import_as_new",
      excluded: row.excluded,
    })));
    if (inserted.error) return NextResponse.json({ error: inserted.error.message }, { status: 400 });
  }

  return NextResponse.json({
    batchId: batch.data.id,
    sheets: sheets.map((sheet) => ({ name: sheet.name, rowCount: sheet.rows.length })),
    selectedSheet: selected.name,
    headers,
    mapping,
    rows,
  });
}

function monthStart(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return "";
  return `${parsed.toISOString().slice(0, 7)}-01`;
}
