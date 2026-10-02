import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sha256Hex } from "../auth";
import { buildDraftBillProposal, canVerifyIntake, canonicalJson, computePayloadHash, sniffMime, verificationBlockers, verifyDocumentBytes, type VerificationState } from "../intake";
import { parseBillIntake, type FinanceOpsBillIntake } from "../schema";
import type { CategoryMatch, SupplierMatch } from "../supplier-match";

const PDF = new TextEncoder().encode("%PDF-1.7\nfake");
const PDF_SHA = sha256Hex(PDF);

function intake(over: Record<string, unknown> = {}, invoice: Record<string, unknown> = {}): FinanceOpsBillIntake {
  const r = parseBillIntake({
    intake_id: "fo_bill_01JABCDEF",
    source: { channel: "telegram", chat_id: "1", message_id: "2", received_at: "2026-10-02T03:04:05Z" },
    entity_code: "IEA",
    supplier: { name: "Mega Supplies", registration_number: null },
    invoice: { number: "INV-1", date: "2026-09-30", due_date: "2026-10-30", currency: "MYR", subtotal: 100, tax_amount: 6, total_amount: 106, description: "Stationery", ...invoice },
    extraction: { agent: "a", version: "1", overall_confidence: 0.95, fields: {} },
    document: { sha256: PDF_SHA, mime_type: "application/pdf", filename: "a.pdf" },
    ...over,
  });
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

const EXACT: SupplierMatch = { status: "exact", supplierId: "s1", candidates: [] };
const CAT: CategoryMatch = { status: "exact", categoryId: "c1" };

describe("draft bill proposal", () => {
  it("builds a draft with every FinanceOps-forbidden state fixed", () => {
    const r = buildDraftBillProposal(intake(), EXACT, CAT);
    assert.equal(r.kind, "draft");
    if (r.kind !== "draft") return;
    assert.equal(r.proposal.bill.payment_status, "draft");
    assert.equal(r.proposal.bill.supporting_document_status, "no_document");
    assert.equal(r.proposal.bill.data_origin, "imported");
    assert.equal(r.proposal.bill.supplier_id, "s1");
    assert.equal(r.proposal.bill.outstanding_amount, 106);
    assert.deepEqual(r.proposal.flags, []);
    assert.ok(!("created_by" in r.proposal.bill) && !("entity_id" in r.proposal.bill));
  });

  it("uses bill_date as a flagged placeholder when the due date is missing (D5)", () => {
    const r = buildDraftBillProposal(intake({}, { due_date: null }), EXACT, CAT);
    assert.equal(r.kind, "draft");
    if (r.kind !== "draft") return;
    assert.equal(r.proposal.bill.due_date, "2026-09-30");
    assert.ok(r.proposal.flags.includes("due_date_missing"));
  });

  it("flags missing amount, number, description and unresolved supplier/category without inventing data", () => {
    const sparse = intake({ supplier: { name: null, registration_number: null } }, { number: null, date: null, due_date: null, subtotal: null, tax_amount: null, total_amount: null, description: null, currency: null });
    const r = buildDraftBillProposal(sparse, { status: "none", supplierId: null, candidates: [] }, { status: "none", categoryId: null });
    assert.equal(r.kind, "draft");
    if (r.kind !== "draft") return;
    for (const f of ["bill_date_missing", "due_date_missing", "amount_missing", "invoice_number_missing", "description_inferred", "currency_assumed", "supplier_unmatched", "category_unmatched"]) {
      assert.ok(r.proposal.flags.includes(f), f);
    }
    assert.equal(r.proposal.bill.total_amount, 0);
    assert.equal(r.proposal.bill.supplier_id, null);
    assert.equal(r.proposal.bill.bill_date, "2026-10-02");
  });

  it("never assigns a supplier or category from an ambiguous match", () => {
    const r = buildDraftBillProposal(intake(), { status: "candidates", supplierId: null, candidates: [{ supplierId: "a", name: "A", score: 0.7, reason: "name_similar" }] }, { status: "candidates", categoryId: null, candidates: [] });
    assert.equal(r.kind === "draft" && r.proposal.bill.supplier_id, null);
    assert.equal(r.kind === "draft" && r.proposal.bill.expense_category_id, null);
    assert.ok(r.kind === "draft" && r.proposal.flags.includes("supplier_ambiguous") && r.proposal.flags.includes("category_ambiguous"));
  });

  it("sends an uncertain entity to human review instead of guessing", () => {
    const r = buildDraftBillProposal(intake({ entity_code: null }), EXACT, CAT);
    assert.deepEqual(r, { kind: "needs_human_review", reason: "entity_unresolved", flags: ["entity_unresolved"] });
  });

  it("flags arithmetic mismatch and low confidence", () => {
    const r = buildDraftBillProposal(intake({ extraction: { agent: "a", version: "1", overall_confidence: 0.5, fields: { total_amount: { value: 999, confidence: 0.4 } } } }, { total_amount: 999 }), EXACT, CAT);
    assert.ok(r.kind === "draft" && r.proposal.flags.includes("amount_mismatch"));
    assert.ok(r.kind === "draft" && r.proposal.flags.includes("low_confidence:total_amount"));
    assert.ok(r.kind === "draft" && r.proposal.flags.includes("low_confidence:overall"));
  });
});

describe("payload hash and file verification", () => {
  it("canonical JSON is key-order independent", () => {
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: null }] }), canonicalJson({ a: [2, { c: null, d: 1 }], b: 1 }));
  });

  it("hash is stable for retries and changes with content", () => {
    const a = computePayloadHash(intake(), PDF_SHA);
    assert.equal(a, computePayloadHash(intake(), PDF_SHA.toUpperCase()));
    assert.notEqual(a, computePayloadHash(intake({}, { total_amount: 107 }), PDF_SHA));
    assert.notEqual(a, computePayloadHash(intake(), "0".repeat(64)));
  });

  it("verifies bytes, content type and declared hash", () => {
    assert.deepEqual(verifyDocumentBytes(PDF, { sha256: PDF_SHA, mimeType: "application/pdf", uploadedMimeType: "application/pdf" }), { ok: true, sha256: PDF_SHA });
    assert.deepEqual(verifyDocumentBytes(PDF, { sha256: "0".repeat(64), mimeType: "application/pdf", uploadedMimeType: "application/pdf" }), { ok: false, code: "document_hash_mismatch" });
    assert.deepEqual(verifyDocumentBytes(PDF, { sha256: PDF_SHA, mimeType: "image/png", uploadedMimeType: "image/png" }), { ok: false, code: "content_type_mismatch" });
    const exe = new TextEncoder().encode("MZ-not-a-document");
    assert.deepEqual(verifyDocumentBytes(exe, { sha256: sha256Hex(exe), mimeType: "application/pdf", uploadedMimeType: "application/pdf" }), { ok: false, code: "unrecognised_file_content" });
  });

  it("sniffs supported types", () => {
    assert.equal(sniffMime(PDF), "application/pdf");
    assert.equal(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
    assert.equal(sniffMime(new Uint8Array([1, 2, 3])), null);
  });
});

