import { createClient } from "@/lib/supabase/server";
import { inferMapping, mapRows, normalise, normaliseAccount, parseCsv, parseDueDay, parseXlsx, resolveEntityCode } from "@/lib/import/supplier-recurring";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
const maxSize = 5 * 1024 * 1024;

async function requireOwner() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return { supabase, user: null, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const profile = await supabase.from("app_profiles").select("role, active_status").eq("id", userData.user.id).maybeSingle();
  if (profile.error || profile.data?.role !== "owner" || !profile.data?.active_status) return { supabase, user: userData.user, error: NextResponse.json({ error: "Owner access is required for supplier imports" }, { status: 403 }) };
  return { supabase, user: userData.user, error: null };
}

export async function POST(request: Request) {
  const { supabase, user, error } = await requireOwner();
  if (error) return error;
  const form = await request.formData();
  const file = form.get("file");
  const worksheetName = String(form.get("worksheet") ?? "");
  if (!(file instanceof File)) return NextResponse.json({ error: "Missing file" }, { status: 400 });
  if (file.size <= 0 || file.size > maxSize) return NextResponse.json({ error: "File must be 1 byte to 5 MB" }, { status: 400 });
  const bytes = Buffer.from(await file.arrayBuffer());
  const looksXlsx = bytes.slice(0, 4).toString("hex").startsWith("504b0304");
  const looksCsv = !bytes.slice(0, Math.min(bytes.length, 512)).toString("utf8").includes("\u0000");
  const lowerName = file.name.toLowerCase();
  let fileType: "csv" | "xlsx";
  if (looksXlsx && lowerName.endsWith(".xlsx")) fileType = "xlsx";
  else if (looksCsv && lowerName.endsWith(".csv")) fileType = "csv";
  else return NextResponse.json({ error: "Only real XLSX and CSV files are supported. File type did not match its extension." }, { status: 400 });

  const [entities, suppliers, recurring] = await Promise.all([
    supabase.from("entities").select("id, short_code, legal_name, display_name").eq("active_status", true),
    supabase.from("suppliers").select("*"),
    supabase.from("recurring_obligations").select("*"),
  ]);
  const lookupError = entities.error || suppliers.error || recurring.error;
  if (lookupError) return NextResponse.json({ error: lookupError.message }, { status: 400 });

  let sheets: { name: string; rows: Record<string, string>[] }[];
  try { sheets = fileType === "csv" ? [{ name: "CSV", rows: parseCsv(bytes.toString("utf8")) }] : parseXlsx(bytes); }
  catch (err) { return NextResponse.json({ error: err instanceof Error ? err.message : "Could not parse spreadsheet" }, { status: 400 }); }
  if (!sheets.length) return NextResponse.json({ error: "No readable worksheet found" }, { status: 400 });
  const selected = sheets.find((sheet) => sheet.name === worksheetName) ?? sheets[0];
  const headers = Object.keys(selected.rows[0] ?? {});
  const mapping = inferMapping(headers);
  const previewRows = mapRows(selected.rows, mapping, entities.data ?? []).map((row) => {
    const entityCode = resolveEntityCode(row.mapped.entity, entities.data ?? []);
    const entity = (entities.data ?? []).find((item) => item.short_code === entityCode);
    const supplierName = String(row.mapped.supplier_name ?? "");
    const registrationNumber = String(row.mapped.registration_number ?? "");
    const bankAccount = normaliseAccount(row.mapped.bank_account_number);
    const supplierDuplicate = (suppliers.data ?? []).find((supplier) => normalise(supplier.supplier_name) === normalise(supplierName) || (registrationNumber && normalise(supplier.registration_number) === normalise(registrationNumber)) || (bankAccount && normaliseAccount(supplier.bank_details?.bank_account_number || supplier.bank_details?.notes) === bankAccount));
    const recurringDuplicate = supplierDuplicate && entity ? (recurring.data ?? []).find((item) => item.entity_id === entity.id && item.supplier_id === supplierDuplicate.id && normalise(item.description) === normalise(row.mapped.description) && normalise(item.account_reference_details) === normalise(row.mapped.account_reference_details) && Number(item.due_day) === (parseDueDay(row.mapped.due_day ?? row.mapped.description) ?? 0)) : null;
    const duplicateWarnings = [supplierDuplicate ? { type: "supplier", existing: { id: supplierDuplicate.id, supplier_name: supplierDuplicate.supplier_name, registration_number: supplierDuplicate.registration_number, bank_details: supplierDuplicate.bank_details } } : null, recurringDuplicate ? { type: "recurring_obligation", existing: { id: recurringDuplicate.id, description: recurringDuplicate.description, due_day: recurringDuplicate.due_day, expected_amount: recurringDuplicate.expected_amount } } : null].filter(Boolean);
    return { ...row, duplicateWarnings };
  });

  const batch = await supabase.from("import_batches").insert({ import_type: "supplier_recurring", filename: file.name, file_type: fileType, worksheet_name: selected.name, uploaded_by: user?.id, status: "mapping", mapping_config: mapping, total_rows: previewRows.length }).select("id").single();
  if (batch.error) return NextResponse.json({ error: batch.error.message }, { status: 400 });
  if (previewRows.length) {
    const inserted = await supabase.from("import_batch_rows").insert(previewRows.map((row) => ({ import_batch_id: batch.data.id, row_number: row.rowNumber, original_data: row.original, mapped_data: row.mapped, validation_errors: row.validationErrors, duplicate_warnings: row.duplicateWarnings, requires_confirmation: row.requiresConfirmation, excluded: row.excluded })));
    if (inserted.error) return NextResponse.json({ error: inserted.error.message }, { status: 400 });
  }
  return NextResponse.json({ batchId: batch.data.id, sheets: sheets.map((sheet) => ({ name: sheet.name, rowCount: sheet.rows.length })), selectedSheet: selected.name, headers, mapping, rows: previewRows });
}
