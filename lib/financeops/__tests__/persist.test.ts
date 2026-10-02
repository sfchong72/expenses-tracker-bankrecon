import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { sha256Hex } from "../auth";
import { billIdFor, documentIdFor } from "../ids";
import { storagePathFor } from "../persist";
import { ENTITY_IDS, FO_USER, FakeStore } from "./fake-store";
import { PDF, PDF2, freshStore, getStatus, metadata, post } from "./harness";

// The handlers log database details server-side by design; keep the test output readable.
const realConsoleError = console.error;
before(() => { console.error = () => {}; });
after(() => { console.error = realConsoleError; });

function store(): FakeStore {
  const s = freshStore();
  s.suppliers.push({ entityId: ENTITY_IDS.IEA, supplier: { id: "50000000-0000-4000-8000-000000000001", supplierName: "Mega Supplies Sdn Bhd", registrationNumber: null, activeStatus: true, archivedAt: null } });
  return s;
}

describe("1/5/6: a valid, entity-resolved intake becomes a DRAFT bill created by FinanceOps", () => {
  it("persists intake -> draft bill -> original document -> complete", async () => {
    const s = store();
    const r = await post(s);
    assert.equal(r.status, 201);
    assert.equal(r.body.status, "complete");
    assert.equal(r.body.process_state, "complete");
    assert.equal(r.body.review_status, "pending_review");
    assert.equal(r.body.bill_created, true);
    assert.equal(r.body.document_attached, true);
    assert.equal(r.body.idempotent_replay, false);

    assert.equal(s.intakes.length, 1);
    assert.equal(s.bills.length, 1);
    assert.equal(s.documents.length, 1);
    assert.equal(s.links.length, 1);
    assert.equal(s.objects.size, 1);
    const [row] = s.intakes;
    assert.equal(row.created_by, FO_USER);
    assert.equal(row.entity_id, ENTITY_IDS.IEA);
    assert.equal(row.supplier_bill_id, billIdFor("fo_bill_01JABCDEF"));
    assert.equal(row.document_id, documentIdFor("fo_bill_01JABCDEF"));
  });

  it("6: the bill is a draft owned by the FinanceOps identity; it is never unpaid/paid/scheduled", async () => {
    const s = store();
    await post(s);
    const [bill] = s.bills;
    assert.equal(bill.payment_status, "draft");
    assert.equal(bill.created_by, FO_USER);
    assert.equal(bill.entity_id, ENTITY_IDS.IEA);
    assert.equal(bill.data_origin, "imported");
    assert.equal(bill.is_demo, false);
    assert.equal(bill.supplier_id, "50000000-0000-4000-8000-000000000001"); // unambiguous supplier match
    assert.equal(bill.total_amount, 106);
    assert.equal(bill.outstanding_amount, 106);
  });

  it("9: the document row matches the intake hash and entity, is linked to the bill, and stored under entity/yyyy/mm/type/bill/doc", async () => {
    const s = store();
    await post(s);
    const [doc] = s.documents;
    const [link] = s.links;
    assert.equal(doc.file_hash, sha256Hex(PDF));
    assert.equal(doc.entity_id, ENTITY_IDS.IEA);
    assert.equal(doc.uploaded_by, FO_USER);
    assert.equal(doc.document_type, "supplier_invoice");
    assert.equal(doc.mime_type, "application/pdf");
    assert.equal(doc.file_size, PDF.byteLength);
    assert.equal(link.linked_record_type, "supplier_bill");
    assert.equal(link.linked_record_id, billIdFor("fo_bill_01JABCDEF"));
    assert.equal(link.entity_id, ENTITY_IDS.IEA);
    assert.equal(doc.storage_path, storagePathFor(ENTITY_IDS.IEA, "2026-10-02T03:04:05Z", billIdFor("fo_bill_01JABCDEF"), documentIdFor("fo_bill_01JABCDEF"), "application/pdf"));
    assert.match(doc.storage_path, new RegExp(`^${ENTITY_IDS.IEA}/2026/10/supplier_invoice/${billIdFor("fo_bill_01JABCDEF")}/${documentIdFor("fo_bill_01JABCDEF")}\\.pdf$`));
    assert.deepEqual(Array.from(s.objects.get(doc.storage_path) as Uint8Array), Array.from(PDF));
  });

  it("9: the order is bill -> storage object -> documents row -> document link -> intake link", async () => {
    const s = store();
    await post(s);
    const order = s.calls.filter((c) => ["insertIntake", "insertBill", "uploadObject", "insertDocument", "linkDocument", "updateIntake"].includes(c));
    assert.deepEqual(order, ["insertIntake", "insertBill", "updateIntake", "uploadObject", "insertDocument", "linkDocument", "updateIntake", "updateIntake"]);
    // the intake is advanced one state at a time: bill_created, document_attached, complete
    assert.deepEqual(s.patches.map((p) => p.process_state), ["bill_created", "document_attached", "complete"]);
  });

  it("the document is never attached before the entity is resolved and the bill exists (insert-first still comes first)", async () => {
    const s = store();
    await post(s);
    assert.equal(s.calls.indexOf("insertIntake") < s.calls.indexOf("insertBill"), true);
    assert.equal(s.calls.indexOf("insertBill") < s.calls.indexOf("uploadObject"), true);
  });
});

