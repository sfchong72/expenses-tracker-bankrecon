/**
 * Strict Phase 1A invoice-intake payload validation (no external dependencies).
 *
 * Fail-closed rules:
 *  - strict ALLOWLISTED schemas: any key not listed for its object is rejected (unknown_field);
 *  - exact, explicitly prohibited field names (payment_status, created_by, approved_by,
 *    bank_transaction_id, sql_document_id, authoritative ids, ...) are rejected as
 *    forbidden_field - exact match only, no substring or token matching;
 *  - entity comes only from an approved `entity_code`; null means "uncertain" and yields an
 *    intake for human review only - it must never produce a supplier bill and is never guessed;
 *  - OCR fields may be null; null means "not stated / uncertain", never a default.
 */

export const ENTITY_CODES = ["IEA", "IETA", "PLC", "KALER"] as const;
export type EntityCode = (typeof ENTITY_CODES)[number];

export const ALLOWED_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export type AllowedMime = (typeof ALLOWED_MIME_TYPES)[number];

/** Phase 1 upload cap (owner decision D7). */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

export const EXTRACTION_FIELD_NAMES = [
  "entity",
  "supplier_name",
  "supplier_registration_number",
  "invoice_number",
  "invoice_date",
  "due_date",
  "currency",
  "subtotal",
  "tax_amount",
  "total_amount",
  "description",
  "category",
] as const;
export type ExtractionFieldName = (typeof EXTRACTION_FIELD_NAMES)[number];

export type IssueCode =
  | "not_an_object"
  | "forbidden_field"
  | "unknown_field"
  | "required"
  | "invalid_type"
  | "invalid_format"
  | "invalid_value"
  | "invalid_entity_code"
  | "too_long"
  | "too_many_decimals"
  | "out_of_range"
  | "control_characters";

export type Issue = { path: string; code: IssueCode };

export type FinanceOpsBillIntake = {
  intake_id: string;
  source: {
    channel: "telegram";
    chat_id: string;
    message_id: string;
    file_id: string | null;
    file_unique_id: string | null;
    received_at: string;
    sender_ref: string | null;
  };
  /** null = FinanceOps could not determine the entity; must go to human review. */
  entity_code: EntityCode | null;
  supplier: { name: string | null; registration_number: string | null };
  invoice: {
    number: string | null;
    date: string | null;
    due_date: string | null;
    currency: string | null;
    subtotal: number | null;
    tax_amount: number | null;
    total_amount: number | null;
    description: string | null;
    bill_type: "supplier_invoice";
  };
  category_hint: { name: string | null };
  extraction: {
    agent: string;
    version: string;
    overall_confidence: number;
    fields: Partial<Record<ExtractionFieldName, { value: string | number | null; confidence: number }>>;
  };
  document: { sha256: string; mime_type: AllowedMime; filename: string };
  notes: string | null;
};

export type ParseResult =
  | { ok: true; value: FinanceOpsBillIntake }
  | { ok: false; issues: Issue[] };

// ---------------------------------------------------------------- prohibited fields

/**
 * Validation model: every object is checked against an explicit ALLOWLIST of keys. Any other
 * key is rejected (unknown_field). Separately, the exact field names below are sensitive or
 * authoritative internal fields that FinanceOps must never set; if one appears it is reported as
 * forbidden_field so the audit trail says what was attempted. There is NO substring or token
 * matching: a key is prohibited only when it equals one of these names exactly (case-sensitive),
 * and everything not on an allowlist fails closed anyway.
 */
export const PROHIBITED_FIELDS: ReadonlySet<string> = new Set([
  // authoritative internal ids
  "id", "supplier_id", "entity_id", "bill_id", "supplier_bill_id", "document_id", "payment_voucher_id", "bill_payment_id",
  "bank_account_id", "expense_category_id", "recurring_obligation_id",
  // ownership / audit actors
  "created_by", "updated_by", "uploaded_by", "reviewed_by", "verified_by",
  // lifecycle and workflow state
  "status", "payment_status", "supporting_document_status", "review_status", "process_state", "approval_status",
  // approval and verification
  "approved_by", "approved_at", "verified_at", "reviewed_at",
  // payment
  "paid_at", "paid_by", "paid_amount", "outstanding_amount",
  // bank and reconciliation
  "bank_transaction_id", "reconciliation_date", "reconciliation_id", "reconciled_at", "reconciled_by",
  // SQL Account
  "sql_document_id", "sql_posted_at", "sql_posted", "sql_account_ref",
  // storage / provenance internals
  "storage_path", "file_hash", "data_origin", "is_demo",
]);

export function isProhibitedField(key: string): boolean {
  return PROHIBITED_FIELDS.has(key);
}

// ---------------------------------------------------------------- primitives

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

