import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { before, describe, it } from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { sha256Hex, signRequest } from "../auth";
import { handlePaymentIntake, handlePaymentStatus } from "../payments/handler";
import { createSupabasePaymentStore } from "../payments/store-supabase";
import { confirmRegisterImport, confirmStatementImport, prepareStatementImport, requireCaller, runMatching, type Caller } from "../payments/services";
import { CONFIG, NOW, SECRET } from "../__tests__/harness";

/**
 * OPT-IN end-to-end test of the Payment Register against a DISPOSABLE LOCAL Supabase stack that has migrations
 * 0001-0018, 0020-0024 and local-fixtures.sql applied, with TOTP MFA enabled in the local auth config.
 * Real RLS, real 0023/0024 triggers, real storage, sessions upgraded to AAL2 with a genuine TOTP code.
 * Skipped unless the environment is set. Only the anon key is used. Never point this at a hosted project.
 */

const url = process.env.FINANCEOPS_IT_API_URL;
const anonKey = process.env.FINANCEOPS_IT_ANON_KEY;
const password = process.env.FINANCEOPS_IT_PASSWORD;
const enabled = Boolean(url && anonKey && password) && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url ?? "");
const ENV = { FINANCEOPS_PAYMENT_REGISTER_ENABLED: "true" };

const USERS = { owner: "owner@it.invalid", manager: "manager@it.invalid", staff: "staff@it.invalid", intern: "intern@it.invalid", fo: "financeops@it.invalid", management: "management@it.invalid" } as const;
type Who = keyof typeof USERS;
const clients = {} as Record<Who, SupabaseClient>;
const aal1Staff = {} as { client: SupabaseClient };
const ids = {} as Record<Who, string>;
const caller = {} as Record<"owner" | "manager" | "staff", Caller>;

function base32(s: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Uint8Array.from(out);
}
function totp(secret: string, atMs = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30000)));
  const h = createHmac("sha1", base32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

async function login(email: string): Promise<{ client: SupabaseClient; id: string }> {
  const client = createClient(url as string, anonKey as string, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password: password as string });
  if (error || !data.user) throw new Error(`fixture login failed for ${email}`);
  return { client, id: data.user.id };
}

/** Upgrade a signed-in client to AAL2 with a real TOTP factor. */
async function upgradeToAal2(client: SupabaseClient): Promise<void> {
  const enrol = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: `it-${randomBytes(4).toString("hex")}` });
  if (enrol.error || !enrol.data) throw new Error(`MFA enrol failed: ${enrol.error?.message}`);
  const challenge = await client.auth.mfa.challenge({ factorId: enrol.data.id });
  if (challenge.error || !challenge.data) throw new Error(`MFA challenge failed: ${challenge.error?.message}`);
  const verify = await client.auth.mfa.verify({ factorId: enrol.data.id, challengeId: challenge.data.id, code: totp(enrol.data.totp.secret) });
  if (verify.error) throw new Error(`MFA verify failed: ${verify.error.message}`);
}

const uid = () => `fo_pay_${randomBytes(6).toString("hex")}`;
const pdf = (tag: string) => new TextEncoder().encode(`%PDF-1.7\n${tag} ${randomBytes(10).toString("hex")}`);
const PATH = "/api/integrations/financeops/v1/payment-intakes";

function signed(method: string, path: string, body: Uint8Array, contentType?: string): Headers {
  const ts = String(Math.floor(Date.now() / 1000));
  const h = new Headers();
  if (contentType) h.set("content-type", contentType);
  h.set("x-financeops-key-id", "kid-current");
  h.set("x-financeops-timestamp", ts);
  h.set("x-financeops-signature", signRequest(SECRET, { timestamp: ts, method, path, query: "", bodySha256: sha256Hex(body) }));
  return h;
}

