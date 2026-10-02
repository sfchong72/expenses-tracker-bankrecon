import { parseCsv, parseXlsx } from "../../import/supplier-recurring";
import { normalizeName, normalizePaymentMethod, parseAmount, parseDateTime } from "./normalize";
import { requirementsFor } from "./requirements";
import type { DocRole, EntityCode, PaymentMethod, PaymentStatus, PaymentType } from "./types";
import { ENTITY_CODES } from "./types";

/**
 * One-time (optional) import of the existing Excel Payment Register. Built against the real sheet, whose columns are:
 *   Payment ID | Payment initiation date | Payment initiation time | Payment method | IBG clearing date | Entity | Paid by |
 *   Pay-from account reference | Pay-from name | Beneficiary | Beneficiary account | Amount (MYR) | Purpose / PV description |
 *   Supporting document | Invoice status | PV status | Claim status | Payment status | Bank verification status |
 *   Reconciliation status | Source reference | Exception / notes
 * Preview first: every row is new / duplicate / invalid / empty. Nothing is overwritten; duplicates are skipped.
 * The old statuses are kept in legacy_state (informational); documents are NOT in the Hub yet, so imported rows start
 * as documents_pending unless the old register says the payment is already posted or reconciled.
 */

export type RegisterField =
  | "payment_id" | "date" | "time" | "method" | "clearing_date" | "entity" | "paid_by" | "pay_from_ref" | "pay_from_name"
  | "beneficiary" | "beneficiary_account" | "beneficiary_bank" | "amount" | "purpose" | "supporting_document" | "invoice_status"
  | "pv_status" | "claim_status" | "payment_status" | "bank_verification_status" | "reconciliation_status" | "source_reference" | "notes";
export type RegisterMapping = Record<string, RegisterField | "">;

const key = (h: string): string => h.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

const SYNONYMS: Record<string, RegisterField> = {
  payment_id: "payment_id", id: "payment_id", payment_no: "payment_id",
  payment_initiation_date: "date", payment_date: "date", date: "date", instruction_date: "date",
  payment_initiation_time: "time", payment_time: "time", time: "time",
  payment_method: "method", method: "method", menu: "method",
  ibg_clearing_date: "clearing_date",
  entity: "entity", company: "entity",
  paid_by: "paid_by",
  pay_from_account_reference: "pay_from_ref", pay_from_account: "pay_from_ref", pay_from_account_no: "pay_from_ref", pay_from: "pay_from_ref",
  pay_from_name: "pay_from_name",
  beneficiary: "beneficiary", beneficiary_name: "beneficiary", payee: "beneficiary",
  beneficiary_account: "beneficiary_account", beneficiary_account_no: "beneficiary_account", payee_account: "beneficiary_account",
  beneficiary_bank: "beneficiary_bank",
  amount_myr: "amount", amount: "amount", transaction_amount: "amount",
  purpose_pv_description: "purpose", purpose: "purpose", description: "purpose", pv_description: "purpose",
  supporting_document: "supporting_document", supporting_documents: "supporting_document",
  invoice_status: "invoice_status", pv_status: "pv_status", claim_status: "claim_status",
  payment_status: "payment_status", bank_verification_status: "bank_verification_status", reconciliation_status: "reconciliation_status",
  source_reference: "source_reference", reference_no: "source_reference", reference: "source_reference", bank_reference: "source_reference",
  exception_notes: "notes", notes: "notes", remarks: "notes", exception: "notes",
};

export function inferRegisterMapping(headers: readonly string[]): RegisterMapping {
  const used = new Set<RegisterField>();
  const out: RegisterMapping = {};
  for (const h of headers) {
    const f = SYNONYMS[key(h)];
    if (f && !used.has(f)) { out[h] = f; used.add(f); } else out[h] = "";
  }
  return out;
}

export type RegisterSheet = { name: string; rows: Record<string, string>[] };

export function parseRegisterFile(bytes: Buffer, fileType: "csv" | "xlsx", sheetName = ""): RegisterSheet[] {
  if (fileType === "csv") return [{ name: "CSV", rows: parseCsv(bytes.toString("utf8")) }];
  const sheets = parseXlsx(bytes) as RegisterSheet[];
  if (!sheetName) return sheets;
  const chosen = sheets.find((s) => s.name === sheetName);
  return chosen ? [chosen] : sheets;
}

// ------------------------------------------------------------------ entity and type inference

