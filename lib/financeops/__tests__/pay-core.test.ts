import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { documentChecklist, documentsComplete, documentsSatisfied, ensureEvidenceRequired, missingDocuments, requirementsFor } from "../payments/requirements";
import { compactName, daysBetween, digitsOnly, matchAccounts, matchNames, matchReferences, normalizePaymentMethod, parseAmount, parseDateTime } from "../payments/normalize";
import { allowedMoves, canEditDetails, type MoveContext } from "../payments/rules";
import { paymentRegisterEnabled } from "../payments/types";

describe("document requirements by payment type (never a reason to reject a payment)", () => {
  it("supplier expense: invoice + payment evidence", () => assert.deepEqual(requirementsFor("supplier_expense"), ["invoice", "payment_evidence"]));
  it("intern wage: wage schedule + payment evidence, and NO invoice", () => {
    assert.deepEqual(requirementsFor("intern_wage"), ["wage_schedule", "payment_evidence"]);
    assert.equal(requirementsFor("intern_wage").includes("invoice"), false);
  });
  it("staff claim: claim support + payment evidence; rent/deposit: agreement + payment evidence; other: payment evidence", () => {
    assert.deepEqual(requirementsFor("staff_claim"), ["claim_support", "payment_evidence"]);
    assert.deepEqual(requirementsFor("rent_deposit"), ["agreement", "payment_evidence"]);
    assert.deepEqual(requirementsFor("other"), ["payment_evidence"]);
  });
  it("payment evidence is always required", () => assert.deepEqual(ensureEvidenceRequired(["invoice"]), ["invoice", "payment_evidence"]));

  it("missing = required - available - not applicable; complete when nothing is missing", () => {
    const base = { required: requirementsFor("supplier_expense"), notApplicable: [], available: [] as never[] };
    assert.deepEqual(missingDocuments(base), ["invoice", "payment_evidence"]);
    assert.deepEqual(missingDocuments({ ...base, available: ["payment_evidence"] }), ["invoice"]);
    assert.equal(documentsComplete({ ...base, available: ["payment_evidence", "invoice"] }), true);
    assert.deepEqual(missingDocuments({ ...base, notApplicable: ["invoice"], available: ["payment_evidence"] }), []);
  });
  it("a linked supplier bill whose invoice is uploaded satisfies the invoice requirement", () => {
    assert.deepEqual(missingDocuments({ required: requirementsFor("supplier_expense"), notApplicable: [], available: ["payment_evidence"], billHasInvoice: true }), []);
    assert.deepEqual(missingDocuments({ required: requirementsFor("intern_wage"), notApplicable: [], available: ["payment_evidence"], billHasInvoice: true }), ["wage_schedule"]);
  });
  it("an approved exception satisfies the gate without pretending the documents exist", () => {
    const s = { required: requirementsFor("intern_wage"), notApplicable: [], available: [] as never[], exceptionApproved: true };
    assert.equal(documentsComplete(s), false);
    assert.equal(documentsSatisfied(s), true);
    assert.deepEqual(missingDocuments(s), ["wage_schedule", "payment_evidence"]);
  });
  it("the checklist shows the invoice as N/A for an intern wage (real wage example), present/missing for the rest", () => {
    const items = documentChecklist("intern_wage", { required: requirementsFor("intern_wage"), notApplicable: [], available: ["wage_schedule"] });
    const by = Object.fromEntries(items.map((i) => [i.role, i.state]));
    assert.deepEqual(by, { wage_schedule: "present", payment_evidence: "missing", invoice: "not_applicable" });
  });
});

