"use strict";
// Focused Stage 1B application tests (no framework, no database, no network).
// Run from the repo root:  node --test tests/stage1b-app-fix.test.cjs
// They execute the REAL source of the API routes and of the UI handlers in app/phase2-workspace.tsx
// (transpiled with the TypeScript compiler already in node_modules) against a scripted fake Supabase client.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const ts = require(path.join(ROOT, "node_modules", "typescript"));
const RealDate = Date;

const BILL = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENTITY = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

// ---------- loaders ----------
function transpile(source, fileName) {
  return ts.transpileModule(source, { fileName, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
}
function loadModule(rel, deps = {}, globals = {}) {
  const code = transpile(fs.readFileSync(path.join(ROOT, rel), "utf8"), rel);
  const mod = { exports: {} };
  const names = Object.keys(globals);
  const req = (id) => { if (id in deps) return deps[id]; throw new Error(`unexpected import ${id} in ${rel}`); };
  new Function("require", "module", "exports", ...names, code)(req, mod, mod.exports, ...names.map((k) => globals[k]));
  return mod.exports;
}
const verification = loadModule("lib/bill-verification.ts");
const NextResponse = { json: (body, init) => ({ status: (init && init.status) || 200, body }) };

// ---------- fake supabase ----------
function makeClient({ user, handler }) {
  const log = [];
  const client = {
    log,
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    from(table) {
      const q = { table, op: "select", payload: null, columns: null, filters: [], mode: "many" };
      const exec = () => { const snap = { ...q, filters: q.filters.map((f) => [...f]) }; log.push(snap); return Promise.resolve(handler(snap)); };
      const api = {
        select(cols) { q.columns = cols; return api; },
        insert(p) { q.op = "insert"; q.payload = p; return api; },
        update(p) { q.op = "update"; q.payload = p; return api; },
        eq(c, v) { q.filters.push(["eq", c, v]); return api; },
        lte(c, v) { q.filters.push(["lte", c, v]); return api; },
        limit() { return api; },
        order() { return api; },
        single() { q.mode = "single"; return exec(); },
        maybeSingle() { q.mode = "maybe"; return exec(); },
        then(res, rej) { return exec().then(res, rej); },
      };
      return api;
    },
  };
  return client;
}
const serverDeps = (client) => ({ "@/lib/supabase/server": { createClient: async () => client }, "next/server": { NextResponse }, "@/lib/bill-verification": verification });
const jsonRequest = (body) => new Request("http://localhost/api/test", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const writes = (client) => client.log.filter((q) => q.op !== "select");
const tablesTouched = (client) => client.log.map((q) => q.table);

// ---------- /api/bills/verify scenarios ----------
function verifyScenario(o = {}) {
  const user = "user" in o ? o.user : { id: USER };
  const bill = "bill" in o ? o.bill : { id: BILL, entity_id: ENTITY, payment_status: "draft" };
  const client = makeClient({
    user,
    handler(q) {
      if (q.table === "app_profiles") return { data: o.role === undefined ? null : { role: o.role, active_status: o.active !== false }, error: null };
      if (q.table === "supplier_bills" && q.op === "select") {
        if (q.columns === "payment_status") return { data: { payment_status: o.currentStatus ?? (bill && bill.payment_status) }, error: null };
        return { data: bill, error: null };
      }
      if (q.table === "supplier_bills" && q.op === "update") {
        if (q.payload.payment_status === "unpaid") return o.updateResult ?? { data: [{ id: BILL }], error: null };
        return o.revertResult ?? { data: [{ id: BILL }], error: null };
      }
      if (q.table === "audit_logs") return o.auditResult ?? { data: null, error: null };
      throw new Error(`unexpected query on ${q.table}`);
    },
  });
  const route = loadModule("app/api/bills/verify/route.ts", serverDeps(client));
  return { client, post: (body) => route.POST(jsonRequest(body)) };
}

// ---------- UI handler harness (real source from app/phase2-workspace.tsx) ----------
const uiSource = fs.readFileSync(path.join(ROOT, "app/phase2-workspace.tsx"), "utf8");
const uiSf = ts.createSourceFile("app/phase2-workspace.tsx", uiSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const uiFns = {};
(function walk(n) {
  if (ts.isFunctionDeclaration(n) && n.name && ["currentUserId", "loadRole", "verifyBill", "saveBill", "savePayment", "generateDrafts"].includes(n.name.text)) uiFns[n.name.text] = n.getText(uiSf);
  ts.forEachChild(n, walk);
})(uiSf);
for (const name of ["currentUserId", "loadRole", "verifyBill", "saveBill", "savePayment", "generateDrafts"]) assert.ok(uiFns[name], `UI function ${name} not found`);
const uiJs = transpile(Object.values(uiFns).join("\n"), "ui-fns.ts");

function makeUi(o = {}) {
  const seen = { errors: [], messages: [], fetches: [], confirms: [], loads: 0, roleSet: [] };
  const state = {
    db: o.db, role: o.role ?? null, canVerifyBill: verification.canVerifyBill, canRecordPaymentAgainst: verification.canRecordPaymentAgainst,
    bill: o.bill, payment: o.payment, bills: o.bills ?? [{ id: "bill-1", entity_id: ENTITY }], billFiles: [], today: "2026-10-02", emptyBill: {},
    setError: (m) => { if (m) seen.errors.push(m); }, setMessage: (m) => seen.messages.push(m), setBill() {}, setBillFiles() {}, setPayment() {}, setRole: (r) => seen.roleSet.push(r),
    load: async () => { seen.loads++; }, uploadDocs: async () => true,
    window: { confirm: (m) => { seen.confirms.push(m); return o.confirm !== false; } },
    fetch: async (url, init) => { seen.fetches.push({ url, body: init && init.body ? JSON.parse(init.body) : null }); const r = await o.fetch(url, init); return { ok: r.status < 400, status: r.status, json: async () => r.body }; },
  };
  const names = Object.keys(state);
  const fns = new Function(...names, `${uiJs}\nreturn { currentUserId, loadRole, verifyBill, saveBill, savePayment, generateDrafts };`)(...names.map((k) => state[k]));
  return { fns, seen };
}
const draftBill = { id: BILL, description: "Test bill", payment_status: "draft", entity_id: ENTITY };
const ev = { preventDefault() {} };

// =====================================================================================
// 1-3, 7, 8: allowed roles, end to end (UI handler -> real API route)
// =====================================================================================
for (const role of ["owner", "finance_manager", "finance_staff"]) {
  test(`1-3/7/8: ${role} verifies draft -> unpaid (UI -> API), update is guarded and audited with the authenticated actor`, async () => {
    const s = verifyScenario({ role });
    const ui = makeUi({ role, fetch: (url, init) => s.post(JSON.parse(init.body)) });
    assert.equal(verification.canVerifyBill(role, draftBill), true);
    assert.equal(await ui.fns.verifyBill(draftBill), true);
    assert.deepEqual(ui.seen.fetches, [{ url: "/api/bills/verify", body: { bill_id: BILL } }]);
    assert.equal(ui.seen.confirms.length, 1);
    assert.equal(ui.seen.loads, 1);
    const upd = writes(s.client).filter((q) => q.table === "supplier_bills");
    assert.equal(upd.length, 1);
    assert.deepEqual(upd[0].payload, { payment_status: "unpaid" });
    assert.deepEqual(upd[0].filters, [["eq", "id", BILL], ["eq", "payment_status", "draft"]]);
    const audit = writes(s.client).filter((q) => q.table === "audit_logs");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].payload.actor_user_id, USER);
    assert.equal(audit[0].payload.action, "supplier_bill_verified");
    assert.equal(audit[0].payload.entity_id, ENTITY);
    assert.deepEqual(audit[0].payload.payload, { bill_id: BILL, previous_status: "draft", new_status: "unpaid" });
    assert.deepEqual(audit[0].payload.before_data, { payment_status: "draft" });
    assert.deepEqual(audit[0].payload.after_data, { payment_status: "unpaid" });
    assert.equal(audit[0].payload.is_demo, false);
  });
}

test("8: actor id and target status come from the session/route, never from request input", async () => {
  const s = verifyScenario({ role: "finance_staff" });
  const res = await s.post({ bill_id: BILL, actor_user_id: "attacker", status: "paid", payment_status: "paid", new_status: "cancelled", created_by: "attacker" });
  assert.equal(res.status, 200);
  const upd = writes(s.client).find((q) => q.table === "supplier_bills");
  assert.deepEqual(upd.payload, { payment_status: "unpaid" });
  const audit = writes(s.client).find((q) => q.table === "audit_logs");
  assert.equal(audit.payload.actor_user_id, USER);
  assert.equal(audit.payload.after_data.payment_status, "unpaid");
});

// =====================================================================================
// 4, 5: roles that must NOT verify (Hermes FinanceOps / data_entry / non-finance)
// =====================================================================================
for (const role of ["data_entry", "management", "read_only", "branch_manager", "counsellor", "marketing", "student_services", "trainer", "intern", "", null]) {
  test(`4-5: role ${JSON.stringify(role)} cannot verify: UI blocks it and the API refuses before any bill read or write`, async () => {
    assert.equal(verification.canVerifyBill(role, draftBill), false);
    const s = verifyScenario({ role: role === null ? undefined : role });
    const ui = makeUi({ role, fetch: (url, init) => s.post(JSON.parse(init.body)) });
    assert.equal(await ui.fns.verifyBill(draftBill), false);
    assert.equal(ui.seen.fetches.length, 0, "UI must not even call the API");
    assert.equal(ui.seen.errors.length, 1);
    const res = await s.post({ bill_id: BILL });
    assert.equal(res.status, 403);
    assert.deepEqual([...new Set(tablesTouched(s.client))], ["app_profiles"]);
    assert.equal(writes(s.client).length, 0);
  });
}
test("4-5: an inactive finance_staff profile cannot verify", async () => {
  const s = verifyScenario({ role: "finance_staff", active: false });
  assert.equal((await s.post({ bill_id: BILL })).status, 403);
  assert.equal(writes(s.client).length, 0);
});
test("4-5: signed-out caller gets 401 and nothing is queried; malformed bill_id gets 400", async () => {
  const out = verifyScenario({ user: null, role: "owner" });
  assert.equal((await out.post({ bill_id: BILL })).status, 401);
  assert.equal(out.client.log.length, 0);
  for (const body of [{}, { bill_id: 5 }, { bill_id: "not-a-uuid" }, "not json"]) {
    const s = verifyScenario({ role: "owner" });
    assert.equal((await s.post(body)).status, 400, JSON.stringify(body));
    assert.equal(s.client.log.length, 0);
  }
});

// =====================================================================================
// 6: only draft bills can use the action; DB denial surfaces; no other transitions
// =====================================================================================
for (const status of ["unpaid", "scheduled", "partially_paid", "overdue", "paid", "cancelled"]) {
  test(`6: a ${status} bill cannot be verified (UI hides it, API returns 409, nothing written)`, async () => {
    assert.equal(verification.canVerifyBill("owner", { payment_status: status }), false);
    const s = verifyScenario({ role: "owner", bill: { id: BILL, entity_id: ENTITY, payment_status: status } });
    const res = await s.post({ bill_id: BILL });
    assert.equal(res.status, 409);
    assert.equal(writes(s.client).length, 0);
  });
}
test("6: missing bill -> 404; lost race (now not draft) -> 409; denied by RLS (still draft, 0 rows) -> 403; trigger error -> 403 with no audit", async () => {
  assert.equal((await verifyScenario({ role: "owner", bill: null }).post({ bill_id: BILL })).status, 404);
  const race = verifyScenario({ role: "owner", updateResult: { data: [], error: null }, currentStatus: "unpaid" });
  assert.equal((await race.post({ bill_id: BILL })).status, 409);
  assert.equal(writes(race.client).filter((q) => q.table === "audit_logs").length, 0);
  const denied = verifyScenario({ role: "finance_staff", updateResult: { data: [], error: null }, currentStatus: "draft" });
  assert.equal((await denied.post({ bill_id: BILL })).status, 403);
  const trig = verifyScenario({ role: "finance_staff", updateResult: { data: null, error: { message: "Data Entry users may only maintain bill drafts" } } });
  const r = await trig.post({ bill_id: BILL });
  assert.equal(r.status, 403);
  assert.equal(writes(trig.client).filter((q) => q.table === "audit_logs").length, 0);
});
test("8: if the audit write fails the verification is reverted (fail closed); if the revert also fails it is reported", async () => {
  const a = verifyScenario({ role: "owner", auditResult: { data: null, error: { message: "audit down" } } });
  const ra = await a.post({ bill_id: BILL });
  assert.equal(ra.status, 500);
  const updates = writes(a.client).filter((q) => q.table === "supplier_bills");
  assert.deepEqual(updates.map((u) => u.payload.payment_status), ["unpaid", "draft"]);
  assert.deepEqual(updates[1].filters, [["eq", "id", BILL], ["eq", "payment_status", "unpaid"]]);
  const b = verifyScenario({ role: "owner", auditResult: { data: null, error: { message: "audit down" } }, revertResult: { data: [], error: null } });
  const rb = await b.post({ bill_id: BILL });
  assert.equal(rb.status, 500);
  assert.equal(rb.body.status_changed, true);
});

// =====================================================================================
// Security: nobody can reach a voucher from a draft; no service-role use
// =====================================================================================
test("6/security: /api/payment-vouchers/generate still rejects a draft bill and creates nothing", async () => {
  const client = makeClient({
    user: { id: USER },
    handler(q) { if (q.table === "supplier_bills") return { data: { ...draftBill, supplier_id: null }, error: null }; throw new Error(`draft bill must stop before touching ${q.table}`); },
  });
  const route = loadModule("app/api/payment-vouchers/generate/route.ts", serverDeps(client));
  const res = await route.POST(jsonRequest({ billId: BILL }));
  assert.equal(res.status, 409);
  assert.equal(writes(client).length, 0);
});
test("security: new/changed server code uses the caller's session client only (no service role / admin client)", () => {
  for (const rel of ["app/api/bills/verify/route.ts", "app/api/recurring/generate/route.ts", "lib/bill-verification.ts"]) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.ok(!/service[_-]?role|SERVICE_ROLE|auth\.admin|createAdminClient|supabase-js/i.test(src), rel);
  }
  assert.deepEqual([...verification.BILL_VERIFIER_ROLES], ["owner", "finance_manager", "finance_staff"]);
});

// =====================================================================================
// Recurring generator (9-14)
// =====================================================================================
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super("2026-11-01T01:00:00Z"); else super(...a); }
  static now() { return new RealDate("2026-11-01T01:00:00Z").getTime(); }
}
const NEXT_GEN = new RealDate(2026, 11, 1).toISOString().slice(0, 10); // same expression the route uses
const OB1 = { id: "ob-1", entity_id: ENTITY, supplier_id: "s-1", description: "Rent", due_day: 5, expected_amount: 100, expense_category_id: null, required_document_type: "invoice", auto_generate_pv: true, is_demo: false, data_origin: "manual" };
const OB2 = { ...OB1, id: "ob-2", description: "Wifi", expected_amount: 50 };

