/**
 * The posting package a person keys (or pastes) into SQL Account for a payment that is Ready for SQL.
 * The Hub does NOT connect to SQL Account in Phase 1: this only prepares and tracks. SQL Account remains the official
 * accounting and bank-reconciliation system.
 */

export type SqlPackageInput = {
  payment: {
    id: string;
    payment_instruction_date: string;
    beneficiary_name: string | null;
    purpose: string | null;
    amount: number | string;
    currency: string;
    account_code: string | null;
    pay_from_account_ref: string | null;
    bank_reference: string | null;
    claim_ref: string | null;
    payroll_ref: string | null;
    payment_type: string;
    notes: string | null;
  };
  entityCode: string;
  bill?: { id: string; bill_number: string | null; description: string | null } | null;
  bankRow?: { bank_reference: string | null; transaction_date: string | null } | null;
  documents: readonly { doc_role: string; original_filename: string }[];
};

export type SqlPackage = {
  entity: string;
  paymentDate: string;
  payee: string;
  description: string;
  amount: number;
  currency: string;
  accountCode: string;
  payFromAccount: string;
  invoiceReference: string;
  voucherReference: string;
  hubPaymentId: string;
  linkedBill: string;
  bankTransactionReference: string;
  bankTransactionDate: string;
  documents: string;
};

export function buildSqlPackage(input: SqlPackageInput): SqlPackage {
  const p = input.payment;
  return {
    entity: input.entityCode,
    paymentDate: p.payment_instruction_date,
    payee: p.beneficiary_name ?? "",
    description: [p.purpose, p.payroll_ref, p.claim_ref].filter(Boolean).join(" | ") || (input.bill?.description ?? ""),
    amount: Math.round(Number(p.amount) * 100) / 100,
    currency: p.currency,
    accountCode: p.account_code ?? "",
    payFromAccount: p.pay_from_account_ref ?? "",
    invoiceReference: input.bill?.bill_number ?? "",
    voucherReference: p.bank_reference ?? "",
    hubPaymentId: p.id,
    linkedBill: input.bill?.id ?? "",
    bankTransactionReference: input.bankRow?.bank_reference ?? "",
    bankTransactionDate: input.bankRow?.transaction_date ?? "",
    documents: input.documents.map((d) => `${d.doc_role}: ${d.original_filename}`).join("; "),
  };
}

export const SQL_PACKAGE_COLUMNS: { key: keyof SqlPackage; label: string }[] = [
  { key: "entity", label: "Entity" },
  { key: "paymentDate", label: "Payment date" },
  { key: "payee", label: "Supplier / payee" },
  { key: "description", label: "Description" },
  { key: "amount", label: "Amount" },
  { key: "currency", label: "Currency" },
  { key: "accountCode", label: "Expense / account code" },
  { key: "payFromAccount", label: "Bank / payment account" },
  { key: "invoiceReference", label: "Invoice / reference no." },
  { key: "voucherReference", label: "PV / payment reference" },
  { key: "hubPaymentId", label: "Hub Payment Register ID" },
  { key: "linkedBill", label: "Linked Supplier Bill" },
  { key: "bankTransactionReference", label: "Bank transaction reference" },
  { key: "bankTransactionDate", label: "Bank transaction date" },
  { key: "documents", label: "Documents" },
];

/** CSV that spreadsheets open safely: quoted fields, and a leading = + - @ is neutralised so nothing runs as a formula. */
export function sqlPackagesToCsv(packages: readonly SqlPackage[]): string {
  const cell = (v: unknown): string => {
    let t = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(t) && typeof v !== "number") t = `'${t}`;
    return `"${t.replace(/"/g, '""')}"`;
  };
  const lines = [SQL_PACKAGE_COLUMNS.map((c) => cell(c.label)).join(",")];
  for (const p of packages) lines.push(SQL_PACKAGE_COLUMNS.map((c) => cell(p[c.key])).join(","));
  return lines.join("\r\n") + "\r\n";
}