const ENTITY_ALIASES: [RegExp, EntityCode][] = [
  [/inter[\s-]*excel\s*tourism|\bieta\b/i, "IETA"],
  [/inter[\s-]*excel\s*advisory|\biea\b/i, "IEA"],
  [/premier|\bplc\b/i, "PLC"],
  [/kaler/i, "KALER"],
];

export function entityFromText(text: string | null | undefined): EntityCode | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const upper = t.toUpperCase();
  if ((ENTITY_CODES as readonly string[]).includes(upper)) return upper as EntityCode;
  const hits = new Set(ENTITY_ALIASES.filter(([re]) => re.test(t)).map(([, code]) => code));
  return hits.size === 1 ? [...hits][0] : null;
}

export type EntityInference = { code: EntityCode | null; basis: "entity_column" | "account" | "pay_from_name" | "none" };

/** The old register's Entity column is often blank, so fall back to the pay-from account, then the pay-from name. */
export function inferEntity(entityCell: string | null | undefined, payFromAccount: string | null | undefined, payFromName: string | null | undefined, accountMap: Readonly<Record<string, EntityCode>> = {}): EntityInference {
  const fromCol = entityFromText(entityCell);
  if (fromCol) return { code: fromCol, basis: "entity_column" };
  const acct = (payFromAccount ?? "").replace(/\D+/g, "");
  if (acct.length >= 6 && accountMap[acct]) return { code: accountMap[acct], basis: "account" };
  const fromName = entityFromText(payFromName);
  if (fromName) return { code: fromName, basis: "pay_from_name" };
  return { code: null, basis: "none" };
}

export function inferPaymentType(input: { purpose?: string | null; supportingDocument?: string | null; notes?: string | null; invoiceStatus?: string | null; claimStatus?: string | null }): PaymentType {
  const text = `${input.purpose ?? ""} ${input.supportingDocument ?? ""} ${input.notes ?? ""}`.toLowerCase();
  if (/intern|allowance|wage|salary|payroll|stipend/.test(text)) return "intern_wage";
  if (/rent|rental|tenancy|lease|condo|deposit/.test(text)) return "rent_deposit";
  if (/claim|reimburs/.test(text)) return "staff_claim";
  const inv = (input.invoiceStatus ?? "").toLowerCase();
  if (/invoice/.test(text) || (/invoice/.test(inv) && !/no invoice|not applicable/.test(inv))) return "supplier_expense";
  return "other";
}

const UNKNOWN_CELL = /^\s*(\[?\s*(masked|not visible|not applicable|n\/a|nil|-+)[^\]]*\]?)\s*$/i;

function cell(v: string | undefined): string | null {
  const t = (v ?? "").replace(/\s+/g, " ").trim();
  return t && !UNKNOWN_CELL.test(t) ? t : null;
}

/** "Anindita Mutiara Ramadhani [source text partly unclear]" -> the name, and the annotation as a note. */
function splitAnnotation(v: string | null): { value: string | null; note: string | null } {
  if (!v) return { value: null, note: null };
  const notes = [...v.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1].trim()).filter(Boolean);
  const value = v.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim() || null;
  return { value, note: notes.length ? notes.join("; ") : null };
}

// ------------------------------------------------------------------ mapping

export type RegisterImportRow = {
  rowNumber: number;
  legacyPaymentId: string | null;
  entityCode: EntityCode | null;
  entityBasis: EntityInference["basis"];
  instructionDate: string | null;
  instructionTime: string | null;
  method: PaymentMethod;
  payFromAccountRef: string | null;
  payFromName: string | null;
  beneficiaryName: string | null;
  beneficiaryAccountNo: string | null;
  beneficiaryBank: string | null;
  amount: number | null;
  purpose: string | null;
  bankReference: string | null;
  paymentType: PaymentType;
  requiredDocuments: DocRole[];
  targetStatus: Extract<PaymentStatus, "captured" | "documents_pending" | "posted_to_sql" | "reconciled">;
  needsAttention: boolean;
  attentionReasons: string[];
  notes: string | null;
  legacy: Record<string, string>;
  errors: string[];
  warnings: string[];
  state: "new" | "duplicate" | "invalid" | "empty";
  duplicateOf: string | null;
};

export type RegisterMapContext = {
  /** used when neither the sheet nor the pay-from details identify the entity (the user picks it in the preview) */
  defaultEntity?: EntityCode | null;
  /** company account number -> entity (learned from earlier imports; the user may add to it) */
  accountEntityMap?: Readonly<Record<string, EntityCode>>;
};

