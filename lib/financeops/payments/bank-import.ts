import { createHash } from "node:crypto";
import { parseCsv, parseXlsx } from "../../import/supplier-recurring";
import { classifyBankRow } from "./matching";
import { cents, parseAmount, parseDateTime } from "./normalize";
import { STATEMENT_FIELDS, statementFieldLabel, type ParsedBankRow, type StatementField, type StatementMapping } from "./statement-fields";

export { STATEMENT_FIELDS, statementFieldLabel, type ParsedBankRow, type StatementField, type StatementMapping };

/**
 * Operational bank-statement import (CSV / XLSX / pasted rows). Transactions only: a balance column is recognised
 * and deliberately IGNORED, never stored. Designed against real Public Bank listings, where:
 *   - "Posting Date" carries date AND time in one cell ("02-Oct-2026 23:16");
 *   - debit and credit are separate columns, "Reference No." is the short tail of the payment reference;
 *   - the payee is in "Remark" (often truncated), the purpose in "Recipient's Reference";
 *   - every transfer is followed by a separate "OTHER TRANSFER FEE 0.10" row with the same reference.
 * Nothing is overwritten: rows are insert-only, duplicate rows are detected and skipped by default.
 */

export type StatementFileType = "csv" | "xlsx" | "pasted";
export type StatementSheet = { name: string; rows: Record<string, string>[] };

const key = (h: string): string => h.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

const SYNONYMS: Record<string, StatementField> = {
  posting_date: "transaction_date", transaction_date: "transaction_date", date: "transaction_date", txn_date: "transaction_date", trn_date: "transaction_date", post_date: "transaction_date", posted_date: "transaction_date",
  time: "transaction_time", transaction_time: "transaction_time",
  debit_amount: "debit", debit: "debit", withdrawal: "debit", withdrawals: "debit", withdrawal_amount: "debit", money_out: "debit", dr: "debit",
  credit_amount: "credit", credit: "credit", deposit: "credit", deposits: "credit", deposit_amount: "credit", money_in: "credit", cr: "credit",
  amount: "amount", transaction_amount: "amount",
  direction: "direction", dr_cr: "direction", debit_credit: "direction",
  reference_no: "reference", reference: "reference", ref_no: "reference", reference_number: "reference", document_no: "reference", document_number: "reference", ref: "reference",
  transaction_description: "description", description: "description", particulars: "description", narrative: "description", transaction_details: "description", details: "description",
  recipient_s_reference: "recipient_reference", recipients_reference: "recipient_reference", recipient_reference: "recipient_reference",
  other_payment_details: "other_details", additional_description: "other_details", other_details: "other_details",
  remark: "payee", remarks: "payee", beneficiary: "payee", beneficiary_name: "payee", payee: "payee", recipient_name: "payee", recipient: "payee", payee_name: "payee",
  beneficiary_account: "beneficiary_account", beneficiary_account_no: "beneficiary_account", beneficiary_acc_no: "beneficiary_account", recipient_account: "beneficiary_account", recipient_account_no: "beneficiary_account",
  beneficiary_bank: "beneficiary_bank", recipient_bank: "beneficiary_bank",
  balance: "ignore_balance", running_balance: "ignore_balance", available_balance: "ignore_balance", closing_balance: "ignore_balance", ledger_balance: "ignore_balance",
};

export function inferStatementMapping(headers: readonly string[]): StatementMapping {
  const used = new Set<StatementField>();
  const out: StatementMapping = {};
  for (const h of headers) {
    const field = SYNONYMS[key(h)];
    // the first column wins for a field, except the ignored balance which may repeat
    if (field && (field === "ignore_balance" || !used.has(field))) { out[h] = field; used.add(field); } else out[h] = "";
  }
  return out;
}

export function parseStatementFile(bytes: Buffer, fileType: "csv" | "xlsx", sheetName = ""): StatementSheet[] {
  if (fileType === "csv") return [{ name: "CSV", rows: parseCsv(bytes.toString("utf8")) }];
  const sheets = parseXlsx(bytes) as StatementSheet[];
  if (!sheetName) return sheets;
  const chosen = sheets.find((s) => s.name === sheetName);
  return chosen ? [chosen] : sheets;
}

