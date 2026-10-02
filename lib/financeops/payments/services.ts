import type { SupabaseClient } from "@supabase/supabase-js";
import { inferStatementMapping, markDuplicates, mapStatementRows, parsePastedStatement, parseStatementFile, sha256Hex, summarizeStatement, type ParsedBankRow, type StatementMapping, type StatementSheet } from "./bank-import";
import { suggestMatches, pairKey, type MatchBankRow, type MatchPayment } from "./matching";
import { inferRegisterMapping, mapRegisterRows, markRegisterDuplicates, parseRegisterFile, summarizeRegisterImport, toRegisterInsert, type RegisterImportRow, type RegisterMapping } from "./register-import";
import { isFinanceReviewer, isOwnerOrFinanceManager, paymentRegisterEnabled, type EntityCode } from "./types";

/**
 * Server-side services behind the human screens. Every function takes the CALLER's own supabase client (cookie
 * session), so RLS and the 0024 triggers decide; none of them can do more than the signed-in user may. The module is
 * default-OFF behind FINANCEOPS_PAYMENT_REGISTER_ENABLED.
 */

export type ServiceResult<T> = { ok: true; value: T } | { ok: false; status: number; body: Record<string, unknown> };
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): { ok: false; status: number; body: Record<string, unknown> } => ({ ok: false, status, body: { error, ...extra } });

export type Caller = { userId: string; role: string; aal2: boolean };

/** Flag, signed-in user, active role, and (optionally) reviewer / Owner-FM / AAL2 requirements. */
export async function requireCaller(supabase: SupabaseClient, env: Record<string, string | undefined>, need: { reviewer?: boolean; ownerOrFm?: boolean; aal2?: boolean } = {}): Promise<ServiceResult<Caller>> {
  if (!paymentRegisterEnabled(env)) return fail(503, "payment_register_disabled");
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) return fail(401, "unauthorized");
  const profile = await supabase.from("app_profiles").select("role, active_status").eq("id", user.id).maybeSingle();
  if (profile.error || !profile.data?.active_status) return fail(403, "forbidden");
  const role = profile.data.role as string;
  let aal2 = false;
  try {
    const level = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    aal2 = level.data?.currentLevel === "aal2";
  } catch {
    aal2 = false;
  }
  if (need.reviewer && !isFinanceReviewer(role)) return fail(403, "reviewer_required", { message: "Only Owner, Finance Manager or Finance Staff may do this." });
  if (need.ownerOrFm && !isOwnerOrFinanceManager(role)) return fail(403, "owner_or_finance_manager_required");
  if (need.aal2 && !aal2) return fail(403, "aal2_required", { message: "Bank data needs two-step verification (MFA). Sign in with your authenticator and retry." });
  return { ok: true, value: { userId: user.id, role, aal2 } };
}

// ====================================================================== bank statement import

export type StatementImportInput = {
  entityId: string;
  companyAccountRef: string;
  filename: string;
  fileType: "csv" | "xlsx" | "pasted";
  bytes: Buffer | null;
  pastedText?: string;
  sheetName?: string;
  mapping?: StatementMapping;
  includeDuplicates?: boolean;
};

export type StatementPreview = {
  fileHash: string;
  fileType: "csv" | "xlsx" | "pasted";
  sheets: string[];
  sheet: string;
  headers: string[];
  mapping: StatementMapping;
  rows: ParsedBankRow[];
  summary: ReturnType<typeof summarizeStatement>;
  alreadyImportedBatchId: string | null;
  mappingProblems: string[];
};

async function existingFingerprints(supabase: SupabaseClient, entityId: string, account: string): Promise<{ ok: true; set: Set<string> } | { ok: false; message: string }> {
  const set = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const r = await supabase.from("finance_bank_statement_transactions").select("fingerprint").eq("entity_id", entityId).eq("company_account_ref", account).range(from, from + 999);
    if (r.error) return { ok: false, message: r.error.message };
    for (const row of r.data ?? []) set.add(row.fingerprint as string);
    if ((r.data ?? []).length < 1000) break;
  }
  return { ok: true, set };
}