function recurringScenario({ obligations = [OB1], insertResult, existingResult, scheduleResult, auditResult } = {}) {
  const client = makeClient({
    user: { id: USER },
    handler(q) {
      if (q.table === "recurring_obligations" && q.op === "select") return { data: obligations, error: null };
      if (q.table === "supplier_bills" && q.op === "insert") return (insertResult ? insertResult(q.payload) : { data: { id: `bill-${q.payload.recurring_obligation_id}` }, error: null });
      if (q.table === "supplier_bills" && q.op === "select") return (existingResult ? existingResult(q) : { data: [], error: null });
      if (q.table === "recurring_obligations" && q.op === "update") { const id = q.filters.find((f) => f[1] === "id")[2]; return (scheduleResult ? scheduleResult(id) : { data: [{ id }], error: null }); }
      if (q.table === "audit_logs") return auditResult ?? { data: null, error: null };
      throw new Error(`recurring generator must not touch ${q.table}`);
    },
  });
  const route = loadModule("app/api/recurring/generate/route.ts", serverDeps(client), { Date: FakeDate });
  return { client, post: () => route.POST() };
}
const billInserts = (c) => c.log.filter((q) => q.table === "supplier_bills" && q.op === "insert");
const scheduleUpdates = (c) => c.log.filter((q) => q.table === "recurring_obligations" && q.op === "update");

