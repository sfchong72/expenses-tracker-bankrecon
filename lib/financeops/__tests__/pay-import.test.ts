import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inferStatementMapping, mapStatementRows, markDuplicates, parsePastedStatement, parseStatementFile, summarizeStatement } from "../payments/bank-import";
import { inferEntity, inferPaymentType, inferRegisterMapping, mapRegisterRows, markRegisterDuplicates, summarizeRegisterImport, toRegisterInsert } from "../payments/register-import";

/** The Public Bank statement view Claire supplied: date+time in one cell, payee in Remark, fee rows, a Balance column (ignored). */
const STATEMENT_CSV = [
  `No,Posting Date,Sender Name,Cheque No.,Recipient's Reference,Other Payment Details,Remark,Debit Amount,Credit Amount,Balance,Transaction Description,Reference No.`,
  `1,02-Oct-2026 23:16,,,Wages,,EE XIN YI,"3,500.00",,"98,765.43",TR IBG,49877607`,
  `2,02-Oct-2026 23:16,,,,,Wages,0.10,,"98,765.33",OTHER TRANSFER FEE,49877607`,
  `3,02-Oct-2026 23:16,,,,,ROSLAN BIN AHMAD,"1,500.00",,"97,265.33",TR TO SAVINGS,49877651`,
  `4,02-Oct-2026 23:13,,,INTERN ALLOWANCE,,Eveyiana Mujan Anak,800.00,,"96,465.33",TR IBG,49882921`,
  `5,02-Oct-2026 23:13,,,INTERN ALLOWANCE,,INTERN ALLOWANCE,0.10,,"96,465.23",OTHER TRANSFER FEE,49882921`,
  `6,02-Oct-2026 23:13,,,INTERN ALLOWANCE,,Sania Arshad,321.00,,"96,144.23",TR IBG,49883140`,
  `7,03-Oct-2026 09:00,Customer Co,,,,Customer Co,,"2,000.00","98,144.23",CR TRANSFER,50000001`,
].join("\n");

