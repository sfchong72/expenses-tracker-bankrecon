/**
 * Review rules for the FinanceOps intake queue. Pure and import-free: usable in client components and tests.
 *
 * These helpers decide what the UI OFFERS. The 0023 trigger and RLS policies remain the authority and refuse
 * anything these helpers would wrongly allow; the helpers mirror them so the UI never offers a dead button.
 *
 * Wording: "Data Verified" is the intake-level human check (the extracted data matches the original document).
 * It is NOT the Stage 1B "Verify & Mark Ready for Payment" (Supplier Bill draft -> unpaid), which is separate.
 */

export const APPROVED_ENTITY_CODES = ["IEA", "IETA", "PLC", "KALER"] as const;

/** D11: only these roles see or resolve an intake whose entity is unknown. */
export const ENTITY_RESOLVER_ROLES = ["owner", "finance_manager", "finance_staff"] as const;

/** can_manage_bills: who may do entity-scoped data review (includes the data_entry intern, D2). */
export const DATA_REVIEWER_ROLES = ["owner", "finance_manager", "finance_staff", "data_entry"] as const;

/** can_view_finance: who may see the queue at all (management read-only). */
export const QUEUE_VIEWER_ROLES = ["owner", "finance_manager", "finance_staff", "data_entry", "management"] as const;

const has = (list: readonly string[], role: string | null | undefined): boolean => typeof role === "string" && list.includes(role);

export const canResolveEntity = (role: string | null | undefined): boolean => has(ENTITY_RESOLVER_ROLES, role);
export const canReviewIntakeData = (role: string | null | undefined): boolean => has(DATA_REVIEWER_ROLES, role);
export const canViewIntakeQueue = (role: string | null | undefined): boolean => has(QUEUE_VIEWER_ROLES, role);

export type ReviewStatus = "pending_review" | "data_verified" | "rejected" | "duplicate_suspected" | "needs_attention";
export type ReviewTarget = ReviewStatus;

export type ReviewContext = {
  role: string | null | undefined;
  actorUserId: string | null | undefined;
  /** The identity that created the intake: always the FinanceOps data_entry user. */
  createdByUserId: string | null | undefined;
  entityResolved: boolean;
  processState: string;
  reviewStatus: ReviewStatus;
};

/**
 * Statuses the current user may move this intake to. Mirrors enforce_finance_intake_rules():
 *  - terminal states (data_verified, rejected) are frozen;
 *  - the creating identity (FinanceOps) can never review its own intake (four-eyes);
 *  - an unresolved intake can only be rejected, and only by the central Finance-review set;
 *  - data_verified needs a resolved entity and process_state 'complete' (bill and original document attached).
 */
export function allowedReviewTargets(ctx: ReviewContext): ReviewTarget[] {
  if (ctx.reviewStatus === "data_verified" || ctx.reviewStatus === "rejected") return [];
  if (!ctx.actorUserId || !ctx.createdByUserId || ctx.actorUserId === ctx.createdByUserId) return [];
  if (!ctx.entityResolved) return canResolveEntity(ctx.role) ? ["rejected"] : [];
  if (!canReviewIntakeData(ctx.role)) return [];

  const complete = ctx.processState === "complete";
  const out: ReviewTarget[] = [];
  if (ctx.reviewStatus === "pending_review") {
    if (complete) out.push("data_verified");
    out.push("rejected", "needs_attention", "duplicate_suspected");
  } else if (ctx.reviewStatus === "needs_attention") {
    out.push("pending_review");
    if (complete) out.push("data_verified");
    out.push("rejected");
  } else if (ctx.reviewStatus === "duplicate_suspected") {
    out.push("pending_review", "rejected");
  }
  return out;
}

export const REVIEW_TARGET_LABELS: Record<ReviewTarget, string> = {
  data_verified: "Data Verified",
  rejected: "Reject intake",
  needs_attention: "Flag: needs attention",
  duplicate_suspected: "Flag: duplicate suspected",
  pending_review: "Return to pending review",
};

// ------------------------------------------------------------------ resolve entity

export type ResolutionInput = { entityCode: string; note: string };
export type ResolutionCheck = { ok: true; entityCode: (typeof APPROVED_ENTITY_CODES)[number]; note: string } | { ok: false; message: string };

/** Exactly one approved entity and a real note (>= 3 characters, as the database requires). */
export function validateResolution(input: ResolutionInput): ResolutionCheck {
  const code = input.entityCode.trim().toUpperCase();
  if (!(APPROVED_ENTITY_CODES as readonly string[]).includes(code)) return { ok: false, message: "Choose exactly one approved entity: IEA, IETA, PLC or KALER." };
  const note = input.note.trim();
  if (note.length < 3) return { ok: false, message: "Enter a resolution note (at least 3 characters) explaining how the entity was determined." };
  if (note.length > 1000) return { ok: false, message: "The resolution note is too long (maximum 1000 characters)." };
  return { ok: true, entityCode: code as (typeof APPROVED_ENTITY_CODES)[number], note };
}

// ------------------------------------------------------------------ queue grouping and display

export type QueueRowLike = {
  entity_id: string | null;
  review_status: ReviewStatus;
  is_superseded?: boolean | null;
};

export type QueueGroup = "needs_entity" | "in_review" | "done" | "superseded";

export function groupOf(row: QueueRowLike): QueueGroup {
  if (row.review_status === "data_verified" || row.review_status === "rejected") return "done";
  if (row.entity_id === null) return row.is_superseded ? "superseded" : "needs_entity";
  return "in_review";
}

export type ExtractedView = { label: string; value: string | null; confidence: number | null; flag?: string };

const money = (v: unknown, currency: unknown): string | null => (typeof v === "number" ? `${typeof currency === "string" ? currency : "MYR"} ${v.toFixed(2)}` : null);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** What FinanceOps extracted, read from the stored payload (never trusted as data; display only). */
export function extractedFromPayload(payload: unknown, flags: readonly string[]): ExtractedView[] {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, any>;
  const inv = (p.invoice ?? {}) as Record<string, unknown>;
  const sup = (p.supplier ?? {}) as Record<string, unknown>;
  const fields = ((p.extraction ?? {}) as Record<string, any>).fields ?? {};
  const conf = (name: string): number | null => (typeof fields?.[name]?.confidence === "number" ? fields[name].confidence : null);
  return [
    { label: "Supplier", value: text(sup.name), confidence: conf("supplier_name") },
    { label: "Supplier registration no.", value: text(sup.registration_number), confidence: conf("supplier_registration_number") },
    { label: "Invoice number", value: text(inv.number), confidence: conf("invoice_number") },
    { label: "Invoice date", value: text(inv.date), confidence: conf("invoice_date") },
    { label: "Due date", value: text(inv.due_date), confidence: conf("due_date"), flag: flags.includes("due_date_missing") ? "due_date_missing" : undefined },
    { label: "Total amount", value: money(inv.total_amount, inv.currency), confidence: conf("total_amount") },
    { label: "Description", value: text(inv.description), confidence: conf("description") },
  ];
}
