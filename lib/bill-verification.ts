// Single source of truth for the Supplier Bill verification step (draft -> unpaid).
// Stage 1B (0022) lets a user with can_manage_bills and entity access move a bill out of draft; the
// trigger only blocks data_entry. This list narrows the application to the approved human reviewers
// (D12). It is a UI/API gate: the database policies and trigger remain authoritative.
export const BILL_VERIFIER_ROLES = ["owner", "finance_manager", "finance_staff"] as const;

export const VERIFY_FROM_STATUS = "draft";
export const VERIFY_TO_STATUS = "unpaid";

export function canVerifyBills(role: string | null | undefined): boolean {
  return typeof role === "string" && (BILL_VERIFIER_ROLES as readonly string[]).includes(role);
}

export function canVerifyBill(role: string | null | undefined, bill: { payment_status?: string | null } | null | undefined): boolean {
  return canVerifyBills(role) && bill?.payment_status === VERIFY_FROM_STATUS;
}