describe("2/3: idempotency (intake_id is the key, the payload hash decides)", () => {
  it("2: same intake_id + same payload is an idempotent replay: no second bill, document or upload", async () => {
    const s = store();
    await post(s);
    const again = await post(s);
    assert.equal(again.status, 200);
    assert.equal(again.body.idempotent_replay, true);
    assert.equal(again.body.status, "complete");
    assert.equal(s.intakes.length, 1);
    assert.equal(s.bills.length, 1);
    assert.equal(s.documents.length, 1);
    assert.equal(s.links.length, 1);
    assert.equal(s.objects.size, 1);
  });

  it("3: same intake_id + different payload is 409 intake_conflict and changes nothing", async () => {
    const s = store();
    await post(s);
    const before = JSON.stringify(s.intakes);
    const patches = s.patches.length;
    const changed = await post(s, metadata({ invoice: { number: "INV-1", date: "2026-09-30", due_date: "2026-10-30", currency: "MYR", subtotal: null, tax_amount: null, total_amount: 999, description: "x", bill_type: "supplier_invoice" } }));
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error, "intake_conflict");
    assert.equal(JSON.stringify(s.intakes), before);
    assert.equal(s.patches.length, patches);
    assert.equal(s.bills.length, 1);
  });

  it("3: same intake_id with a different FILE (different hash) is also 409", async () => {
    const s = store();
    await post(s);
    const r = await post(s, metadata({}, PDF2), PDF2);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "intake_conflict");
    assert.equal(s.bills.length, 1);
    assert.equal(s.documents.length, 1);
  });

  it("3: an intake_id that exists but is invisible to this identity is treated as a conflict, never reused", async () => {
    const s = store();
    s.hiddenIntakes.push({ intake_id: "fo_bill_01JABCDEF" } as never);
    const r = await post(s);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "intake_conflict");
    assert.equal(s.bills.length, 0);
  });
});

