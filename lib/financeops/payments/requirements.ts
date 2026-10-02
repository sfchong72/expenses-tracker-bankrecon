import type { DocRole, PaymentType } from "./types";
import { DOC_ROLE_LABELS } from "./types";

/**
 * Simple, rule-based document requirements per payment type. A missing document never rejects a payment: it keeps
 * the payment visible in the Missing Documents queue (and stops it moving to finance_review until a human attaches
 * the document, marks it not applicable, or approves an exception).
 */

export const REQUIRED_BY_TYPE: Record<PaymentType, readonly DocRole[]> = {
  supplier_expense: ["invoice", "payment_evidence"],
  intern_wage: ["wage_schedule", "payment_evidence"], // an invoice is NOT required for wages
  staff_claim: ["claim_support", "payment_evidence"],
  rent_deposit: ["agreement", "payment_evidence"],
  other: ["payment_evidence"], // a human may add or relax requirements
};

/** Roles that are explicitly "not applicable" for a type (shown as N/A in the checklist, never as missing). */
export const NOT_APPLICABLE_BY_TYPE: Record<PaymentType, readonly DocRole[]> = {
  supplier_expense: [],
  intern_wage: ["invoice"],
  staff_claim: ["invoice"],
  rent_deposit: [],
  other: [],
};

export function requirementsFor(type: PaymentType): DocRole[] {
  return [...REQUIRED_BY_TYPE[type]];
}

export type DocumentsState = {
  required: readonly DocRole[];
  notApplicable: readonly DocRole[];
  /** roles with at least one live (not removed) document attached to the payment */
  available: readonly DocRole[];
  /** a linked Supplier Bill whose invoice is already uploaded satisfies the invoice requirement */
  billHasInvoice?: boolean;
  exceptionApproved?: boolean;
};

export function missingDocuments(state: DocumentsState): DocRole[] {
  return state.required.filter(
    (role) => !state.notApplicable.includes(role) && !state.available.includes(role) && !(role === "invoice" && state.billHasInvoice),
  );
}

export const documentsComplete = (state: DocumentsState): boolean => missingDocuments(state).length === 0;

/** What the database gate checks before finance_review / ready_for_sql: complete, or a human approved an exception. */
export const documentsSatisfied = (state: DocumentsState): boolean => documentsComplete(state) || Boolean(state.exceptionApproved);

export type ChecklistItem = { role: DocRole; label: string; state: "present" | "missing" | "not_applicable" | "via_supplier_bill" };

export function documentChecklist(type: PaymentType, state: DocumentsState): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const seen = new Set<DocRole>();
  for (const role of state.required) {
    seen.add(role);
    let s: ChecklistItem["state"] = "missing";
    if (state.notApplicable.includes(role)) s = "not_applicable";
    else if (state.available.includes(role)) s = "present";
    else if (role === "invoice" && state.billHasInvoice) s = "via_supplier_bill";
    items.push({ role, label: DOC_ROLE_LABELS[role], state: s });
  }
  for (const role of NOT_APPLICABLE_BY_TYPE[type]) {
    if (!seen.has(role)) items.push({ role, label: DOC_ROLE_LABELS[role], state: "not_applicable" });
  }
  return items;
}

/** The bank/payment evidence is the one document every payment needs, whatever its type. */
export function ensureEvidenceRequired(required: readonly DocRole[]): DocRole[] {
  return required.includes("payment_evidence") ? [...required] : [...required, "payment_evidence"];
}