type Ctx = { issues: Issue[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkKeys(obj: Record<string, unknown>, allowed: readonly string[], path: string, ctx: Ctx): void {
  for (const key of Object.keys(obj)) {
    const keyPath = path ? `${path}.${key}` : key;
    if (isProhibitedField(key)) ctx.issues.push({ path: keyPath, code: "forbidden_field" });
    else if (!allowed.includes(key)) ctx.issues.push({ path: keyPath, code: "unknown_field" });
  }
}

function objectAt(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  ctx: Ctx,
  required: boolean,
): Record<string, unknown> | null {
  const v = parent[key];
  const p = path ? `${path}.${key}` : key;
  if (v === undefined) {
    if (required) ctx.issues.push({ path: p, code: "required" });
    return null;
  }
  if (!isPlainObject(v)) {
    ctx.issues.push({ path: p, code: "invalid_type" });
    return null;
  }
  return v;
}

function str(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  ctx: Ctx,
  opts: { required?: boolean; nullable?: boolean; max: number; min?: number; allowNewlines?: boolean },
): string | null {
  const p = `${path}.${key}`;
  const v = obj[key];
  if (v === undefined) {
    if (opts.required) ctx.issues.push({ path: p, code: "required" });
    return null;
  }
  if (v === null) {
    if (!opts.nullable) ctx.issues.push({ path: p, code: "invalid_type" });
    return null;
  }
  if (typeof v !== "string") {
    ctx.issues.push({ path: p, code: "invalid_type" });
    return null;
  }
  const text = v.trim();
  if (text.length > opts.max) {
    ctx.issues.push({ path: p, code: "too_long" });
    return null;
  }
  const control = opts.allowNewlines ? text.replace(/[\n\r\t]/g, " ") : text;
  if (CONTROL_CHARS.test(control) || (!opts.allowNewlines && /[\n\r\t]/.test(text))) {
    ctx.issues.push({ path: p, code: "control_characters" });
    return null;
  }
  if (text === "") {
    if (opts.required && !opts.nullable) ctx.issues.push({ path: p, code: "required" });
    return null;
  }
  if (opts.min !== undefined && text.length < opts.min) {
    ctx.issues.push({ path: p, code: "invalid_format" });
    return null;
  }
  return text;
}

function idLike(v: unknown, p: string, ctx: Ctx, required: boolean): string | null {
  if (v === undefined || v === null) {
    if (required) ctx.issues.push({ path: p, code: "required" });
    return null;
  }
  const text = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : typeof v === "string" ? v.trim() : null;
  if (text === null) {
    ctx.issues.push({ path: p, code: "invalid_type" });
    return null;
  }
  if (!/^-?[A-Za-z0-9_:.-]{1,64}$/.test(text)) {
    ctx.issues.push({ path: p, code: "invalid_format" });
    return null;
  }
  return text;
}

export function isRealCalendarDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1990 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function dateField(obj: Record<string, unknown>, key: string, path: string, ctx: Ctx): string | null {
  const text = str(obj, key, path, ctx, { nullable: true, max: 10 });
  if (text === null) return null;
  if (!isRealCalendarDate(text)) {
    ctx.issues.push({ path: `${path}.${key}`, code: "invalid_format" });
    return null;
  }
  return text;
}

function money(obj: Record<string, unknown>, key: string, path: string, ctx: Ctx): number | null {
  const p = `${path}.${key}`;
  const v = obj[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    ctx.issues.push({ path: p, code: "invalid_type" });
    return null;
  }
  if (v < 0 || v > 999_999_999.99) {
    ctx.issues.push({ path: p, code: "out_of_range" });
    return null;
  }
  if (Math.abs(Math.round(v * 100) / 100 - v) > 1e-9) {
    ctx.issues.push({ path: p, code: "too_many_decimals" });
    return null;
  }
  return Math.round(v * 100) / 100;
}

function confidence(v: unknown, p: string, ctx: Ctx): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    ctx.issues.push({ path: p, code: v === undefined ? "required" : "invalid_type" });
    return 0;
  }
  if (v < 0 || v > 1) {
    ctx.issues.push({ path: p, code: "out_of_range" });
    return 0;
  }
  return v;
}

// ---------------------------------------------------------------- main parser

const TOP_LEVEL_KEYS = ["intake_id", "source", "entity_code", "supplier", "invoice", "category_hint", "extraction", "document", "notes"] as const;

