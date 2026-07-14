import { createHash } from "node:crypto";
import { parseCsv, parseDate, parseXlsx } from "@/lib/import/supplier-recurring";

export type BankParsedSheet = {
  name: string;
  rows: Record<string, string>[];
};

export type BankMapping = Record<string, string>;

export type BankImportRow = {
  rowNumber: number;
  original: Record<string, string>;
  originalSanitized: Record<string, string>;
  mapped: Record<string, unknown>;
  mappedSanitized: Record<string, unknown>;
  validationErrors: string[];
  duplicateWarnings: unknown[];
  excluded: boolean;
};

export const bankImportFields = [
  "transaction_date",
  "transaction_time",
  "value_date",
  "description",
  "additional_description",
  "reference_number",
  "debit",
  "credit",
  "amount",
  "direction",
  "running_balance",
];

export const bankFieldLabels: Record<string, string> = {
  transaction_date: "Transaction date",
  transaction_time: "Transaction time",
  value_date: "Value date",
  description: "Description",
  additional_description: "Additional description",
  reference_number: "Reference / document no.",
  debit: "Debit",
  credit: "Credit",
  amount: "Amount",
  direction: "Direction",
  running_balance: "Running balance",
};

const headerMapping: Record<string, string> = {
  date: "transaction_date",
  transaction_date: "transaction_date",
  posting_date: "transaction_date",
  post_date: "transaction_date",
  posted_date: "transaction_date",
  txn_date: "transaction_date",
  trn_date: "transaction_date",
  value_date: "value_date",
  effective_date: "value_date",
  time: "transaction_time",
  transaction_time: "transaction_time",
  description: "description",
  transaction_description: "description",
  transaction_details: "description",
  details: "description",
  particulars: "description",
  narrative: "description",
  additional_description: "additional_description",
  extra_description: "additional_description",
  reference: "reference_number",
  ref: "reference_number",
  ref_no: "reference_number",
  reference_no: "reference_number",
  reference_number: "reference_number",
  document_number: "reference_number",
  document_no: "reference_number",
  cheque_number: "reference_number",
  cheque_no: "reference_number",
  debit: "debit",
  debit_amount: "debit",
  withdrawal: "debit",
  withdrawal_amount: "debit",
  withdrawals: "debit",
  payment: "debit",
  money_out: "debit",
  credit: "credit",
  credit_amount: "credit",
  deposit: "credit",
  deposit_amount: "credit",
  deposits: "credit",
  money_in: "credit",
  amount: "amount",
  transaction_amount: "amount",
  direction: "direction",
  type: "direction",
  running_balance: "running_balance",
  balance: "running_balance",
  available_balance: "running_balance",
};

const balanceFieldPattern = /balance|running\s*bal|opening|closing|current/i;

export function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function inferBankMapping(headers: string[]): BankMapping {
  return Object.fromEntries(headers.map((header) => [header, headerMapping[toKey(header)] || ""]));
}

export function parseBankFile(buffer: Buffer, fileType: "csv" | "xlsx", worksheetName = ""): BankParsedSheet[] {
  if (fileType === "csv") return [{ name: "CSV", rows: parseCsv(buffer.toString("utf8")) }];
  const sheets = parseXlsx(buffer);
  if (!worksheetName) return sheets;
  const selected = sheets.find((sheet) => sheet.name === worksheetName);
  return selected ? [selected] : sheets;
}