function get(row: Record<string, string>, mapping: RegisterMapping, field: RegisterField): string | undefined {
  for (const [h, f] of Object.entries(mapping)) if (f === field && row[h] !== undefined) return row[h];
  return undefined;
}

export function mapRegisterRows(rows: readonly Record<string, string>[], mapping: RegisterMapping, ctx: RegisterMapContext = {}): RegisterImportRow[] {
  return rows.map((row, index): RegisterImportRow => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const attention: string[] = [];
    const legacy: Record<string, string> = {};
    for (const f of ["payment_id", "paid_by", "clearing_date", "supporting_document", "invoice_status", "pv_status", "claim_status", "payment_status", "bank_verification_status", "reconciliation_status"] as RegisterField[]) {
      const v = cell(get(row, mapping, f));
      if (v) legacy[f] = v;
    }

    const dt = parseDateTime(get(row, mapping, "date"));
    const timeCell = cell(get(row, mapping, "time"));
    const time = timeCell ? parseDateTime(timeCell).time : dt.time;
    const amount = parseAmount(get(row, mapping, "amount"));
    const payFromName = cell(get(row, mapping, "pay_from_name"));
    const payFromRef = cell(get(row, mapping, "pay_from_ref"));
    const beneficiary = splitAnnotation(cell(get(row, mapping, "beneficiary")));
    const purposeCell = cell(get(row, mapping, "purpose"));
    const purposeMissing = !purposeCell || /not provided|clarification required|to be confirmed/i.test(purposeCell);
    const notesCell = cell(get(row, mapping, "notes"));
    const supporting = cell(get(row, mapping, "supporting_document"));

    const entity = inferEntity(get(row, mapping, "entity"), payFromRef, payFromName, ctx.accountEntityMap);
    let entityCode = entity.code;
    if (!entityCode && ctx.defaultEntity) { entityCode = ctx.defaultEntity; warnings.push(`Entity not stated: the default (${ctx.defaultEntity}) will be used`); }
    if (!entityCode) errors.push("Entity could not be determined: choose one for the import");

    const empty = !cell(get(row, mapping, "payment_id")) && !beneficiary.value && amount === null && !dt.date;
    if (!empty) {
      if (!dt.date) errors.push("Missing or unreadable payment date");
      if (amount === null || amount <= 0) errors.push("Missing or invalid amount");
    }
    if (!beneficiary.value && !empty) warnings.push("Beneficiary is not stated");
    if (beneficiary.note) warnings.push(`Beneficiary note: ${beneficiary.note}`);
    if (purposeMissing && !empty) attention.push("purpose_missing");

    const payStatus = (legacy.payment_status ?? "").toLowerCase();
    const reconStatus = (legacy.reconciliation_status ?? "").toLowerCase();
    let target: RegisterImportRow["targetStatus"] = "documents_pending";
    if (/^reconciled/.test(reconStatus)) target = "reconciled";
    else if (/\bposted\b/.test(reconStatus)) target = "posted_to_sql";
    else if (/pending (transfer|authori[sz]ation)/.test(payStatus)) { target = "captured"; attention.push("payment_not_yet_executed"); }
    if (/held|exception/.test(reconStatus)) attention.push("held_in_old_register");
    if (/partially/.test(reconStatus)) attention.push("partially_matched_in_old_register");

    const type = inferPaymentType({ purpose: purposeCell, supportingDocument: supporting, notes: notesCell, invoiceStatus: legacy.invoice_status, claimStatus: legacy.claim_status });
    const method = normalizePaymentMethod(get(row, mapping, "method"));
    const notes = [notesCell, beneficiary.note ? `Beneficiary note: ${beneficiary.note}` : null].filter(Boolean).join(" | ") || null;

    return {
      rowNumber: index + 2,
      legacyPaymentId: legacy.payment_id ?? null,
      entityCode,
      entityBasis: entity.basis,
      instructionDate: dt.date,
      instructionTime: time,
      method,
      payFromAccountRef: payFromRef,
      payFromName,
      beneficiaryName: beneficiary.value,
      beneficiaryAccountNo: cell(get(row, mapping, "beneficiary_account")),
      beneficiaryBank: cell(get(row, mapping, "beneficiary_bank")),
      amount,
      purpose: purposeMissing ? null : purposeCell,
      bankReference: cell(get(row, mapping, "source_reference")),
      paymentType: type,
      requiredDocuments: requirementsFor(type),
      targetStatus: target,
      needsAttention: attention.length > 0,
      attentionReasons: attention,
      notes,
      legacy,
      errors,
      warnings,
      state: empty ? "empty" : errors.length ? "invalid" : "new",
      duplicateOf: null,
    };
  });
}