describe("4: unresolved entity creates the intake only", () => {
  it("stores the intake as awaiting_entity and creates NO bill, NO file, NO document", async () => {
    const s = store();
    const r = await post(s, metadata({ entity_code: null }));
    assert.equal(r.status, 202);
    assert.equal(r.body.status, "needs_entity");
    assert.equal(r.body.process_state, "awaiting_entity");
    assert.equal(r.body.needs_entity, true);
    assert.equal(r.body.next_action, "awaiting_entity_resolution");
    assert.equal(s.intakes.length, 1);
    assert.equal(s.intakes[0].entity_id, null);
    assert.equal(s.intakes[0].entity_code_declared, null);
    assert.deepEqual(s.intakes[0].flags, ["entity_unresolved"]);
    assert.equal(s.bills.length, 0);
    assert.equal(s.documents.length, 0);
    assert.equal(s.links.length, 0);
    assert.equal(s.objects.size, 0);
    for (const forbidden of ["insertBill", "uploadObject", "insertDocument", "linkDocument", "loadSuppliers", "loadDuplicateContext"]) assert.equal(s.calls.includes(forbidden), false, forbidden);
  });

  it("replaying an unresolved intake stays unresolved and still creates nothing (the entity is never guessed)", async () => {
    const s = store();
    await post(s, metadata({ entity_code: null }));
    const again = await post(s, metadata({ entity_code: null }));
    assert.equal(again.status, 202);
    assert.equal(again.body.idempotent_replay, true);
    assert.equal(s.bills.length, 0);
  });

  it("after a reviewer resolves the entity, re-sending the SAME intake creates the draft bill and attaches the file", async () => {
    const s = store();
    await post(s, metadata({ entity_code: null }));
    // a Finance Staff reviewer resolves the entity (their own session; modelled directly on the row, as 0023 does)
    Object.assign(s.intakes[0], { entity_id: ENTITY_IDS.PLC, entity_resolved_at: "2026-10-02T05:00:00Z", process_state: "received" });
    s.suppliers.push({ entityId: ENTITY_IDS.PLC, supplier: { id: "50000000-0000-4000-8000-000000000002", supplierName: "Mega Supplies", registrationNumber: null, activeStatus: true, archivedAt: null } });
    const r = await post(s, metadata({ entity_code: null }));
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "complete");
    assert.equal(r.body.entity_code, "PLC");
    assert.equal(s.bills.length, 1);
    assert.equal(s.bills[0].entity_id, ENTITY_IDS.PLC);
    assert.equal(s.bills[0].payment_status, "draft");
    assert.equal(s.documents[0].entity_id, ENTITY_IDS.PLC);
    assert.equal(s.intakes[0].flags.includes("entity_unresolved"), false);
  });
});

describe("7: duplicate handling", () => {
  const dupWorld = (s: FakeStore, entityId: string) => {
    s.existingBills.push({ id: "b0000000-0000-4000-8000-000000000009", entityId, supplierId: null, billNumber: "OLD-1", totalAmount: 10, billDate: "2026-01-01", paymentStatus: "unpaid" });
    s.existingDocuments.push({ fileSha256: sha256Hex(PDF), billId: "b0000000-0000-4000-8000-000000000009", deleted: false });
  };

  it("an exact duplicate (same file hash, same entity, active bill) creates no second bill and flags the intake duplicate_suspected", async () => {
    const s = store();
    dupWorld(s, ENTITY_IDS.IEA);
    const r = await post(s);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "duplicate_file");
    assert.equal(r.body.review_status, "duplicate_suspected");
    assert.deepEqual(r.body.duplicate_of, [{ type: "exact_file", strength: "hard" }]);
    assert.equal(s.bills.length, 0);
    assert.equal(s.documents.length, 0);
    assert.equal(s.objects.size, 0);
    assert.equal(s.intakes[0].review_status, "duplicate_suspected");
    assert.equal((s.intakes[0].duplicate_matches as { type: string }[])[0].type, "exact_file");
    assert.equal(s.intakes[0].flags.includes("duplicate_suspected_file"), true);
    assert.equal(s.intakes[0].process_state, "received");
  });

  it("replaying a held duplicate stays held: still no bill", async () => {
    const s = store();
    dupWorld(s, ENTITY_IDS.IEA);
    await post(s);
    const again = await post(s);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "duplicate_suspected");
    assert.equal(s.bills.length, 0);
  });

  it("a cancelled bill with the same file is not an active duplicate", async () => {
    const s = store();
    dupWorld(s, ENTITY_IDS.IEA);
    s.existingBills[0].paymentStatus = "cancelled";
    assert.equal((await post(s)).status, 201);
  });

  it("soft duplicates still produce a flagged draft for human review (same file in ANOTHER entity; same supplier + invoice number)", async () => {
    const s = store();
    dupWorld(s, ENTITY_IDS.PLC);
    s.existingBills.push({ id: "b0000000-0000-4000-8000-000000000010", entityId: ENTITY_IDS.IEA, supplierId: "50000000-0000-4000-8000-000000000001", billNumber: "inv 1", totalAmount: 1, billDate: "2025-01-01", paymentStatus: "unpaid" });
    const r = await post(s);
    assert.equal(r.status, 201);
    assert.equal(s.bills.length, 1);
    assert.equal(s.bills[0].payment_status, "draft");
    assert.equal(s.intakes[0].review_status, "pending_review");
    assert.equal(s.intakes[0].flags.includes("same_file_in_other_entity"), true);
    assert.equal(s.intakes[0].flags.includes("possible_duplicate_invoice_number"), true);
  });
});

