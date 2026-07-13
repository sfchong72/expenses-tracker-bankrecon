import { createClient } from "@/lib/supabase/server";
import { normalise, normaliseAccount, parseAmount, parseBoolean, parseDate, parseDueDay, resolveEntityCode, validateMapped } from "@/lib/import/supplier-recurring";
import { NextResponse } from "next/server";

type IncomingRow = { rowNumber: number; mapped: Record<string, unknown>; excluded?: boolean; duplicateDecision?: "pending" | "skip" | "update_existing" | "import_as_new"; createCategory?: boolean };
async function requireOwner() { const supabase = await createClient(); const { data: userData } = await supabase.auth.getUser(); if (!userData.user) return { supabase, user: null, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }; const profile = await supabase.from("app_profiles").select("role, active_status").eq("id", userData.user.id).maybeSingle(); if (profile.error || profile.data?.role !== "owner" || !profile.data?.active_status) return { supabase, user: userData.user, error: NextResponse.json({ error: "Owner access is required for supplier imports" }, { status: 403 }) }; return { supabase, user: userData.user, error: null }; }

export async function POST(request: Request) {
  const { supabase, user, error } = await requireOwner(); if (error) return error;
  const body = await request.json(); const batchId = String(body.batchId ?? ""); const rows = (body.rows ?? []) as IncomingRow[];
  if (!batchId || !rows.length) return NextResponse.json({ error: "Batch and rows are required" }, { status: 400 });
  const batch = await supabase.from("import_batches").select("*").eq("id", batchId).maybeSingle();
  if (batch.error || !batch.data) return NextResponse.json({ error: "Import batch not found" }, { status: 404 });
  if (["processing", "completed", "completed_with_errors", "reverted"].includes(batch.data.status)) return NextResponse.json({ error: `Batch cannot be confirmed because it is ${batch.data.status}` }, { status: 409 });
  await supabase.from("import_batches").update({ status: "processing" }).eq("id", batchId);

  const [entitiesRes, suppliersRes, recurringRes, categoriesRes, rowRes] = await Promise.all([
    supabase.from("entities").select("id, short_code, legal_name, display_name").eq("active_status", true),
    supabase.from("suppliers").select("*"),
    supabase.from("recurring_obligations").select("*"),
    supabase.from("categories").select("*").eq("category_type", "expense"),
    supabase.from("import_batch_rows").select("id, row_number").eq("import_batch_id", batchId),
  ]);
  const firstError = entitiesRes.error || suppliersRes.error || recurringRes.error || categoriesRes.error || rowRes.error;
  if (firstError) { await supabase.from("import_batches").update({ status: "failed", result_summary: { error: firstError.message } }).eq("id", batchId); return NextResponse.json({ error: firstError.message }, { status: 400 }); }
  const entities = entitiesRes.data ?? []; const suppliers = suppliersRes.data ?? []; const recurring = recurringRes.data ?? []; let categories = categoriesRes.data ?? []; const importRows = new Map((rowRes.data ?? []).map((row) => [row.row_number, row.id]));
  const results: Record<string, unknown>[] = []; let successful = 0, skipped = 0, failed = 0;

  for (const row of rows) {
    const importRowId = importRows.get(row.rowNumber);
    if (!importRowId) { failed++; results.push({ rowNumber: row.rowNumber, status: "failed", message: "Import row not found" }); continue; }
    if (row.excluded) { skipped++; await updateRow(supabase, importRowId, row, "skipped", "Excluded by user"); results.push({ rowNumber: row.rowNumber, status: "skipped", message: "Excluded by user" }); continue; }
    const mapped = row.mapped; const validationErrors = validateMapped(mapped, entities);
    if (validationErrors.length) { failed++; await updateRow(supabase, importRowId, row, "failed", validationErrors.join("; "), validationErrors); results.push({ rowNumber: row.rowNumber, status: "failed", message: validationErrors.join("; ") }); continue; }
    const entityCode = resolveEntityCode(mapped.entity, entities); const entity = entities.find((item) => item.short_code === entityCode);
    if (!entity) { failed++; await updateRow(supabase, importRowId, row, "failed", "Unknown entity"); continue; }
    const supplierName = String(mapped.supplier_name ?? "").trim(); const reg = String(mapped.registration_number ?? "").trim(); const bankAccount = normaliseAccount(mapped.bank_account_number);
    const supplierDuplicate = suppliers.find((s) => normalise(s.supplier_name) === normalise(supplierName) || (reg && normalise(s.registration_number) === normalise(reg)) || (bankAccount && normaliseAccount(s.bank_details?.bank_account_number || s.bank_details?.notes) === bankAccount));
    if (supplierDuplicate && row.duplicateDecision === "skip") { skipped++; await updateRow(supabase, importRowId, row, "skipped", "Skipped duplicate supplier"); results.push({ rowNumber: row.rowNumber, status: "skipped" }); continue; }
    if (supplierDuplicate && (!row.duplicateDecision || row.duplicateDecision === "pending")) { failed++; await updateRow(supabase, importRowId, row, "failed", "Duplicate supplier requires a decision"); results.push({ rowNumber: row.rowNumber, status: "failed", message: "Duplicate supplier requires a decision" }); continue; }

    let categoryId: string | null = null; const categoryName = String(mapped.expense_category ?? "").trim();
    if (categoryName) { let category = categories.find((c) => normalise(c.name) === normalise(categoryName)); if (!category && row.createCategory) { const created = await supabase.from("categories").insert({ entity_id: null, category_type: "expense", name: categoryName, data_origin: "imported" }).select("*").single(); if (created.error) { failed++; await updateRow(supabase, importRowId, row, "failed", created.error.message); continue; } category = created.data; categories = [...categories, category]; } categoryId = category?.id ?? null; }
    const supplierPayload = { supplier_name: supplierName, registration_number: reg || null, contact_person: String(mapped.contact_person ?? "").trim() || null, email: String(mapped.email ?? "").trim() || null, phone: String(mapped.phone ?? "").trim() || null, bank_details: { bank_name: String(mapped.bank_name ?? "").trim() || null, bank_account_number: String(mapped.bank_account_number ?? "").trim() || null, masked_bank_account_number: maskForStorage(mapped.bank_account_number), notes: String(mapped.account_reference_details ?? "").trim() || null }, default_expense_category: categoryId, default_description: String(mapped.default_description || mapped.description || "").trim() || null, account_code: String(mapped.account_code_or_SQL_reference ?? "").trim() || null, remarks: String(mapped.remarks ?? "").trim() || null, active_status: parseBoolean(mapped.active_status, true), data_origin: "imported" };
    let supplierId = supplierDuplicate?.id as string | undefined;
    if (supplierDuplicate && row.duplicateDecision === "update_existing") { const updated = await supabase.from("suppliers").update(supplierPayload).eq("id", supplierDuplicate.id).select("id").single(); if (updated.error) { failed++; await updateRow(supabase, importRowId, row, "failed", updated.error.message); continue; } supplierId = updated.data.id; }
    else if (!supplierDuplicate || row.duplicateDecision === "import_as_new") { const created = await supabase.from("suppliers").insert({ ...supplierPayload, source_import_batch_id: batchId, source_import_row_id: importRowId }).select("id").single(); if (created.error) { failed++; await updateRow(supabase, importRowId, row, "failed", created.error.message); continue; } supplierId = created.data.id; suppliers.push({ id: supplierId, ...supplierPayload }); }
    if (!supplierId) { failed++; await updateRow(supabase, importRowId, row, "failed", "Supplier could not be resolved"); continue; }
    await supabase.from("supplier_entities").upsert({ supplier_id: supplierId, entity_id: entity.id, default_category_id: categoryId, account_code: supplierPayload.account_code, active_status: true, is_demo: false, data_origin: "imported" });

    const dueDay = parseDueDay(mapped.due_day ?? mapped.description) ?? 1; const amount = parseAmount(mapped.expected_amount); const accountRef = String(mapped.account_reference_details ?? "").trim();
    const recDuplicate = recurring.find((item) => item.entity_id === entity.id && item.supplier_id === supplierId && normalise(item.description) === normalise(mapped.description) && normalise(item.account_reference_details) === normalise(accountRef) && Number(item.due_day) === dueDay);
    if (recDuplicate && row.duplicateDecision === "skip") { skipped++; await updateRow(supabase, importRowId, row, "skipped", "Skipped duplicate recurring obligation", [], supplierId); continue; }
    if (recDuplicate && (!row.duplicateDecision || row.duplicateDecision === "pending")) { failed++; await updateRow(supabase, importRowId, row, "failed", "Duplicate recurring obligation requires a decision", [], supplierId); continue; }
    const recurringPayload = { entity_id: entity.id, supplier_id: supplierId, description: String(mapped.description ?? "").trim(), frequency: String(mapped.frequency ?? "monthly").trim().toLowerCase() || "monthly", start_date: parseDate(mapped.start_date) || new Date().toISOString().slice(0,10), end_date: parseDate(mapped.end_date), fixed_or_variable: String(mapped.fixed_or_variable ?? "fixed").toLowerCase().includes("var") ? "variable" : "fixed", expected_amount: amount ?? 0, due_day: dueDay, reminder_days: Number(mapped.reminder_days || 3), required_document_type: String(mapped.required_document_type || "payment_voucher"), next_due_date: nextDueDate(dueDay), next_generation_date: new Date().toISOString().slice(0,10), auto_generate_bill: parseBoolean(mapped.auto_generate_bill, true), auto_generate_pv: parseBoolean(mapped.auto_generate_payment_voucher, true), active_status: parseBoolean(mapped.active_status, true), expense_category_id: categoryId, account_reference_details: accountRef || null, remarks: String(mapped.remarks ?? "").trim() || null, created_by: user?.id, data_origin: "imported" };
    let recurringId: string | null = recDuplicate?.id ?? null;
    if (recDuplicate && row.duplicateDecision === "update_existing") { const updated = await supabase.from("recurring_obligations").update(recurringPayload).eq("id", recDuplicate.id).select("id").single(); if (updated.error) { failed++; await updateRow(supabase, importRowId, row, "failed", updated.error.message, [], supplierId); continue; } recurringId = updated.data.id; }
    else if (!recDuplicate || row.duplicateDecision === "import_as_new") { const created = await supabase.from("recurring_obligations").insert({ ...recurringPayload, source_import_batch_id: batchId, source_import_row_id: importRowId }).select("id").single(); if (created.error) { failed++; await updateRow(supabase, importRowId, row, "failed", created.error.message, [], supplierId); continue; } recurringId = created.data.id; recurring.push({ id: recurringId, ...recurringPayload }); }
    successful++; await updateRow(supabase, importRowId, row, "success", "Imported", [], supplierId, recurringId); results.push({ rowNumber: row.rowNumber, status: "success", supplierId, recurringId });
  }
  const finalStatus = failed ? "completed_with_errors" : "completed";
  await supabase.from("import_batches").update({ status: finalStatus, successful_rows: successful, skipped_rows: skipped, failed_rows: failed, has_created_records: successful > 0, last_action: "confirmed", last_action_at: new Date().toISOString(), last_action_by: user?.id, result_summary: { results } }).eq("id", batchId);
  await supabase.from("audit_logs").insert({ actor_user_id: user?.id, action: "supplier_recurring_import_confirmed", entity_type: "import_batch", entity_id: batchId, payload: { successful, skipped, failed }, data_origin: "manual" });
  return NextResponse.json({ status: finalStatus, successful, skipped, failed, results });
}
async function updateRow(supabase: Awaited<ReturnType<typeof createClient>>, id: string, row: IncomingRow, resultStatus: "success" | "skipped" | "failed", message: string, validationErrors: string[] = [], supplierId?: string | null, recurringId?: string | null) { await supabase.from("import_batch_rows").update({ mapped_data: row.mapped, excluded: Boolean(row.excluded), duplicate_decision: row.duplicateDecision || "pending", validation_errors: validationErrors, result_status: resultStatus, result_message: message, supplier_id: supplierId || null, recurring_obligation_id: recurringId || null }).eq("id", id); }
function nextDueDate(dueDay: number) { const now = new Date(); const last = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate(); return new Date(now.getFullYear(), now.getMonth(), Math.min(dueDay, last)).toISOString().slice(0,10); }
function maskForStorage(value: unknown) { const digits = normaliseAccount(value); if (digits.length < 6) return digits || null; return `${digits.slice(0,2)}${"*".repeat(Math.max(4, digits.length-6))}${digits.slice(-4)}`; }