export function parsePastedRows(text: string): BankParsedSheet[] {
  const delimiter = text.includes("\t") ? "\t" : ",";
  const csv = delimiter === "," ? text : text.split(/\r?\n/).map((line) => line.split("\t").map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\n");
  return [{ name: "Pasted rows", rows: parseCsv(csv) }];
}

export function mapBankRows(rows: Record<string, string>[], mapping: BankMapping, existingFingerprints: Set<string>, bankAccountId: string): BankImportRow[] {
  return rows.map((row, index) => {
    const mapped: Record<string, unknown> = {};
    for (const [header, field] of Object.entries(mapping)) {
      if (field) mapped[field] = row[header] ?? "";
    }
    const normalised = normaliseMapped(mapped);
    const validationErrors = validateMappedBankRow(normalised);
    const fingerprint = makeFingerprint(bankAccountId, normalised);
    const duplicateWarnings = fingerprint && existingFingerprints.has(fingerprint)
      ? [{ type: "possible_bank_transaction_duplicate", reason: "Same bank account, date/time, amount, direction, reference and description already exists." }]
      : [];
    return {
      rowNumber: index + 2,
      original: row,
      originalSanitized: sanitizeRecord(row),
      mapped: { ...normalised, duplicate_fingerprint: fingerprint },
      mappedSanitized: sanitizeRecord(normalised),
      validationErrors,
      duplicateWarnings,
      excluded: shouldExcludeRow(row, normalised),
    };
  });
}

export function normaliseMapped(mapped: Record<string, unknown>) {
  const debitInfo = parseMoneyDetail(mapped.debit ?? mapped.source_debit_amount ?? mapped.debit_amount);
  const creditInfo = parseMoneyDetail(mapped.credit ?? mapped.source_credit_amount ?? mapped.credit_amount);
  const amountInfo = parseMoneyDetail(mapped.amount);
  const reviewWarnings: string[] = [];
  const debit = debitInfo.amount;
  const credit = creditInfo.amount;
  const debitPositive = debit != null && debit > 0;
  const creditPositive = credit != null && credit > 0;
  let direction = normaliseDirection(mapped.direction);
  let amount = amountInfo.amount;

  if (debitInfo.isNegative || creditInfo.isNegative || amountInfo.isNegative) {
    reviewWarnings.push("Negative amount normalised to positive; review the bank format.");
  }

  if (!direction && debitPositive && !creditPositive) direction = "debit";
  if (!direction && creditPositive && !debitPositive) direction = "credit";
  if (debitPositive && creditPositive) {
    reviewWarnings.push(direction
      ? "Both debit and credit are populated; selected direction will be used."
      : "Both debit and credit are populated; choose a direction or exclude the row.");
  }

  if (amount == null) {
    if (direction === "debit" && debitPositive) amount = debit;
    if (direction === "credit" && creditPositive) amount = credit;
    if (!direction && debitPositive && !creditPositive) amount = debit;
    if (!direction && creditPositive && !debitPositive) amount = credit;
  }

  return {
    transaction_date: parseFlexibleDate(mapped.transaction_date),
    transaction_time: parseTime(mapped.transaction_time),
    value_date: parseFlexibleDate(mapped.value_date),
    description: String(mapped.description ?? "").trim(),
    additional_description: String(mapped.additional_description ?? "").trim(),
    reference_number: String(mapped.reference_number ?? "").trim(),
    direction,
    source_debit_amount: debit,
    source_credit_amount: credit,
    debit_amount: direction === "debit" ? amount : null,
    credit_amount: direction === "credit" ? amount : null,
    amount,
    running_balance: parseMoney(mapped.running_balance),
    review_warnings: reviewWarnings,
  };
}

export function validateMappedBankRow(mapped: Record<string, unknown>) {
  const errors: string[] = [];
  if (!mapped.transaction_date) errors.push("Missing or invalid transaction date");
  if (!String(mapped.description ?? "").trim()) errors.push("Missing description");
  if (!["debit", "credit"].includes(String(mapped.direction))) errors.push("Direction must be debit or credit");
  if (Number(mapped.amount || 0) <= 0) errors.push("Amount must be greater than zero");
  if (mapped.direction === "debit" && !mapped.debit_amount) errors.push("Debit transaction must have a debit amount");
  if (mapped.direction === "credit" && !mapped.credit_amount) errors.push("Credit transaction must have a credit amount");
  return errors;
}

export function sanitizeRecord<T extends Record<string, unknown>>(record: T): T {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    sanitized[key] = balanceFieldPattern.test(key) ? "[balance hidden]" : value;
  }
  return sanitized as T;
}

export function statementMonthStart(value: string) {
  const parsed = parseFlexibleDate(value.length === 7 ? `${value}-01` : value);
  if (!parsed) return "";
  return `${parsed.slice(0, 7)}-01`;
}

export function makeFingerprint(bankAccountId: string, mapped: Record<string, unknown>) {
  if (!bankAccountId || !mapped.transaction_date || !mapped.amount || !mapped.direction) return "";
  return sha256(Buffer.from([
    bankAccountId,
    mapped.transaction_date,
    mapped.transaction_time || "",
    Number(mapped.amount).toFixed(2),
    mapped.direction,
    normaliseText(mapped.reference_number),
    normaliseText(mapped.description),
  ].join("|")));
}

export function parseMoney(value: unknown) {
  return parseMoneyDetail(value).amount;
}

function parseMoneyDetail(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return { amount: null, isNegative: false };
  const cleaned = text.replace(/rm/gi, "").replace(/,/g, "").replace(/[()]/g, (char) => char === "(" ? "-" : "").replace(/[^\d.-]/g, "");
  if (!cleaned || cleaned === "-") return { amount: null, isNegative: false };
  const number = Number(cleaned);
  return Number.isFinite(number) ? { amount: Math.abs(number), isNegative: number < 0 } : { amount: null, isNegative: false };
}

export function parseFlexibleDate(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const serial = Number(text);
  if (Number.isFinite(serial) && serial > 20000 && serial < 80000) return parseDate(serial);
  const dmy = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (dmy) {
    const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    const parsed = new Date(`${year}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return parseDate(text);
}

function parseTime(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  return `${match[1].padStart(2, "0")}:${match[2]}:${match[3] ?? "00"}`;
}

function shouldExcludeRow(original: Record<string, string>, mapped: Record<string, unknown>) {
  const joined = Object.values(original).join(" ").toLowerCase();
  if (/opening balance|closing balance|balance brought forward|balance carried forward|brought forward|carried forward|total debit|total credit|available balance/.test(joined)) return true;
  return !mapped.transaction_date && !mapped.amount && !String(mapped.description ?? "").trim();
}

function normaliseDirection(value: unknown) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return "";
  if (text.includes("withdraw") || text.includes("payment") || text.includes("debit") || text === "dr" || text === "d") return "debit";
  if (text.includes("deposit") || text.includes("credit") || text === "cr" || text === "c") return "credit";
  return text;
}

function normaliseText(value: unknown) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function toKey(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}
