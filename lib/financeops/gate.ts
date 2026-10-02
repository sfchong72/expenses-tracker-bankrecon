/**
 * Q5 (application-only gate): a Supplier Bill that was created from a FinanceOps intake may not be released
 * draft -> unpaid until a human has marked that intake `data_verified`. Bills with no FinanceOps intake behave
 * exactly as before (Stage 1B). The universal database trigger/policy is intentionally NOT changed for this.
 *
 * Fails closed: if the intake lookup itself fails we cannot tell whether the bill is FinanceOps-linked, so the
 * release is refused rather than allowed.
 */

export const FINANCEOPS_NOT_DATA_VERIFIED = "financeops_intake_not_data_verified";
export const FINANCEOPS_GATE_UNAVAILABLE = "financeops_gate_unavailable";

export type VerifyGateLookup = { error: string | null | undefined; rows: ReadonlyArray<{ review_status?: string | null }> | null | undefined };

export type VerifyGateDecision = { allow: true; financeopsLinked: boolean } | { allow: false; status: 409 | 500; error: string; message: string };

export function evaluateFinanceOpsVerifyGate(lookup: VerifyGateLookup): VerifyGateDecision {
  if (lookup.error) {
    return { allow: false, status: 500, error: FINANCEOPS_GATE_UNAVAILABLE, message: "Could not check whether this bill came from a FinanceOps intake, so it was not released. Please try again." };
  }
  const rows = lookup.rows ?? [];
  if (rows.length === 0) return { allow: true, financeopsLinked: false };
  if (rows.every((r) => r.review_status === "data_verified")) return { allow: true, financeopsLinked: true };
  return {
    allow: false,
    status: 409,
    error: FINANCEOPS_NOT_DATA_VERIFIED,
    message: "This bill came from a FinanceOps intake. A human must mark the intake Data Verified before the bill can be verified and marked ready for payment.",
  };
}