describe("bank statement import (Public Bank listing, no balance needed)", () => {
  const sheet = parseStatementFile(Buffer.from(STATEMENT_CSV), "csv")[0];
  const mapping = inferStatementMapping(Object.keys(sheet.rows[0]));
  const rows = mapStatementRows(sheet.rows, mapping, { companyAccountRef: "8001344252" });

  it("recognises the columns, including the payee in Remark, and sets the balance aside", () => {
    assert.equal(mapping["Posting Date"], "transaction_date");
    assert.equal(mapping["Debit Amount"], "debit");
    assert.equal(mapping["Credit Amount"], "credit");
    assert.equal(mapping["Remark"], "payee");
    assert.equal(mapping["Reference No."], "reference");
    assert.equal(mapping["Transaction Description"], "description");
    assert.equal(mapping["Recipient's Reference"], "recipient_reference");
    assert.equal(mapping["Balance"], "ignore_balance");
  });

  it("reads date AND time from one cell, amounts with commas, short reference tails and truncated payees", () => {
    const r = rows[0];
    assert.equal(r.transactionDate, "2026-10-02");
    assert.equal(r.transactionTime, "23:16:00");
    assert.equal(r.direction, "debit");
    assert.equal(r.amount, 3500);
    assert.equal(r.bankReference, "49877607");
    assert.equal(r.payeeName, "EE XIN YI");
    assert.equal(r.description, "TR IBG | Wages");
    assert.equal(rows[3].payeeName, "Eveyiana Mujan Anak");
    assert.equal(rows[6].direction, "credit");
    assert.equal(rows[6].amount, 2000);
  });

  it("never stores a balance", () => {
    for (const r of rows) {
      assert.equal(Object.keys(r).some((k) => /balance/i.test(k)), false);
      assert.equal(JSON.stringify(r).includes("98,765") || JSON.stringify(r).includes("98765"), false);
    }
  });

  it("flags the separate OTHER TRANSFER FEE rows as bank fees (kept, but never matched to a payment)", () => {
    assert.equal(rows[1].kind, "bank_fee");
    assert.equal(rows[4].kind, "bank_fee");
    assert.equal(rows[0].kind, "payment_candidate");
    assert.equal(rows[6].kind, "credit");
    assert.ok(rows[1].warnings.some((w) => /Bank fee/.test(w)));
  });

  it("summarises debits, credits and fees", () => {
    const s = summarizeStatement(rows);
    assert.equal(s.total, 7);
    assert.equal(s.new, 7);
    assert.equal(s.debits, 6);
    assert.equal(s.credits, 1);
    assert.equal(s.fees, 2);
    assert.equal(s.debitTotal, 6121.2);
    assert.equal(s.creditTotal, 2000);
  });

  it("re-importing the same statement: every row is a duplicate, nothing is imported twice", () => {
    const existing = new Set(rows.map((r) => r.fingerprint as string));
    const again = markDuplicates(mapStatementRows(sheet.rows, mapping, { companyAccountRef: "8001344252" }), existing);
    assert.equal(summarizeStatement(again).duplicate, 7);
    assert.equal(summarizeStatement(again).new, 0);
    assert.ok(again.every((r) => r.warnings.some((w) => /Already imported/.test(w))));
  });

  it("an overlapping statement imports only the genuinely new rows", () => {
    const existing = new Set(rows.slice(0, 5).map((r) => r.fingerprint as string));
    const later = markDuplicates(rows, existing);
    assert.equal(later.filter((r) => r.state === "duplicate").length, 5);
    assert.equal(later.filter((r) => r.state === "new").length, 2);
  });

  it("the same transaction in a DIFFERENT company account is not a duplicate", () => {
    const other = mapStatementRows(sheet.rows, mapping, { companyAccountRef: "8009777553" });
    const existing = new Set(rows.map((r) => r.fingerprint as string));
    assert.equal(markDuplicates(other, existing).filter((r) => r.state === "duplicate").length, 0);
  });

  it("two genuinely identical rows in one file stay distinct (occurrence index), and re-import still dedupes both", () => {
    const csv = [`Date,Debit,Description,Reference`, `02/10/2026,50.00,Parking,P1`, `02/10/2026,50.00,Parking,P1`].join("\n");
    const s = parseStatementFile(Buffer.from(csv), "csv")[0];
    const m = mapStatementRows(s.rows, inferStatementMapping(Object.keys(s.rows[0])), { companyAccountRef: "A" });
    assert.notEqual(m[0].fingerprint, m[1].fingerprint);
    const again = markDuplicates(mapStatementRows(s.rows, inferStatementMapping(Object.keys(s.rows[0])), { companyAccountRef: "A" }), new Set(m.map((r) => r.fingerprint as string)));
    assert.equal(again.filter((r) => r.state === "duplicate").length, 2);
  });

  it("bad rows are flagged, not silently dropped; empty lines are skipped", () => {
    const csv = [`Date,Debit,Credit,Description`, `not a date,10.00,,Rent`, `02/10/2026,10.00,5.00,Both`, `02/10/2026,,,No amount`, `,,,`, `02/10/2026,12.00,,OK`].join("\n");
    const s = parseStatementFile(Buffer.from(csv), "csv")[0];
    const out = mapStatementRows(s.rows, inferStatementMapping(Object.keys(s.rows[0])), { companyAccountRef: "A" });
    assert.deepEqual(out.map((r) => r.state), ["invalid", "invalid", "invalid", "new"].slice(0, 3).concat(out.length === 4 ? ["new"] : ["empty", "new"]));
    assert.match(out[0].errors.join(), /date/);
    assert.match(out[1].errors.join(), /Both a debit and a credit/);
    assert.match(out[2].errors.join(), /Missing debit or credit/);
  });

  it("a single Amount column with a debit/credit indicator is supported", () => {
    const csv = [`Date,Amount,DR/CR,Description`, `02/10/2026,100.00,DR,Rent`, `02/10/2026,200.00,CR,Customer`, `02/10/2026,-30.00,,Fee`].join("\n");
    const s = parseStatementFile(Buffer.from(csv), "csv")[0];
    const out = mapStatementRows(s.rows, inferStatementMapping(Object.keys(s.rows[0])), { companyAccountRef: "A" });
    assert.deepEqual(out.map((r) => [r.direction, r.amount]), [["debit", 100], ["credit", 200], ["debit", 30]]);
  });

  it("rows pasted from the bank's web page (tab separated) import like a file", () => {
    const text = ["Posting Date\tRemark\tDebit Amount\tCredit Amount\tReference No.", "02-Oct-2026 23:13\tSania Arshad\t321.00\t\t49883140"].join("\n");
    const s = parsePastedStatement(text)[0];
    const out = mapStatementRows(s.rows, inferStatementMapping(Object.keys(s.rows[0])), { companyAccountRef: "A" });
    assert.equal(out.length, 1);
    assert.equal(out[0].amount, 321);
    assert.equal(out[0].payeeName, "Sania Arshad");
    assert.equal(out[0].transactionTime, "23:13:00");
  });

  it("the mapping can be corrected by the user (a different payee column)", () => {
    const m = { ...mapping, Remark: "" as const, "Sender Name": "payee" as const };
    const out = mapStatementRows(sheet.rows, m, { companyAccountRef: "A" });
    assert.equal(out[0].payeeName, null);
  });
});