export function parseBillIntake(input: unknown): ParseResult {
  if (!isPlainObject(input)) return { ok: false, issues: [{ path: "", code: "not_an_object" }] };
  const ctx: Ctx = { issues: [] };
  checkKeys(input, TOP_LEVEL_KEYS, "", ctx);

  // intake_id
  const intakeIdRaw = input.intake_id;
  let intakeId = "";
  if (intakeIdRaw === undefined) ctx.issues.push({ path: "intake_id", code: "required" });
  else if (typeof intakeIdRaw !== "string") ctx.issues.push({ path: "intake_id", code: "invalid_type" });
  else if (!/^[A-Za-z0-9_-]{8,64}$/.test(intakeIdRaw)) ctx.issues.push({ path: "intake_id", code: "invalid_format" });
  else intakeId = intakeIdRaw;

  // source
  const srcObj = objectAt(input, "source", "", ctx, true);
  let source: FinanceOpsBillIntake["source"] = {
    channel: "telegram",
    chat_id: "",
    message_id: "",
    file_id: null,
    file_unique_id: null,
    received_at: "",
    sender_ref: null,
  };
  if (srcObj) {
    checkKeys(srcObj, ["channel", "chat_id", "message_id", "file_id", "file_unique_id", "received_at", "sender_ref"], "source", ctx);
    if (srcObj.channel !== "telegram") ctx.issues.push({ path: "source.channel", code: srcObj.channel === undefined ? "required" : "invalid_value" });
    const receivedAt = str(srcObj, "received_at", "source", ctx, { required: true, max: 40 });
    if (receivedAt !== null && (!/^\d{4}-\d{2}-\d{2}T/.test(receivedAt) || Number.isNaN(Date.parse(receivedAt)))) {
      ctx.issues.push({ path: "source.received_at", code: "invalid_format" });
    }
    source = {
      channel: "telegram",
      chat_id: idLike(srcObj.chat_id, "source.chat_id", ctx, true) ?? "",
      message_id: idLike(srcObj.message_id, "source.message_id", ctx, true) ?? "",
      file_id: str(srcObj, "file_id", "source", ctx, { nullable: true, max: 200 }),
      file_unique_id: str(srcObj, "file_unique_id", "source", ctx, { nullable: true, max: 200 }),
      received_at: receivedAt ?? "",
      sender_ref: str(srcObj, "sender_ref", "source", ctx, { nullable: true, max: 64 }),
    };
  }

  // entity_code
  let entityCode: EntityCode | null = null;
  if (input.entity_code === undefined) ctx.issues.push({ path: "entity_code", code: "required" });
  else if (input.entity_code !== null) {
    if (typeof input.entity_code === "string" && (ENTITY_CODES as readonly string[]).includes(input.entity_code)) {
      entityCode = input.entity_code as EntityCode;
    } else ctx.issues.push({ path: "entity_code", code: "invalid_entity_code" });
  }

  // supplier (optional envelope; fields nullable)
  const supObj = objectAt(input, "supplier", "", ctx, false);
  let supplier = { name: null as string | null, registration_number: null as string | null };
  if (supObj) {
    checkKeys(supObj, ["name", "registration_number"], "supplier", ctx);
    supplier = {
      name: str(supObj, "name", "supplier", ctx, { nullable: true, max: 200 }),
      registration_number: str(supObj, "registration_number", "supplier", ctx, { nullable: true, max: 64 }),
    };
  }

  // invoice (required envelope; every field nullable except bill_type)
  const invObj = objectAt(input, "invoice", "", ctx, true);
  let invoice: FinanceOpsBillIntake["invoice"] = {
    number: null, date: null, due_date: null, currency: null, subtotal: null, tax_amount: null, total_amount: null, description: null, bill_type: "supplier_invoice",
  };
  if (invObj) {
    checkKeys(invObj, ["number", "date", "due_date", "currency", "subtotal", "tax_amount", "total_amount", "description", "bill_type"], "invoice", ctx);
    if (invObj.bill_type !== undefined && invObj.bill_type !== "supplier_invoice") ctx.issues.push({ path: "invoice.bill_type", code: "invalid_value" });
    const currency = str(invObj, "currency", "invoice", ctx, { nullable: true, max: 3 });
    if (currency !== null && !/^[A-Z]{3}$/.test(currency)) ctx.issues.push({ path: "invoice.currency", code: "invalid_format" });
    invoice = {
      number: str(invObj, "number", "invoice", ctx, { nullable: true, max: 64 }),
      date: dateField(invObj, "date", "invoice", ctx),
      due_date: dateField(invObj, "due_date", "invoice", ctx),
      currency: currency !== null && /^[A-Z]{3}$/.test(currency) ? currency : null,
      subtotal: money(invObj, "subtotal", "invoice", ctx),
      tax_amount: money(invObj, "tax_amount", "invoice", ctx),
      total_amount: money(invObj, "total_amount", "invoice", ctx),
      description: str(invObj, "description", "invoice", ctx, { nullable: true, max: 500, allowNewlines: true }),
      bill_type: "supplier_invoice",
    };
  }

  // category_hint
  const catObj = objectAt(input, "category_hint", "", ctx, false);
  let categoryHint = { name: null as string | null };
  if (catObj) {
    checkKeys(catObj, ["name"], "category_hint", ctx);
    categoryHint = { name: str(catObj, "name", "category_hint", ctx, { nullable: true, max: 120 }) };
  }

  // extraction
  const exObj = objectAt(input, "extraction", "", ctx, true);
  let extraction: FinanceOpsBillIntake["extraction"] = { agent: "", version: "", overall_confidence: 0, fields: {} };
  if (exObj) {
    checkKeys(exObj, ["agent", "version", "overall_confidence", "fields"], "extraction", ctx);
    const agent = str(exObj, "agent", "extraction", ctx, { required: true, max: 64 });
    const version = str(exObj, "version", "extraction", ctx, { required: true, max: 64 });
    const overall = confidence(exObj.overall_confidence, "extraction.overall_confidence", ctx);
    const fields: FinanceOpsBillIntake["extraction"]["fields"] = {};
    const fieldsObj = objectAt(exObj, "fields", "extraction", ctx, false);
    if (fieldsObj) {
      for (const [name, raw] of Object.entries(fieldsObj)) {
        const p = `extraction.fields.${name}`;
        if (!(EXTRACTION_FIELD_NAMES as readonly string[]).includes(name)) {
          ctx.issues.push({ path: p, code: isProhibitedField(name) ? "forbidden_field" : "unknown_field" });
          continue;
        }
        if (!isPlainObject(raw)) {
          ctx.issues.push({ path: p, code: "invalid_type" });
          continue;
        }
        checkKeys(raw, ["value", "confidence"], p, ctx);
        const value = raw.value;
        let normalised: string | number | null = null;
        if (value === undefined) ctx.issues.push({ path: `${p}.value`, code: "required" });
        else if (value === null) normalised = null;
        else if (typeof value === "number" && Number.isFinite(value)) normalised = value;
        else if (typeof value === "string" && value.length <= 500 && !CONTROL_CHARS.test(value)) normalised = value.trim() || null;
        else ctx.issues.push({ path: `${p}.value`, code: typeof value === "string" ? "too_long" : "invalid_type" });
        fields[name as ExtractionFieldName] = { value: normalised, confidence: confidence(raw.confidence, `${p}.confidence`, ctx) };
      }
    }
    extraction = { agent: agent ?? "", version: version ?? "", overall_confidence: overall, fields };
  }

  // document
  const docObj = objectAt(input, "document", "", ctx, true);
  let document: FinanceOpsBillIntake["document"] = { sha256: "", mime_type: "application/pdf", filename: "" };
  if (docObj) {
    checkKeys(docObj, ["sha256", "mime_type", "filename"], "document", ctx);
    const sha = str(docObj, "sha256", "document", ctx, { required: true, max: 64 });
    if (sha !== null && !/^[0-9a-fA-F]{64}$/.test(sha)) ctx.issues.push({ path: "document.sha256", code: "invalid_format" });
    const mime = docObj.mime_type;
    if (mime === undefined) ctx.issues.push({ path: "document.mime_type", code: "required" });
    else if (typeof mime !== "string" || !(ALLOWED_MIME_TYPES as readonly string[]).includes(mime)) {
      ctx.issues.push({ path: "document.mime_type", code: "invalid_value" });
    }
    const filename = str(docObj, "filename", "document", ctx, { required: true, max: 255 });
    document = {
      sha256: sha !== null && /^[0-9a-fA-F]{64}$/.test(sha) ? sha.toLowerCase() : "",
      mime_type: (typeof mime === "string" && (ALLOWED_MIME_TYPES as readonly string[]).includes(mime) ? mime : "application/pdf") as AllowedMime,
      filename: filename ?? "",
    };
  }

  const notes = input.notes === undefined ? null : str(input, "notes", "", ctx, { nullable: true, max: 1000, allowNewlines: true });

  if (ctx.issues.length > 0) return { ok: false, issues: dedupeIssues(ctx.issues) };

  return {
    ok: true,
    value: { intake_id: intakeId, source, entity_code: entityCode, supplier, invoice, category_hint: categoryHint, extraction, document, notes },
  };
}

function dedupeIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.path}|${i.code}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------- file envelope

export type FileCheck =
  | { ok: true }
  | { ok: false; status: 413 | 415 | 422; code: "file_too_large" | "unsupported_media_type" | "empty_file"; message: string };

export function checkFileEnvelope(file: { size: number; mimeType: string }): FileCheck {
  if (file.size <= 0) return { ok: false, status: 422, code: "empty_file", message: "The uploaded file is empty." };
  if (file.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      status: 413,
      code: "file_too_large",
      message: "File exceeds the 4 MB Phase 1 limit. Manual upload in the Hub is required for this document.",
    };
  }
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(file.mimeType)) {
    return { ok: false, status: 415, code: "unsupported_media_type", message: "Only PDF, JPEG and PNG files are accepted. Convert other formats before submitting." };
  }
  return { ok: true };
}
