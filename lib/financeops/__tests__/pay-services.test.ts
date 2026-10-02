import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildSqlPackage, sqlPackagesToCsv, SQL_PACKAGE_COLUMNS } from "../payments/sql-package";
import { requireCaller } from "../payments/services";

/** A scripted stand-in for the caller's supabase client: just enough surface for requireCaller. */
function fakeClient(o: { user?: { id: string } | null; role?: string | null; active?: boolean; aal?: string; mfaThrows?: boolean }): SupabaseClient {
  return {
    auth: {
      getUser: async () => ({ data: { user: o.user === undefined ? { id: "u1" } : o.user } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => { if (o.mfaThrows) throw new Error("mfa down"); return { data: { currentLevel: o.aal ?? "aal1" } }; } },
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: o.role === null ? null : { role: o.role ?? "finance_staff", active_status: o.active !== false }, error: null }) }) }) }),
  } as unknown as SupabaseClient;
}
const ON = { FINANCEOPS_PAYMENT_REGISTER_ENABLED: "true" };

describe("requireCaller: flag, session, role and MFA for the human screens", () => {
  it("the module is OFF by default: nothing is served, whoever asks", async () => {
    for (const env of [{}, { FINANCEOPS_PAYMENT_REGISTER_ENABLED: "false" }, { FINANCEOPS_PAYMENT_REGISTER_ENABLED: "1" }]) {
      const r = await requireCaller(fakeClient({ role: "owner", aal: "aal2" }), env, { reviewer: true, aal2: true });
      assert.equal(r.ok, false);
      if (!r.ok) { assert.equal(r.status, 503); assert.equal(r.body.error, "payment_register_disabled"); }
    }
  });
  it("signed-out and inactive users are refused", async () => {
    const out = await requireCaller(fakeClient({ user: null }), ON, {});
    assert.equal(out.ok === false && out.status, 401);
    assert.equal((await requireCaller(fakeClient({ active: false }), ON, {})).ok, false);
    assert.equal((await requireCaller(fakeClient({ role: null }), ON, {})).ok, false);
  });
  it("reviewer-only actions refuse the intern, management, FinanceOps and everyone else", async () => {
    for (const role of ["data_entry", "management", "read_only", "counsellor"]) {
      const r = await requireCaller(fakeClient({ role, aal: "aal2" }), ON, { reviewer: true });
      assert.equal(r.ok, false, role);
      if (!r.ok) assert.equal(r.body.error, "reviewer_required");
    }
    for (const role of ["owner", "finance_manager", "finance_staff"]) assert.equal((await requireCaller(fakeClient({ role, aal: "aal2" }), ON, { reviewer: true })).ok, true, role);
  });
  it("bank data needs MFA (AAL2) even for the Owner; a failing MFA lookup counts as not AAL2", async () => {
    const low = await requireCaller(fakeClient({ role: "owner", aal: "aal1" }), ON, { reviewer: true, aal2: true });
    assert.equal(low.ok, false);
    if (!low.ok) assert.equal(low.body.error, "aal2_required");
    assert.equal((await requireCaller(fakeClient({ role: "owner", mfaThrows: true }), ON, { reviewer: true, aal2: true })).ok, false);
    assert.equal((await requireCaller(fakeClient({ role: "owner", aal: "aal2" }), ON, { reviewer: true, aal2: true })).ok, true);
  });
  it("Owner / Finance Manager only for the actions that need it", async () => {
    assert.equal((await requireCaller(fakeClient({ role: "finance_staff", aal: "aal2" }), ON, { ownerOrFm: true })).ok, false);
    assert.equal((await requireCaller(fakeClient({ role: "finance_manager", aal: "aal2" }), ON, { ownerOrFm: true })).ok, true);
  });
});

describe("the SQL posting package (prepared for a person to key into SQL Account; no connection to it)", () => {
  const pkg = buildSqlPackage({
    payment: { id: "11111111-2222-4333-8444-555555555555", payment_instruction_date: "2026-10-02", beneficiary_name: "Ingyin May", purpose: "Intern allowance Sept 2026", amount: "1250.00", currency: "MYR", account_code: "620-100", pay_from_account_ref: "8001344252", bank_reference: "202610020349882888", claim_ref: null, payroll_ref: "Sept 2026 wage sheet", payment_type: "intern_wage", notes: null },
    entityCode: "IETA",
    bill: { id: "bill-1", bill_number: "INV-9", description: "Printing" },
    bankRow: { bank_reference: "49882888", transaction_date: "2026-10-02" },
    documents: [{ doc_role: "payment_evidence", original_filename: "slip.pdf" }, { doc_role: "wage_schedule", original_filename: "wages.pdf" }],
  });
  it("carries everything the posting needs", () => {
    assert.equal(pkg.entity, "IETA");
    assert.equal(pkg.paymentDate, "2026-10-02");
    assert.equal(pkg.payee, "Ingyin May");
    assert.equal(pkg.description, "Intern allowance Sept 2026 | Sept 2026 wage sheet");
    assert.equal(pkg.amount, 1250);
    assert.equal(pkg.accountCode, "620-100");
    assert.equal(pkg.payFromAccount, "8001344252");
    assert.equal(pkg.invoiceReference, "INV-9");
    assert.equal(pkg.voucherReference, "202610020349882888");
    assert.equal(pkg.hubPaymentId, "11111111-2222-4333-8444-555555555555");
    assert.equal(pkg.linkedBill, "bill-1");
    assert.equal(pkg.bankTransactionReference, "49882888");
    assert.equal(pkg.documents, "payment_evidence: slip.pdf; wage_schedule: wages.pdf");
  });
  it("exports a CSV with one header row and one row per payment", () => {
    const csv = sqlPackagesToCsv([pkg, pkg]);
    const lines = csv.trim().split("\r\n");
    assert.equal(lines.length, 3);
    assert.equal(lines[0].split('","').length, SQL_PACKAGE_COLUMNS.length);
    assert.match(lines[1], /"Ingyin May"/);
  });
  it("neutralises spreadsheet formulas and quotes embedded quotes", () => {
    const evil = buildSqlPackage({ payment: { id: "i", payment_instruction_date: "2026-10-02", beneficiary_name: '=HYPERLINK("http://evil","x")', purpose: '+cmd|" /C calc"', amount: 5, currency: "MYR", account_code: "@SUM(A1)", pay_from_account_ref: null, bank_reference: null, claim_ref: null, payroll_ref: null, payment_type: "other", notes: null }, entityCode: "IEA", documents: [] });
    const csv = sqlPackagesToCsv([evil]);
    assert.match(csv, /"'=HYPERLINK\(""http:\/\/evil"",""x""\)"/);
    assert.match(csv, /"'@SUM\(A1\)"/);
    assert.equal(/(^|,)"[=+@]/.test(csv.split("\r\n")[1]), false);
    assert.ok(csv.includes('"5"')); // numbers stay plain text, never a formula
  });
});
