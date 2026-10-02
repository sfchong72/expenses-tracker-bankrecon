/**
 * Shared vocabulary for the Finance Operations module (Payment Register, bank import, matching, SQL tracking).
 * Pure and import-free so client components, server routes and tests can all use it.
 *
 * Reminder of the accounting separation this module keeps:
 *   payment instruction/proof  !=  bank transaction  !=  accounting posting in SQL Account  !=  bank reconciliation.
 * A Payment Register row is an OPERATIONAL record. It never means bank-cleared, posted or reconciled by itself.
 */

export const PAYMENT_STATUSES = ["captured", "documents_pending", "ready_for_bank_match", "bank_match_suggested", "bank_matched", "finance_review", "ready_for_sql", "posted_to_sql", "reconciled"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Statuses before a bank match is confirmed. */
export const EARLY_STATUSES: readonly PaymentStatus[] = ["captured", "documents_pending", "ready_for_bank_match", "bank_match_suggested"];
/** What FinanceOps (and the data_entry intern) may set. */
export const CAPTURE_STATUSES: readonly PaymentStatus[] = ["captured", "documents_pending", "ready_for_bank_match"];

export const STATUS_LABELS: Record<PaymentStatus, string> = {
  captured: "Captured",
  documents_pending: "Documents pending",
  ready_for_bank_match: "Ready for bank match",
  bank_match_suggested: "Bank match suggested",
  bank_matched: "Bank matched",
  finance_review: "Finance review",
  ready_for_sql: "Ready for SQL",
  posted_to_sql: "Posted to SQL",
  reconciled: "Reconciled",
};

export const PAYMENT_TYPES = ["supplier_expense", "intern_wage", "staff_claim", "rent_deposit", "other"] as const;
export type PaymentType = (typeof PAYMENT_TYPES)[number];

export const PAYMENT_TYPE_LABELS: Record<PaymentType, string> = {
  supplier_expense: "Supplier expense",
  intern_wage: "Intern wage / allowance",
  staff_claim: "Staff claim",
  rent_deposit: "Rent / deposit / agreement payment",
  other: "Other",
};

export const PAYMENT_METHODS = ["bank_transfer", "duitnow", "ibg", "cheque", "cash", "card", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const DOC_ROLES = ["payment_evidence", "invoice", "wage_schedule", "claim_support", "agreement", "other_support"] as const;
export type DocRole = (typeof DOC_ROLES)[number];

export const DOC_ROLE_LABELS: Record<DocRole, string> = {
  payment_evidence: "Payment evidence",
  invoice: "Invoice",
  wage_schedule: "Wage / attendance schedule",
  claim_support: "Claim form / receipt",
  agreement: "Agreement / invoice / payment schedule",
  other_support: "Other support",
};

export const ENTITY_CODES = ["IEA", "IETA", "PLC", "KALER"] as const;
export type EntityCode = (typeof ENTITY_CODES)[number];

/** Owner / Finance Manager / Finance Staff: may review, confirm matches, mark ready for SQL, record posting. */
export const FINANCE_REVIEWER_ROLES = ["owner", "finance_manager", "finance_staff"] as const;
/** Who may capture / edit early payments (can_manage_bills): reviewers plus the data_entry intern. */
export const PAYMENT_CAPTURE_ROLES = ["owner", "finance_manager", "finance_staff", "data_entry"] as const;
/** Who may see the register (can_view_finance). */
export const REGISTER_VIEWER_ROLES = ["owner", "finance_manager", "finance_staff", "data_entry", "management"] as const;
/** Owner and Finance Manager only: reverse a posting / reconciliation, import closed historical rows. */
export const OWNER_FM_ROLES = ["owner", "finance_manager"] as const;

const has = (list: readonly string[], role: string | null | undefined): boolean => typeof role === "string" && list.includes(role);
export const isFinanceReviewer = (role: string | null | undefined): boolean => has(FINANCE_REVIEWER_ROLES, role);
export const canCapturePayments = (role: string | null | undefined): boolean => has(PAYMENT_CAPTURE_ROLES, role);
export const canViewRegister = (role: string | null | undefined): boolean => has(REGISTER_VIEWER_ROLES, role);
export const isOwnerOrFinanceManager = (role: string | null | undefined): boolean => has(OWNER_FM_ROLES, role);

/** A feature flag for the whole module. Default OFF: unset, empty or anything but the exact string "true" is disabled. */
export function paymentRegisterEnabled(env: Record<string, string | undefined>): boolean {
  return env.FINANCEOPS_PAYMENT_REGISTER_ENABLED === "true";
}

export type RegisterRow = {
  id: string;
  entity_id: string;
  source_type: "manual" | "financeops" | "excel_import";
  intake_id: string | null;
  payment_type: PaymentType;
  supplier_bill_id: string | null;
  claim_ref: string | null;
  payroll_ref: string | null;
  account_code: string | null;
  payment_instruction_date: string;
  payment_instruction_time: string | null;
  payment_method: PaymentMethod;
  pay_from_account_ref: string | null;
  beneficiary_name: string | null;
  beneficiary_account_no: string | null;
  beneficiary_bank: string | null;
  amount: number | string;
  currency: string;
  bank_reference: string | null;
  purpose: string | null;
  required_documents: DocRole[];
  not_applicable_documents: DocRole[];
  not_applicable_note: string | null;
  document_exception_note: string | null;
  document_exception_approved_at: string | null;
  bank_match_not_applicable: boolean;
  bank_match_na_note: string | null;
  status: PaymentStatus;
  needs_attention: boolean;
  attention_reasons: string[];
  notes: string | null;
  followup_note: string | null;
  reviewed_at: string | null;
  ready_for_sql_at: string | null;
  sql_posting_date: string | null;
  sql_reference: string | null;
  sql_note: string | null;
  sql_posted_at: string | null;
  reconciled_date: string | null;
  reconciled_at: string | null;
  legacy_state: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type BankTxRow = {
  id: string;
  batch_id: string;
  entity_id: string;
  company_account_ref: string;
  row_number: number;
  transaction_date: string;
  transaction_time: string | null;
  direction: "debit" | "credit";
  amount: number | string;
  currency: string;
  bank_reference: string | null;
  description: string | null;
  payee_name: string | null;
  beneficiary_account_no: string | null;
  beneficiary_bank: string | null;
  fingerprint: string;
};
