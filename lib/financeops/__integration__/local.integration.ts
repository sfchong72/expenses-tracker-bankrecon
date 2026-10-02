import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { before, describe, it } from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { sha256Hex } from "../auth";
import { evaluateFinanceOpsVerifyGate } from "../gate";
import { createSupabaseIntakeStore } from "../store-supabase";
import { getStatus, metadata, post } from "../__tests__/harness";

/**
 * OPT-IN integration test against a DISPOSABLE LOCAL Supabase stack that has migrations 0001-0018, 0020-0023 and
 * local-fixtures.sql applied. It drives the REAL handler and the REAL store through real RLS and the real 0023 /
 * Stage 1B triggers. Skipped unless the environment below is set. It must never be pointed at a hosted project.
 *
 *   FINANCEOPS_IT_API_URL   e.g. http://127.0.0.1:55321
 *   FINANCEOPS_IT_ANON_KEY  the LOCAL stack's anon key
 *   FINANCEOPS_IT_PASSWORD  the password passed to local-fixtures.sql
 *
 * Only the anon key is used: no service-role key is needed or accepted here.
 */

const url = process.env.FINANCEOPS_IT_API_URL;
const anonKey = process.env.FINANCEOPS_IT_ANON_KEY;
const password = process.env.FINANCEOPS_IT_PASSWORD;
const enabled = Boolean(url && anonKey && password) && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url ?? "");

const USERS = {
  owner: "owner@it.invalid",
  manager: "manager@it.invalid",
  staff: "staff@it.invalid",
  intern: "intern@it.invalid",
  fo: "financeops@it.invalid",
  management: "management@it.invalid",
  staffIeaOnly: "staff-iea-only@it.invalid",
} as const;
type Who = keyof typeof USERS;

const clients = {} as Record<Who, SupabaseClient>;
const ids = {} as Record<Who, string>;

async function login(email: string): Promise<{ client: SupabaseClient; id: string }> {
  const client = createClient(url as string, anonKey as string, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password: password as string });
  if (error || !data.user) throw new Error(`fixture login failed for ${email}`);
  return { client, id: data.user.id };
}

const uid = () => `fo_it_${randomBytes(8).toString("hex")}`;
const pdf = (tag = "") => new TextEncoder().encode(`%PDF-1.7\nintegration ${tag} ${randomBytes(12).toString("hex")}`);
const meta = (intakeId: string, bytes: Uint8Array, over: Record<string, unknown> = {}) => metadata({ intake_id: intakeId, ...over }, bytes);
const fo = () => createSupabaseIntakeStore(clients.fo);

