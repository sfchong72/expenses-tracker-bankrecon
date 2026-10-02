import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyBankRow, pairKey, suggestMatches, type MatchBankRow, type MatchPayment } from "../payments/matching";

/**
 * Fixtures are the real Public Bank examples Claire supplied: payment-management screenshots (long reference numbers,
 * company account 8001344252) and the statement listing (short reference tails, truncated payee names in "Remark",
 * and a separate "OTHER TRANSFER FEE 0.10" row for every transfer).
 */
const IETA = "e-ieta";
const ACCT = "8001344252";

const pay = (id: string, over: Partial<MatchPayment> = {}): MatchPayment => ({
  id, entityId: IETA, amount: 100, currency: "MYR", instructionDate: "2026-10-02", bankReference: null, payFromAccountRef: ACCT, beneficiaryName: null, beneficiaryAccountNo: null, status: "ready_for_bank_match", ...over,
});
const row = (id: string, over: Partial<MatchBankRow> = {}): MatchBankRow => ({
  id, entityId: IETA, companyAccountRef: ACCT, transactionDate: "2026-10-02", direction: "debit", amount: 100, currency: "MYR", bankReference: null, description: "TR IBG", payeeName: null, beneficiaryAccountNo: null, ...over,
});

const payments: MatchPayment[] = [
  pay("p-eveyiana", { amount: 800, bankReference: "202610020349882921", beneficiaryName: "Eveyiana Mujan Anak Mackie", beneficiaryAccountNo: "161051782101" }),
  pay("p-sania", { amount: 321, bankReference: "202610020349883140", beneficiaryName: "Sania Arshad", beneficiaryAccountNo: "164838229184" }),
  pay("p-suvitra", { amount: 400, bankReference: "202610020349883216", beneficiaryName: "SUVITRAA/P G ANASAN", beneficiaryAccountNo: "162526446296" }),
  pay("p-ivy", { amount: 700, bankReference: "202610020349882816", beneficiaryName: "I vy Su Hui Ing", beneficiaryAccountNo: "25500048897" }),
  pay("p-ingyin", { amount: 1250, bankReference: "202610020349882888", beneficiaryName: "Ingyin May", beneficiaryAccountNo: "152023754172" }),
  pay("p-roslan", { amount: 1500, bankReference: "202610020349877651", beneficiaryName: "R OSLAN BIN AH MAD ( MYR )", beneficiaryAccountNo: "7005097685" }),
  pay("p-eexinyi", { amount: 3500, bankReference: "202610020349877607", beneficiaryName: "E E XIN YI", beneficiaryAccountNo: "02300110526" }),
];

const bank: MatchBankRow[] = [
  row("b-ee", { amount: 3500, bankReference: "49877607", payeeName: "EE XIN YI", description: "Wages | TR IBG", transactionDate: "2026-10-02" }),
  row("b-ee-fee", { amount: 0.1, bankReference: "49877607", description: "OTHER TRANSFER FEE" }),
  row("b-roslan", { amount: 1500, bankReference: "49877651", payeeName: "ROSLAN BIN AHMAD", description: "TR TO SAVINGS" }),
  row("b-eve", { amount: 800, bankReference: "49882921", payeeName: "Eveyiana Mujan Anak", description: "INTERN ALLOWANCE | TR IBG" }),
  row("b-eve-fee", { amount: 0.1, bankReference: "49882921", description: "INTERN ALLOWANCE | OTHER TRANSFER FEE" }),
  row("b-sania", { amount: 321, bankReference: "49883140", payeeName: "Sania Arshad", description: "INTERN ALLOWANCE | TR IBG" }),
  row("b-ivy", { amount: 700, bankReference: "49882816", payeeName: "Ivy Su Hui Ing", description: "INTERN ALLOWANCE | TR IBG" }),
  row("b-anindita", { amount: 700, bankReference: "49877939", payeeName: "Anindita Mutiara Ram", description: "INTERN ALLOWANCE | TR IBG" }),
  row("b-credit", { direction: "credit", amount: 800, bankReference: "49882921", payeeName: "Eveyiana Mujan Anak" }),
];

const top = (list: ReturnType<typeof suggestMatches>, paymentId: string) => list.filter((s) => s.paymentId === paymentId)[0];