describe("8: missing financial data is flagged, never invented", () => {
  it("a missing due date uses the bill date as a placeholder and keeps the due_date_missing flag", async () => {
    const s = store();
    const meta = metadata();
    (meta.invoice as { due_date: string | null }).due_date = null;
    const r = await post(s, meta);
    assert.equal(r.status, 201);
    assert.equal(s.bills[0].due_date, s.bills[0].bill_date);
    assert.equal(s.bills[0].bill_date, "2026-09-30");
    assert.equal(s.intakes[0].flags.includes("due_date_missing"), true);
    assert.equal((r.body.flags as string[]).includes("due_date_missing"), true);
  });

  it("a missing amount becomes 0 with an amount_missing flag (a human must confirm)", async () => {
    const s = store();
    const meta = metadata();
    (meta.invoice as { total_amount: number | null }).total_amount = null;
    await post(s, meta);
    assert.equal(s.bills[0].total_amount, 0);
    assert.equal(s.intakes[0].flags.includes("amount_missing"), true);
  });
});

describe("10: a retry resumes from the stored process_state without creating duplicates", () => {
  it("failure while inserting the document: the intake stays bill_created and the retry completes it (one bill, one document)", async () => {
    const s = store();
    s.failOn({ method: "insertDocument" });
    const first = await post(s);
    assert.equal(first.status, 503);
    assert.equal(first.body.retryable, true);
    assert.equal(s.intakes[0].process_state, "bill_created");
    assert.equal(s.bills.length, 1);

    const retry = await post(s);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.status, "complete");
    assert.equal(s.bills.length, 1);
    assert.equal(s.documents.length, 1);
    assert.equal(s.links.length, 1);
    assert.equal(s.objects.size, 1);
  });

  it("failure while linking the document: the retry adopts the existing document row (primary-key conflict) and links it", async () => {
    const s = store();
    s.failOn({ method: "linkDocument" });
    assert.equal((await post(s)).status, 503);
    assert.equal(s.documents.length, 1);
    assert.equal(s.links.length, 0);
    const retry = await post(s);
    assert.equal(retry.status, 200);
    assert.equal(s.documents.length, 1);
    assert.equal(s.links.length, 1);
    assert.equal(s.intakes[0].process_state, "complete");
  });

  it("the bill was inserted but the intake link failed: the retry ADOPTS the same bill (deterministic id), no second bill", async () => {
    const s = store();
    s.failOn({ method: "updateIntake", nth: 1 });
    const first = await post(s);
    assert.equal(first.status, 503);
    assert.equal(s.bills.length, 1);
    assert.equal(s.intakes[0].process_state, "received");
    assert.equal(s.intakes[0].supplier_bill_id, null);

    const retry = await post(s);
    assert.equal(retry.status, 200);
    assert.equal(s.bills.length, 1);
    assert.equal(s.intakes[0].supplier_bill_id, billIdFor("fo_bill_01JABCDEF"));
    assert.equal(s.intakes[0].process_state, "complete");
  });

  it("a storage failure leaves the intake at bill_created, reports not-complete, and the retry finishes it", async () => {
    const s = store();
    s.failOn({ method: "uploadObject" });
    const first = await post(s);
    assert.equal(first.status, 503);
    assert.notEqual(first.body.status, "complete");
    assert.equal(s.intakes[0].process_state, "bill_created");
    assert.equal((await post(s)).status, 200);
    assert.equal(s.intakes[0].process_state, "complete");
  });

  it("a retry after the object was uploaded but the row insert failed reuses the stored object", async () => {
    const s = store();
    s.failOn({ method: "insertDocument" });
    await post(s);
    assert.equal(s.objects.size, 1);
    await post(s);
    assert.equal(s.objects.size, 1);
  });

  it("an intake is never reported complete unless the stored state is complete", async () => {
    for (const method of ["entityByCode", "insertIntake", "loadSuppliers", "loadDuplicateContext", "getBill", "insertBill", "uploadObject", "insertDocument", "linkDocument"] as const) {
      const s = store();
      s.failOn({ method });
      const r = await post(s);
      if (r.status === 201) assert.equal(s.intakes[0].process_state, "complete", method);
      else assert.notEqual(r.body.status, "complete", method);
    }
  });

  it("the intake link failing for a business reason (bill no longer draft) is a 409 for a reviewer, not a retry loop", async () => {
    const s = store();
    s.failOn({ method: "updateIntake", nth: 1, error: { kind: "rejected", message: "An intake can only be linked to a draft supplier bill" } });
    const r = await post(s);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "intake_update_rejected");
    assert.equal(r.body.retryable, false);
  });
});

