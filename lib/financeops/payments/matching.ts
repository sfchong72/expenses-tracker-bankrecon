import { cents, daysBetween, matchAccounts, matchNames, matchReferences, digitsOnly } from "./normalize";

/**
 * Payment <-> bank-transaction matching: a simple, EXPLAINABLE rule set. No AI scoring.
 *
 * The result is a SUGGESTION, never a decision: a human confirms or rejects it. Only a bank DEBIT can match a
 * payment. Bank-fee rows (for example Public Bank's separate "OTHER TRANSFER FEE 0.10" that shares the payment's
 * reference) are recognised and kept out of payment matching.
 *
 * Signals (points are additive, capped at 100):
 *   bank reference   exact / suffix ("49883140" is the tail of "202610020349883140")      40 / 38
 *   company account  same pay-from account                                                 10   (a different account disqualifies)
 *   amount           identical to the cent 40;   rounded to the ringgit 28 (flagged for review)
 *   beneficiary acct identical (when the statement shows one)                              15
 *   payee name       exact 15, truncated-prefix 13 ("Eveyiana Mujan Anak"), similar 8
 *   date             same day 8, within 1 day 6, within 3 days 4, within 7 days 2
 * Ambiguity (several payments or several rows fit equally well) caps the score at 69 and says so.
 */

export type MatchPayment = {
  id: string;
  entityId: string;
  amount: number;
  currency: string;
  instructionDate: string;
  bankReference: string | null;
  payFromAccountRef: string | null;
  beneficiaryName: string | null;
  beneficiaryAccountNo: string | null;
  /** Only payments that are not yet bank_matched are candidates. */
  status: string;
};

export type MatchBankRow = {
  id: string;
  entityId: string;
  companyAccountRef: string;
  transactionDate: string;
  direction: "debit" | "credit";
  amount: number;
  currency: string;
  bankReference: string | null;
  description: string | null;
  payeeName: string | null;
  beneficiaryAccountNo: string | null;
};

export type Reason = { text: string; kind: "match" | "warn" };
export type Confidence = "strong" | "likely" | "weak";

export type Suggestion = {
  paymentId: string;
  bankTransactionId: string;
  score: number;
  confidence: Confidence;
  reasons: Reason[];
  ambiguous: boolean;
};

export type MatchOptions = {
  /** payment|bank pairs already decided or suggested (including rejected): never suggested again */
  skipPairs?: ReadonlySet<string>;
  /** bank rows already confirmed to a payment */
  confirmedBankRows?: ReadonlySet<string>;
  /** payments that already have a confirmed match */
  confirmedPayments?: ReadonlySet<string>;
  maxPerPayment?: number;
  minScore?: number;
  maxDaysAfter?: number;
  maxDaysBefore?: number;
};

export const pairKey = (paymentId: string, bankTransactionId: string): string => `${paymentId}|${bankTransactionId}`;

const FEE_WORDS = /\b(fee|fees|charge|charges|commission|stamp duty|service tax|sst)\b/i;

export type BankRowKind = "payment_candidate" | "bank_fee" | "credit";

/** Fee rows and credits are never payment candidates. */
export function classifyBankRow(row: Pick<MatchBankRow, "direction" | "description" | "amount" | "payeeName">): BankRowKind {
  if (row.direction === "credit") return "credit";
  const text = `${row.description ?? ""} ${row.payeeName ?? ""}`;
  if (FEE_WORDS.test(text) && row.amount <= 50) return "bank_fee";
  return "payment_candidate";
}

export function confidenceOf(score: number): Confidence {
  return score >= 90 ? "strong" : score >= 70 ? "likely" : "weak";
}

type Scored = { payment: MatchPayment; row: MatchBankRow; score: number; reasons: Reason[]; amountOk: boolean; refMatch: boolean };

