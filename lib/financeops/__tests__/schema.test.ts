import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkFileEnvelope, isProhibitedField, MAX_FILE_BYTES, parseBillIntake, PROHIBITED_FIELDS } from "../schema";

const SHA = "a".repeat(64);

function valid(): Record<string, unknown> {
  return {
    intake_id: "fo_bill_01JABCDEF",
    source: { channel: "telegram", chat_id: "-1001234567", message_id: 42, file_id: "AgAC...", file_unique_id: "AQAD...", received_at: "2026-10-02T03:04:05Z", sender_ref: "claire" },
    entity_code: "IEA",
    supplier: { name: "Mega Supplies Sdn Bhd", registration_number: "201901012345" },
    invoice: { number: "INV-0041", date: "2026-09-30", due_date: "2026-10-30", currency: "MYR", subtotal: 100, tax_amount: 6, total_amount: 106, description: "Office stationery", bill_type: "supplier_invoice" },
    category_hint: { name: "Office supplies" },
    extraction: { agent: "financeops-hermes", version: "1.0", overall_confidence: 0.93, fields: { total_amount: { value: 106, confidence: 0.97 } } },
    document: { sha256: SHA, mime_type: "application/pdf", filename: "inv.pdf" },
    notes: null,
  };
}

function codes(input: unknown) {
  const r = parseBillIntake(input);
  return r.ok ? [] : r.issues.map((i) => `${i.path}:${i.code}`);
}