describe("matching against the real Public Bank examples", () => {
  const out = suggestMatches(payments, bank);

  it("RM800 Eveyiana: reference tail + exact amount + same account + truncated name -> strong", () => {
    const s = top(out, "p-eveyiana");
    assert.equal(s.bankTransactionId, "b-eve");
    assert.equal(s.confidence, "strong");
    assert.ok(s.score >= 90, String(s.score));
    const text = s.reasons.map((r) => r.text).join(" | ");
    assert.match(text, /exact amount/);
    assert.match(text, /reference matches/);
    assert.match(text, /same company bank account/);
    assert.match(text, /truncates/);
  });

  it("every other supplied example matches its own bank row strongly", () => {
    const expected: Record<string, string> = { "p-suvitra": "", "p-ivy": "b-ivy", "p-roslan": "b-roslan", "p-eexinyi": "b-ee", "p-sania": "b-sania" };
    for (const [paymentId, rowId] of Object.entries(expected)) {
      if (!rowId) continue;
      const s = top(out, paymentId);
      assert.equal(s.bankTransactionId, rowId, paymentId);
      assert.equal(s.confidence, "strong", `${paymentId}: ${s.score}`);
    }
  });

  it("the separate bank-fee rows are never suggested as payments", () => {
    assert.equal(classifyBankRow(bank[1]), "bank_fee");
    assert.equal(classifyBankRow(bank[4]), "bank_fee");
    assert.equal(out.some((s) => s.bankTransactionId === "b-ee-fee" || s.bankTransactionId === "b-eve-fee"), false);
  });

  it("a bank credit is never matched to a payment, even with the same amount and reference", () => {
    assert.equal(classifyBankRow(bank[8]), "credit");
    assert.equal(out.some((s) => s.bankTransactionId === "b-credit"), false);
  });

  it("no payment is suggested a row that belongs to a different reference with a different amount", () => {
    const sania = out.filter((s) => s.paymentId === "p-sania");
    assert.ok(sania.every((s) => s.bankTransactionId === "b-sania" || s.score < 70));
  });

  it("explains itself and returns a score, not a verdict", () => {
    for (const s of out) {
      assert.ok(s.score >= 40 && s.score <= 100);
      assert.ok(s.reasons.length > 0);
      assert.ok(["strong", "likely", "weak"].includes(s.confidence));
    }
  });
});