test("9/10/12/14: generated bill is a draft with full linkage, no Payment Voucher is touched, schedule advances, response contract", async () => {
  const s = recurringScenario({ obligations: [{ ...OB1, auto_generate_pv: true }] });
  const res = await s.post();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { bills_created: 1, bills_existing: 0, errors: [] });
  const [ins] = billInserts(s.client);
  assert.equal(ins.payload.payment_status, "draft");
  assert.equal(ins.payload.is_recurring_generated, true);
  assert.equal(ins.payload.recurring_obligation_id, "ob-1");
  assert.equal(ins.payload.generated_month, "2026-11");
  assert.equal(ins.payload.created_by, USER);
  assert.equal(ins.payload.entity_id, ENTITY);
  assert.equal(ins.payload.supplier_id, "s-1");
  assert.ok(!tablesTouched(s.client).some((t) => t === "payment_vouchers" || t === "payment_voucher_items"), "no voucher tables may be touched");
  const [upd] = scheduleUpdates(s.client);
  assert.equal(upd.payload.next_generation_date, NEXT_GEN);
  assert.equal(upd.payload.last_generated_date, "2026-11-01");
  assert.deepEqual(upd.filters, [["eq", "id", "ob-1"]]);
  if (process.env.TZ === "UTC") assert.equal(NEXT_GEN, "2026-12-01");
});

