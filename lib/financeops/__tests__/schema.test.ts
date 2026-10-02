import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkFileEnvelope, isForbiddenKey, MAX_FILE_BYTES, parseBillIntake } from "../schema.ts";

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

  it("rejects a forbidden status field", () => {
    for (const key of ["payment_status", "status", "supporting_document_status"]) {
      const v = valid();
      (v.invoice as Record<string, unknown>)[key] = "paid";
      assert.ok(codes(v).includes(`invoice.${key}:forbidden_field`), key);
    }
    const top = { ...valid(), payment_status: "unpaid" };
    assert.ok(codes(top).includes("payment_status:forbidden_field"));
  });

  it("rejects forbidden approval fields", () => {
    for (const key of ["approved", "approved_by", "approvalState", "is_approved"]) {
      assert.ok(codes({ ...valid(), [key]: true }).includes(`${key}:forbidden_field`), key);
    }
  });

  it("rejects forbidden paid / payment fields", () => {
    for (const key of ["paid", "paid_at", "payment_reference", "payment_date", "payments"]) {
      assert.ok(codes({ ...valid(), [key]: "x" }).includes(`${key}:forbidden_field`), key);
    }
  });

  it("rejects forbidden bank fields", () => {
    for (const key of ["bank_account", "bank_transaction_id", "bankName"]) {
      assert.ok(codes({ ...valid(), [key]: "x" }).includes(`${key}:forbidden_field`), key);
    }
    const nested = valid();
    (nested.supplier as Record<string, unknown>).bank_details = { acc: "1" };
    assert.ok(codes(nested).includes("supplier.bank_details:forbidden_field"));
  });

  it("rejects forbidden reconciliation and SQL fields", () => {
    for (const key of ["reconciled", "reconciliation_id", "sql_posted", "sql_account_ref", "sqlDocNo"]) {
      assert.ok(codes({ ...valid(), [key]: "x" }).includes(`${key}:forbidden_field`), key);
    }
  });

  it("rejects verification, ownership and authoritative-id fields", () => {
    for (const key of ["verified", "verified_by", "created_by", "uploaded_by", "supplier_id", "entity_id", "bill_id", "document_id"]) {
      assert.ok(codes({ ...valid(), [key]: "x" }).includes(`${key}:forbidden_field`), key);
    }
    const nested = valid();
    (nested.supplier as Record<string, unknown>).supplier_id = "00000000-0000-0000-0000-000000000000";
    assert.ok(codes(nested).includes("supplier.supplier_id:forbidden_field"));
  });

  it("rejects forbidden keys hidden inside extraction.fields", () => {
    const v = valid();
    (v.extraction as { fields: Record<string, unknown> }).fields.payment_status = { value: "paid", confidence: 1 };
    assert.ok(codes(v).includes("extraction.fields.payment_status:forbidden_field"));
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

  it("isForbiddenKey does not over-block legitimate keys", () => {
    for (const key of ["intake_id", "entity_code", "invoice", "total_amount", "description", "chat_id", "file_unique_id", "sender_ref", "overall_confidence"]) {
      assert.equal(isForbiddenKey(key), false, key);
    }
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