// ---------------------------------------------------------------- Excel register import

const H = ["Payment ID", "Payment initiation date", "Payment initiation time", "Payment method", "IBG clearing date", "Entity", "Paid by", "Pay-from account reference", "Pay-from name", "Beneficiary", "Beneficiary account", "Amount (MYR)", "Purpose / PV description", "Supporting document", "Invoice status", "PV status", "Claim status", "Payment status", "Bank verification status", "Reconciliation status", "Source reference", "Exception / notes"];
const reg = (o: Record<string, string>): Record<string, string> => Object.fromEntries(H.map((h) => [h, o[h] ?? ""]));
const IETA_FROM = { "Pay-from account reference": "8001344252", "Pay-from name": "INTER EXCEL TOURISM ACADEMY SDN. BHD. (MYR)" };

const REGISTER_ROWS = [
  reg({ "Payment ID": "PAY-20260831-0346228889", "Payment initiation date": "2026-08-31", "Payment initiation time": "Not visible", "Payment method": "IBG", "Paid by": "Claire Chong", ...IETA_FROM, Beneficiary: "Shennaz Begum binti Mohamed Hassan", "Beneficiary account": "15804800121656", "Amount (MYR)": "782", "Purpose / PV description": "Shennaz August 2026 intern allowance", "Supporting document": "Intern wages sheet", "Invoice status": "No invoice applicable", "PV status": "Not required", "Claim status": "Personal expense — to claim", "Payment status": "Paid — IBG; clearing pending", "Bank verification status": "Awaiting bank statement", "Reconciliation status": "Ready for reconciliation", "Source reference": "202608310346227889", "Exception / notes": "Rounded up per usual practice." }),
  reg({ "Payment ID": "PAY-20260831-0346228310", "Payment initiation date": "2026-08-31", "Payment initiation time": "10:44:28", "Payment method": "IBG", ...IETA_FROM, Beneficiary: "EE XIN YI", "Beneficiary account": "02300110526", "Amount (MYR)": "3500", "Purpose / PV description": "Not provided — clarification required", "Supporting document": "50", "PV status": "To assess", "Claim status": "Needs information", "Payment status": "Paid — IBG; clearing pending", "Reconciliation status": "Ready for reconciliation", "Source reference": "202608310346228310" }),
  reg({ "Payment ID": "PAY-20260831-0346228051", "Payment initiation date": "2026-08-31", "Payment initiation time": "10:26:25", "Payment method": "Domestic Transfers", ...IETA_FROM, Beneficiary: "Anindita Mutiara Ramadhani [source text partly unclear]", "Beneficiary account": "164838230856", "Amount (MYR)": "700", "Purpose / PV description": "Anindita allowance", "Supporting document": "Intern wages sheet", "Source reference": "202608310346228051", "Reconciliation status": "Partially matched" }),
  reg({ "Payment ID": "PAY-20260902-0346497505", "Payment initiation date": "2026-09-02", "Payment initiation time": "22:07:13", "Payment method": "In-House Transfers", ...IETA_FROM, Beneficiary: "INTER EXCEL TOURISM ACADEMY SDN. BHD. (MYR)", "Beneficiary account": "1806657159", "Amount (MYR)": "1973", "Purpose / PV description": "Not provided — clarification required", "Source reference": "202609020346497505" }),
  reg({ "Payment ID": "PAY-20260903-0000000001", "Payment initiation date": "2026-09-03", "Payment method": "Domestic Transfer", "Pay-from account reference": "8009777553", "Pay-from name": "PREMIER INTERNATIONAL HOLDINGS SDN BHD (MYR)", Beneficiary: "KOSWIP Sdn Bhd", "Beneficiary account": "[masked]", "Amount (MYR)": "6830", "Purpose / PV description": "Condo rental payment September", "Supporting document": "Condo rental payment breakdown / tenancy arrangement", "Invoice status": "To link to KOSWIP landlord ledger", "Payment status": "Pending transfer", "Reconciliation status": "Held / exception", "Source reference": "202609030000000001" }),
  reg({ "Payment ID": "PAY-20260831-0346228889", "Payment initiation date": "2026-08-31", ...IETA_FROM, Beneficiary: "Shennaz Begum binti Mohamed Hassan", "Amount (MYR)": "782", "Source reference": "202608310346227889" }),
  reg({ "Payment ID": "PAY-NOAMOUNT", "Payment initiation date": "2026-09-05", ...IETA_FROM, Beneficiary: "Nobody", "Amount (MYR)": "" }),
  reg({ "Payment ID": "PAY-NOENTITY", "Payment initiation date": "2026-09-05", Beneficiary: "Somebody", "Amount (MYR)": "10", "Pay-from name": "Not visible", "Pay-from account reference": "[not visible]" }),
  reg({ "Payment ID": "PAY-SUPPLIER", "Payment initiation date": "2026-09-06", "Payment method": "CIMB Web Portal", "Pay-from account reference": "8001344252", Beneficiary: "ABC Trading", "Amount (MYR)": "1,200.50", "Purpose / PV description": "Printing", "Supporting document": "Invoice IV-008508.pdf", "Invoice status": "Invoice matched — SA/ZA/26/3Q/I-025", "Entity": "IETA" }),
  reg({}),
];

