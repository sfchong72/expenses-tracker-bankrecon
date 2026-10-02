/**
 * Human-verification rules for FinanceOps intakes. Pure and import-free so it can run in
 * client components and on the server. "Verified" means the extracted data matches the
 * original document; it does NOT approve payment (draft -> unpaid is a separate Finance
 * Staff-or-higher release).
 */

/** Flags that a human must explicitly resolve before "Mark Verified". */
export const VERIFY_BLOCKING_FLAGS = ["entity_unresolved", "due_date_missing", "amount_missing", "supplier_unmatched", "supplier_ambiguous", "duplicate_suspected_file"] as const;

export type VerificationState = {
  flags: readonly string[];
  /** Fields the reviewer has explicitly confirmed or corrected in this review session. */
  confirmed: { dueDate: boolean; amount: boolean; supplier: boolean; entity: boolean };
  current: { supplierId: string | null; totalAmount: number; entityId: string | null; hasDocument: boolean };
  /** Set when the reviewer has dismissed duplicate warnings after inspecting the matches. */
  duplicatesAcknowledged: boolean;
};

/** Returns the reasons "Mark Verified" must stay disabled; empty array = allowed. */
export function verificationBlockers(state: VerificationState): string[] {
  const out: string[] = [];
  if (!state.current.entityId) out.push("Entity must be selected.");
  if (!state.current.hasDocument) out.push("The original document must be attached.");
  if (!state.current.supplierId) out.push("A supplier must be selected.");
  if (!(state.current.totalAmount > 0)) out.push("Amount must be greater than zero.");
  if (state.flags.includes("due_date_missing") && !state.confirmed.dueDate) out.push("The due date is a placeholder; confirm or correct it.");
  if (state.flags.includes("amount_missing") && !state.confirmed.amount) out.push("The amount was not extracted; confirm or correct it.");
  if (state.flags.includes("entity_unresolved") && !state.confirmed.entity) out.push("The entity was uncertain; confirm it.");
  if ((state.flags.includes("supplier_unmatched") || state.flags.includes("supplier_ambiguous")) && !state.confirmed.supplier) out.push("Confirm the supplier.");
  const dupFlags = state.flags.filter((f) => f === "duplicate_suspected_file" || f.startsWith("possible_duplicate") || f === "same_file_in_other_entity");
  if (dupFlags.length > 0 && !state.duplicatesAcknowledged) out.push("Review the duplicate warnings.");
  return out;
}

/**
 * Four-eyes rule (D2): the identity that created an intake can never verify it.
 * The DB trigger in the future migration must enforce the same rule; this helper is the
 * application-layer mirror and is what the UI uses to hide/disable the action.
 */
export function canVerifyIntake(actorUserId: string | null | undefined, createdByUserId: string | null | undefined): boolean {
  if (!actorUserId || !createdByUserId) return false;
  return actorUserId !== createdByUserId;
}