test("11: a failed insert does NOT advance next_generation_date, is reported and audited, and the loop continues", async () => {
  const s = recurringScenario({
    obligations: [OB1, OB2],
    insertResult: (p) => (p.recurring_obligation_id === "ob-1" ? { data: null, error: { code: "23514", message: "check constraint failed" } } : { data: { id: "b2" }, error: null }),
  });
  const res = await s.post();
  assert.equal(res.body.bills_created, 1);
  assert.equal(res.body.errors.length, 1);
  assert.deepEqual({ ...res.body.errors[0] }, { obligation_id: "ob-1", description: "Rent", stage: "bill", code: "23514", message: "check constraint failed" });
  assert.deepEqual(scheduleUpdates(s.client).map((u) => u.filters[0][2]), ["ob-2"], "only the successful obligation advances");
  const audit = s.client.log.filter((q) => q.table === "audit_logs");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].payload.action, "recurring_bill_generation_failed");
  assert.equal(audit[0].payload.actor_user_id, USER);
  assert.equal(audit[0].payload.is_demo, false);
});
test("11: an RLS denial (caller not allowed to create bills) never advances the schedule and writes no audit spam", async () => {
  const s = recurringScenario({ insertResult: () => ({ data: null, error: { code: "42501", message: "new row violates row-level security policy" } }) });
  const res = await s.post();
  assert.equal(res.body.bills_created, 0);
  assert.equal(res.body.errors.length, 1);
  assert.equal(scheduleUpdates(s.client).length, 0);
  assert.equal(s.client.log.filter((q) => q.table === "audit_logs").length, 0);
});
test("11: an old-style 'unpaid' bill would be rejected by 0022, so the generator must never send it", async () => {
  const s = recurringScenario();
  await s.post();
  assert.ok(billInserts(s.client).every((q) => q.payload.payment_status === "draft"));
});

