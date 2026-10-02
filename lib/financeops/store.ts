import type { ExistingBill, ExistingDocumentLink } from "./duplicates";
import type { SafeCategory, SafeSupplier } from "./supplier-match";

/**
 * Persistence port for the FinanceOps intake flow. Pure types: the orchestration in persist.ts and status.ts
 * depends only on this interface. The production implementation (store-supabase.ts) runs every call with the
 * FinanceOps identity's OWN Supabase session, so RLS and the 0023 / Stage 1B triggers stay authoritative.
 * There is no service-role path anywhere behind this interface.
 */

export type ProcessState = "received" | "awaiting_entity" | "bill_created" | "document_attached" | "complete";
export type ReviewStatus = "pending_review" | "data_verified" | "rejected" | "duplicate_suspected" | "needs_attention";

export type StoreErrorKind =
  /** unique violation */
  | "conflict"
  /** row-level security / privilege denial */
  | "denied"
  /** a trigger raised an exception (a business rule said no) */
  | "rejected"
  /** check / foreign-key / not-null violation */
  | "constraint"
  /** anything else: network, timeout, unexpected error. Safe to retry. */
  | "unavailable";

export type StoreError = { kind: StoreErrorKind; constraint?: string; message: string };
export type Res<T> = { ok: true; value: T } | { ok: false; error: StoreError };

export type FinanceOpsIdentity = {
  userId: string;
  /** app_profiles.role of the signed-in identity; must be exactly "data_entry". */
  role: string | null;
  profileActive: boolean;
  /** finance_integration_identities row is present and active (the kill switch). */
  registryActive: boolean;
  allowedEntityIds: string[];
};

export type EntityRef = { id: string; code: string };

export type IntakeRow = {
  id: string;
  intake_id: string;
  payload_hash: string;
  entity_code_declared: string | null;
  entity_id: string | null;
  supplier_bill_id: string | null;
  document_id: string | null;
  document_sha256: string;
  document_mime_type: string;
  document_filename: string;
  document_size_bytes: number;
  flags: string[];
  duplicate_matches: unknown[];
  process_state: ProcessState;
  review_status: ReviewStatus;
  entity_resolved_at: string | null;
  supersedes_intake_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type NewIntake = {
  intake_id: string;
  payload_hash: string;
  integration_key_id: string;
  request_id: string;
  source: Record<string, unknown>;
  payload: Record<string, unknown>;
  entity_code_declared: string | null;
  entity_id: string | null;
  document_sha256: string;
  document_mime_type: string;
  document_filename: string;
  document_size_bytes: number;
  flags: string[];
  duplicate_matches: unknown[];
  review_status: "pending_review";
  supersedes_intake_id: string | null;
  created_by: string;
};

/** The only columns the FinanceOps identity ever advances (0023 enforces the same set). */
export type IntakePatch = Partial<Pick<IntakeRow, "flags" | "duplicate_matches" | "review_status" | "supplier_bill_id" | "document_id" | "process_state">>;

export type NewBill = {
  id: string;
  entity_id: string;
  supplier_id: string | null;
  bill_number: string | null;
  description: string;
  bill_type: "supplier_invoice";
  bill_date: string;
  due_date: string;
  subtotal: number;
  tax_amount: number;
  total_amount: number;
  outstanding_amount: number;
  currency: string;
  expense_category_id: string | null;
  payment_status: "draft";
  supporting_document_status: "no_document";
  remarks: string | null;
  created_by: string;
  is_demo: false;
  data_origin: "imported";
};

export type BillRef = { id: string; entity_id: string; created_by: string | null; payment_status: string };

export type NewDocument = {
  id: string;
  entity_id: string;
  document_type: "supplier_invoice";
  original_filename: string;
  storage_path: string;
  mime_type: string;
  file_size: number;
  file_hash: string;
  uploaded_by: string;
  version_number: 1;
  is_demo: false;
  data_origin: "imported";
};

export type NewDocumentLink = {
  document_id: string;
  entity_id: string;
  linked_record_type: "supplier_bill";
  linked_record_id: string;
  created_by: string;
  is_demo: false;
  data_origin: "imported";
};

export interface IntakeStore {
  identity(): Promise<Res<FinanceOpsIdentity>>;
  entityByCode(code: string): Promise<Res<EntityRef | null>>;
  entityById(id: string): Promise<Res<EntityRef | null>>;

  insertIntake(row: NewIntake): Promise<Res<IntakeRow>>;
  getIntake(intakeId: string): Promise<Res<IntakeRow | null>>;
  updateIntake(rowId: string, patch: IntakePatch): Promise<Res<IntakeRow>>;

  loadSuppliers(entityId: string): Promise<Res<SafeSupplier[]>>;
  loadCategories(entityId: string): Promise<Res<SafeCategory[]>>;
  loadDuplicateContext(query: { entityId: string; fileSha256: string; supplierId: string | null }): Promise<Res<{ bills: ExistingBill[]; documents: ExistingDocumentLink[] }>>;

  getBill(id: string): Promise<Res<BillRef | null>>;
  insertBill(row: NewBill): Promise<Res<BillRef>>;

  /** Resolves ok for both a fresh upload and an object that an earlier attempt already stored at the same path. */
  uploadObject(path: string, bytes: Uint8Array, contentType: string): Promise<Res<{ alreadyExisted: boolean }>>;
  /** Inserts WITHOUT reading the row back: an unlinked document is invisible to its own uploader until linked. */
  insertDocument(row: NewDocument): Promise<Res<null>>;
  linkDocument(row: NewDocumentLink): Promise<Res<null>>;
}

// ------------------------------------------------------------------ error classification

export type RawDbError = { code?: string | null; message?: string | null; details?: string | null; hint?: string | null; statusCode?: string | number | null };

/** Extracts `constraint "name"` from a Postgres/PostgREST message. */
export function constraintFrom(message: string | null | undefined): string | undefined {
  const m = /constraint "([^"]+)"/.exec(message ?? "");
  return m ? m[1] : undefined;
}

export function classifyDbError(err: RawDbError): StoreError {
  const message = String(err.message ?? "unknown database error");
  const code = String(err.code ?? "");
  const constraint = constraintFrom(message) ?? constraintFrom(err.details);
  if (code === "23505") return { kind: "conflict", constraint, message };
  if (code === "42501") return { kind: "denied", message };
  if (code === "P0001") return { kind: "rejected", message };
  if (code === "23514" || code === "23503" || code === "23502" || code.startsWith("22")) return { kind: "constraint", constraint, message };
  return { kind: "unavailable", message };
}