function scorePair(p: MatchPayment, r: MatchBankRow, o: Required<Pick<MatchOptions, "maxDaysAfter" | "maxDaysBefore">>): Scored | null {
  if (p.entityId !== r.entityId) return null;
  if (r.direction !== "debit") return null;
  if (p.currency !== r.currency) return null;
  const reasons: Reason[] = [];
  let score = 0;

  // company bank account: a different account is a different payment
  if (p.payFromAccountRef && digitsOnly(p.payFromAccountRef).length >= 6 && digitsOnly(r.companyAccountRef).length >= 6) {
    const acct = matchAccounts(p.payFromAccountRef, r.companyAccountRef);
    if (acct === "none") return null;
    score += 10;
    reasons.push({ text: "paid from the same company bank account", kind: "match" });
  }

  const ref = matchReferences(p.bankReference, r.bankReference);
  if (ref === "exact") { score += 40; reasons.push({ text: "bank reference identical", kind: "match" }); }
  else if (ref === "suffix") { score += 38; reasons.push({ text: "bank reference matches (statement shows the tail of the payment reference)", kind: "match" }); }

  const diff = Math.abs(cents(r.amount) - cents(p.amount));
  let amountOk = false;
  if (diff === 0) {
    score += 40; amountOk = true;
    reasons.push({ text: "exact amount", kind: "match" });
  } else if (diff < 100 && (Math.round(p.amount) === r.amount || Math.round(r.amount) === p.amount || diff <= 50)) {
    score += 28; amountOk = true;
    reasons.push({ text: `amount differs by RM${(diff / 100).toFixed(2)} (looks like rounding)`, kind: "warn" });
  } else if (ref !== "none") {
    reasons.push({ text: `amount differs by RM${(diff / 100).toFixed(2)} despite a matching reference`, kind: "warn" });
  } else {
    return null; // different amount and no reference: not a candidate
  }

  const acctMatch = matchAccounts(p.beneficiaryAccountNo, r.beneficiaryAccountNo);
  if (acctMatch !== "none") { score += 15; reasons.push({ text: "beneficiary account matches", kind: "match" }); }

  const name = matchNames(p.beneficiaryName, r.payeeName ?? r.description);
  // a rounded amount (RM320.83 on the wage sheet, RM321 debited) with the right payee is still a likely match
  if (amountOk && diff !== 0 && name.kind !== "none") { score += 10; reasons.push({ text: "amount differs only by rounding and the payee matches", kind: "match" }); }
  if (name.kind === "exact") { score += 15; reasons.push({ text: "payee name matches", kind: "match" }); }
  else if (name.kind === "prefix") { score += 13; reasons.push({ text: "payee name matches (the statement truncates it)", kind: "match" }); }
  else if (name.kind === "similar") { score += 8; reasons.push({ text: "payee name looks similar", kind: "match" }); }
  else if (p.beneficiaryName && (r.payeeName || r.description)) { reasons.push({ text: "payee name differs", kind: "warn" }); }

  const days = daysBetween(p.instructionDate, r.transactionDate); // positive = bank row after the instruction
  if (days > o.maxDaysAfter || days < -o.maxDaysBefore) {
    if (ref === "none") return null;
    reasons.push({ text: `bank date is ${Math.abs(days)} days ${days > 0 ? "after" : "before"} the instruction`, kind: "warn" });
  } else {
    const a = Math.abs(days);
    if (a === 0) { score += 8; reasons.push({ text: "same day", kind: "match" }); }
    else if (a <= 1) { score += 6; reasons.push({ text: "date within 1 day", kind: "match" }); }
    else if (a <= 3) { score += 4; reasons.push({ text: `date within ${a} days`, kind: "match" }); }
    else if (a <= 7) { score += 2; reasons.push({ text: `date within ${a} days`, kind: "match" }); }
    else reasons.push({ text: `bank date is ${a} days from the instruction`, kind: "warn" });
  }

  // a payment whose reference matched but whose amount does not is a conflict a human must look at
  if (ref !== "none" && !amountOk) score = Math.min(score, 60);
  return { payment: p, row: r, score: Math.min(100, score), reasons, amountOk, refMatch: ref !== "none" };
}

export function suggestMatches(payments: readonly MatchPayment[], bankRows: readonly MatchBankRow[], options: MatchOptions = {}): Suggestion[] {
  const skip = options.skipPairs ?? new Set<string>();
  const minScore = options.minScore ?? 40;
  const maxPer = options.maxPerPayment ?? 3;
  const limits = { maxDaysAfter: options.maxDaysAfter ?? 14, maxDaysBefore: options.maxDaysBefore ?? 3 };

  const candidatePayments = payments.filter((p) => !options.confirmedPayments?.has(p.id) && ["captured", "documents_pending", "ready_for_bank_match", "bank_match_suggested"].includes(p.status));
  const candidateRows = bankRows.filter((r) => classifyBankRow(r) === "payment_candidate" && !options.confirmedBankRows?.has(r.id));

  const scored: Scored[] = [];
  for (const p of candidatePayments) {
    for (const r of candidateRows) {
      if (skip.has(pairKey(p.id, r.id))) continue;
      const s = scorePair(p, r, limits);
      if (s && s.score >= minScore) scored.push(s);
    }
  }

  // ambiguity: several payments fit one row (or several rows fit one payment) about equally well
  const byRow = new Map<string, Scored[]>();
  const byPayment = new Map<string, Scored[]>();
  for (const s of scored) {
    (byRow.get(s.row.id) ?? byRow.set(s.row.id, []).get(s.row.id))!.push(s);
    (byPayment.get(s.payment.id) ?? byPayment.set(s.payment.id, []).get(s.payment.id))!.push(s);
  }
  const ambiguousPairs = new Set<Scored>();
  const mark = (group: Scored[]) => {
    if (group.length < 2) return;
    const top = Math.max(...group.map((g) => g.score));
    const close = group.filter((g) => top - g.score <= 5);
    if (close.length >= 2) close.forEach((g) => ambiguousPairs.add(g));
  };
  byRow.forEach(mark);
  byPayment.forEach(mark);

  const out: Suggestion[] = scored.map((s) => {
    const ambiguous = ambiguousPairs.has(s);
    const reasons = [...s.reasons];
    let score = s.score;
    if (ambiguous) {
      score = Math.min(score, 69);
      reasons.push({ text: "several candidates fit about equally well: a human must choose", kind: "warn" });
    }
    return { paymentId: s.payment.id, bankTransactionId: s.row.id, score, confidence: confidenceOf(score), reasons, ambiguous };
  });

  out.sort((a, b) => b.score - a.score || a.paymentId.localeCompare(b.paymentId) || a.bankTransactionId.localeCompare(b.bankTransactionId));
  // keep at most N per payment
  const perPayment = new Map<string, number>();
  return out.filter((s) => {
    const n = perPayment.get(s.paymentId) ?? 0;
    if (n >= maxPer) return false;
    perPayment.set(s.paymentId, n + 1);
    return true;
  });
}