test("13: duplicate month with the bill confirmed to exist is idempotent: no second bill, counted as existing, schedule advances", async () => {
  const s = recurringScenario({
    insertResult: () => ({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }),
    existingResult: () => ({ data: [{ id: "already" }], error: null }),
  });
  const res = await s.post();
  assert.deepEqual(res.body, { bills_created: 0, bills_existing: 1, errors: [] });
  assert.equal(billInserts(s.client).length, 1, "exactly one insert attempt, no second bill");
  const lookup = s.client.log.find((q) => q.table === "supplier_bills" && q.op === "select");
  assert.deepEqual(lookup.filters, [["eq", "recurring_obligation_id", "ob-1"], ["eq", "generated_month", "2026-11"]]);
  assert.equal(scheduleUpdates(s.client).length, 1);
});
test("13: duplicate reported but the existing bill cannot be confirmed -> error, schedule NOT advanced", async () => {
  const s = recurringScenario({
    insertResult: () => ({ data: null, error: { code: "23505", message: "duplicate key" } }),
    existingResult: () => ({ data: [], error: null }),
  });
  const res = await s.post();
  assert.equal(res.body.bills_existing, 0);
  assert.equal(res.body.errors.length, 1);
  assert.equal(scheduleUpdates(s.client).length, 0);
});
test("12: a schedule update that is denied/0-row is surfaced (not silent) and not audited when it is a permission case", async () => {
  const s = recurringScenario({ scheduleResult: () => ({ data: [], error: null }) });
  const res = await s.post();
  assert.equal(res.body.bills_created, 1);
  assert.equal(res.body.errors.length, 1);
  assert.equal(res.body.errors[0].stage, "schedule");
  assert.equal(s.client.log.filter((q) => q.table === "audit_logs").length, 0);
});