export async function prepareStatementImport(supabase: SupabaseClient, input: StatementImportInput): Promise<ServiceResult<StatementPreview>> {
  const account = input.companyAccountRef.trim();
  if (!input.entityId) return fail(422, "entity_required");
  if (!account) return fail(422, "company_account_required", { message: "Enter the company bank account this statement belongs to (for example the account number)." });
  let sheets: StatementSheet[];
  let fileHash: string;
  try {
    if (input.fileType === "pasted") {
      sheets = parsePastedStatement(input.pastedText ?? "");
      fileHash = sha256Hex(input.pastedText ?? "");
    } else {
      if (!input.bytes || input.bytes.length === 0) return fail(422, "file_required");
      if (input.bytes.length > 8 * 1024 * 1024) return fail(413, "file_too_large", { message: "Statement files are limited to 8 MB." });
      sheets = parseStatementFile(input.bytes, input.fileType, input.sheetName);
      fileHash = sha256Hex(input.bytes);
    }
  } catch {
    return fail(422, "unreadable_file", { message: "The file could not be read. Export the statement as CSV or XLSX and try again." });
  }
  const sheet = (input.sheetName && sheets.find((s) => s.name === input.sheetName)) || sheets.find((s) => s.rows.length > 0) || sheets[0];
  if (!sheet || sheet.rows.length === 0) return fail(422, "no_rows", { message: "No transaction rows were found in the file." });
  const headers = Object.keys(sheet.rows[0]);
  const mapping = input.mapping ?? inferStatementMapping(headers);
  const mapped = Object.values(mapping);
  const mappingProblems: string[] = [];
  if (!mapped.includes("transaction_date")) mappingProblems.push("No date column is mapped.");
  if (!(mapped.includes("debit") || mapped.includes("amount"))) mappingProblems.push("No debit or amount column is mapped.");

  const parsed = mapStatementRows(sheet.rows, mapping, { companyAccountRef: account });
  const existing = await existingFingerprints(supabase, input.entityId, account);
  if (!existing.ok) return fail(403, "cannot_read_bank_rows", { message: "Bank rows could not be read for duplicate checking (bank data needs an authorised user with MFA)." });
  const rows = markDuplicates(parsed, existing.set);

  const batch = await supabase.from("finance_bank_import_batches").select("id").eq("entity_id", input.entityId).eq("company_account_ref", account).eq("file_hash", fileHash).maybeSingle();
  return {
    ok: true,
    value: { fileHash, fileType: input.fileType, sheets: sheets.map((s) => s.name), sheet: sheet.name, headers, mapping, rows, summary: summarizeStatement(rows), alreadyImportedBatchId: (batch.data?.id as string | undefined) ?? null, mappingProblems },
  };
}

export type StatementImportResult = { batchId: string; imported: number; skipped: number; resumed: boolean };

