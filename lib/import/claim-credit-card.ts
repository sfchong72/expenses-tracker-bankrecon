import { createHash } from "node:crypto";
import { parseCsv, parseXlsx } from "@/lib/import/supplier-recurring";

export type CreditCardClaimRow = {
  rowNumber: number;
  original: Record<string, string>;
  mapped: Record<string, unknown>;
  validationErrors: string[];
  duplicateWarnings: unknown[];
  excluded: boolean;
};

export const claimImportFields = [
  "statement_date",
  "transaction_date",
  "cardholder_name",
  "card_last_four",
  "card_type",
  "merchant_or_supplier",
  "transaction_description",
  "business_purpose",
  "expense_category",
  "amount",
  "tax_amount",
  "original_currency",
  "exchange_rate",
  "payment_method",
  "invoice_or_receipt_number",
  "receipt_date",
  "remarks",
];

const defaultMapping: Record<string, string> = {
  statement_date: "statement_date",
  statement: "statement_date",
  transaction_date: "transaction_date",
  date: "transaction_date",
  posting_date: "transaction_date",
  cardholder: "cardholder_name",
  cardholder_name: "cardholder_name",
  card_last_four: "card_last_four",
  last_four: "card_last_four",
  card_no: "card_last_four",
  card_number: "card_last_four",
  merchant: "merchant_or_supplier",
  supplier: "merchant_or_supplier",
  payee: "merchant_or_supplier",
  description: "transaction_description",
  transaction_description: "transaction_description",
  details: "transaction_description",
  business_purpose: "business_purpose",
  purpose: "business_purpose",
  category: "expense_category",
  expense_category: "expense_category",
  amount: "amount",
  transaction_amount: "amount",
  tax: "tax_amount",
  tax_amount: "tax_amount",
  currency: "original_currency",
  original_currency: "original_currency",
  exchange_rate: "exchange_rate",
  payment_method: "payment_method",
  receipt_no: "invoice_or_receipt_number",
  invoice_no: "invoice_or_receipt_number",
  receipt_date: "receipt_date",
  remarks: "remarks",
};

export function parseClaimImportFile(bytes: Buffer, fileType: "csv" | "xlsx") {
  return fileType === "csv"
    ? [{ name: "CSV", rows: parseCsv(bytes.toString("utf8")) }]
    : parseXlsx(bytes);
}

export function inferClaimMapping(headers: string[]) {
  return Object.fromEntries(headers.map((header) => [header, defaultMapping[toKey(header)] || ""]));
}

export function mapClaimRows(
  rows: Record<string, string>[],
  mapping: Record<string, string>,
  statementMonth: string,
): CreditCardClaimRow[] {
  return rows.map((row, index) => {
    const mapped: Record<string, unknown> = {};
    for (const [header, field] of Object.entries(mapping)) {
      if (field) mapped[field] = row[header] ?? "";
    }
    if (!mapped.original_currency) mapped.original_currency = "MYR";
    if (!mapped.exchange_rate) mapped.exchange_rate = "1";
    if (!mapped.card_type) mapped.card_type = "personal";
    const validationErrors = validateClaimMapped(mapped, statementMonth);
    return {
      rowNumber: index + 2,
      original: row,
      mapped,
      validationErrors,
      duplicateWarnings: [],
      excluded: false,
    };
  });
}

export function validateClaimMapped(mapped: Record<string, unknown>, statementMonth: string) {
  const errors: string[] = [];
  const transactionDate = parseDate(mapped.transaction_date || mapped.statement_date);
  const amount = parseAmount(mapped.amount);
  const lastFour = lastFourDigits(mapped.card_last_four);
  if (!transactionDate) errors.push("Missing or invalid transaction date");
  if (transactionDate && statementMonth && transactionDate.slice(0, 7) !== statementMonth.slice(0, 7)) errors.push("Transaction date is outside statement month");
  if (!lastFour) errors.push("Card last four digits are required");
  if (!String(mapped.merchant_or_supplier ?? "").trim() && !String(mapped.transaction_description ?? "").trim()) errors.push("Merchant or description is required");
  if (amount == null || amount <= 0) errors.push("Amount must be greater than zero");
  return errors;
}

export function fingerprintClaimLine(entityId: string, statementMonth: string, mapped: Record<string, unknown>) {
  const parts = [
    entityId,
    statementMonth.slice(0, 7),
    lastFourDigits(mapped.card_last_four),
    parseDate(mapped.transaction_date || mapped.statement_date) ?? "",
    String(parseAmount(mapped.amount) ?? ""),
    normalise(mapped.merchant_or_supplier),
    normalise(mapped.transaction_description),
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

export function parseAmount(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const cleaned = text.replace(/rm/gi, "").replace(/,/g, "").replace(/[^\d.-]/g, "");
  if (!cleaned) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? Math.abs(number) : null;
}

export function parseDate(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return excelDate(value);
  }
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return excelDate(Number(raw));
  const dmy = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (dmy) {
    const year = Number(dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3]);
    const date = new Date(Date.UTC(year, Number(dmy[2]) - 1, Number(dmy[1])));
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export function lastFourDigits(value: unknown) {
  const digits = String(value ?? "").replace(/\D+/g, "");
  if (digits.length < 4) return "";
  return digits.slice(-4);
}

export function normalise(value: unknown) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function excelDate(value: number) {
  const date = new Date(Date.UTC(1899, 11, 30 + Math.floor(value)));
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function toKey(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}
