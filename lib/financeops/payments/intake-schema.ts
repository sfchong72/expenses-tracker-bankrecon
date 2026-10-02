import { PROHIBITED_FIELDS } from "../schema";
import { normalizePaymentMethod, parseDateTime } from "./normalize";
import type { DocRole, EntityCode, PaymentMethod, PaymentType } from "./types";
import { DOC_ROLES, ENTITY_CODES, PAYMENT_TYPES } from "./types";

/**
 * Strict validation of a Hermes/FinanceOps PAYMENT capture (separate from invoice intake).
 * Same fail-closed rules as the invoice schema: every object is an allow-list, exact-name prohibited fields are
 * reported as forbidden_field, nothing is guessed. FinanceOps may describe a payment and attach evidence; it can
 * never state a lifecycle status, a match, a posting or a review (those names are prohibited outright).
 */

/** Payment-specific names FinanceOps must never send (in addition to the shared PROHIBITED_FIELDS). */
export const PAYMENT_PROHIBITED_FIELDS: ReadonlySet<string> = new Set([
  "bank_matched", "bank_match", "matched_by", "matched_at", "match_id", "confirmed", "confirmed_by", "bank_statement_transaction_id",
  "ready_for_sql", "posted_to_sql", "reconciled", "reconciled_date", "sql_reference", "sql_posting_date", "sql_note",
  "required_documents", "not_applicable_documents", "document_exception_note", "bank_match_not_applicable", "needs_attention", "attention_reasons",
  "finance_review", "reviewed_by", "reviewed_at", "legacy_state", "source_type", "payment_register_id", "payment_id",
]);

export const MAX_PAYMENT_DOCUMENTS = 5;
export const MAX_PAYMENT_FILE_BYTES = 4 * 1024 * 1024;
export const PAYMENT_DOC_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png", "text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"] as const;
export type PaymentDocMime = (typeof PAYMENT_DOC_MIME_TYPES)[number];

export type PaymentIssueCode = "not_an_object" | "forbidden_field" | "unknown_field" | "required" | "invalid_type" | "invalid_format" | "invalid_value" | "invalid_entity_code" | "too_long" | "out_of_range" | "too_many_decimals" | "control_characters" | "too_many";
export type PaymentIssue = { path: string; code: PaymentIssueCode };

export type PaymentIntakeDocument = { part: string; role: DocRole; sha256: string; mime_type: PaymentDocMime; filename: string };

export type PaymentIntake = {
  intake_id: string;
  source: { channel: "telegram"; chat_id: string; message_id: string; received_at: string; sender_ref: string | null };
  entity_code: EntityCode;
  payment_type: PaymentType;
  payment: {
    instruction_date: string;
    instruction_time: string | null;
    method: PaymentMethod;
    method_text: string | null;
    pay_from_account_ref: string | null;
    pay_from_name: string | null;
    beneficiary_name: string | null;
    beneficiary_account_no: string | null;
    beneficiary_bank: string | null;
    amount: number;
    currency: string;
    bank_reference: string | null;
    purpose: string | null;
  };
  suggested_links: { supplier_name: string | null; invoice_number: string | null; claim_ref: string | null; payroll_ref: string | null; note: string | null };
  documents: PaymentIntakeDocument[];
  extraction: { agent: string; version: string; overall_confidence: number };
  notes: string | null;
};

export type PaymentParseResult = { ok: true; value: PaymentIntake } | { ok: false; issues: PaymentIssue[] };

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
type Ctx = { issues: PaymentIssue[] };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const forbidden = (k: string): boolean => PROHIBITED_FIELDS.has(k) || PAYMENT_PROHIBITED_FIELDS.has(k);