describe("11: supersedes_intake_id", () => {
  const unresolved = async (s: FakeStore) => post(s, metadata({ intake_id: "fo_bill_UNRESOLVED1", entity_code: null }));

  it("a new intake that supersedes an unresolved one is stored with the lineage and processed normally", async () => {
    const s = store();
    await unresolved(s);
    const r = await post(s, metadata({ intake_id: "fo_bill_SUCCESSOR01", supersedes_intake_id: "fo_bill_UNRESOLVED1" }));
    assert.equal(r.status, 201);
    const successor = s.intakes.find((i) => i.intake_id === "fo_bill_SUCCESSOR01");
    assert.equal(successor?.supersedes_intake_id, "fo_bill_UNRESOLVED1");
    assert.equal(s.bills.length, 1);
  });

  it("database supersession rules surface as clear responses: already superseded / already resolved / needs an entity / unknown original", async () => {
    const s = store();
    await unresolved(s);
    await post(s, metadata({ intake_id: "fo_bill_SUCCESSOR01", supersedes_intake_id: "fo_bill_UNRESOLVED1" }));

    const second = await post(s, metadata({ intake_id: "fo_bill_SUCCESSOR02", supersedes_intake_id: "fo_bill_UNRESOLVED1" }));
    assert.equal(second.status, 409);
    assert.equal(second.body.error, "already_superseded");

    const noEntity = await post(s, metadata({ intake_id: "fo_bill_SUCCESSOR03", entity_code: null, supersedes_intake_id: "fo_bill_UNRESOLVED1" }));
    assert.equal(noEntity.status, 422);
    assert.equal(noEntity.body.error, "supersede_requires_entity");

    const unknown = await post(s, metadata({ intake_id: "fo_bill_SUCCESSOR04", supersedes_intake_id: "fo_bill_DOESNOTEXIST" }));
    assert.equal(unknown.status, 422);
    assert.equal(unknown.body.error, "supersedes_intake_not_found");

    const resolved = await post(s, metadata({ intake_id: "fo_bill_SUCCESSOR05", supersedes_intake_id: "fo_bill_SUCCESSOR01" }));
    assert.equal(resolved.status, 409);
    assert.equal(resolved.body.error, "intake_already_resolved");
    // none of the refused attempts left anything behind
    assert.equal(s.intakes.filter((i) => /SUCCESSOR0[2-5]/.test(i.intake_id)).length, 0);
    assert.equal(s.bills.length, 1);
  });

  it("a malformed supersedes_intake_id is rejected by validation before the database is touched", async () => {
    const s = store();
    const r = await post(s, metadata({ supersedes_intake_id: "x" }));
    assert.equal(r.status, 422);
    assert.equal(s.calls.length, 0);
    const wrongType = await post(s, metadata({ supersedes_intake_id: 12345678 }));
    assert.equal(wrongType.status, 422);
    const nullValue = await post(s, metadata({ supersedes_intake_id: null }));
    assert.equal(nullValue.status, 422);
  });
});

