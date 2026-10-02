import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allowedReviewTargets,
  canResolveEntity,
  canReviewIntakeData,
  canViewIntakeQueue,
  extractedFromPayload,
  groupOf,
  validateResolution,
  type ReviewContext,
} from "../review";
import { evaluateFinanceOpsVerifyGate, FINANCEOPS_GATE_UNAVAILABLE, FINANCEOPS_NOT_DATA_VERIFIED } from "../gate";
import { canVerifyBills } from "../../bill-verification";

const FO = "f0f0f0f0-0000-4000-8000-000000000001";
const STAFF = "55555555-5555-4555-8555-555555555555";
const ctx = (over: Partial<ReviewContext> = {}): ReviewContext => ({ role: "finance_staff", actorUserId: STAFF, createdByUserId: FO, entityResolved: true, processState: "complete", reviewStatus: "pending_review", ...over });

describe("13/14: Resolve Entity is for Owner, Finance Manager and Finance Staff only", () => {
  it("is offered to the three finance roles", () => {
    for (const role of ["owner", "finance_manager", "finance_staff"]) assert.equal(canResolveEntity(role), true, role);
  });
  it("is hidden from FinanceOps, the data_entry intern, management and every other role", () => {
    for (const role of ["data_entry", "management", "read_only", "branch_manager", "counsellor", "marketing", "student_services", "trainer", null, undefined, "", "OWNER", "admin"]) {
      assert.equal(canResolveEntity(role as string | null | undefined), false, String(role));
    }
  });
  it("the queue itself is visible to finance, data entry and management (read-only) but not to student-side roles", () => {
    for (const role of ["owner", "finance_manager", "finance_staff", "data_entry", "management"]) assert.equal(canViewIntakeQueue(role), true, role);
    for (const role of ["read_only", "counsellor", "marketing", "trainer", null]) assert.equal(canViewIntakeQueue(role as string | null), false, String(role));
  });
  it("a resolution needs exactly one approved entity and a real note", () => {
    assert.deepEqual(validateResolution({ entityCode: "iea", note: "  Billed to Inter-Excel Advisory  " }), { ok: true, entityCode: "IEA", note: "Billed to Inter-Excel Advisory" });
    for (const code of ["PLC", "IETA", "KALER"]) assert.equal(validateResolution({ entityCode: code, note: "per invoice header" }).ok, true, code);
    assert.equal(validateResolution({ entityCode: "", note: "per invoice header" }).ok, false);
    assert.equal(validateResolution({ entityCode: "PREMIER", note: "per invoice header" }).ok, false); // Premier is PLC
    assert.equal(validateResolution({ entityCode: "IEA,PLC", note: "per invoice header" }).ok, false);
    assert.equal(validateResolution({ entityCode: "IEA", note: "  " }).ok, false);
    assert.equal(validateResolution({ entityCode: "IEA", note: "ab" }).ok, false);
    assert.equal(validateResolution({ entityCode: "IEA", note: "x".repeat(1001) }).ok, false);
  });
});

describe("15/16: who can move an intake to Data Verified (mirrors the 0023 trigger; the database stays authoritative)", () => {
  it("15: the FinanceOps identity (the creator) is offered no review action at all", () => {
    for (const role of ["data_entry", "finance_staff", "owner"]) assert.deepEqual(allowedReviewTargets(ctx({ role, actorUserId: FO })), [], role);
  });
  it("16: a different human reviewer may mark a complete intake data_verified, rejected, needs_attention or duplicate_suspected", () => {
    for (const role of ["finance_staff", "finance_manager", "owner", "data_entry"]) {
      assert.deepEqual(allowedReviewTargets(ctx({ role })), ["data_verified", "rejected", "needs_attention", "duplicate_suspected"], role);
    }
  });
  it("data_verified is not offered until the draft bill and document are attached (process_state complete)", () => {
    for (const processState of ["received", "bill_created", "document_attached"]) {
      assert.equal(allowedReviewTargets(ctx({ processState })).includes("data_verified"), false, processState);
      assert.equal(allowedReviewTargets(ctx({ processState, reviewStatus: "needs_attention" })).includes("data_verified"), false, processState);
    }
  });
  it("terminal states are frozen", () => {
    for (const reviewStatus of ["data_verified", "rejected"] as const) assert.deepEqual(allowedReviewTargets(ctx({ reviewStatus })), []);
  });
  it("transitions follow the database: duplicate_suspected can only return to pending or be rejected", () => {
    assert.deepEqual(allowedReviewTargets(ctx({ reviewStatus: "duplicate_suspected" })), ["pending_review", "rejected"]);
    assert.deepEqual(allowedReviewTargets(ctx({ reviewStatus: "needs_attention" })), ["pending_review", "data_verified", "rejected"]);
  });
  it("an unresolved intake can only be rejected, and only by the central finance-review set (never data_verified)", () => {
    assert.deepEqual(allowedReviewTargets(ctx({ entityResolved: false, processState: "awaiting_entity" })), ["rejected"]);
    assert.deepEqual(allowedReviewTargets(ctx({ entityResolved: false, processState: "awaiting_entity", role: "data_entry" })), []);
    assert.deepEqual(allowedReviewTargets(ctx({ entityResolved: false, processState: "awaiting_entity", role: "management" })), []);
  });
  it("roles outside the review set, signed-out users and unknown creators get nothing", () => {
    for (const role of ["management", "read_only", "counsellor", null]) assert.deepEqual(allowedReviewTargets(ctx({ role: role as string | null })), [], String(role));
    assert.deepEqual(allowedReviewTargets(ctx({ actorUserId: null })), []);
    assert.deepEqual(allowedReviewTargets(ctx({ createdByUserId: null })), []);
  });
  it("Data Verified review does not widen who may release a bill: only owner / finance_manager / finance_staff can (Stage 1B)", () => {
    assert.equal(canVerifyBills("data_entry"), false);
    assert.equal(canVerifyBills("management"), false);
    for (const role of ["owner", "finance_manager", "finance_staff"]) assert.equal(canVerifyBills(role), true, role);
    assert.equal(canReviewIntakeData("data_entry"), true); // the intern checks data (D2) ...
    assert.equal(canVerifyBills("data_entry"), false); // ... but still cannot release a bill
  });
});