describe("FinanceOps application against a local Supabase stack (real RLS + real 0023 triggers)", { skip: enabled ? false : "set FINANCEOPS_IT_API_URL / _ANON_KEY / _PASSWORD for a LOCAL stack" }, () => {
  before(async () => {
    for (const who of Object.keys(USERS) as Who[]) {
      const l = await login(USERS[who]);
      clients[who] = l.client;
      ids[who] = l.id;
    }
  });

  it("1/5/6/9: a valid intake becomes a draft bill created by FinanceOps with the original document linked", async () => {
    const intakeId = uid();
    const bytes = pdf("e2e");
    const r = await post(fo(), meta(intakeId, bytes), bytes);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.process_state, "complete");

    const { data: intake } = await clients.staff.from("finance_intake_submissions").select("*").eq("intake_id", intakeId).single();
    assert.equal(intake?.process_state, "complete");
    assert.equal(intake?.review_status, "pending_review");
    assert.equal(intake?.created_by, ids.fo);
    assert.ok(intake?.supplier_bill_id && intake?.document_id);

    const { data: bill } = await clients.staff.from("supplier_bills").select("*").eq("id", intake?.supplier_bill_id).single();
    assert.equal(bill?.payment_status, "draft");
    assert.equal(bill?.created_by, ids.fo);
    assert.equal(bill?.data_origin, "imported");
    assert.equal(bill?.supplier_id, "b0000000-0000-4000-8000-000000000001"); // matched by name
    assert.equal(Number(bill?.total_amount), 106);
    assert.equal(bill?.supporting_document_status, "invoice_uploaded"); // recalculated by the document-link trigger

    const { data: doc } = await clients.staff.from("documents").select("*").eq("id", intake?.document_id).single();
    assert.equal(doc?.file_hash, sha256Hex(bytes));
    assert.equal(doc?.entity_id, intake?.entity_id);
    const { data: link } = await clients.staff.from("document_links").select("*").eq("document_id", intake?.document_id).single();
    assert.equal(link?.linked_record_id, bill?.id);

    // the reviewer can open the original file (the review screen's signed URL)
    const signed = await clients.staff.storage.from("bill-documents").createSignedUrl(doc?.storage_path as string, 60);
    assert.ok(signed.data?.signedUrl, JSON.stringify(signed.error));
    const fetched = new Uint8Array(await (await fetch(signed.data?.signedUrl as string)).arrayBuffer());
    assert.equal(sha256Hex(fetched), sha256Hex(bytes));
  });

  it("2/3/10: replay is idempotent; a different payload is 409; the original is untouched", async () => {
    const intakeId = uid();
    const bytes = pdf("replay");
    const first = await post(fo(), meta(intakeId, bytes), bytes);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const again = await post(fo(), meta(intakeId, bytes), bytes);
    assert.equal(again.status, 200);
    assert.equal(again.body.idempotent_replay, true);
    const { data: rows } = await clients.staff.from("finance_intake_submissions").select("id, supplier_bill_id").eq("intake_id", intakeId);
    assert.equal(rows?.length, 1);

    const changed = await post(fo(), meta(intakeId, bytes, { invoice: { number: "CHANGED", date: "2026-09-30", due_date: "2026-10-30", currency: "MYR", total_amount: 5, bill_type: "supplier_invoice" } }), bytes);
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error, "intake_conflict");
    const { data: docs } = await clients.staff.from("document_links").select("id").eq("linked_record_id", rows?.[0]?.supplier_bill_id);
    assert.equal(docs?.length, 1);
  });

  it("4/13/14: an unresolved intake stores only the intake; Finance Staff+ resolve it; FinanceOps and the intern cannot; then a re-send completes it", async () => {
    const intakeId = uid();
    const bytes = pdf("unresolved");
    const r = await post(fo(), meta(intakeId, bytes, { entity_code: null }), bytes);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.status, "needs_entity");

    const { data: row } = await clients.staff.from("finance_intake_submissions").select("id, entity_id, supplier_bill_id, document_id, process_state").eq("intake_id", intakeId).single();
    assert.equal(row?.entity_id, null);
    assert.equal(row?.supplier_bill_id, null);
    assert.equal(row?.document_id, null);
    assert.equal(row?.process_state, "awaiting_entity");

    // visibility: central review set only (+ the creator)
    for (const who of ["intern", "management"] as const) {
      const { data } = await clients[who].from("finance_intake_submissions").select("id").eq("intake_id", intakeId);
      assert.equal(data?.length, 0, who);
    }
    for (const who of ["staff", "manager", "owner", "staffIeaOnly", "fo"] as const) {
      const { data } = await clients[who].from("finance_intake_submissions").select("id").eq("intake_id", intakeId);
      assert.equal(data?.length, 1, who);
    }

    const { data: plc } = await clients.staff.from("entities").select("id").eq("short_code", "PLC").single();
    // not allowed: FinanceOps itself, the data_entry intern, management
    for (const who of ["fo", "intern", "management"] as const) {
      const res = await clients[who].from("finance_intake_submissions").update({ entity_id: plc?.id, entity_resolution_note: "not allowed" }).eq("id", row?.id).select("id");
      assert.ok(res.error || (res.data ?? []).length === 0, who);
    }
    const { data: still } = await clients.staff.from("finance_intake_submissions").select("entity_id").eq("id", row?.id).single();
    assert.equal(still?.entity_id, null);

    // a Finance Staff user cannot resolve to an entity they cannot access
    const { data: kaler } = await clients.staff.from("entities").select("id").eq("short_code", "KALER");
    assert.equal(kaler?.length, 0); // invisible to them
    const noAccess = await clients.staff.from("finance_intake_submissions").update({ entity_id: "e1000000-0000-4000-8000-0000000000ff", entity_resolution_note: "no such entity" }).eq("id", row?.id).select("id");
    assert.ok(noAccess.error || (noAccess.data ?? []).length === 0);

    // allowed: Finance Staff resolves with a note
    const ok = await clients.staff.from("finance_intake_submissions").update({ entity_id: plc?.id, entity_resolution_note: "Billed to Premier Language Centre per invoice header" }).eq("id", row?.id).select("id, process_state");
    assert.equal(ok.error, null, JSON.stringify(ok.error));
    assert.equal(ok.data?.[0]?.process_state, "received");

    const status = await getStatus(fo(), intakeId);
    assert.equal(status.body.next_action, "resubmit_same_intake");
    assert.equal(status.body.entity_code, "PLC");

    const done = await post(fo(), meta(intakeId, bytes, { entity_code: null }), bytes);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.process_state, "complete");
    const { data: bill } = await clients.staff.from("supplier_bills").select("entity_id, payment_status").eq("id", (await clients.staff.from("finance_intake_submissions").select("supplier_bill_id").eq("intake_id", intakeId).single()).data?.supplier_bill_id).single();
    assert.equal(bill?.payment_status, "draft");
    assert.equal(bill?.entity_id, plc?.id);
  });

  it("7: an exact duplicate (same file, same entity) creates no second bill and is flagged; the same file in another entity is only a soft flag", async () => {
    const bytes = pdf("dup");
    const a = uid();
    assert.equal((await post(fo(), meta(a, bytes), bytes)).status, 201);
    const b = uid();
    const dup = await post(fo(), meta(b, bytes), bytes);
    assert.equal(dup.status, 409, JSON.stringify(dup.body));
    assert.equal(dup.body.error, "duplicate_file");
    const { data: row } = await clients.staff.from("finance_intake_submissions").select("review_status, supplier_bill_id, document_id, duplicate_matches, flags").eq("intake_id", b).single();
    assert.equal(row?.review_status, "duplicate_suspected");
    assert.equal(row?.supplier_bill_id, null);
    assert.equal(row?.document_id, null);
    assert.ok((row?.flags as string[]).includes("duplicate_suspected_file"));

    const c = uid();
    const soft = await post(fo(), meta(c, bytes, { entity_code: "PLC" }), bytes);
    assert.equal(soft.status, 201, JSON.stringify(soft.body));
    const { data: softRow } = await clients.staff.from("finance_intake_submissions").select("flags, review_status").eq("intake_id", c).single();
    assert.ok((softRow?.flags as string[]).includes("same_file_in_other_entity"));
    assert.equal(softRow?.review_status, "pending_review");
  });

  it("8: a missing due date keeps the placeholder and the due_date_missing flag in the database", async () => {
    const bytes = pdf("nodue");
    const id = uid();
    const m = meta(id, bytes);
    (m.invoice as { due_date: string | null }).due_date = null;
    assert.equal((await post(fo(), m, bytes)).status, 201);
    const { data: intake } = await clients.staff.from("finance_intake_submissions").select("flags, supplier_bill_id").eq("intake_id", id).single();
    assert.ok((intake?.flags as string[]).includes("due_date_missing"));
    const { data: bill } = await clients.staff.from("supplier_bills").select("due_date, bill_date").eq("id", intake?.supplier_bill_id).single();
    assert.equal(bill?.due_date, bill?.bill_date);
  });

  it("15-18: FinanceOps cannot review or release; a human Data Verified unlocks release by Finance Staff+ only", async () => {
    const bytes = pdf("release");
    const id = uid();
    assert.equal((await post(fo(), meta(id, bytes), bytes)).status, 201);
    const { data: row } = await clients.staff.from("finance_intake_submissions").select("id, supplier_bill_id").eq("intake_id", id).single();

    // 15: FinanceOps cannot data_verify / reject its own intake, cannot write review notes
    for (const patch of [{ review_status: "data_verified" }, { review_status: "rejected", review_note: "x" }, { review_note: "self-approved" }]) {
      const res = await clients.fo.from("finance_intake_submissions").update(patch).eq("id", row?.id).select("id");
      assert.ok(res.error || (res.data ?? []).length === 0, JSON.stringify(patch));
    }
    // FinanceOps cannot move its own bill out of draft (Stage 1B: data_entry may not draft -> unpaid)
    const release = await clients.fo.from("supplier_bills").update({ payment_status: "unpaid" }).eq("id", row?.supplier_bill_id).eq("payment_status", "draft").select("id");
    assert.ok(release.error || (release.data ?? []).length === 0);
    const { data: stillDraft } = await clients.staff.from("supplier_bills").select("payment_status").eq("id", row?.supplier_bill_id).single();
    assert.equal(stillDraft?.payment_status, "draft");

    // 17: the gate lookup (what /api/bills/verify does as the human caller) sees the intake and blocks until data_verified
    const lookup = async (who: Who) => {
      const r = await clients[who].from("finance_intake_submissions").select("review_status").eq("supplier_bill_id", row?.supplier_bill_id);
      return evaluateFinanceOpsVerifyGate({ error: r.error?.message, rows: r.data });
    };
    for (const who of ["staff", "manager", "owner"] as const) assert.equal((await lookup(who)).allow, false, who);

    // 16: the data_entry intern (a different identity) can Data Verify (D2) ...
    const verified = await clients.intern.from("finance_intake_submissions").update({ review_status: "data_verified", review_note: "checked against the PDF" }).eq("id", row?.id).select("id, review_status");
    assert.equal(verified.error, null, JSON.stringify(verified.error));
    assert.equal(verified.data?.[0]?.review_status, "data_verified");
    // ... the intake is now frozen, FinanceOps still cannot touch it
    const frozen = await clients.fo.from("finance_intake_submissions").update({ review_status: "rejected" }).eq("id", row?.id).select("id");
    assert.ok(frozen.error || (frozen.data ?? []).length === 0);

    // ... but the intern still cannot release the bill (draft -> unpaid)
    const internRelease = await clients.intern.from("supplier_bills").update({ payment_status: "unpaid" }).eq("id", row?.supplier_bill_id).eq("payment_status", "draft").select("id");
    assert.ok(internRelease.error || (internRelease.data ?? []).length === 0);

    // 18: the gate now allows; Finance Staff releases the bill as usual
    for (const who of ["staff", "manager", "owner"] as const) assert.deepEqual(await lookup(who), { allow: true, financeopsLinked: true }, who);
    const released = await clients.staff.from("supplier_bills").update({ payment_status: "unpaid" }).eq("id", row?.supplier_bill_id).eq("payment_status", "draft").select("id");
    assert.equal(released.error, null, JSON.stringify(released.error));
    assert.equal(released.data?.length, 1);
  });

  it("19: an ordinary manually-created bill has no intake row, so the gate lets Stage 1B proceed", async () => {
    const created = await clients.staff.from("supplier_bills").insert({ entity_id: (await clients.staff.from("entities").select("id").eq("short_code", "IEA").single()).data?.id, description: "Manual bill", bill_date: "2026-10-01", due_date: "2026-10-31", subtotal: 10, tax_amount: 0, total_amount: 10, outstanding_amount: 10, payment_status: "draft", created_by: ids.staff, is_demo: false, data_origin: "manual" }).select("id").single();
    assert.equal(created.error, null, JSON.stringify(created.error));
    const r = await clients.staff.from("finance_intake_submissions").select("review_status").eq("supplier_bill_id", created.data?.id);
    assert.deepEqual(evaluateFinanceOpsVerifyGate({ error: r.error?.message, rows: r.data }), { allow: true, financeopsLinked: false });
    const rel = await clients.staff.from("supplier_bills").update({ payment_status: "unpaid" }).eq("id", created.data?.id).eq("payment_status", "draft").select("id");
    assert.equal(rel.data?.length, 1);
  });

  it("11: supersedes_intake_id: a successor with an entity replaces an unresolved intake; the database refuses a second successor", async () => {
    const bytes = pdf("supersede");
    const original = uid();
    assert.equal((await post(fo(), meta(original, bytes, { entity_code: null }), bytes)).status, 202);
    const successor = uid();
    const r = await post(fo(), meta(successor, bytes, { supersedes_intake_id: original }), bytes);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const { data: row } = await clients.staff.from("finance_intake_submissions").select("supersedes_intake_id").eq("intake_id", successor).single();
    assert.equal(row?.supersedes_intake_id, original);

    const secondBytes = pdf("second");
    const second = await post(fo(), meta(uid(), secondBytes, { supersedes_intake_id: original }), secondBytes);
    assert.ok([409, 422].includes(second.status), JSON.stringify(second.body));
    assert.ok(["already_superseded", "intake_already_resolved"].includes(second.body.error as string), JSON.stringify(second.body));

    const unknownBytes = pdf("u");
    const unknown = await post(fo(), meta(uid(), unknownBytes, { supersedes_intake_id: "fo_it_doesnotexist01" }), unknownBytes);
    assert.equal(unknown.status, 422, JSON.stringify(unknown.body));

    const nullBytes = pdf("n");
    const nullEntity = await post(fo(), meta(uid(), nullBytes, { entity_code: null, supersedes_intake_id: original }), nullBytes);
    assert.ok([409, 422].includes(nullEntity.status), JSON.stringify(nullEntity.body));
  });

  it("12: the status endpoint reads through the FinanceOps identity's own RLS and reports only its own intakes", async () => {
    const bytes = pdf("status");
    const id = uid();
    await post(fo(), meta(id, bytes), bytes);
    const s = await getStatus(fo(), id);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.process_state, "complete");
    assert.equal(s.body.next_action, "awaiting_data_review");
    const text = JSON.stringify(s.body);
    for (const internal of [ids.fo, "supplier_bill_id", "document_id", "payload"]) assert.equal(text.includes(internal), false, internal);
    assert.equal((await getStatus(fo(), "fo_it_nosuchintake01")).status, 404);
    // another user's session would see the row through entity RLS, but the handler only reports intakes the identity created
    assert.equal((await getStatus(createSupabaseIntakeStore(clients.intern), id)).status, 404);
  });

  it("20: FinanceOps cannot touch bank, payment, voucher or reconciliation data, nor create a bill with another status", async () => {
    for (const table of ["bank_transactions", "bank_accounts", "bill_payments", "payment_vouchers", "reconciliation_matches"]) {
      const r = await clients.fo.from(table).select("id").limit(1);
      assert.ok(r.error || (r.data ?? []).length === 0, table);
    }
    const iea = (await clients.fo.from("entities").select("id").eq("short_code", "IEA").single()).data?.id;
    for (const status of ["unpaid", "paid", "scheduled"]) {
      const bad = await clients.fo.from("supplier_bills").insert({ entity_id: iea, description: "x", bill_date: "2026-10-01", due_date: "2026-10-31", total_amount: 1, payment_status: status, created_by: ids.fo, is_demo: false, data_origin: "imported" }).select("id");
      assert.ok(bad.error, status);
    }
    const voucher = await clients.fo.from("payment_vouchers").insert({ entity_id: iea, payee: "x", purpose: "x" }).select("id");
    assert.ok(voucher.error);
  });
});