describe("human verification rules", () => {
  const base: VerificationState = {
    flags: [],
    confirmed: { dueDate: false, amount: false, supplier: false, entity: false },
    current: { supplierId: "s1", totalAmount: 106, entityId: "e1", hasDocument: true },
    duplicatesAcknowledged: false,
  };

  it("allows verification of a clean intake", () => {
    assert.deepEqual(verificationBlockers(base), []);
  });

  it("blocks Mark Verified while the due date is only a placeholder (D5)", () => {
    assert.equal(verificationBlockers({ ...base, flags: ["due_date_missing"] }).length, 1);
    assert.deepEqual(verificationBlockers({ ...base, flags: ["due_date_missing"], confirmed: { ...base.confirmed, dueDate: true } }), []);
  });

  it("blocks on missing amount, supplier, document, entity and unacknowledged duplicates", () => {
    assert.ok(verificationBlockers({ ...base, current: { ...base.current, totalAmount: 0 } }).length > 0);
    assert.ok(verificationBlockers({ ...base, current: { ...base.current, supplierId: null } }).length > 0);
    assert.ok(verificationBlockers({ ...base, current: { ...base.current, hasDocument: false } }).length > 0);
    assert.ok(verificationBlockers({ ...base, current: { ...base.current, entityId: null } }).length > 0);
    assert.equal(verificationBlockers({ ...base, flags: ["possible_duplicate_invoice_number"] }).length, 1);
    assert.deepEqual(verificationBlockers({ ...base, flags: ["possible_duplicate_invoice_number"], duplicatesAcknowledged: true }), []);
  });

  it("enforces four-eyes: the creating identity can never verify", () => {
    assert.equal(canVerifyIntake("intern", "financeops"), true);
    assert.equal(canVerifyIntake("financeops", "financeops"), false);
    assert.equal(canVerifyIntake(null, "financeops"), false);
    assert.equal(canVerifyIntake("intern", null), false);
  });
});