describe("one-time import of the old Excel Payment Register (your real columns)", () => {
  const mapping = inferRegisterMapping(H);
  const mapped = mapRegisterRows(REGISTER_ROWS, mapping, {});
  const marked = markRegisterDuplicates(mapped, { bankReferences: new Set(), legacyPaymentIds: new Set() });

  it("maps every column of the real sheet", () => {
    assert.equal(mapping["Payment ID"], "payment_id");
    assert.equal(mapping["Payment initiation date"], "date");
    assert.equal(mapping["Pay-from account reference"], "pay_from_ref");
    assert.equal(mapping["Pay-from name"], "pay_from_name");
    assert.equal(mapping["Beneficiary"], "beneficiary");
    assert.equal(mapping["Amount (MYR)"], "amount");
    assert.equal(mapping["Purpose / PV description"], "purpose");
    assert.equal(mapping["Source reference"], "source_reference");
    assert.equal(mapping["Exception / notes"], "notes");
    assert.equal(mapping["Reconciliation status"], "reconciliation_status");
    assert.equal(Object.values(mapping).filter(Boolean).length, 22); // every column of the real sheet is recognised
  });

  it("infers the entity from the pay-from name when the Entity column is blank (IETA / Premier = PLC)", () => {
    assert.equal(mapped[0].entityCode, "IETA");
    assert.equal(mapped[0].entityBasis, "pay_from_name");
    assert.equal(mapped[4].entityCode, "PLC");
    assert.equal(mapped[8].entityCode, "IETA");
    assert.equal(mapped[8].entityBasis, "entity_column");
    assert.equal(inferEntity("", "8001344252", "", { "8001344252": "IETA" }).basis, "account");
  });

  it("an unknown entity is an error the user resolves in the preview, or a default is applied with a warning", () => {
    assert.equal(mapped[7].state, "invalid");
    assert.match(mapped[7].errors.join(), /Entity could not be determined/);
    const withDefault = mapRegisterRows([REGISTER_ROWS[7]], mapping, { defaultEntity: "IEA" });
    assert.equal(withDefault[0].entityCode, "IEA");
    assert.ok(withDefault[0].warnings.some((w) => /default/.test(w)));
  });

  it("classifies the payment type: intern allowance = wage (no invoice needed), rent, supplier, other", () => {
    assert.equal(mapped[0].paymentType, "intern_wage");
    assert.deepEqual(mapped[0].requiredDocuments, ["wage_schedule", "payment_evidence"]);
    assert.equal(mapped[4].paymentType, "rent_deposit");
    assert.equal(mapped[8].paymentType, "supplier_expense");
    assert.equal(mapped[1].paymentType, "other");
    assert.equal(inferPaymentType({ purpose: "Staff medical claim for Sept" }), "staff_claim");
  });

  it("reads amounts, dates, times and methods; 'Not visible' and masked cells become empty, never invented", () => {
    assert.equal(mapped[0].amount, 782);
    assert.equal(mapped[8].amount, 1200.5);
    assert.equal(mapped[0].instructionDate, "2026-08-31");
    assert.equal(mapped[0].instructionTime, null);
    assert.equal(mapped[1].instructionTime, "10:44:28");
    assert.equal(mapped[0].method, "ibg");
    assert.equal(mapped[2].method, "ibg");
    assert.equal(mapped[3].method, "bank_transfer");
    assert.equal(mapped[8].method, "bank_transfer");
    assert.equal(mapped[4].beneficiaryAccountNo, null);
  });

  it("moves bracketed OCR annotations out of the name and into the notes", () => {
    assert.equal(mapped[2].beneficiaryName, "Anindita Mutiara Ramadhani");
    assert.match(mapped[2].notes ?? "", /source text partly unclear/);
  });

  it("flags what a human should look at: missing purpose, not yet executed, held or partially matched in the old register", () => {
    assert.ok(mapped[1].attentionReasons.includes("purpose_missing"));
    assert.equal(mapped[1].purpose, null);
    assert.ok(mapped[4].attentionReasons.includes("payment_not_yet_executed"));
    assert.equal(mapped[4].targetStatus, "captured");
    assert.ok(mapped[4].attentionReasons.includes("held_in_old_register"));
    assert.ok(mapped[2].attentionReasons.includes("partially_matched_in_old_register"));
    assert.equal(mapped[0].needsAttention, false);
  });

  it("imported rows start as documents_pending: the documents are not in the Hub yet", () => {
    assert.equal(mapped[0].targetStatus, "documents_pending");
    assert.equal(mapped[8].targetStatus, "documents_pending");
  });

  it("previews new / duplicate / invalid / empty: the repeated Payment ID and the blank amount are caught, nothing overwritten", () => {
    assert.equal(marked[5].state, "duplicate");
    assert.match(marked[5].duplicateOf ?? "", /same Payment ID/);
    assert.equal(marked[6].state, "invalid");
    assert.match(marked[6].errors.join(), /amount/);
    assert.equal(marked[9].state, "empty");
    const s = summarizeRegisterImport(marked);
    assert.deepEqual([s.total, s.new, s.duplicate, s.invalid, s.empty], [10, 6, 1, 2, 1]);
    assert.equal(s.byType.intern_wage, 2);
  });

  it("rows already in the Hub (bank reference or Payment ID) are duplicates on a second import", () => {
    const second = markRegisterDuplicates(mapped, { bankReferences: new Set(["202608310346228310"]), legacyPaymentIds: new Set(["pay-20260831-0346228889"]) });
    assert.equal(second[1].state, "duplicate");
    assert.match(second[1].duplicateOf ?? "", /bank reference/);
    assert.equal(second[0].state, "duplicate");
    assert.match(second[0].duplicateOf ?? "", /Payment ID/);
  });

  it("the insert keeps the old statuses as legacy_state; closed history needs Owner / Finance Manager; waiving documents too", () => {
    const base = marked[0];
    const insert = toRegisterInsert(base, { entityId: "e", createdBy: "u", ownerOrFinanceManager: false, waiveDocuments: true });
    assert.equal(insert.source_type, "excel_import");
    assert.equal(insert.status, "documents_pending");
    assert.equal("document_exception_note" in insert, false); // a non-Owner cannot waive
    assert.equal((insert.legacy_state as Record<string, string>).payment_id, "PAY-20260831-0346228889");
    assert.equal((insert.legacy_state as Record<string, string>).reconciliation_status, "Ready for reconciliation");
    assert.equal(insert.bank_reference, "202608310346227889");
    assert.equal(insert.amount, 782);
    const waived = toRegisterInsert(base, { entityId: "e", createdBy: "u", ownerOrFinanceManager: true, waiveDocuments: true });
    assert.match(String(waived.document_exception_note), /held outside the Hub/);
    const closed = { ...base, targetStatus: "reconciled" as const };
    assert.equal(toRegisterInsert(closed, { entityId: "e", createdBy: "u", ownerOrFinanceManager: false, waiveDocuments: false }).status, "documents_pending");
    assert.equal(toRegisterInsert(closed, { entityId: "e", createdBy: "u", ownerOrFinanceManager: true, waiveDocuments: false }).status, "reconciled");
  });

  it("a Reconciled / Posted status in the old sheet maps to that closed status", () => {
    const rows = mapRegisterRows([reg({ "Payment ID": "X1", "Payment initiation date": "2026-05-01", ...IETA_FROM, Beneficiary: "Old Supplier", "Amount (MYR)": "10", "Reconciliation status": "Reconciled" }), reg({ "Payment ID": "X2", "Payment initiation date": "2026-05-01", ...IETA_FROM, Beneficiary: "Old Supplier", "Amount (MYR)": "10", "Reconciliation status": "Posted to SQL" })], mapping, {});
    assert.deepEqual(rows.map((r) => r.targetStatus), ["reconciled", "posted_to_sql"]);
  });
});