describe("queue grouping and display", () => {
  it("groups by what needs doing", () => {
    assert.equal(groupOf({ entity_id: null, review_status: "pending_review" }), "needs_entity");
    assert.equal(groupOf({ entity_id: null, review_status: "pending_review", is_superseded: true }), "superseded");
    assert.equal(groupOf({ entity_id: "e", review_status: "pending_review" }), "in_review");
    assert.equal(groupOf({ entity_id: "e", review_status: "needs_attention" }), "in_review");
    assert.equal(groupOf({ entity_id: "e", review_status: "data_verified" }), "done");
    assert.equal(groupOf({ entity_id: null, review_status: "rejected" }), "done");
  });
  it("reads what FinanceOps extracted from the stored payload for display only", () => {
    const fields = extractedFromPayload(
      { supplier: { name: "Mega" }, invoice: { number: "INV-1", date: "2026-09-30", due_date: null, total_amount: 106, currency: "MYR" }, extraction: { fields: { supplier_name: { value: "Mega", confidence: 0.55 } } } },
      ["due_date_missing"],
    );
    const by = Object.fromEntries(fields.map((f) => [f.label, f]));
    assert.equal(by["Supplier"].value, "Mega");
    assert.equal(by["Supplier"].confidence, 0.55);
    assert.equal(by["Total amount"].value, "MYR 106.00");
    assert.equal(by["Due date"].value, null);
    assert.equal(by["Due date"].flag, "due_date_missing");
    assert.doesNotThrow(() => extractedFromPayload(null, []));
    assert.doesNotThrow(() => extractedFromPayload("junk", []));
  });
});

describe("17/18/19: Q5 application gate (draft -> unpaid for FinanceOps-origin bills)", () => {
  it("19: a bill with no FinanceOps intake is unaffected (normal Stage 1B behaviour)", () => {
    assert.deepEqual(evaluateFinanceOpsVerifyGate({ error: null, rows: [] }), { allow: true, financeopsLinked: false });
    assert.deepEqual(evaluateFinanceOpsVerifyGate({ error: undefined, rows: null }), { allow: true, financeopsLinked: false });
  });
  it("17: a FinanceOps-linked bill is blocked until its intake is data_verified", () => {
    for (const review_status of ["pending_review", "needs_attention", "duplicate_suspected", "rejected", null, undefined, "weird"]) {
      const d = evaluateFinanceOpsVerifyGate({ error: null, rows: [{ review_status }] });
      assert.equal(d.allow, false, String(review_status));
      if (!d.allow) {
        assert.equal(d.status, 409);
        assert.equal(d.error, FINANCEOPS_NOT_DATA_VERIFIED);
        assert.match(d.message, /Data Verified/);
      }
    }
  });
  it("18: once the intake is data_verified the release is allowed (Finance Staff+ is still enforced by the route and the database)", () => {
    assert.deepEqual(evaluateFinanceOpsVerifyGate({ error: null, rows: [{ review_status: "data_verified" }] }), { allow: true, financeopsLinked: true });
  });
  it("fails closed when the lookup itself fails: cannot tell if the bill is FinanceOps-linked, so no release", () => {
    const d = evaluateFinanceOpsVerifyGate({ error: "permission denied", rows: null });
    assert.equal(d.allow, false);
    if (!d.allow) {
      assert.equal(d.status, 500);
      assert.equal(d.error, FINANCEOPS_GATE_UNAVAILABLE);
    }
    // an error wins over rows that look fine
    assert.equal(evaluateFinanceOpsVerifyGate({ error: "boom", rows: [{ review_status: "data_verified" }] }).allow, false);
  });
  it("any non-verified row among several blocks (belt and braces; the database allows only one intake per bill)", () => {
    assert.equal(evaluateFinanceOpsVerifyGate({ error: null, rows: [{ review_status: "data_verified" }, { review_status: "pending_review" }] }).allow, false);
  });
});