test("14: response contract matches the UI caller (generateDrafts) for success, existing and errors", async () => {
  const ok = recurringScenario({ obligations: [OB1, OB2], insertResult: (p) => (p.recurring_obligation_id === "ob-1" ? { data: null, error: { code: "23505", message: "dup" } } : { data: { id: "n" }, error: null }), existingResult: () => ({ data: [{ id: "x" }], error: null }) });
  const ui = makeUi({ fetch: () => ok.post() });
  await ui.fns.generateDrafts();
  assert.equal(ui.seen.errors.length, 0);
  assert.match(ui.seen.messages[0], /^Generated 1 bill draft\(s\) \(1 already existed\)\. Drafts must be verified before payment\.$/);
  assert.equal(ui.seen.loads, 1);

  const bad = recurringScenario({ insertResult: () => ({ data: null, error: { code: "23514", message: "check constraint failed" } }) });
  const ui2 = makeUi({ fetch: () => bad.post() });
  await ui2.fns.generateDrafts();
  assert.equal(ui2.seen.errors.length, 1);
  assert.match(ui2.seen.errors[0], /1 recurring bill\(s\) could not be generated: check constraint failed/);

  const down = makeUi({ fetch: async () => ({ status: 401, body: { error: "Unauthorized" } }) });
  await down.fns.generateDrafts();
  assert.deepEqual(down.seen.errors, ["Unauthorized"]);

  const routeSrc = fs.readFileSync(path.join(ROOT, "app/api/recurring/generate/route.ts"), "utf8");
  assert.ok(/bills_created/.test(routeSrc) && /bills_existing/.test(routeSrc) && /errors/.test(routeSrc));
  assert.ok(!/vouchers_created|json\.created\b/.test(uiFns.generateDrafts + routeSrc));
});

// =====================================================================================
// 15: e2aefea created_by fixes remain intact (Supplier Bill + Bill Payment)
// =====================================================================================
function dbFor(user) {
  const calls = [];
  const db = {
    auth: { getUser: async () => ({ data: { user }, error: null }), getSession() { throw new Error("getSession must not be used"); } },
    from(table) { return { insert(payload) { calls.push({ table, payload }); const r = { data: { id: "new" }, error: null }; const p = Promise.resolve(r); p.select = () => ({ single: () => Promise.resolve(r) }); return p; } }; },
  };
  return { db, calls };
}
const baseBill = { entity_id: ENTITY, supplier_id: "s", description: "t", bill_number: "n", bill_type: "supplier_invoice", bill_date: "2026-10-02", due_date: "2026-10-02", subtotal: "1", tax_amount: "0", total_amount: "1", payment_status: "paid", expense_category_id: "", remarks: "", created_by: "attacker" };
const basePayment = { supplier_bill_id: "bill-1", payment_voucher_id: "", amount: "1", payment_date: "2026-10-02", method: "bank_transfer", payment_reference: "", remarks: "", created_by: "attacker" };