export async function confirmStatementImport(supabase: SupabaseClient, caller: Caller, input: StatementImportInput, bankName: string | null): Promise<ServiceResult<StatementImportResult>> {
  const prepared = await prepareStatementImport(supabase, input);
  if (!prepared.ok) return prepared;
  const p = prepared.value;
  if (p.mappingProblems.length > 0) return fail(422, "mapping_incomplete", { problems: p.mappingProblems });
  const toInsert = p.rows.filter((r) => r.state === "new" || (input.includeDuplicates && r.state === "duplicate"));
  if (toInsert.length === 0) return fail(409, "nothing_to_import", { summary: p.summary, alreadyImportedBatchId: p.alreadyImportedBatchId, message: "Every row is a duplicate, invalid or empty." });
  const account = input.companyAccountRef.trim();

  // insert-only: the batch is created once; a retry after a partial failure resumes INTO the same batch (duplicates are skipped)
  let batchId = p.alreadyImportedBatchId;
  const resumed = Boolean(batchId);
  if (!batchId) {
    const batch = await supabase
      .from("finance_bank_import_batches")
      .insert({
        entity_id: input.entityId,
        company_account_ref: account,
        bank_name: bankName,
        filename: input.filename.slice(0, 255) || "statement",
        file_type: input.fileType,
        file_hash: p.fileHash,
        total_rows: p.rows.length,
        imported_rows: toInsert.length,
        skipped_rows: p.rows.length - toInsert.length,
        mapping: p.mapping,
        summary: p.summary,
        imported_by: caller.userId,
      })
      .select("id")
      .single();
    if (batch.error) return fail(batch.error.code === "42501" ? 403 : 409, "batch_insert_failed", { message: batch.error.message });
    batchId = batch.data.id as string;
  }

  // row numbers continue after any rows a previous (partial) run already stored for this batch
  const max = await supabase.from("finance_bank_statement_transactions").select("row_number").eq("batch_id", batchId).order("row_number", { ascending: false }).limit(1);
  let nextNo = ((max.data?.[0]?.row_number as number | undefined) ?? 0) + 1;
  let imported = 0;
  for (let i = 0; i < toInsert.length; i += 200) {
    const chunk = toInsert.slice(i, i + 200).map((r) => ({
      batch_id: batchId,
      entity_id: input.entityId,
      company_account_ref: account,
      row_number: nextNo++,
      transaction_date: r.transactionDate,
      transaction_time: r.transactionTime,
      direction: r.direction,
      amount: r.amount,
      currency: "MYR",
      bank_reference: r.bankReference,
      description: r.description,
      payee_name: r.payeeName,
      beneficiary_account_no: r.beneficiaryAccountNo,
      beneficiary_bank: r.beneficiaryBank,
      fingerprint: r.fingerprint,
    }));
    const res = await supabase.from("finance_bank_statement_transactions").insert(chunk);
    if (res.error) return fail(500, "row_insert_failed", { imported, message: res.error.message, hint: "Retry the same file: it resumes into the same batch and skips rows already stored." });
    imported += chunk.length;
  }
  return { ok: true, value: { batchId, imported, skipped: p.rows.length - toInsert.length, resumed } };
}

// ====================================================================== matching

export type MatchingRunResult = { suggested: number; paymentsConsidered: number; bankRowsConsidered: number; feeRowsIgnored: number; paymentsMarkedSuggested: number };

