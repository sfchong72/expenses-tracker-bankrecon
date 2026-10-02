import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyDuplicates, normalizeInvoiceNumber, type DuplicateCandidate, type ExistingBill, type ExistingDocumentLink } from "../duplicates.ts";

const SHA = "b".repeat(64);
const ENTITY = "entity-iea";
const OTHER_ENTITY = "entity-kaler";
const SUPPLIER = "supplier-1";

const candidate: DuplicateCandidate = { entityId: ENTITY, supplierId: SUPPLIER, invoiceNumber: "INV-0041", totalAmount: 106, billDate: "2026-09-30", fileSha256: SHA };

function bill(over: Partial<ExistingBill> = {}): ExistingBill {
  return { id: "bill-1", entityId: ENTITY, supplierId: SUPPLIER, billNumber: "OTHER-9", totalAmount: 5, billDate: "2026-01-01", paymentStatus: "unpaid", ...over };
}
function doc(over: Partial<ExistingDocumentLink> = {}): ExistingDocumentLink {
  return { fileSha256: SHA, billId: "bill-1", deleted: false, ...over };
}

describe("duplicate classification", () => {
  it("blocks an exact file duplicate in the same entity", () => {
    const r = classifyDuplicates(candidate, [bill()], [doc()]);
    assert.equal(r.decision, "block_duplicate_file");
    assert.deepEqual(r.matches.map((m) => [m.type, m.billId, m.strength]), [["exact_file", "bill-1", "hard"]]);
    assert.deepEqual(r.flags, ["duplicate_suspected_file"]);
  });

  it("matches file hashes case-insensitively", () => {
    const r = classifyDuplicates({ ...candidate, fileSha256: SHA.toUpperCase() }, [bill()], [doc()]);
    assert.equal(r.decision, "block_duplicate_file");
  });

  it("does not block when the existing bill is cancelled or the document deleted", () => {
    assert.equal(classifyDuplicates(candidate, [bill({ paymentStatus: "cancelled" })], [doc()]).decision, "create_draft");
    assert.equal(classifyDuplicates(candidate, [bill()], [doc({ deleted: true })]).decision, "create_draft");
    assert.equal(classifyDuplicates(candidate, [bill()], [doc({ billId: null })]).decision, "create_draft");
  });

  it("flags (but does not block) a same file in another entity", () => {
    const r = classifyDuplicates(candidate, [bill({ entityId: OTHER_ENTITY })], [doc()]);
    assert.equal(r.decision, "create_draft");
    assert.deepEqual(r.matches.map((m) => [m.type, m.entityId, m.strength]), [["cross_entity_same_file", OTHER_ENTITY, "soft"]]);
    assert.deepEqual(r.flags, ["same_file_in_other_entity"]);
  });

  it("flags the same supplier + invoice number (normalised) as a soft duplicate", () => {
    const r = classifyDuplicates(candidate, [bill({ billNumber: "inv 0041" })], []);
    assert.equal(r.decision, "create_draft");
    assert.deepEqual(r.matches.map((m) => m.type), ["same_invoice_number"]);
    assert.deepEqual(r.flags, ["possible_duplicate_invoice_number"]);
  });

  it("flags supplier + amount + date as a soft candidate", () => {
    const r = classifyDuplicates(candidate, [bill({ totalAmount: 106.0, billDate: "2026-09-30" })], []);
    assert.deepEqual(r.matches.map((m) => m.type), ["same_amount_date"]);
    assert.deepEqual(r.flags, ["possible_duplicate_amount_date"]);
  });

  it("reports both soft signals when both apply, ordered deterministically", () => {
    const r = classifyDuplicates(candidate, [bill({ billNumber: "INV-0041", totalAmount: 106, billDate: "2026-09-30" })], []);
    assert.deepEqual(r.matches.map((m) => m.type), ["same_invoice_number", "same_amount_date"]);
  });

  it("returns no match for unrelated bills", () => {
    const r = classifyDuplicates(candidate, [bill(), bill({ id: "bill-2", supplierId: "supplier-2", billNumber: "INV-0041", totalAmount: 106, billDate: "2026-09-30" })], [doc({ fileSha256: "c".repeat(64) })]);
    assert.deepEqual(r, { decision: "create_draft", matches: [], flags: [] });
  });

  it("does not use supplier-based signals when the supplier is unknown", () => {
    const r = classifyDuplicates({ ...candidate, supplierId: null }, [bill({ billNumber: "INV-0041", totalAmount: 106, billDate: "2026-09-30" })], []);
    assert.equal(r.matches.length, 0);
  });

  it("ignores zero or missing amounts for the amount/date signal", () => {
    assert.equal(classifyDuplicates({ ...candidate, invoiceNumber: null, totalAmount: 0 }, [bill({ totalAmount: 0, billDate: "2026-09-30" })], []).matches.length, 0);
    assert.equal(classifyDuplicates({ ...candidate, invoiceNumber: null, totalAmount: null }, [bill()], []).matches.length, 0);
  });

  it("does not report supplier signals across entities", () => {
    const r = classifyDuplicates(candidate, [bill({ entityId: OTHER_ENTITY, billNumber: "INV-0041" })], []);
    assert.equal(r.matches.length, 0);
  });

  it("normalizes invoice numbers", () => {
    assert.equal(normalizeInvoiceNumber(" inv-0041/A "), "INV0041A");
    assert.equal(normalizeInvoiceNumber("-"), null);
    assert.equal(normalizeInvoiceNumber(null), null);
  });
});
