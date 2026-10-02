/**
 * Client-safe vocabulary for the bank statement import screen (no Node imports, so a browser bundle can use it).
 * The parsing itself lives in bank-import.ts, which is server only.
 */

export const STATEMENT_FIELDS = ["transaction_date", "transaction_time", "debit", "credit", "amount", "direction", "reference", "description", "recipient_reference", "other_details", "payee", "beneficiary_account", "beneficiary_bank", "ignore_balance"] as const;
export type StatementField = (typeof STATEMENT_FIELDS)[number];
export type StatementMapping = Record<string, StatementField | "">;

const FIELD_LABELS: Record<StatementField, string> = {
  transaction_date: "Transaction / posting date",
  transaction_time: "Time",
  debit: "Debit amount",
  credit: "Credit amount",
  amount: "Amount (with a direction column)",
  direction: "Debit / credit indicator",
  reference: "Bank reference no.",
  description: "Transaction description",
  recipient_reference: "Recipient's reference",
  other_details: "Other payment details",
  payee: "Payee / beneficiary name",
  beneficiary_account: "Beneficiary account",
  beneficiary_bank: "Beneficiary bank",
  ignore_balance: "Balance (ignored)",
};
export const statementFieldLabel = (f: StatementField): string => FIELD_LABELS[f];

export type ParsedBankRow = {
  rowNumber: number;
  transactionDate: string | null;
  transactionTime: string | null;
  direction: "debit" | "credit" | null;
  amount: number | null;
  bankReference: string | null;
  description: string | null;
  payeeName: string | null;
  beneficiaryAccountNo: string | null;
  beneficiaryBank: string | null;
  kind: "payment_candidate" | "bank_fee" | "credit" | "invalid";
  /** "new" rows will be imported; "duplicate" rows already exist; "invalid"/"empty" are skipped. */
  state: "new" | "duplicate" | "invalid" | "empty";
  errors: string[];
  warnings: string[];
  fingerprint: string | null;
};