test("15: Supplier Bill insert still sends created_by = session user and a hard-coded draft status (form values ignored)", async () => {
  const { db, calls } = dbFor({ id: USER });
  const ui = makeUi({ db, bill: { ...baseBill }, payment: basePayment, fetch: async () => ({ status: 200, body: {} }) });
  await ui.fns.saveBill(ev);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].table, "supplier_bills");
  assert.equal(calls[0].payload.created_by, USER);
  assert.equal(calls[0].payload.payment_status, "draft");
});
test("15: Bill Payment insert still sends created_by = session user; signed-out saves insert nothing", async () => {
  const ok = dbFor({ id: USER });
  await makeUi({ db: ok.db, bill: baseBill, payment: { ...basePayment }, fetch: async () => ({ status: 200, body: {} }) }).fns.savePayment(ev);
  assert.equal(ok.calls[0].table, "bill_payments");
  assert.equal(ok.calls[0].payload.created_by, USER);
  const out = dbFor(null);
  const ui = makeUi({ db: out.db, bill: baseBill, payment: { ...basePayment }, fetch: async () => ({ status: 200, body: {} }) });
  await ui.fns.saveBill(ev); await ui.fns.savePayment(ev);
  assert.equal(out.calls.length, 0);
});
test("loadRole reads the role of the authenticated user only", async () => {
  const seen = [];
  const db = { auth: { getUser: async () => ({ data: { user: { id: USER } } }) }, from(t) { const q = { t, f: [] }; const api = { select() { return api; }, eq(c, v) { q.f.push([c, v]); return api; }, maybeSingle: async () => { seen.push(q); return { data: { role: "finance_staff" } }; } }; return api; } };
  const ui = makeUi({ db, fetch: async () => ({ status: 200, body: {} }) });
  await ui.fns.loadRole();
  assert.deepEqual(ui.seen.roleSet, ["finance_staff"]);
  assert.deepEqual(seen[0].f, [["id", USER]]);
});

// =====================================================================================
// Payment entry ("Record an existing bill payment") must not offer unverified or cancelled bills
// =====================================================================================
const crypto = require("node:crypto");

test("payment entry: draft and cancelled are not eligible; every other status is unchanged", () => {
  assert.equal(verification.canRecordPaymentAgainst({ payment_status: "draft" }), false);
  assert.equal(verification.canRecordPaymentAgainst({ payment_status: "cancelled" }), false);
  for (const s of ["unpaid", "scheduled", "partially_paid", "overdue", "paid"]) assert.equal(verification.canRecordPaymentAgainst({ payment_status: s }), true, s);
  assert.equal(verification.canRecordPaymentAgainst(null), false);
  assert.equal(verification.canRecordPaymentAgainst(undefined), false);
  assert.deepEqual([...verification.PAYMENT_ENTRY_EXCLUDED_STATUSES], ["draft", "cancelled"]);
});

test("payment entry: the real <PaymentForm bills=...> expression hides draft/cancelled bills and keeps eligible ones", () => {
  const usages = [];
  (function walk(n) {
    if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText(uiSf) === "PaymentForm") {
      const attr = n.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(uiSf) === "bills");
      usages.push(attr && attr.initializer && attr.initializer.expression ? attr.initializer.expression.getText(uiSf) : null);
    }
    ts.forEachChild(n, walk);
  })(uiSf);
  assert.equal(usages.length, 1, "exactly one PaymentForm call site");
  const expr = usages[0];
  assert.ok(expr && /canRecordPaymentAgainst/.test(expr), `bills prop must be filtered, got: ${expr}`);
  const bills = [
    { id: "d", payment_status: "draft" }, { id: "c", payment_status: "cancelled" }, { id: "u", payment_status: "unpaid" },
    { id: "p", payment_status: "partially_paid" }, { id: "s", payment_status: "scheduled" }, { id: "o", payment_status: "overdue" }, { id: "x", payment_status: "paid" },
  ];
  const shown = new Function("bills", "canRecordPaymentAgainst", `return ${expr};`)(bills, verification.canRecordPaymentAgainst).map((b) => b.id);
  assert.deepEqual(shown, ["u", "p", "s", "o", "x"]);
  assert.ok(!shown.includes("d") && !shown.includes("c"));
});

