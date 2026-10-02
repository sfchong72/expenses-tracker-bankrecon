import type { IntakeRow } from "./store";

/**
 * The narrow, operational view of an intake that FinanceOps/Hermes may see. Booleans instead of internal ids:
 * no bill id, document id, user id, supplier, amount, bank or payment data is ever returned.
 */

export type NextAction =
  /** unresolved entity: a Finance Staff-or-above reviewer resolves it, or send a NEW intake that supersedes it */
  | "awaiting_entity_resolution"
  /** a reviewer resolved the entity: re-send the SAME intake (same intake_id and payload) to create the draft bill and attach the file */
  | "resubmit_same_intake"
  /** blocked as a duplicate / flagged: a human decides */
  | "human_review_required"
  /** complete and waiting for a human to check the data */
  | "awaiting_data_review"
  /** nothing more to do (data verified, or released onward by a human) */
  | "none"
  | "rejected";

export function nextActionFor(row: Pick<IntakeRow, "entity_id" | "process_state" | "review_status" | "supplier_bill_id">): NextAction {
  if (row.review_status === "rejected") return "rejected";
  if (row.entity_id === null) return "awaiting_entity_resolution";
  if (row.review_status === "data_verified") return "none";
  if (row.review_status === "duplicate_suspected" || row.review_status === "needs_attention") return "human_review_required";
  if (row.process_state === "complete") return "awaiting_data_review";
  if (row.process_state === "received" && row.supplier_bill_id === null) return "resubmit_same_intake";
  // bill_created / document_attached: mid-flight; the same request resumes it.
  return "resubmit_same_intake";
}

export function summarizeIntake(row: IntakeRow, entityCode: string | null): Record<string, unknown> {
  return {
    intake_id: row.intake_id,
    process_state: row.process_state,
    review_status: row.review_status,
    entity_code: entityCode,
    entity_resolved: row.entity_id !== null,
    needs_entity: row.entity_id === null,
    duplicate_suspected: row.review_status === "duplicate_suspected",
    bill_created: row.supplier_bill_id !== null,
    document_attached: row.document_id !== null,
    flags: row.flags,
    next_action: nextActionFor(row),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