describe("normalisation against real bank and register text", () => {
  it("names: OCR splits, truncation and annotations still match; different people do not", () => {
    assert.equal(matchNames("R OSLAN BIN AH MAD ( MYR )", "ROSLAN BIN AHMAD").kind, "exact");
    assert.equal(matchNames("SUVITRAA/P G ANASAN", "SUVITRA A/P GANASAN").kind, "exact");
    assert.equal(matchNames("Eveyiana Mujan Anak Mackie", "Eveyiana Mujan Anak").kind, "prefix"); // the statement truncates
    assert.equal(matchNames("Anindita Mutiara Ramadhani [source text partly unclear]", "Anindita Mutiara Ram").kind, "prefix");
    assert.equal(matchNames("Ivy Su Hui Ing", "Ivy Su Hui Ing").kind, "exact");
    assert.equal(matchNames("Ingyin May", "Sania Arshad").kind, "none");
    assert.equal(matchNames(null, "Ingyin May").kind, "none");
    assert.equal(compactName("A/P  Ganasan"), "apganasan");
  });
  it("accounts ignore spaces; the same last digits count as a suffix; short numbers never match", () => {
    assert.equal(matchAccounts("1648 3823 0856", "164838230856"), "exact");
    assert.equal(matchAccounts("8001344252", "8001344252 / INTER EXCEL"), "exact");
    assert.equal(matchAccounts("164838230856", "XXXXXX230856"), "suffix");
    assert.equal(matchAccounts("115", "115"), "none");
    assert.equal(digitsOnly("1648 3823 0856"), "164838230856");
  });
  it("references: the statement shows the TAIL of the long payment reference", () => {
    assert.equal(matchReferences("202610020349883140", "49883140"), "suffix");
    assert.equal(matchReferences("202610020349883140", "202610020349883140"), "exact");
    assert.equal(matchReferences("202610020349883140", "49883141"), "none");
    assert.equal(matchReferences("123", "123"), "none");
    assert.equal(matchReferences(null, "49883140"), "none");
  });
  it("amounts: RM, commas, parentheses, long decimals", () => {
    assert.equal(parseAmount("RM1,500.00"), 1500);
    assert.equal(parseAmount("MYR 3,500.00"), 3500);
    assert.equal(parseAmount("320.8333333"), 320.83);
    assert.equal(parseAmount("(250.00)"), -250);
    assert.equal(parseAmount("0.10"), 0.1);
    assert.equal(parseAmount(""), null);
    assert.equal(parseAmount("n/a"), null);
    assert.equal(parseAmount(782), 782);
  });
  it("dates and times as banks and the register write them", () => {
    assert.deepEqual(parseDateTime("02-Oct-2026 23:16"), { date: "2026-10-02", time: "23:16:00" });
    assert.deepEqual(parseDateTime("02/10/2026"), { date: "2026-10-02", time: null });
    assert.deepEqual(parseDateTime("2026-08-31"), { date: "2026-08-31", time: null });
    assert.deepEqual(parseDateTime("2-Oct-26 10:54:38"), { date: "2026-10-02", time: "10:54:38" });
    assert.deepEqual(parseDateTime("Not visible"), { date: null, time: null });
    assert.equal(parseDateTime("31/02/2026").date, null);
    assert.equal(parseDateTime(46297).date, "2026-10-02"); // Excel serial
    assert.equal(parseDateTime("46297").date, "2026-10-02");
    assert.equal(daysBetween("2026-10-02", "2026-10-05"), 3);
  });
  it("payment methods as the portals word them", () => {
    assert.equal(normalizePaymentMethod("In-House Transfers"), "bank_transfer");
    assert.equal(normalizePaymentMethod("Domestic Transfers"), "ibg");
    assert.equal(normalizePaymentMethod("Domestic Transfer"), "ibg");
    assert.equal(normalizePaymentMethod("IBG"), "ibg");
    assert.equal(normalizePaymentMethod("DuitNow"), "duitnow");
    assert.equal(normalizePaymentMethod("CIMB Web Portal"), "bank_transfer");
    assert.equal(normalizePaymentMethod("Cash transfer — Claire confirmation; source receipt displays DuitNow QR"), "cash");
    assert.equal(normalizePaymentMethod("Cash"), "cash");
    assert.equal(normalizePaymentMethod("carrier pigeon"), "other");
    assert.equal(normalizePaymentMethod(""), "bank_transfer");
  });
});

const ctx = (over: Partial<MoveContext> = {}): MoveContext => ({
  role: "finance_staff", actorUserId: "staff", createdByUserId: "fo", sourceType: "financeops", status: "ready_for_bank_match", hasConfirmedMatch: false, bankMatchNotApplicable: false,
  documentsSatisfied: true, missingDocuments: [], hasSqlReference: false, hasSqlPostingDate: false, hasReconciledDate: false, ...over,
});
const allowedTo = (c: MoveContext) => allowedMoves(c).filter((m) => m.allowed).map((m) => m.to);