export async function runMatching(supabase: SupabaseClient, caller: Caller, entityId: string): Promise<ServiceResult<MatchingRunResult>> {
  if (!entityId) return fail(422, "entity_required");
  const paymentsRes = await supabase
    .from("finance_payment_register")
    .select("id, entity_id, amount, currency, payment_instruction_date, bank_reference, pay_from_account_ref, beneficiary_name, beneficiary_account_no, status")
    .eq("entity_id", entityId)
    .in("status", ["captured", "documents_pending", "ready_for_bank_match", "bank_match_suggested"])
    .limit(2000);
  if (paymentsRes.error) return fail(500, "payments_unreadable", { message: paymentsRes.error.message });
  const rowsRes = await supabase
    .from("finance_bank_statement_transactions")
    .select("id, entity_id, company_account_ref, transaction_date, direction, amount, currency, bank_reference, description, payee_name, beneficiary_account_no")
    .eq("entity_id", entityId)
    .eq("direction", "debit")
    .order("transaction_date", { ascending: false })
    .limit(5000);
  if (rowsRes.error) return fail(403, "bank_rows_unreadable", { message: rowsRes.error.message });
  const matchesRes = await supabase.from("finance_payment_bank_matches").select("payment_register_id, bank_transaction_id, status").eq("entity_id", entityId).limit(20000);
  if (matchesRes.error) return fail(403, "matches_unreadable", { message: matchesRes.error.message });

  const payments: MatchPayment[] = (paymentsRes.data ?? []).map((p) => ({
    id: p.id as string, entityId: p.entity_id as string, amount: Number(p.amount), currency: p.currency as string, instructionDate: p.payment_instruction_date as string,
    bankReference: (p.bank_reference as string | null) ?? null, payFromAccountRef: (p.pay_from_account_ref as string | null) ?? null,
    beneficiaryName: (p.beneficiary_name as string | null) ?? null, beneficiaryAccountNo: (p.beneficiary_account_no as string | null) ?? null, status: p.status as string,
  }));
  const bankRows: MatchBankRow[] = (rowsRes.data ?? []).map((r) => ({
    id: r.id as string, entityId: r.entity_id as string, companyAccountRef: r.company_account_ref as string, transactionDate: r.transaction_date as string, direction: r.direction as "debit",
    amount: Number(r.amount), currency: r.currency as string, bankReference: (r.bank_reference as string | null) ?? null, description: (r.description as string | null) ?? null,
    payeeName: (r.payee_name as string | null) ?? null, beneficiaryAccountNo: (r.beneficiary_account_no as string | null) ?? null,
  }));
  const skip = new Set<string>();
  const confirmedRows = new Set<string>();
  const confirmedPayments = new Set<string>();
  for (const m of matchesRes.data ?? []) {
    skip.add(pairKey(m.payment_register_id as string, m.bank_transaction_id as string));
    if (m.status === "confirmed") { confirmedRows.add(m.bank_transaction_id as string); confirmedPayments.add(m.payment_register_id as string); }
  }

  const suggestions = suggestMatches(payments, bankRows, { skipPairs: skip, confirmedBankRows: confirmedRows, confirmedPayments });
  let inserted = 0;
  for (let i = 0; i < suggestions.length; i += 100) {
    const chunk = suggestions.slice(i, i + 100).map((s) => ({ entity_id: entityId, payment_register_id: s.paymentId, bank_transaction_id: s.bankTransactionId, status: "suggested", score: s.score, reasons: s.reasons }));
    const res = await supabase.from("finance_payment_bank_matches").insert(chunk);
    if (res.error) return fail(500, "suggestion_insert_failed", { inserted, message: res.error.message });
    inserted += chunk.length;
  }
  // payments that now carry a suggestion are marked bank_match_suggested (a reviewer's housekeeping move)
  const toMark = Array.from(new Set(suggestions.map((s) => s.paymentId))).filter((id) => payments.find((p) => p.id === id)?.status !== "bank_match_suggested");
  let marked = 0;
  if (toMark.length > 0) {
    const res = await supabase.from("finance_payment_register").update({ status: "bank_match_suggested" }).in("id", toMark).in("status", ["captured", "documents_pending", "ready_for_bank_match"]).select("id");
    if (!res.error) marked = (res.data ?? []).length;
  }
  const feeRows = bankRows.filter((r) => /\b(fee|fees|charge|charges|commission)\b/i.test(`${r.description ?? ""} ${r.payeeName ?? ""}`) && r.amount <= 50).length;
  return { ok: true, value: { suggested: inserted, paymentsConsidered: payments.length, bankRowsConsidered: bankRows.length, feeRowsIgnored: feeRows, paymentsMarkedSuggested: marked } };
}

// ====================================================================== Excel register import

export type RegisterImportInput = {
  bytes: Buffer;
  fileType: "csv" | "xlsx";
  sheetName?: string;
  mapping?: RegisterMapping;
  defaultEntity?: EntityCode | null;
  accountEntityMap?: Record<string, EntityCode>;
  waiveDocuments?: boolean;
  /** per-row overrides chosen in the preview: row number -> payment type / entity */
  overrides?: Record<string, { paymentType?: RegisterImportRow["paymentType"]; entityCode?: EntityCode }>;
};

export type RegisterPreview = { sheets: string[]; sheet: string; headers: string[]; mapping: RegisterMapping; rows: RegisterImportRow[]; summary: ReturnType<typeof summarizeRegisterImport> };