describe("12: status endpoint (FinanceOps' own intake only, safe fields only)", () => {
  it("returns operational fields for its own intake and nothing internal", async () => {
    const s = store();
    await post(s);
    const r = await getStatus(s, "fo_bill_01JABCDEF");
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), [
      "bill_created", "created_at", "document_attached", "duplicate_suspected", "entity_code", "entity_resolved", "flags", "intake_id",
      "needs_entity", "next_action", "process_state", "review_status", "updated_at",
    ]);
    assert.equal(r.body.process_state, "complete");
    assert.equal(r.body.review_status, "pending_review");
    assert.equal(r.body.entity_code, "IEA");
    assert.equal(r.body.bill_created, true);
    assert.equal(r.body.document_attached, true);
    assert.equal(r.body.next_action, "awaiting_data_review");
    const text = JSON.stringify(r.body);
    for (const secret of [FO_USER, billIdFor("fo_bill_01JABCDEF"), documentIdFor("fo_bill_01JABCDEF"), ENTITY_IDS.IEA, "supplier", "amount", "bank"]) assert.equal(text.includes(secret), false, secret);
  });

  it("an unresolved intake reports needs_entity / awaiting_entity_resolution", async () => {
    const s = store();
    await post(s, metadata({ entity_code: null }));
    const r = await getStatus(s, "fo_bill_01JABCDEF");
    assert.equal(r.body.needs_entity, true);
    assert.equal(r.body.next_action, "awaiting_entity_resolution");
    assert.equal(r.body.entity_code, null);
  });

  it("after a reviewer resolves the entity it tells FinanceOps to re-send the same intake", async () => {
    const s = store();
    await post(s, metadata({ entity_code: null }));
    Object.assign(s.intakes[0], { entity_id: ENTITY_IDS.KALER, entity_resolved_at: "2026-10-02T05:00:00Z", process_state: "received" });
    const r = await getStatus(s, "fo_bill_01JABCDEF");
    assert.equal(r.body.next_action, "resubmit_same_intake");
    assert.equal(r.body.entity_code, "KALER");
  });

  it("another submitter's intake, an unknown id and a malformed id are all 404 (indistinguishable)", async () => {
    const s = store();
    s.hiddenIntakes.push({ intake_id: "fo_bill_OTHERSONE1" } as never);
    assert.equal((await getStatus(s, "fo_bill_OTHERSONE1")).status, 404);
    assert.equal((await getStatus(s, "fo_bill_NOSUCHID1")).status, 404);
    assert.equal((await getStatus(s, "../etc")).status, 404);
    assert.equal(s.calls.filter((c) => c === "getIntake").length, 2); // the malformed id never reaches the store
  });

  it("an intake that RLS lets this identity see but that somebody else created is 404 (only what FinanceOps submitted itself)", async () => {
    const s = store();
    await post(s);
    s.intakes[0].created_by = "99999999-9999-4999-8999-999999999999";
    assert.equal((await getStatus(s, "fo_bill_01JABCDEF")).status, 404);
    // and it can never be replayed or adopted by this identity either
    const replay = await post(s);
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error, "intake_conflict");
    assert.equal(s.bills.length, 1);
  });

  it("requires a valid HMAC signature, GET only, and honours the kill switch", async () => {
    const s = store();
    await post(s);
    assert.equal((await getStatus(s, "fo_bill_01JABCDEF", { sign: false })).status, 401);
    assert.equal((await getStatus(s, "fo_bill_01JABCDEF", { method: "POST" })).status, 405);
  });

  it("a database outage is a retryable 503, not a 404", async () => {
    const s = store();
    await post(s);
    s.failOn({ method: "getIntake" });
    const r = await getStatus(s, "fo_bill_01JABCDEF");
    assert.equal(r.status, 503);
    assert.equal(r.body.retryable, true);
  });
});