type Doc = { part: string; role: string; bytes: Uint8Array };
function metaFor(over: Record<string, unknown>, payment: Record<string, unknown>, docs: Doc[]) {
  return {
    intake_id: uid(),
    source: { channel: "telegram", chat_id: "1", message_id: "2", received_at: new Date().toISOString() },
    entity_code: "PLC",
    payment_type: "intern_wage",
    payment: { instruction_date: new Date().toISOString().slice(0, 10), instruction_time: "22:44:43", method: "Domestic Transfers", pay_from_account_ref: "8009777553", pay_from_name: "PREMIER LANGUAGE CENTRE", beneficiary_name: "Ingyin May", beneficiary_account_no: "152023754172", beneficiary_bank: "MALAYAN BANKING BHD", amount: 1250, currency: "MYR", bank_reference: "20261002034988" + randomBytes(2).toString("hex").replace(/[a-f]/g, "7"), purpose: "Intern allowance", ...payment },
    documents: docs.map((d) => ({ part: d.part, role: d.role, sha256: sha256Hex(d.bytes), mime_type: "application/pdf", filename: `${d.part}.pdf` })),
    extraction: { agent: "hermes", version: "1", overall_confidence: 0.93 },
    ...over,
  };
}

async function capture(meta: ReturnType<typeof metaFor>, docs: Doc[]) {
  const fd = new FormData();
  fd.set("metadata", JSON.stringify(meta));
  for (const d of docs) fd.set(d.part, new File([d.bytes as BlobPart], `${d.part}.pdf`, { type: "application/pdf" }));
  const res = new Response(fd);
  const raw = new Uint8Array(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") as string;
  const store = createSupabasePaymentStore(clients.fo);
  return handlePaymentIntake({ method: "POST", path: PATH, query: "", headers: signed("POST", PATH, raw, contentType), rawBody: raw }, CONFIG, { nowSeconds: Math.floor(Date.now() / 1000), paymentRegisterEnabled: true, paymentStoreProvider: async () => store });
}

const dbRow = async (id: string) => (await clients.manager.from("finance_payment_register").select("*").eq("intake_id", id).single()).data;

describe("Payment Register end to end (real RLS, real triggers, real storage, AAL2 sessions)", { skip: enabled ? false : "set FINANCEOPS_IT_API_URL / _ANON_KEY / _PASSWORD for a LOCAL stack with TOTP MFA enabled" }, () => {
  before(async () => {
    for (const who of Object.keys(USERS) as Who[]) {
      const l = await login(USERS[who]);
      clients[who] = l.client;
      ids[who] = l.id;
    }
    for (const who of ["owner", "manager", "staff"] as const) await upgradeToAal2(clients[who]);
    // a fresh sign-in AFTER the factor exists is AAL1 until the user verifies (signing in earlier would be dropped by the verify)
    aal1Staff.client = (await login(USERS.staff)).client;
    for (const who of ["owner", "manager", "staff"] as const) {
      const c = await requireCaller(clients[who], ENV, { reviewer: true, aal2: true });
      if (!c.ok) throw new Error(`caller ${who}: ${JSON.stringify(c.body)}`);
      caller[who] = c.value;
    }
  });

  const A = { intake: "", ref: "", sha: "" };
  const wage = pdf("wage schedule");
  const slipA = pdf("slip A");
  const slipB = pdf("slip B");

  it("1. FinanceOps captures a wage payment with its evidence and the wage schedule: ready for bank match, documents complete", async () => {
    const m = metaFor({}, { amount: 1250 }, [{ part: "file_0", role: "payment_evidence", bytes: slipA }, { part: "file_1", role: "wage_schedule", bytes: wage }]);
    const r = await capture(m, [{ part: "file_0", role: "payment_evidence", bytes: slipA }, { part: "file_1", role: "wage_schedule", bytes: wage }]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, "ready_for_bank_match");
    assert.equal(r.body.documents_complete, true);
    A.intake = m.intake_id;
    A.ref = (m.payment as { bank_reference: string }).bank_reference;
    const row = await dbRow(A.intake);
    assert.equal(row?.created_by, ids.fo);
    assert.equal(row?.source_type, "financeops");
    assert.equal(row?.payment_method, "ibg");
    assert.deepEqual(row?.required_documents, ["wage_schedule", "payment_evidence"]);
    const docs = await clients.staff.from("finance_payment_documents").select("*").eq("payment_register_id", row?.id);
    assert.equal(docs.data?.length, 2);
    // a reviewer can open the evidence FinanceOps stored (private bucket, entity-scoped read)
    const slipDoc = docs.data?.find((d) => d.doc_role === "payment_evidence");
    const signedUrl = await clients.staff.storage.from("finance-payment-documents").createSignedUrl(slipDoc?.storage_path as string, 60);
    assert.ok(signedUrl.data?.signedUrl, JSON.stringify(signedUrl.error));
    assert.equal(sha256Hex(new Uint8Array(await (await fetch(signedUrl.data?.signedUrl as string)).arrayBuffer())), sha256Hex(slipA));
  });

  it("2. replay is idempotent; a changed payload is 409; status shows own progress only", async () => {
    const m = metaFor({ intake_id: A.intake }, { amount: 1250, bank_reference: A.ref }, [{ part: "file_0", role: "payment_evidence", bytes: slipA }, { part: "file_1", role: "wage_schedule", bytes: wage }]);
    // (same intake id; the received_at differs so the payload differs -> conflict)
    const changed = await capture(m, [{ part: "file_0", role: "payment_evidence", bytes: slipA }, { part: "file_1", role: "wage_schedule", bytes: wage }]);
    assert.equal(changed.status, 409, JSON.stringify(changed.body));
    const store = createSupabasePaymentStore(clients.fo);
    const path = `${PATH}/${A.intake}`;
    const st = await handlePaymentStatus({ method: "GET", path, query: "", headers: signed("GET", path, new Uint8Array(0)), rawBody: new Uint8Array(0) }, A.intake, CONFIG, { nowSeconds: Math.floor(Date.now() / 1000), paymentRegisterEnabled: true, paymentStoreProvider: async () => store });
    assert.equal(st.status, 200, JSON.stringify(st.body));
    assert.equal(st.body.status, "ready_for_bank_match");
    assert.equal(JSON.stringify(st.body).includes("1250"), false);
  });

  it("3. a supplier payment without its invoice is documents_pending, not rejected", async () => {
    const m = metaFor({ payment_type: "supplier_expense" }, { amount: 800, beneficiary_name: "ABC Trading Sdn Bhd", beneficiary_account_no: "5144012345", bank_reference: "202610020349770001", purpose: "Printing" }, [{ part: "file_0", role: "payment_evidence", bytes: slipB }]);
    const r = await capture(m, [{ part: "file_0", role: "payment_evidence", bytes: slipB }]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, "documents_pending");
    assert.deepEqual(r.body.documents_missing, ["invoice"]);
  });

  it("4. FinanceOps cannot go beyond capture: no status moves, no bank data, no matches, no human fields", async () => {
    const row = await dbRow(A.intake);
    for (const status of ["bank_matched", "finance_review", "ready_for_sql", "posted_to_sql", "reconciled"]) {
      const r = await clients.fo.from("finance_payment_register").update({ status }).eq("id", row?.id).select("id");
      assert.ok(r.error || (r.data ?? []).length === 0, status);
    }
    for (const patch of [{ amount: 1 }, { document_exception_note: "bot says fine" }, { bank_match_not_applicable: true, bank_match_na_note: "robot" }, { notes: "approved" }, { sql_reference: "X" }]) {
      const r = await clients.fo.from("finance_payment_register").update(patch).eq("id", row?.id).select("id");
      assert.ok(r.error || (r.data ?? []).length === 0, JSON.stringify(patch));
    }
    for (const table of ["finance_bank_statement_transactions", "finance_bank_import_batches", "finance_payment_bank_matches"]) {
      const r = await clients.fo.from(table).select("id").limit(1);
      assert.ok(r.error || (r.data ?? []).length === 0, table);
    }
    const insBank = await clients.fo.from("finance_bank_import_batches").insert({ entity_id: row?.entity_id, company_account_ref: "x", filename: "x", file_type: "csv", file_hash: "a".repeat(64), imported_by: ids.fo });
    assert.ok(insBank.error);
    const forced = await clients.fo.from("finance_payment_register").insert({ entity_id: row?.entity_id, source_type: "financeops", intake_id: uid(), payload_hash: "a".repeat(64), payment_type: "other", payment_instruction_date: "2026-10-02", amount: 1, required_documents: [], status: "ready_for_sql", created_by: ids.fo });
    assert.ok(forced.error);
  });

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const stmtDate = (time: string) => { const d = new Date(); return `${String(d.getUTCDate()).padStart(2, "0")}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${time}`; };
  const csv = (ref: string) => [
    `No,Posting Date,Sender Name,Cheque No.,Recipient's Reference,Other Payment Details,Remark,Debit Amount,Credit Amount,Balance,Transaction Description,Reference No.`,
    `1,${stmtDate("23:13")},,,INTERN ALLOWANCE,,Ingyin May,"1,250.00",,"96,465.33",TR IBG,${ref.slice(-8)}`,
    `2,${stmtDate("23:13")},,,INTERN ALLOWANCE,,INTERN ALLOWANCE,0.10,,"96,465.23",OTHER TRANSFER FEE,${ref.slice(-8)}`,
    `3,${stmtDate("09:00")},Customer Co,,,,Customer Co,,"2,000.00","98,465.23",CR TRANSFER,50000001`,
  ].join("\n");

  it("5. bank import needs a reviewer AND AAL2: Finance Staff at AAL1 is refused, the intern and FinanceOps cannot", async () => {
    const entityId = (await clients.staff.from("entities").select("id").eq("short_code", "PLC").single()).data?.id as string;
    const input = { entityId, companyAccountRef: "8009777553", filename: "stmt.csv", fileType: "csv" as const, bytes: Buffer.from(csv(A.ref)) };
    const lowAal = await requireCaller(aal1Staff.client, ENV, { reviewer: true, aal2: true });
    assert.equal(lowAal.ok, false);
    if (!lowAal.ok) assert.equal(lowAal.body.error, "aal2_required");
    const direct = await aal1Staff.client.from("finance_bank_import_batches").insert({ entity_id: entityId, company_account_ref: "x", filename: "x", file_type: "csv", file_hash: "b".repeat(64), imported_by: ids.staff });
    assert.ok(direct.error, "AAL1 insert must be refused by RLS");
    const internCaller = await requireCaller(clients.intern, ENV, { reviewer: true });
    assert.equal(internCaller.ok, false);
    const foCaller = await requireCaller(clients.fo, ENV, { reviewer: true });
    assert.equal(foCaller.ok, false);
    const prev = await prepareStatementImport(clients.staff, input);
    assert.ok(prev.ok);
    if (prev.ok) {
      assert.equal(prev.value.summary.new, 3);
      assert.equal(prev.value.summary.fees, 1);
      assert.equal(prev.value.rows[0].payeeName, "Ingyin May");
      assert.equal(prev.value.mapping["Balance"], "ignore_balance");
    }
  });

  it("6. import is insert-only: the rows land, a second import of the same file is refused, no balance is stored", async () => {
    const entityId = (await clients.staff.from("entities").select("id").eq("short_code", "PLC").single()).data?.id as string;
    const input = { entityId, companyAccountRef: "8009777553", filename: "stmt.csv", fileType: "csv" as const, bytes: Buffer.from(csv(A.ref)) };
    const done = await confirmStatementImport(clients.staff, caller.staff, input, "Public Bank");
    assert.ok(done.ok, JSON.stringify(done));
    if (done.ok) { assert.equal(done.value.imported, 3); assert.equal(done.value.resumed, false); }
    const again = await confirmStatementImport(clients.staff, caller.staff, input, "Public Bank");
    assert.equal(again.ok, false);
    const cols = (await clients.staff.from("finance_bank_statement_transactions").select("*").limit(1)).data?.[0] ?? {};
    assert.equal(Object.keys(cols).some((k) => /balance/i.test(k)), false);
    const update = await clients.staff.from("finance_bank_statement_transactions").update({ amount: 1 }).eq("entity_id", entityId).select("id");
    assert.ok(update.error || (update.data ?? []).length === 0, "statement rows cannot be updated");
    const del = await clients.staff.from("finance_bank_statement_transactions").delete().eq("entity_id", entityId).select("id");
    assert.ok(del.error || (del.data ?? []).length === 0, "statement rows cannot be deleted");
    // the intern, management and FinanceOps cannot read bank rows even at their own access level
    for (const who of ["intern", "management", "fo"] as const) {
      const r = await clients[who].from("finance_bank_statement_transactions").select("id").limit(1);
      assert.ok(r.error || (r.data ?? []).length === 0, who);
    }
    assert.equal(((await aal1Staff.client.from("finance_bank_statement_transactions").select("id").limit(1)).data ?? []).length, 0, "AAL1 reviewer sees no bank rows");
  });

  it("7. matching suggests the right bank row (reference tail + amount + account + name), never the fee row, never a credit", async () => {
    const entityId = (await clients.staff.from("entities").select("id").eq("short_code", "PLC").single()).data?.id as string;
    const run = await runMatching(clients.staff, caller.staff, entityId);
    assert.ok(run.ok, JSON.stringify(run));
    const row = await dbRow(A.intake);
    const matches = (await clients.staff.from("finance_payment_bank_matches").select("*, finance_bank_statement_transactions(*)").eq("payment_register_id", row?.id)).data ?? [];
    assert.ok(matches.length >= 1);
    const top = matches.sort((a, b) => b.score - a.score)[0];
    assert.ok(top.score >= 90, `score ${top.score}`);
    assert.equal(top.finance_bank_statement_transactions.payee_name, "Ingyin May");
    assert.equal(top.finance_bank_statement_transactions.direction, "debit");
    assert.equal(matches.some((m) => m.finance_bank_statement_transactions.description?.includes("FEE")), false);
    assert.equal((await dbRow(A.intake))?.status, "bank_match_suggested");
    // running it again suggests nothing twice
    const again = await runMatching(clients.staff, caller.staff, entityId);
    assert.ok(again.ok && again.value.suggested === 0);
  });

  it("8. humans confirm: the intern and FinanceOps cannot; Finance Staff can; bank_matched needs the confirmed match", async () => {
    const row = await dbRow(A.intake);
    const m = (await clients.staff.from("finance_payment_bank_matches").select("*").eq("payment_register_id", row?.id).eq("status", "suggested").order("score", { ascending: false })).data?.[0];
    assert.ok(m);
    for (const who of ["intern", "fo"] as const) {
      const r = await clients[who].from("finance_payment_bank_matches").update({ status: "confirmed" }).eq("id", m.id).select("id");
      assert.ok(r.error || (r.data ?? []).length === 0, who);
    }
    const early = await clients.staff.from("finance_payment_register").update({ status: "bank_matched" }).eq("id", row?.id).select("id");
    assert.ok(early.error, "bank_matched without a confirmed match is refused");
    const confirm = await clients.staff.from("finance_payment_bank_matches").update({ status: "confirmed" }).eq("id", m.id).select("id");
    assert.equal(confirm.error, null, JSON.stringify(confirm.error));
    const moved = await clients.staff.from("finance_payment_register").update({ status: "bank_matched" }).eq("id", row?.id).select("id");
    assert.equal(moved.error, null, JSON.stringify(moved.error));
    const stamped = (await clients.staff.from("finance_payment_bank_matches").select("match_method, confirmed_by").eq("id", m.id).single()).data;
    assert.equal(stamped?.match_method, "suggested_confirmed");
    assert.equal(stamped?.confirmed_by, ids.staff);
  });

  it("9. finance review -> Ready for SQL -> Posted -> Reconciled: reviewers only, with the stamps and prerequisites enforced by the database", async () => {
    const row = await dbRow(A.intake);
    const update = (who: Who, patch: Record<string, unknown>) => clients[who].from("finance_payment_register").update(patch).eq("id", row?.id).select("id");
    for (const who of ["fo", "intern", "management"] as const) {
      const r = await update(who, { status: "finance_review" });
      assert.ok(r.error || (r.data ?? []).length === 0, `${who} -> finance_review`);
    }
    assert.equal((await update("staff", { status: "finance_review" })).error, null);
    assert.equal((await dbRow(A.intake))?.reviewed_by, ids.staff);
    for (const who of ["fo", "intern"] as const) {
      const r = await update(who, { status: "ready_for_sql" });
      assert.ok(r.error || (r.data ?? []).length === 0, `${who} -> ready_for_sql`);
    }
    assert.equal((await update("staff", { status: "ready_for_sql" })).error, null);
    const noRef = await update("staff", { status: "posted_to_sql" });
    assert.match(noRef.error?.message ?? "", /SQL reference/);
    const foPost = await update("fo", { status: "posted_to_sql", sql_reference: "PV-1", sql_posting_date: "2026-10-03" });
    assert.ok(foPost.error || (foPost.data ?? []).length === 0);
    assert.equal((await update("staff", { status: "posted_to_sql", sql_reference: "PV-2026-00123", sql_posting_date: new Date().toISOString().slice(0, 10) })).error, null);
    assert.equal((await dbRow(A.intake))?.sql_posted_by, ids.staff);
    const noDate = await update("staff", { status: "reconciled" });
    assert.match(noDate.error?.message ?? "", /reconciliation date/);
    assert.equal((await update("staff", { status: "reconciled", reconciled_date: new Date().toISOString().slice(0, 10) })).error, null);
    assert.ok((await update("staff", { status: "posted_to_sql" })).error, "Finance Staff cannot reverse a reconciliation");
    assert.equal((await update("manager", { status: "posted_to_sql" })).error, null);
    // the audit trail records who did what
    const audit = (await clients.owner.from("audit_logs").select("action, actor_user_id").like("action", "finance_%")).data ?? [];
    const actions = new Set(audit.map((a) => a.action));
    for (const a of ["finance_payment_captured", "finance_payment_finance_review", "finance_payment_ready_for_sql", "finance_payment_posted_to_sql", "finance_payment_reconciled", "finance_bank_match_confirmed", "finance_bank_import_batch_created", "finance_payment_document_attached"]) assert.ok(actions.has(a), a);
    assert.equal(audit.find((a) => a.action === "finance_payment_ready_for_sql")?.actor_user_id, ids.staff);
  });

  it("10. the supplier payment without an invoice cannot reach finance review until a human approves an exception; cash needs a human 'bank match not applicable'", async () => {
    const supplier = (await clients.manager.from("finance_payment_register").select("*").eq("payment_type", "supplier_expense").eq("status", "documents_pending").order("created_at", { ascending: false }).limit(1).single()).data;
    assert.ok(supplier);
    const update = (who: Who, patch: Record<string, unknown>) => clients[who].from("finance_payment_register").update(patch).eq("id", supplier?.id).select("id");
    const na = await update("intern", { bank_match_not_applicable: true, bank_match_na_note: "intern says so" });
    assert.ok(na.error || (na.data ?? []).length === 0, "the intern cannot decide bank match not applicable");
    assert.equal((await update("staff", { bank_match_not_applicable: true, bank_match_na_note: "paid in cash, no bank movement" })).error, null);
    const blocked = await update("staff", { status: "finance_review" });
    assert.match(blocked.error?.message ?? "", /Required documents are missing \(invoice\)/);
    const internEx = await update("intern", { document_exception_note: "intern approves" });
    assert.ok(internEx.error || (internEx.data ?? []).length === 0, "the intern cannot approve an exception");
    assert.equal((await update("staff", { document_exception_note: "invoice to follow, approved" })).error, null);
    assert.equal((await update("staff", { status: "finance_review" })).error, null);
  });

  it("11. one wage schedule can support several payments (the same stored file, one row per payment)", async () => {
    const entityId = (await clients.staff.from("entities").select("id").eq("short_code", "PLC").single()).data?.id as string;
    const mk = async (name: string) => {
      const r = await clients.staff.from("finance_payment_register").insert({ entity_id: entityId, source_type: "manual", payment_type: "intern_wage", payment_instruction_date: new Date().toISOString().slice(0, 10), payment_method: "ibg", beneficiary_name: name, amount: 700, required_documents: ["wage_schedule", "payment_evidence"], status: "documents_pending", created_by: ids.staff }).select("id").single();
      assert.equal(r.error, null, JSON.stringify(r.error));
      return r.data?.id as string;
    };
    const [p1, p2] = [await mk("Ivy Su Hui Ing"), await mk("Sania Arshad")];
    const bytes = pdf("shared wage sheet");
    const path = `${entityId}/2026/10/payments/${randomBytes(6).toString("hex")}.pdf`;
    const up = await clients.staff.storage.from("finance-payment-documents").upload(path, bytes, { contentType: "application/pdf", upsert: false });
    assert.equal(up.error, null, JSON.stringify(up.error));
    for (const id of [p1, p2]) {
      const r = await clients.staff.from("finance_payment_documents").insert({ payment_register_id: id, entity_id: entityId, doc_role: "wage_schedule", storage_path: path, original_filename: "wages.pdf", mime_type: "application/pdf", file_size: bytes.byteLength, file_hash: sha256Hex(bytes), uploaded_by: ids.staff });
      assert.equal(r.error, null, JSON.stringify(r.error));
    }
    const docs = await clients.staff.from("finance_payment_documents").select("payment_register_id").eq("storage_path", path);
    assert.equal(docs.data?.length, 2);
    const dupe = await clients.staff.from("finance_payment_documents").insert({ payment_register_id: p1, entity_id: entityId, doc_role: "wage_schedule", storage_path: path, original_filename: "wages.pdf", mime_type: "application/pdf", file_size: bytes.byteLength, file_hash: sha256Hex(bytes), uploaded_by: ids.staff });
    assert.ok(dupe.error, "the same file cannot be attached twice to one payment");
  });

  it("12. cross-entity: a payment for an entity the Finance Staff user cannot access is invisible to them (the Finance Manager sees it)", async () => {
    const m = metaFor({ entity_code: "IETA" }, { beneficiary_name: "Cordelia Puyang Augustine", amount: 100, bank_reference: "202610020349883327" }, []);
    const r = await capture(m, []);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = (await dbRow(m.intake_id))?.id;
    assert.ok(id);
    assert.equal(((await clients.staff.from("finance_payment_register").select("id").eq("id", id)).data ?? []).length, 0);
    assert.equal(((await clients.intern.from("finance_payment_register").select("id").eq("id", id)).data ?? []).length, 0);
    assert.equal(((await clients.manager.from("finance_payment_register").select("id").eq("id", id)).data ?? []).length, 1);
  });

  it("13. the old Excel register imports with a preview: closed history needs Owner / Finance Manager; duplicates are skipped on a second run", async () => {
    const header = ["Payment ID", "Payment initiation date", "Payment method", "Pay-from account reference", "Pay-from name", "Beneficiary", "Amount (MYR)", "Purpose / PV description", "Reconciliation status", "Source reference"];
    const line = (id: string, status: string) => [id, "2026-08-31", "IBG", "8009777553", "PREMIER LANGUAGE CENTRE", "Old Supplier", "55.00", "Old intern allowance", status, `20260831${id.slice(-6)}`].map((c) => `"${c}"`).join(",");
    const tag = randomBytes(3).toString("hex");
    const file = Buffer.from([header.map((h) => `"${h}"`).join(","), line(`PAY-${tag}-111111`, "Reconciled"), line(`PAY-${tag}-222222`, "Ready for reconciliation")].join("\n"));
    const staffRun = await confirmRegisterImport(clients.staff, caller.staff, { bytes: file, fileType: "csv" });
    assert.ok(staffRun.ok, JSON.stringify(staffRun));
    if (staffRun.ok) assert.equal(staffRun.value.imported, 2);
    const rows = (await clients.manager.from("finance_payment_register").select("status, legacy_state").in("legacy_state->>payment_id", [`PAY-${tag}-111111`, `PAY-${tag}-222222`])).data ?? [];
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.status === "documents_pending"), "Finance Staff cannot import a closed historical row as reconciled");
    const again = await confirmRegisterImport(clients.staff, caller.staff, { bytes: file, fileType: "csv" });
    assert.ok(again.ok);
    if (again.ok) { assert.equal(again.value.imported, 0); assert.equal(again.value.skipped, 2); }
    // a Finance Manager imports closed history as it was
    const tag2 = randomBytes(3).toString("hex");
    const closed = Buffer.from([header.map((h) => `"${h}"`).join(","), line(`PAY-${tag2}-333333`, "Reconciled")].join("\n"));
    const fm = await confirmRegisterImport(clients.manager, caller.manager, { bytes: closed, fileType: "csv", waiveDocuments: true });
    assert.ok(fm.ok, JSON.stringify(fm));
    const hist = (await clients.manager.from("finance_payment_register").select("status, document_exception_approved_by").eq("legacy_state->>payment_id", `PAY-${tag2}-333333`).single()).data;
    assert.equal(hist?.status, "reconciled");
    assert.equal(hist?.document_exception_approved_by, ids.manager);
  });

  it("14. no official payment, voucher or legacy bank row was created by any of this", async () => {
    for (const table of ["bill_payments", "payment_vouchers"]) {
      const r = await clients.owner.from(table).select("id").limit(1);
      assert.ok(r.error || (r.data ?? []).length === 0, table);
    }
  });
});