describe("rounding, ambiguity and the other rules", () => {
  it("RM321 bank debit vs RM320.83 payroll calculation -> a likely match for human review, not a rejection", () => {
    const out = suggestMatches([pay("p", { amount: 320.83, beneficiaryName: "Sania Arshad", bankReference: null })], [row("b", { amount: 321, payeeName: "Sania Arshad", bankReference: null })]);
    assert.equal(out.length, 1);
    assert.ok(out[0].score >= 70 && out[0].score < 90, String(out[0].score));
    assert.ok(out[0].reasons.some((r) => r.kind === "warn" && /rounding/.test(r.text)));
    // and the reverse: the payment holds 321 (as paid) while the wage sheet said 320.83
    const rev = suggestMatches([pay("p", { amount: 321, beneficiaryName: "Sania Arshad" })], [row("b", { amount: 320.83, payeeName: "Sania Arshad" })]);
    assert.equal(rev.length, 1);
  });

  it("same amount, two different people, names disambiguate (no reference needed)", () => {
    const out = suggestMatches(
      [pay("a", { amount: 400, beneficiaryName: "SUVITRA A/P GANASAN" }), pay("b", { amount: 400, beneficiaryName: "Someone Else Entirely" })],
      [row("r", { amount: 400, payeeName: "SUVITRA A/P GANASAN" })],
    );
    const a = out.find((s) => s.paymentId === "a")!;
    const b = out.find((s) => s.paymentId === "b");
    assert.ok(a.score > (b?.score ?? 0) + 5);
    assert.equal(a.ambiguous, false);
    assert.ok(a.score >= 60);
  });

  it("two equally good candidates are flagged ambiguous, capped below 70, and say so", () => {
    const out = suggestMatches([pay("a", { amount: 400 }), pay("b", { amount: 400 })], [row("r", { amount: 400 })]);
    assert.equal(out.length, 2);
    for (const s of out) {
      assert.equal(s.ambiguous, true);
      assert.ok(s.score <= 69);
      assert.ok(s.reasons.some((r) => /human must choose/.test(r.text)));
    }
  });

  it("one payment with two equally good bank rows is ambiguous too", () => {
    const out = suggestMatches([pay("a", { amount: 250 })], [row("r1", { amount: 250 }), row("r2", { amount: 250 })]);
    assert.equal(out.length, 2);
    assert.ok(out.every((s) => s.ambiguous && s.score <= 69));
  });

  it("a different company account is a different payment: disqualified", () => {
    const out = suggestMatches([pay("a", { amount: 100, payFromAccountRef: "8009777553", beneficiaryName: "Ingyin May" })], [row("r", { amount: 100, payeeName: "Ingyin May" })]);
    assert.equal(out.length, 0);
  });

  it("a matching reference with a different amount is kept but capped for review, with the conflict stated", () => {
    const out = suggestMatches([pay("a", { amount: 800, bankReference: "202610020349882921" })], [row("r", { amount: 900, bankReference: "49882921" })]);
    assert.equal(out.length, 1);
    assert.ok(out[0].score <= 60);
    assert.ok(out[0].reasons.some((r) => /amount differs/.test(r.text)));
  });

  it("different amount and no reference is not a candidate", () => {
    assert.equal(suggestMatches([pay("a", { amount: 800 })], [row("r", { amount: 900 })]).length, 0);
  });

  it("entity and currency must agree", () => {
    assert.equal(suggestMatches([pay("a", { amount: 100 })], [row("r", { amount: 100, entityId: "other" })]).length, 0);
    assert.equal(suggestMatches([pay("a", { amount: 100, currency: "MYR" })], [row("r", { amount: 100, currency: "SGD" })]).length, 0);
  });

  it("dates far from the instruction need a reference; nearby dates add points", () => {
    assert.equal(suggestMatches([pay("a", { amount: 100 })], [row("r", { amount: 100, transactionDate: "2026-11-20" })]).length, 0);
    const near = suggestMatches([pay("a", { amount: 100 })], [row("r", { amount: 100, transactionDate: "2026-10-03" })]);
    const same = suggestMatches([pay("a", { amount: 100 })], [row("r", { amount: 100, transactionDate: "2026-10-02" })]);
    assert.ok(same[0].score > near[0].score);
    // a bank row dated well BEFORE the instruction is not a candidate (without a reference)
    assert.equal(suggestMatches([pay("a", { amount: 100 })], [row("r", { amount: 100, transactionDate: "2026-09-20" })]).length, 0);
  });

  it("already decided or suggested pairs, confirmed rows and confirmed payments are never suggested again", () => {
    const p = [pay("a", { amount: 100 })];
    const r = [row("r", { amount: 100 })];
    assert.equal(suggestMatches(p, r, { skipPairs: new Set([pairKey("a", "r")]) }).length, 0);
    assert.equal(suggestMatches(p, r, { confirmedBankRows: new Set(["r"]) }).length, 0);
    assert.equal(suggestMatches(p, r, { confirmedPayments: new Set(["a"]) }).length, 0);
    assert.equal(suggestMatches(p, r).length, 1);
  });

  it("payments past bank_matched are not candidates", () => {
    assert.equal(suggestMatches([pay("a", { amount: 100, status: "finance_review" })], [row("r", { amount: 100 })]).length, 0);
    assert.equal(suggestMatches([pay("a", { amount: 100, status: "bank_matched" })], [row("r", { amount: 100 })]).length, 0);
  });

  it("at most three suggestions per payment, best first, deterministic order", () => {
    const rows = ["r1", "r2", "r3", "r4", "r5"].map((id, i) => row(id, { amount: 100, transactionDate: `2026-10-0${2 + (i % 2)}` }));
    const out = suggestMatches([pay("a", { amount: 100, beneficiaryName: "X Person" })], rows);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((s) => s.score), [...out.map((s) => s.score)].sort((x, y) => y - x));
    assert.deepEqual(suggestMatches([pay("a", { amount: 100 })], rows), suggestMatches([pay("a", { amount: 100 })], rows));
  });

  it("fee rows are recognised by wording but a large 'service charge' payment is still a payment candidate", () => {
    assert.equal(classifyBankRow({ direction: "debit", description: "OTHER TRANSFER FEE", amount: 0.1, payeeName: null }), "bank_fee");
    assert.equal(classifyBankRow({ direction: "debit", description: "Service charge", amount: 12, payeeName: null }), "bank_fee");
    assert.equal(classifyBankRow({ direction: "debit", description: "Service charge to consultant", amount: 8000, payeeName: "ABC Consulting" }), "payment_candidate");
  });
});