export type ExistingRegisterKeys = { bankReferences: ReadonlySet<string>; legacyPaymentIds: ReadonlySet<string> };

/** Flags rows already in the file (same Payment ID / source reference) or already in the Hub. Nothing is overwritten. */
export function markRegisterDuplicates(rows: RegisterImportRow[], existing: ExistingRegisterKeys): RegisterImportRow[] {
  const seenIds = new Map<string, number>();
  const seenRefs = new Map<string, number>();
  return rows.map((r) => {
    if (r.state !== "new") return r;
    const id = r.legacyPaymentId ? r.legacyPaymentId.toLowerCase() : null;
    const ref = r.bankReference ? r.bankReference.replace(/\W+/g, "").toLowerCase() : null;
    let dupOf: string | null = null;
    if (id && existing.legacyPaymentIds.has(id)) dupOf = "already imported (Payment ID)";
    else if (ref && existing.bankReferences.has(ref)) dupOf = "already in the Hub (bank reference)";
    else if (id && seenIds.has(id)) dupOf = `row ${seenIds.get(id)} of this file (same Payment ID)`;
    else if (ref && seenRefs.has(ref)) dupOf = `row ${seenRefs.get(ref)} of this file (same source reference)`;
    if (id && !seenIds.has(id)) seenIds.set(id, r.rowNumber);
    if (ref && !seenRefs.has(ref)) seenRefs.set(ref, r.rowNumber);
    return dupOf ? { ...r, state: "duplicate", duplicateOf: dupOf, warnings: [...r.warnings, `Skipped: ${dupOf}`] } : r;
  });
}

export type RegisterImportSummary = { total: number; new: number; duplicate: number; invalid: number; empty: number; needsAttention: number; byType: Record<string, number>; byEntity: Record<string, number> };

export function summarizeRegisterImport(rows: readonly RegisterImportRow[]): RegisterImportSummary {
  const s: RegisterImportSummary = { total: rows.length, new: 0, duplicate: 0, invalid: 0, empty: 0, needsAttention: 0, byType: {}, byEntity: {} };
  for (const r of rows) {
    s[r.state] += 1;
    if (r.state !== "new") continue;
    if (r.needsAttention) s.needsAttention += 1;
    s.byType[r.paymentType] = (s.byType[r.paymentType] ?? 0) + 1;
    s.byEntity[r.entityCode ?? "?"] = (s.byEntity[r.entityCode ?? "?"] ?? 0) + 1;
  }
  return s;
}

/** The record to INSERT for a "new" row. Closed historical rows (posted/reconciled) are only allowed for Owner / Finance Manager. */
export function toRegisterInsert(row: RegisterImportRow, ctx: { entityId: string; createdBy: string; ownerOrFinanceManager: boolean; waiveDocuments: boolean }): Record<string, unknown> {
  const closed = row.targetStatus === "posted_to_sql" || row.targetStatus === "reconciled";
  const status = closed && !ctx.ownerOrFinanceManager ? "documents_pending" : row.targetStatus;
  const waive = ctx.waiveDocuments && ctx.ownerOrFinanceManager;
  return {
    entity_id: ctx.entityId,
    source_type: "excel_import",
    payment_type: row.paymentType,
    payment_instruction_date: row.instructionDate,
    payment_instruction_time: row.instructionTime,
    payment_method: row.method,
    pay_from_account_ref: row.payFromAccountRef,
    beneficiary_name: row.beneficiaryName,
    beneficiary_account_no: row.beneficiaryAccountNo,
    beneficiary_bank: row.beneficiaryBank,
    amount: row.amount,
    currency: "MYR",
    bank_reference: row.bankReference,
    purpose: row.purpose,
    required_documents: row.requiredDocuments,
    status,
    needs_attention: row.needsAttention,
    attention_reasons: row.attentionReasons,
    notes: row.notes,
    ...(waive ? { document_exception_note: "Imported from the old Excel register: supporting documents are held outside the Hub." } : {}),
    legacy_state: { ...row.legacy, imported_row: row.rowNumber, entity_basis: row.entityBasis },
    created_by: ctx.createdBy,
  };
}

export { normalizeName };