export async function prepareRegisterImport(supabase: SupabaseClient, input: RegisterImportInput): Promise<ServiceResult<RegisterPreview>> {
  if (!input.bytes || input.bytes.length === 0) return fail(422, "file_required");
  if (input.bytes.length > 8 * 1024 * 1024) return fail(413, "file_too_large");
  let sheets;
  try {
    sheets = parseRegisterFile(input.bytes, input.fileType, input.sheetName);
  } catch {
    return fail(422, "unreadable_file", { message: "The file could not be read. Save the register as XLSX or CSV and try again." });
  }
  const sheet = (input.sheetName && sheets.find((s) => s.name === input.sheetName)) || sheets.find((s) => s.rows.length > 0 && Object.keys(s.rows[0]).some((h) => /payment|beneficiary|amount/i.test(h))) || sheets.find((s) => s.rows.length > 0) || sheets[0];
  if (!sheet || sheet.rows.length === 0) return fail(422, "no_rows", { message: "No rows were found in the file." });
  const headers = Object.keys(sheet.rows[0]);
  const mapping = input.mapping ?? inferRegisterMapping(headers);
  let rows = mapRegisterRows(sheet.rows, mapping, { defaultEntity: input.defaultEntity ?? null, accountEntityMap: input.accountEntityMap });
  rows = rows.map((r) => {
    const o = input.overrides?.[String(r.rowNumber)];
    if (!o) return r;
    const next = { ...r, ...(o.paymentType ? { paymentType: o.paymentType } : {}), ...(o.entityCode ? { entityCode: o.entityCode } : {}) };
    return o.entityCode && r.state === "invalid" && r.errors.length === 1 && /Entity could not be determined/.test(r.errors[0]) ? { ...next, errors: [], state: "new" as const } : next;
  });

  const existing = { bankReferences: new Set<string>(), legacyPaymentIds: new Set<string>() };
  for (let from = 0; ; from += 1000) {
    const r = await supabase.from("finance_payment_register").select("bank_reference, legacy_state").range(from, from + 999);
    if (r.error) return fail(500, "register_unreadable", { message: r.error.message });
    for (const row of r.data ?? []) {
      if (row.bank_reference) existing.bankReferences.add(String(row.bank_reference).replace(/\W+/g, "").toLowerCase());
      const legacyId = (row.legacy_state as { payment_id?: string } | null)?.payment_id;
      if (legacyId) existing.legacyPaymentIds.add(legacyId.toLowerCase());
    }
    if ((r.data ?? []).length < 1000) break;
  }
  const marked = markRegisterDuplicates(rows, existing);
  return { ok: true, value: { sheets: sheets.map((s) => s.name), sheet: sheet.name, headers, mapping, rows: marked, summary: summarizeRegisterImport(marked) } };
}

export type RegisterImportResult = { imported: number; failed: { rowNumber: number; message: string }[]; skipped: number };

export async function confirmRegisterImport(supabase: SupabaseClient, caller: Caller, input: RegisterImportInput): Promise<ServiceResult<RegisterImportResult>> {
  const prepared = await prepareRegisterImport(supabase, input);
  if (!prepared.ok) return prepared;
  const { data: entities, error } = await supabase.from("entities").select("id, short_code");
  if (error) return fail(500, "entities_unreadable", { message: error.message });
  const idByCode = new Map((entities ?? []).map((e) => [e.short_code as string, e.id as string]));
  const ownerFm = isOwnerOrFinanceManager(caller.role);
  let imported = 0;
  const failed: { rowNumber: number; message: string }[] = [];
  let skipped = 0;
  for (const row of prepared.value.rows) {
    if (row.state !== "new") { skipped += 1; continue; }
    const entityId = row.entityCode ? idByCode.get(row.entityCode) : undefined;
    if (!entityId) { failed.push({ rowNumber: row.rowNumber, message: "Entity is not available to you" }); continue; }
    const res = await supabase.from("finance_payment_register").insert(toRegisterInsert(row, { entityId, createdBy: caller.userId, ownerOrFinanceManager: ownerFm, waiveDocuments: Boolean(input.waiveDocuments) }));
    if (res.error) failed.push({ rowNumber: row.rowNumber, message: res.error.message });
    else imported += 1;
  }
  return { ok: true, value: { imported, failed, skipped } };
}