describe("status moves offered (mirror of the 0024 trigger; the database refuses anything wrongly offered)", () => {
  it("FinanceOps (the creator of a financeops row) is offered nothing", () => {
    assert.deepEqual(allowedMoves(ctx({ role: "data_entry", actorUserId: "fo" })), []);
    assert.deepEqual(allowedMoves(ctx({ role: "finance_staff", actorUserId: "fo" })), []);
  });
  it("the intern can only tidy early statuses", () => {
    assert.deepEqual(allowedTo(ctx({ role: "data_entry", actorUserId: "intern" })), ["captured", "documents_pending"]);
    assert.deepEqual(allowedMoves(ctx({ role: "data_entry", actorUserId: "intern", status: "bank_matched" })), []);
    assert.deepEqual(allowedMoves(ctx({ role: "management", actorUserId: "m", status: "captured" })), []);
  });
  it("bank_matched needs a confirmed match; finance review needs documents or an exception", () => {
    const early = allowedMoves(ctx());
    assert.equal(early.find((m) => m.to === "bank_matched")?.allowed, false);
    assert.equal(allowedMoves(ctx({ hasConfirmedMatch: true })).find((m) => m.to === "bank_matched")?.allowed, true);
    const matched = allowedMoves(ctx({ status: "bank_matched", hasConfirmedMatch: true, documentsSatisfied: false, missingDocuments: ["invoice"] }));
    assert.match(matched.find((m) => m.to === "finance_review")?.blocker ?? "", /invoice/);
    assert.equal(allowedMoves(ctx({ status: "bank_matched", hasConfirmedMatch: true })).find((m) => m.to === "finance_review")?.allowed, true);
  });
  it("a cash payment skips the bank match only when a human marked it not applicable", () => {
    assert.equal(allowedMoves(ctx()).some((m) => m.to === "finance_review"), false);
    assert.equal(allowedMoves(ctx({ bankMatchNotApplicable: true })).find((m) => m.to === "finance_review")?.allowed, true);
  });
  it("Ready for SQL, Posted and Reconciled have their own prerequisites", () => {
    assert.equal(allowedMoves(ctx({ status: "finance_review", hasConfirmedMatch: true })).find((m) => m.to === "ready_for_sql")?.allowed, true);
    assert.equal(allowedMoves(ctx({ status: "finance_review" })).find((m) => m.to === "ready_for_sql")?.allowed, false);
    assert.equal(allowedMoves(ctx({ status: "ready_for_sql" })).find((m) => m.to === "posted_to_sql")?.allowed, false);
    assert.equal(allowedMoves(ctx({ status: "ready_for_sql", hasSqlReference: true, hasSqlPostingDate: true })).find((m) => m.to === "posted_to_sql")?.allowed, true);
    assert.equal(allowedMoves(ctx({ status: "posted_to_sql" })).find((m) => m.to === "reconciled")?.allowed, false);
    assert.equal(allowedMoves(ctx({ status: "posted_to_sql", hasReconciledDate: true })).find((m) => m.to === "reconciled")?.allowed, true);
  });
  it("only the Owner or a Finance Manager can reverse a posting or a reconciliation", () => {
    assert.equal(allowedTo(ctx({ status: "posted_to_sql", role: "finance_staff" })).includes("ready_for_sql"), false);
    assert.equal(allowedTo(ctx({ status: "posted_to_sql", role: "finance_manager", actorUserId: "fm", hasReconciledDate: true })).includes("ready_for_sql"), true);
    assert.equal(allowedTo(ctx({ status: "reconciled", role: "finance_staff" })).length, 0);
    assert.deepEqual(allowedTo(ctx({ status: "reconciled", role: "owner", actorUserId: "own" })), ["posted_to_sql"]);
  });
  it("details are editable until finance review (reviewers) / while early (intern); never by FinanceOps", () => {
    assert.equal(canEditDetails({ role: "finance_staff", actorUserId: "s", createdByUserId: "fo", sourceType: "financeops", status: "bank_matched" }), true);
    assert.equal(canEditDetails({ role: "finance_staff", actorUserId: "s", createdByUserId: "fo", sourceType: "financeops", status: "finance_review" }), false);
    assert.equal(canEditDetails({ role: "data_entry", actorUserId: "i", createdByUserId: "fo", sourceType: "manual", status: "captured" }), true);
    assert.equal(canEditDetails({ role: "data_entry", actorUserId: "i", createdByUserId: "fo", sourceType: "manual", status: "bank_matched" }), false);
    assert.equal(canEditDetails({ role: "data_entry", actorUserId: "fo", createdByUserId: "fo", sourceType: "financeops", status: "captured" }), false);
  });
});

describe("feature flag", () => {
  it("is OFF unless FINANCEOPS_PAYMENT_REGISTER_ENABLED is exactly 'true'", () => {
    assert.equal(paymentRegisterEnabled({}), false);
    for (const v of ["", "TRUE", "1", "yes", " true", "false"]) assert.equal(paymentRegisterEnabled({ FINANCEOPS_PAYMENT_REGISTER_ENABLED: v }), false, v);
    assert.equal(paymentRegisterEnabled({ FINANCEOPS_PAYMENT_REGISTER_ENABLED: "true" }), true);
  });
});