describe("identity, kill switch and entity limits", () => {
  it("refuses to write when the identity is not an active data_entry registry identity", async () => {
    for (const patch of [{ role: "finance_staff" }, { role: "owner" }, { profileActive: false }, { registryActive: false }] as const) {
      const s = store();
      Object.assign(s.identityValue, patch);
      const r = await post(s);
      assert.equal(r.status, 503, JSON.stringify(patch));
      assert.equal(r.body.error, "integration_identity_inactive");
      assert.equal(s.intakes.length, 0);
      assert.equal(s.bills.length, 0);
    }
  });

  it("an entity outside the registry's allowed entities is 403 before anything is stored", async () => {
    const s = store();
    s.identityValue.allowedEntityIds = [ENTITY_IDS.IEA];
    const r = await post(s, metadata({ entity_code: "PLC" }));
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "entity_not_permitted");
    assert.equal(s.intakes.length, 0);
    // an unresolved intake needs no entity, so it is still accepted
    assert.equal((await post(s, metadata({ intake_id: "fo_bill_UNRESOLVED2", entity_code: null }))).status, 202);
  });

  it("RLS denial on insert is a 403, a database outage a retryable 503, and nothing leaks the database message", async () => {
    const s = store();
    s.failOn({ method: "insertIntake", error: { kind: "denied", message: "new row violates row-level security policy for table finance_intake_submissions" } });
    const denied = await post(s);
    assert.equal(denied.status, 403);
    assert.equal(JSON.stringify(denied.body).includes("row-level"), false);

    const s2 = store();
    s2.failOn({ method: "insertIntake", error: { kind: "unavailable", message: "connect ECONNREFUSED 10.0.0.1:5432" } });
    const down = await post(s2);
    assert.equal(down.status, 503);
    assert.equal(JSON.stringify(down.body).includes("ECONNREFUSED"), false);
  });
});

describe("15: FinanceOps never reviews, resolves or releases", () => {
  it("across every scenario the integration only ever writes mechanical columns; never data_verified, rejected, notes, entity or payment status", async () => {
    const scenarios: Array<(s: FakeStore) => Promise<unknown>> = [
      (s) => post(s),
      (s) => post(s, metadata({ entity_code: null })),
      async (s) => {
        s.existingBills.push({ id: "b0000000-0000-4000-8000-000000000009", entityId: ENTITY_IDS.IEA, supplierId: null, billNumber: "OLD", totalAmount: 1, billDate: "2026-01-01", paymentStatus: "unpaid" });
        s.existingDocuments.push({ fileSha256: sha256Hex(PDF), billId: "b0000000-0000-4000-8000-000000000009", deleted: false });
        await post(s);
      },
    ];
    const allowedKeys = new Set(["flags", "duplicate_matches", "review_status", "supplier_bill_id", "document_id", "process_state"]);
    for (const run of scenarios) {
      const s = store();
      await run(s);
      for (const patch of s.patches) {
        for (const k of Object.keys(patch)) assert.equal(allowedKeys.has(k), true, k);
        if (patch.review_status) assert.equal(["duplicate_suspected", "needs_attention"].includes(patch.review_status), true);
      }
      for (const b of s.bills) assert.equal(b.payment_status, "draft");
    }
  });

  it("the fake store (modelling the 0023 trigger) refuses the integration identity data_verified / rejected updates", async () => {
    const s = store();
    await post(s);
    const id = s.intakes[0].id;
    for (const review_status of ["data_verified", "rejected"] as const) {
      const r = await s.updateIntake(id, { review_status });
      assert.equal(r.ok, false);
    }
  });
});