describe("bill intake schema", () => {
  it("accepts a valid intake and normalises it", () => {
    const r = parseBillIntake(valid());
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.source.message_id, "42");
      assert.equal(r.value.entity_code, "IEA");
      assert.equal(r.value.invoice.total_amount, 106);
    }
  });

  it("accepts nullable OCR fields and a null (uncertain) entity", () => {
    const v = valid();
    v.entity_code = null;
    v.supplier = { name: null, registration_number: null };
    v.invoice = { number: null, date: null, due_date: null, currency: null, subtotal: null, tax_amount: null, total_amount: null, description: null };
    v.category_hint = { name: null };
    const r = parseBillIntake(v);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.entity_code, null);
      assert.equal(r.value.invoice.due_date, null);
      assert.equal(r.value.invoice.total_amount, null);
    }
  });

  it("treats empty strings as null and does not invent values", () => {
    const v = valid();
    (v.invoice as Record<string, unknown>).due_date = "  ";
    (v.invoice as Record<string, unknown>).number = "";
    const r = parseBillIntake(v);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.invoice.due_date, null);
      assert.equal(r.value.invoice.number, null);
    }
  });

  it("rejects explicitly prohibited fields at the top level and in every nested object", () => {
    const targets: Array<[string, (v: Record<string, unknown>) => Record<string, unknown>]> = [
      ["", (v) => v],
      ["source.", (v) => v.source as Record<string, unknown>],
      ["supplier.", (v) => v.supplier as Record<string, unknown>],
      ["invoice.", (v) => v.invoice as Record<string, unknown>],
      ["category_hint.", (v) => v.category_hint as Record<string, unknown>],
      ["extraction.", (v) => v.extraction as Record<string, unknown>],
      ["document.", (v) => v.document as Record<string, unknown>],
    ];
    for (const key of ["payment_status", "created_by", "approved_by", "approved_at", "paid_at", "bank_transaction_id", "reconciliation_date", "sql_document_id", "sql_posted_at", "supplier_id", "entity_id", "bill_id", "document_id", "status", "supporting_document_status", "verified_by", "outstanding_amount", "data_origin"]) {
      for (const [prefix, pick] of targets) {
        const v = valid();
        pick(v)[key] = "x";
        assert.ok(codes(v).includes(`${prefix}${key}:forbidden_field`), `${prefix}${key}`);
      }
    }
  });

  it("rejects prohibited fields smuggled into extraction.fields", () => {
    const v = valid();
    (v.extraction as { fields: Record<string, unknown> }).fields.payment_status = { value: "paid", confidence: 1 };
    assert.ok(codes(v).includes("extraction.fields.payment_status:forbidden_field"));
  });

  it("covers the required sensitive field list exactly", () => {
    for (const key of ["payment_status", "created_by", "approved_by", "approved_at", "paid_at", "bank_transaction_id", "reconciliation_date", "sql_document_id", "sql_posted_at"]) {
      assert.ok(PROHIBITED_FIELDS.has(key), key);
    }
  });

  it("does not use substring or token matching: near-miss names are unknown_field, not forbidden", () => {
    for (const key of ["bank_note", "sql_hint", "payments", "approval", "is_approved", "paid", "reconciled", "bankName", "Payment_Status", "payment_status ", "status_text"]) {
      const c = codes({ ...valid(), [key]: "x" });
      assert.deepEqual(c, [`${key}:unknown_field`], key);
      assert.equal(isProhibitedField(key), false, key);
    }
  });

  it("still fails closed: every unknown key is rejected, however innocuous", () => {
    for (const key of ["colour", "bank", "sql", "status_flag", "x"]) assert.ok(codes({ ...valid(), [key]: 1 }).length > 0, key);
  });

  it("rejects invalid entity codes (no guessing)", () => {
    for (const code of ["iea", "ABC", "UNKNOWN", "", 5]) {
      assert.ok(codes({ ...valid(), entity_code: code }).includes("entity_code:invalid_entity_code"), String(code));
    }
    const missing = valid();
    delete missing.entity_code;
    assert.ok(codes(missing).includes("entity_code:required"));
  });

  it("accepts all four approved entity codes", () => {
    for (const code of ["IEA", "IETA", "PLC", "KALER"]) assert.equal(parseBillIntake({ ...valid(), entity_code: code }).ok, true, code);
  });

  it("fails closed on unknown fields at every level", () => {
    assert.ok(codes({ ...valid(), colour: "red" }).includes("colour:unknown_field"));
    const a = valid();
    (a.source as Record<string, unknown>).extra = 1;
    assert.ok(codes(a).includes("source.extra:unknown_field"));
    const b = valid();
    (b.invoice as Record<string, unknown>).vendor_notes = "x";
    assert.ok(codes(b).includes("invoice.vendor_notes:unknown_field"));
    const c = valid();
    (c.extraction as { fields: Record<string, unknown> }).fields.mystery = { value: 1, confidence: 1 };
    assert.ok(codes(c).includes("extraction.fields.mystery:unknown_field"));
  });

  it("requires the mandatory envelope", () => {
    for (const key of ["intake_id", "source", "invoice", "extraction", "document"]) {
      const v = valid();
      delete v[key];
      assert.ok(codes(v).includes(`${key}:required`), key);
    }
    const noSource = valid();
    (noSource.source as Record<string, unknown>).chat_id = undefined;
    assert.ok(codes(noSource).includes("source.chat_id:required"));
    assert.deepEqual(codes("nope"), [":not_an_object"]);
    assert.deepEqual(codes(null), [":not_an_object"]);
    assert.deepEqual(codes([]), [":not_an_object"]);
  });

  it("validates formats", () => {
    assert.ok(codes({ ...valid(), intake_id: "short" }).includes("intake_id:invalid_format"));
    const bad = valid();
    Object.assign(bad.invoice as object, { date: "2026-02-30", due_date: "30/10/2026", total_amount: 10.123, subtotal: -1, currency: "myr", bill_type: "recurring_obligation" });
    const c = codes(bad);
    assert.ok(c.includes("invoice.date:invalid_format"));
    assert.ok(c.includes("invoice.due_date:invalid_format"));
    assert.ok(c.includes("invoice.total_amount:too_many_decimals"));
    assert.ok(c.includes("invoice.subtotal:out_of_range"));
    assert.ok(c.includes("invoice.currency:invalid_format"));
    assert.ok(c.includes("invoice.bill_type:invalid_value"));
    const doc = valid();
    Object.assign(doc.document as object, { sha256: "xyz", mime_type: "image/heic" });
    const d = codes(doc);
    assert.ok(d.includes("document.sha256:invalid_format"));
    assert.ok(d.includes("document.mime_type:invalid_value"));
    const conf = valid();
    (conf.extraction as Record<string, unknown>).overall_confidence = 1.5;
    assert.ok(codes(conf).includes("extraction.overall_confidence:out_of_range"));
  });

  it("rejects control characters and over-long text", () => {
    const v = valid();
    (v.invoice as Record<string, unknown>).number = "INV\u0000-1";
    (v.supplier as Record<string, unknown>).name = "x".repeat(201);
    const c = codes(v);
    assert.ok(c.includes("invoice.number:control_characters"));
    assert.ok(c.includes("supplier.name:too_long"));
  });

  it("lower-cases the document hash", () => {
    const v = valid();
    (v.document as Record<string, unknown>).sha256 = "A".repeat(64);
    const r = parseBillIntake(v);
    assert.equal(r.ok && r.value.document.sha256, "a".repeat(64));
  });

  it("every allowlisted field is accepted (nothing legitimate is blocked by the prohibited list)", () => {
    const allowed = ["intake_id", "source", "entity_code", "supplier", "invoice", "category_hint", "extraction", "document", "notes", "chat_id", "message_id", "file_id", "file_unique_id", "received_at", "sender_ref", "registration_number", "total_amount", "tax_amount", "subtotal", "due_date", "description", "overall_confidence", "filename", "sha256", "mime_type", "bill_type", "currency", "number", "date", "name", "agent", "version", "fields", "channel"];
    for (const key of allowed) assert.equal(isProhibitedField(key), false, key);
    const full = valid();
    (full.extraction as { fields: Record<string, unknown> }).fields = Object.fromEntries(["entity", "supplier_name", "supplier_registration_number", "invoice_number", "invoice_date", "due_date", "currency", "subtotal", "tax_amount", "total_amount", "description", "category"].map((k) => [k, { value: null, confidence: 0.9 }]));
    assert.equal(parseBillIntake(full).ok, true);
  });
});

describe("file envelope", () => {
  it("accepts allowed types within 4 MB", () => {
    for (const mimeType of ["application/pdf", "image/jpeg", "image/png"]) assert.deepEqual(checkFileEnvelope({ size: 1000, mimeType }), { ok: true });
    assert.deepEqual(checkFileEnvelope({ size: MAX_FILE_BYTES, mimeType: "application/pdf" }), { ok: true });
  });

  it("returns a manual-upload requirement for oversize files", () => {
    const r = checkFileEnvelope({ size: MAX_FILE_BYTES + 1, mimeType: "application/pdf" });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 413);
      assert.match(r.message, /Manual upload/i);
    }
  });

  it("rejects unsupported and empty files", () => {
    const heic = checkFileEnvelope({ size: 10, mimeType: "image/heic" });
    assert.equal(!heic.ok && heic.status, 415);
    const empty = checkFileEnvelope({ size: 0, mimeType: "application/pdf" });
    assert.equal(!empty.ok && empty.status, 422);
  });
});