function keys(obj: Record<string, unknown>, allowed: readonly string[], path: string, ctx: Ctx): void {
  for (const k of Object.keys(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (forbidden(k)) ctx.issues.push({ path: p, code: "forbidden_field" });
    else if (!allowed.includes(k)) ctx.issues.push({ path: p, code: "unknown_field" });
  }
}

function sub(parent: Record<string, unknown>, k: string, path: string, ctx: Ctx, required: boolean): Record<string, unknown> | null {
  const v = parent[k];
  const p = path ? `${path}.${k}` : k;
  if (v === undefined) { if (required) ctx.issues.push({ path: p, code: "required" }); return null; }
  if (!isObj(v)) { ctx.issues.push({ path: p, code: "invalid_type" }); return null; }
  return v;
}

function text(obj: Record<string, unknown>, k: string, path: string, ctx: Ctx, o: { required?: boolean; nullable?: boolean; max: number; newlines?: boolean }): string | null {
  const p = `${path}.${k}`;
  const v = obj[k];
  if (v === undefined) { if (o.required) ctx.issues.push({ path: p, code: "required" }); return null; }
  if (v === null) { if (!o.nullable) ctx.issues.push({ path: p, code: "invalid_type" }); return null; }
  if (typeof v !== "string") { ctx.issues.push({ path: p, code: "invalid_type" }); return null; }
  const t = v.trim();
  if (t.length > o.max) { ctx.issues.push({ path: p, code: "too_long" }); return null; }
  const probe = o.newlines ? t.replace(/[\n\r\t]/g, " ") : t;
  if (CONTROL_CHARS.test(probe) || (!o.newlines && /[\n\r\t]/.test(t))) { ctx.issues.push({ path: p, code: "control_characters" }); return null; }
  if (t === "") { if (o.required && !o.nullable) ctx.issues.push({ path: p, code: "required" }); return null; }
  return t;
}

export function parsePaymentIntake(input: unknown): PaymentParseResult {
  if (!isObj(input)) return { ok: false, issues: [{ path: "", code: "not_an_object" }] };
  const ctx: Ctx = { issues: [] };
  keys(input, ["intake_id", "source", "entity_code", "payment_type", "payment", "suggested_links", "documents", "extraction", "notes"], "", ctx);

  let intakeId = "";
  const idRaw = input.intake_id;
  if (idRaw === undefined) ctx.issues.push({ path: "intake_id", code: "required" });
  else if (typeof idRaw !== "string") ctx.issues.push({ path: "intake_id", code: "invalid_type" });
  else if (!/^[A-Za-z0-9_-]{8,64}$/.test(idRaw)) ctx.issues.push({ path: "intake_id", code: "invalid_format" });
  else intakeId = idRaw;

  // source
  let source: PaymentIntake["source"] = { channel: "telegram", chat_id: "", message_id: "", received_at: "", sender_ref: null };
  const srcObj = sub(input, "source", "", ctx, true);
  if (srcObj) {
    keys(srcObj, ["channel", "chat_id", "message_id", "received_at", "sender_ref"], "source", ctx);
    if (srcObj.channel !== "telegram") ctx.issues.push({ path: "source.channel", code: srcObj.channel === undefined ? "required" : "invalid_value" });
    const idLike = (k: string): string => {
      const v = srcObj[k];
      if (v === undefined || v === null) { ctx.issues.push({ path: `source.${k}`, code: "required" }); return ""; }
      const t = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : typeof v === "string" ? v.trim() : null;
      if (t === null) { ctx.issues.push({ path: `source.${k}`, code: "invalid_type" }); return ""; }
      if (!/^-?[A-Za-z0-9_:.-]{1,64}$/.test(t)) { ctx.issues.push({ path: `source.${k}`, code: "invalid_format" }); return ""; }
      return t;
    };
    const receivedAt = text(srcObj, "received_at", "source", ctx, { required: true, max: 40 });
    if (receivedAt !== null && (!/^\d{4}-\d{2}-\d{2}T/.test(receivedAt) || Number.isNaN(Date.parse(receivedAt)))) ctx.issues.push({ path: "source.received_at", code: "invalid_format" });
    source = { channel: "telegram", chat_id: idLike("chat_id"), message_id: idLike("message_id"), received_at: receivedAt ?? "", sender_ref: text(srcObj, "sender_ref", "source", ctx, { nullable: true, max: 64 }) };
  }

  // entity (required: a payment is always for one entity; null/unknown is refused so FinanceOps asks Claire)
  let entity: EntityCode = "IEA";
  if (input.entity_code === undefined || input.entity_code === null) ctx.issues.push({ path: "entity_code", code: "required" });
  else if (typeof input.entity_code === "string" && (ENTITY_CODES as readonly string[]).includes(input.entity_code)) entity = input.entity_code as EntityCode;
  else ctx.issues.push({ path: "entity_code", code: "invalid_entity_code" });

  let paymentType: PaymentType = "other";
  if (input.payment_type === undefined) ctx.issues.push({ path: "payment_type", code: "required" });
  else if (typeof input.payment_type === "string" && (PAYMENT_TYPES as readonly string[]).includes(input.payment_type)) paymentType = input.payment_type as PaymentType;
  else ctx.issues.push({ path: "payment_type", code: "invalid_value" });

  // payment
  const empty: PaymentIntake["payment"] = { instruction_date: "", instruction_time: null, method: "bank_transfer", method_text: null, pay_from_account_ref: null, pay_from_name: null, beneficiary_name: null, beneficiary_account_no: null, beneficiary_bank: null, amount: 0, currency: "MYR", bank_reference: null, purpose: null };
  let payment = empty;
  const payObj = sub(input, "payment", "", ctx, true);
  if (payObj) {
    keys(payObj, ["instruction_date", "instruction_time", "method", "pay_from_account_ref", "pay_from_name", "beneficiary_name", "beneficiary_account_no", "beneficiary_bank", "amount", "currency", "bank_reference", "purpose"], "payment", ctx);
    const dateText = text(payObj, "instruction_date", "payment", ctx, { required: true, max: 10 });
    let date = "";
    if (dateText !== null) {
      const parsed = parseDateTime(dateText);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText) || parsed.date !== dateText) ctx.issues.push({ path: "payment.instruction_date", code: "invalid_format" });
      else date = dateText;
    }
    const timeText = text(payObj, "instruction_time", "payment", ctx, { nullable: true, max: 8 });
    let time: string | null = null;
    if (timeText !== null) {
      const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(timeText);
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3] ?? 0) > 59) ctx.issues.push({ path: "payment.instruction_time", code: "invalid_format" });
      else time = `${m[1]}:${m[2]}:${m[3] ?? "00"}`;
    }
    const methodText = text(payObj, "method", "payment", ctx, { nullable: true, max: 80 });
    let amount = 0;
    const a = payObj.amount;
    if (a === undefined || a === null) ctx.issues.push({ path: "payment.amount", code: "required" });
    else if (typeof a !== "number" || !Number.isFinite(a)) ctx.issues.push({ path: "payment.amount", code: "invalid_type" });
    else if (a <= 0 || a > 999_999_999.99) ctx.issues.push({ path: "payment.amount", code: "out_of_range" });
    else if (Math.abs(Math.round(a * 100) / 100 - a) > 1e-9) ctx.issues.push({ path: "payment.amount", code: "too_many_decimals" });
    else amount = Math.round(a * 100) / 100;
    const currency = text(payObj, "currency", "payment", ctx, { nullable: true, max: 3 });
    if (currency !== null && !/^[A-Z]{3}$/.test(currency)) ctx.issues.push({ path: "payment.currency", code: "invalid_format" });
    payment = {
      instruction_date: date,
      instruction_time: time,
      method: normalizePaymentMethod(methodText),
      method_text: methodText,
      pay_from_account_ref: text(payObj, "pay_from_account_ref", "payment", ctx, { nullable: true, max: 120 }),
      pay_from_name: text(payObj, "pay_from_name", "payment", ctx, { nullable: true, max: 200 }),
      beneficiary_name: text(payObj, "beneficiary_name", "payment", ctx, { nullable: true, max: 200 }),
      beneficiary_account_no: text(payObj, "beneficiary_account_no", "payment", ctx, { nullable: true, max: 64 }),
      beneficiary_bank: text(payObj, "beneficiary_bank", "payment", ctx, { nullable: true, max: 120 }),
      amount,
      currency: currency !== null && /^[A-Z]{3}$/.test(currency) ? currency : "MYR",
      bank_reference: text(payObj, "bank_reference", "payment", ctx, { nullable: true, max: 120 }),
      purpose: text(payObj, "purpose", "payment", ctx, { nullable: true, max: 500, newlines: true }),
    };
  }

  // suggested links (hints only; a human makes the real link)
  let links: PaymentIntake["suggested_links"] = { supplier_name: null, invoice_number: null, claim_ref: null, payroll_ref: null, note: null };
  const linkObj = sub(input, "suggested_links", "", ctx, false);
  if (linkObj) {
    keys(linkObj, ["supplier_name", "invoice_number", "claim_ref", "payroll_ref", "note"], "suggested_links", ctx);
    links = {
      supplier_name: text(linkObj, "supplier_name", "suggested_links", ctx, { nullable: true, max: 200 }),
      invoice_number: text(linkObj, "invoice_number", "suggested_links", ctx, { nullable: true, max: 64 }),
      claim_ref: text(linkObj, "claim_ref", "suggested_links", ctx, { nullable: true, max: 120 }),
      payroll_ref: text(linkObj, "payroll_ref", "suggested_links", ctx, { nullable: true, max: 120 }),
      note: text(linkObj, "note", "suggested_links", ctx, { nullable: true, max: 500, newlines: true }),
    };
  }

  // documents
  const documents: PaymentIntakeDocument[] = [];
  if (input.documents !== undefined) {
    if (!Array.isArray(input.documents)) ctx.issues.push({ path: "documents", code: "invalid_type" });
    else if (input.documents.length > MAX_PAYMENT_DOCUMENTS) ctx.issues.push({ path: "documents", code: "too_many" });
    else {
      const parts = new Set<string>();
      input.documents.forEach((d, i) => {
        const p = `documents[${i}]`;
        if (!isObj(d)) { ctx.issues.push({ path: p, code: "invalid_type" }); return; }
        keys(d, ["part", "role", "sha256", "mime_type", "filename"], p, ctx);
        const part = text(d, "part", p, ctx, { required: true, max: 32 });
        if (part !== null && (!/^file_[0-9]$/.test(part) || parts.has(part))) ctx.issues.push({ path: `${p}.part`, code: parts.has(part) ? "invalid_value" : "invalid_format" });
        if (part !== null) parts.add(part);
        const role = d.role;
        if (role === undefined) ctx.issues.push({ path: `${p}.role`, code: "required" });
        else if (typeof role !== "string" || !(DOC_ROLES as readonly string[]).includes(role)) ctx.issues.push({ path: `${p}.role`, code: "invalid_value" });
        const sha = text(d, "sha256", p, ctx, { required: true, max: 64 });
        if (sha !== null && !/^[0-9a-fA-F]{64}$/.test(sha)) ctx.issues.push({ path: `${p}.sha256`, code: "invalid_format" });
        const mime = d.mime_type;
        if (mime === undefined) ctx.issues.push({ path: `${p}.mime_type`, code: "required" });
        else if (typeof mime !== "string" || !(PAYMENT_DOC_MIME_TYPES as readonly string[]).includes(mime)) ctx.issues.push({ path: `${p}.mime_type`, code: "invalid_value" });
        const filename = text(d, "filename", p, ctx, { required: true, max: 255 });
        if (part !== null && typeof role === "string" && (DOC_ROLES as readonly string[]).includes(role) && sha !== null && /^[0-9a-fA-F]{64}$/.test(sha) && typeof mime === "string" && (PAYMENT_DOC_MIME_TYPES as readonly string[]).includes(mime) && filename !== null) {
          documents.push({ part, role: role as DocRole, sha256: sha.toLowerCase(), mime_type: mime as PaymentDocMime, filename });
        }
      });
    }
  }

  // extraction
  let extraction: PaymentIntake["extraction"] = { agent: "", version: "", overall_confidence: 0 };
  const exObj = sub(input, "extraction", "", ctx, true);
  if (exObj) {
    keys(exObj, ["agent", "version", "overall_confidence"], "extraction", ctx);
    const c = exObj.overall_confidence;
    let conf = 0;
    if (c === undefined) ctx.issues.push({ path: "extraction.overall_confidence", code: "required" });
    else if (typeof c !== "number" || !Number.isFinite(c)) ctx.issues.push({ path: "extraction.overall_confidence", code: "invalid_type" });
    else if (c < 0 || c > 1) ctx.issues.push({ path: "extraction.overall_confidence", code: "out_of_range" });
    else conf = c;
    extraction = { agent: text(exObj, "agent", "extraction", ctx, { required: true, max: 64 }) ?? "", version: text(exObj, "version", "extraction", ctx, { required: true, max: 64 }) ?? "", overall_confidence: conf };
  }

  const notes = input.notes === undefined ? null : text(input, "notes", "", ctx, { nullable: true, max: 1000, newlines: true });

  if (ctx.issues.length > 0) {
    const seen = new Set<string>();
    return { ok: false, issues: ctx.issues.filter((i) => { const k = `${i.path}|${i.code}`; if (seen.has(k)) return false; seen.add(k); return true; }) };
  }
  return { ok: true, value: { intake_id: intakeId, source, entity_code: entity, payment_type: paymentType, payment, suggested_links: links, documents, extraction, notes } };
}