/** Rows copied from the bank's web page (tab separated) or a comma list. */
export function parsePastedStatement(text: string): StatementSheet[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return [{ name: "Pasted rows", rows: [] }];
  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  if (delimiter === ",") return [{ name: "Pasted rows", rows: parseCsv(lines.join("\n")) }];
  const headers = lines[0].split("\t").map((h, i) => h.trim() || `Column ${i + 1}`);
  return [{ name: "Pasted rows", rows: lines.slice(1).map((l) => Object.fromEntries(headers.map((h, i) => [h, (l.split("\t")[i] ?? "").trim()]))) }];
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const clean = (v: string | undefined): string | null => {
  const t = (v ?? "").replace(/\s+/g, " ").trim();
  return t ? t : null;
};

function fieldValue(row: Record<string, string>, mapping: StatementMapping, field: StatementField): string | undefined {
  for (const [header, f] of Object.entries(mapping)) if (f === field && row[header] !== undefined) return row[header];
  return undefined;
}

export type MapContext = { companyAccountRef: string; currency?: string };

/** Map raw rows to normalised rows. Pure; duplicates are decided afterwards by {@link markDuplicates}. */
export function mapStatementRows(rows: readonly Record<string, string>[], mapping: StatementMapping, ctx: MapContext): ParsedBankRow[] {
  const mapped = rows.map((row, index): ParsedBankRow => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const rowNumber = index + 2;
    const dateCell = fieldValue(row, mapping, "transaction_date");
    const timeCell = fieldValue(row, mapping, "transaction_time");
    const parsedDate = parseDateTime(isSerial(dateCell) ? Number(dateCell) : dateCell);
    const parsedTime = timeCell ? parseDateTime(timeCell).time ?? parsedDate.time : parsedDate.time;
    const debitText = fieldValue(row, mapping, "debit");
    const creditText = fieldValue(row, mapping, "credit");
    const amountText = fieldValue(row, mapping, "amount");
    const directionText = (fieldValue(row, mapping, "direction") ?? "").toLowerCase();

    let direction: "debit" | "credit" | null = null;
    let amount: number | null = null;
    const debit = parseAmount(debitText);
    const credit = parseAmount(creditText);
    if (debit !== null && debit > 0 && credit !== null && credit > 0) errors.push("Both a debit and a credit amount are filled");
    else if (debit !== null && debit > 0) { direction = "debit"; amount = debit; }
    else if (credit !== null && credit > 0) { direction = "credit"; amount = credit; }
    else if (amountText !== undefined && parseAmount(amountText) !== null) {
      const a = parseAmount(amountText) as number;
      if (/^(dr|debit|d)\b/.test(directionText) || a < 0) { direction = "debit"; amount = Math.abs(a); }
      else if (/^(cr|credit|c)\b/.test(directionText)) { direction = "credit"; amount = Math.abs(a); }
      else errors.push("The amount has no debit/credit indicator");
    }

    const description = [clean(fieldValue(row, mapping, "description")), clean(fieldValue(row, mapping, "recipient_reference")), clean(fieldValue(row, mapping, "other_details"))].filter(Boolean).join(" | ") || null;
    const payee = clean(fieldValue(row, mapping, "payee"));
    const empty = direction === null && errors.length === 0 && !parsedDate.date && !description && !payee;

    if (!empty) {
      if (!parsedDate.date) errors.push("Missing or unreadable transaction date");
      if (direction === null && errors.length === 0) errors.push("Missing debit or credit amount");
      if (amount !== null && amount > 999999999.99) errors.push("Amount out of range");
    }
    const kind: ParsedBankRow["kind"] = errors.length ? "invalid" : direction ? classifyBankRow({ direction, description, amount: amount as number, payeeName: payee }) : "invalid";
    if (kind === "bank_fee") warnings.push("Bank fee: kept for the record, never matched to a payment");
    const bankReference = clean(fieldValue(row, mapping, "reference"));
    return {
      rowNumber,
      transactionDate: parsedDate.date,
      transactionTime: parsedTime,
      direction,
      amount,
      bankReference,
      description,
      payeeName: payee,
      beneficiaryAccountNo: clean(fieldValue(row, mapping, "beneficiary_account")),
      beneficiaryBank: clean(fieldValue(row, mapping, "beneficiary_bank")),
      kind,
      state: empty ? "empty" : errors.length ? "invalid" : "new",
      errors,
      warnings,
      fingerprint: null,
    };
  });

  // fingerprint with an occurrence index, so two genuinely identical rows in one file stay distinct
  const seen = new Map<string, number>();
  for (const r of mapped) {
    if (r.state !== "new" || r.direction === null || r.amount === null) continue;
    const base = JSON.stringify([ctx.companyAccountRef.trim().toLowerCase(), r.transactionDate, r.transactionTime ?? "", r.direction, cents(r.amount), (r.bankReference ?? "").toLowerCase(), (r.description ?? "").toLowerCase(), (r.payeeName ?? "").toLowerCase()]);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    r.fingerprint = sha256Hex(`${base}#${n}`);
  }
  return mapped;
}

function isSerial(v: string | undefined): boolean {
  return typeof v === "string" && /^\d{5}(\.\d+)?$/.test(v.trim()) && Number(v) > 20000 && Number(v) < 80000;
}

/** Rows whose fingerprint already exists for this entity + account are duplicates (skipped unless a human opts in). */
export function markDuplicates(rows: ParsedBankRow[], existingFingerprints: ReadonlySet<string>): ParsedBankRow[] {
  return rows.map((r) => (r.state === "new" && r.fingerprint && existingFingerprints.has(r.fingerprint) ? { ...r, state: "duplicate", warnings: [...r.warnings, "Already imported for this account"] } : r));
}

export type StatementSummary = { total: number; new: number; duplicate: number; invalid: number; empty: number; debits: number; credits: number; fees: number; debitTotal: number; creditTotal: number };

export function summarizeStatement(rows: readonly ParsedBankRow[]): StatementSummary {
  const s: StatementSummary = { total: rows.length, new: 0, duplicate: 0, invalid: 0, empty: 0, debits: 0, credits: 0, fees: 0, debitTotal: 0, creditTotal: 0 };
  for (const r of rows) {
    s[r.state] += 1;
    if (r.state !== "new") continue;
    if (r.direction === "debit") { s.debits += 1; s.debitTotal += r.amount ?? 0; }
    if (r.direction === "credit") { s.credits += 1; s.creditTotal += r.amount ?? 0; }
    if (r.kind === "bank_fee") s.fees += 1;
  }
  s.debitTotal = Math.round(s.debitTotal * 100) / 100;
  s.creditTotal = Math.round(s.creditTotal * 100) / 100;
  return s;
}