function paymentDb(user, insertError = null) {
  const calls = [];
  const db = {
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    from(table) { return { insert(payload) { calls.push({ table, payload }); return Promise.resolve({ data: null, error: insertError }); } }; },
  };
  return { db, calls };
}
const payBills = [
  { id: "bill-draft", entity_id: ENTITY, payment_status: "draft" },
  { id: "bill-cancelled", entity_id: ENTITY, payment_status: "cancelled" },
  { id: "bill-unpaid", entity_id: ENTITY, payment_status: "unpaid" },
  { id: "bill-partial", entity_id: ENTITY, payment_status: "partially_paid" },
];
const payment = (id) => ({ ...basePayment, supplier_bill_id: id });

test("payment entry: savePayment refuses a draft or cancelled bill (stale selection) and inserts nothing", async () => {
  for (const id of ["bill-draft", "bill-cancelled", "bill-missing", ""]) {
    const { db, calls } = paymentDb({ id: USER });
    const ui = makeUi({ db, bills: payBills, bill: baseBill, payment: payment(id), fetch: async () => ({ status: 200, body: {} }) });
    await ui.fns.savePayment(ev);
    assert.equal(calls.length, 0, id);
    assert.equal(ui.seen.errors.length, 1, id);
    assert.equal(ui.seen.messages.length, 0, id);
  }
});

test("payment entry: an eligible payable bill still records a payment with created_by = session user", async () => {
  for (const id of ["bill-unpaid", "bill-partial"]) {
    const { db, calls } = paymentDb({ id: USER });
    const ui = makeUi({ db, bills: payBills, bill: baseBill, payment: payment(id), fetch: async () => ({ status: 200, body: {} }) });
    await ui.fns.savePayment(ev);
    assert.equal(calls.length, 1, id);
    assert.equal(calls[0].table, "bill_payments");
    assert.equal(calls[0].payload.supplier_bill_id, id);
    assert.equal(calls[0].payload.created_by, USER);
    assert.equal(calls[0].payload.entity_id, ENTITY);
    assert.deepEqual(ui.seen.errors, []);
    assert.deepEqual(ui.seen.messages, ["Payment recorded."]);
  }
});

test("payment entry: AAL2 / Owner-Finance-Manager enforcement stays in the database; a DB rejection is surfaced, not swallowed", async () => {
  const { db, calls } = paymentDb({ id: USER }, { message: "new row violates row-level security policy for table \"bill_payments\"" });
  const ui = makeUi({ db, bills: payBills, bill: baseBill, payment: payment("bill-unpaid"), fetch: async () => ({ status: 200, body: {} }) });
  await ui.fns.savePayment(ev);
  assert.equal(calls.length, 1, "the insert is still attempted through the user's own client so RLS decides");
  assert.equal(ui.seen.errors.length, 1);
  assert.match(ui.seen.errors[0], /row-level security/);
  assert.deepEqual(ui.seen.messages, [], "no success message on rejection");
  // the app adds no role/AAL logic of its own to the payment path
  assert.ok(!/aal|mfa|role|owner|finance_manager|service[_-]?role/i.test(uiFns.savePayment), "savePayment must not add role/AAL handling");
});

test("scope: migrations 0021/0022 are byte-identical to the release (git blob hashes) and no 0023 exists", () => {
  const gitBlobSha = (rel) => {
    const lf = Buffer.from(fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n"), "utf8");
    return crypto.createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${lf.length}\0`), lf])).digest("hex");
  };
  assert.equal(gitBlobSha("supabase/migrations/0021_stage1b_preflight_security_hardening.sql"), "d0de140e12a903944d3fea0543be8c760628ecbf");
  assert.equal(gitBlobSha("supabase/migrations/0022_stage1b_finance_security_boundary.sql"), "1eadd009af9f127eabc1f371c33548ad627d7fb1");
  assert.ok(!fs.readdirSync(path.join(ROOT, "supabase/migrations")).some((n) => /^0023/.test(n)));
});
