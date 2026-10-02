import type { PaymentStatus } from "./types";
import { CAPTURE_STATUSES, canCapturePayments, EARLY_STATUSES, isFinanceReviewer, isOwnerOrFinanceManager, STATUS_LABELS } from "./types";

/**
 * What the UI OFFERS for a payment, mirroring enforce_finance_payment_rules() in migration 0024. The database trigger
 * is the authority and refuses anything this would wrongly allow; mirroring it just means no dead buttons and a clear
 * reason beside every disabled move.
 */

export type MoveContext = {
  role: string | null | undefined;
  actorUserId: string | null | undefined;
  /** the FinanceOps identity (creator of a financeops-sourced row) is never offered a human move */
  createdByUserId: string | null | undefined;
  sourceType: "manual" | "financeops" | "excel_import";
  status: PaymentStatus;
  hasConfirmedMatch: boolean;
  bankMatchNotApplicable: boolean;
  /** required documents are all present / not applicable, or a human approved an exception */
  documentsSatisfied: boolean;
  missingDocuments: readonly string[];
  hasSqlReference: boolean;
  hasSqlPostingDate: boolean;
  hasReconciledDate: boolean;
};

export type Move = { to: PaymentStatus; label: string; allowed: boolean; blocker?: string };

const move = (to: PaymentStatus, label: string, blocker?: string): Move => ({ to, label, allowed: !blocker, ...(blocker ? { blocker } : {}) });

export function allowedMoves(ctx: MoveContext): Move[] {
  const reviewer = isFinanceReviewer(ctx.role);
  const ownerFm = isOwnerOrFinanceManager(ctx.role);
  if (!ctx.actorUserId) return [];
  if (ctx.sourceType === "financeops" && ctx.actorUserId === ctx.createdByUserId) return []; // FinanceOps moves its own capture mechanically, never via the UI
  const early = EARLY_STATUSES.includes(ctx.status);
  const moves: Move[] = [];

  if (early && canCapturePayments(ctx.role)) {
    for (const s of CAPTURE_STATUSES) if (s !== ctx.status) moves.push(move(s, `Set to ${STATUS_LABELS[s]}`));
  }
  if (!reviewer) return moves; // the data_entry intern: early housekeeping only

  const bankOk = ctx.hasConfirmedMatch || ctx.bankMatchNotApplicable;
  const docsBlocker = ctx.documentsSatisfied ? undefined : `Required documents are missing (${ctx.missingDocuments.join(", ")}): attach them or approve an exception`;

  switch (ctx.status) {
    case "captured":
    case "documents_pending":
    case "ready_for_bank_match":
    case "bank_match_suggested":
      if (ctx.status !== "bank_match_suggested") moves.push(move("bank_match_suggested", "Mark match suggested"));
      moves.push(move("bank_matched", "Bank matched (needs a confirmed match)", ctx.hasConfirmedMatch ? undefined : "Confirm a bank match first"));
      if (ctx.bankMatchNotApplicable) moves.push(move("finance_review", "Send to finance review", docsBlocker));
      break;
    case "bank_matched":
      moves.push(move("finance_review", "Send to finance review", docsBlocker));
      moves.push(move("ready_for_bank_match", "Return to ready for bank match", ctx.hasConfirmedMatch ? "Reject the confirmed bank match first" : undefined));
      break;
    case "finance_review":
      moves.push(move("ready_for_sql", "Mark Ready for SQL", !bankOk ? "Needs a confirmed bank match or a bank-match-not-applicable decision" : docsBlocker));
      moves.push(move(ctx.hasConfirmedMatch ? "bank_matched" : "ready_for_bank_match", "Return for correction"));
      break;
    case "ready_for_sql":
      moves.push(move("posted_to_sql", "Record Posted to SQL", ctx.hasSqlReference && ctx.hasSqlPostingDate ? undefined : "Enter the SQL reference and the SQL posting date first"));
      moves.push(move("finance_review", "Return to finance review"));
      break;
    case "posted_to_sql":
      moves.push(move("reconciled", "Track as Reconciled", ctx.hasReconciledDate ? undefined : "Enter the reconciliation date first"));
      if (ownerFm) moves.push(move("ready_for_sql", "Reverse posting (Owner / Finance Manager)"));
      break;
    case "reconciled":
      if (ownerFm) moves.push(move("posted_to_sql", "Reverse reconciliation (Owner / Finance Manager)"));
      break;
  }
  return moves;
}

/** Details are editable by reviewers until finance review, by the intern only while early. Never for FinanceOps. */
export function canEditDetails(ctx: Pick<MoveContext, "role" | "actorUserId" | "createdByUserId" | "sourceType" | "status">): boolean {
  if (!ctx.actorUserId) return false;
  if (ctx.sourceType === "financeops" && ctx.actorUserId === ctx.createdByUserId) return false;
  if (["finance_review", "ready_for_sql", "posted_to_sql", "reconciled"].includes(ctx.status)) return false;
  if (isFinanceReviewer(ctx.role)) return true;
  return ctx.role === "data_entry" && EARLY_STATUSES.includes(ctx.status);
}

/** Exception approval, not-applicable decisions, bank-match-not-applicable and SQL fields: reviewers only. */
export const canMakeHumanDecisions = (role: string | null | undefined): boolean => isFinanceReviewer(role);
