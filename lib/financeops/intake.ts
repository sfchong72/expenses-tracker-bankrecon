import { sha256Hex } from "./auth.ts";
import type { CategoryMatch, SupplierMatch } from "./supplier-match.ts";
import type { AllowedMime, EntityCode, FinanceOpsBillIntake } from "./schema.ts";

/**
 * Pure helpers that turn a validated intake into a *proposal* for a DRAFT supplier bill,
 * and the rules a human reviewer must satisfy before "Mark Verified".
 * Nothing here touches a database. FinanceOps can only ever propose payment_status='draft'.
 */

export const LOW_CONFIDENCE_THRESHOLD = 0.8;

// ------------------------------------------------------------------ hashing

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** Stable per intake: identical retries hash identically; a changed payload does not. */
export function computePayloadHash(intake: FinanceOpsBillIntake, fileSha256: string): string {
  return sha256Hex(`${canonicalJson(intake)}\n${fileSha256.toLowerCase()}`);
}

// ------------------------------------------------------------------ file checks

export function sniffMime(bytes: Uint8Array): AllowedMime | null {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return "application/pdf";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  return null;
}

export type FileVerification =
  | { ok: true; sha256: string }
  | { ok: false; code: "document_hash_mismatch" | "content_type_mismatch" | "unrecognised_file_content" };

/** Server-side recomputation: never trust the declared hash or MIME type alone. */
export function verifyDocumentBytes(bytes: Uint8Array, declared: { sha256: string; mimeType: string; uploadedMimeType: string }): FileVerification {
  const sniffed = sniffMime(bytes);
  if (!sniffed) return { ok: false, code: "unrecognised_file_content" };
  if (sniffed !== declared.mimeType || sniffed !== declared.uploadedMimeType) return { ok: false, code: "content_type_mismatch" };
  const actual = sha256Hex(bytes);
  if (actual !== declared.sha256.toLowerCase()) return { ok: false, code: "document_hash_mismatch" };
  return { ok: true, sha256: actual };
}

// ------------------------------------------------------------------ proposal

export type DraftBillProposal = {
  /** Insert fields. `created_by` and ids of existing records are supplied by the server, never by FinanceOps. */
  bill: {
    entity_code: EntityCode;
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
    is_demo: false;
    data_origin: "imported";
  };
  flags: string[];
};

export type ProposalResult =
  | { kind: "draft"; proposal: DraftBillProposal }
  | { kind: "needs_human_review"; reason: "entity_unresolved"; flags: string[] };

export function isoDate(isoDateTime: string): string {
  return isoDateTime.slice(0, 10);
}

export function buildDraftBillProposal(intake: FinanceOpsBillIntake, supplier: SupplierMatch, category: CategoryMatch): ProposalResult {
  const flags: string[] = [];
  if (intake.entity_code === null) return { kind: "needs_human_review", reason: "entity_unresolved", flags: ["entity_unresolved"] };

  const inv = intake.invoice;
  const receivedDate = isoDate(intake.source.received_at);

  let billDate = inv.date;
  if (!billDate) {
    billDate = receivedDate;
    flags.push("bill_date_missing");
  }

  // D5: schema requires NOT NULL due_date; use bill_date as a clearly flagged placeholder.
  let dueDate = inv.due_date;
  if (!dueDate) {
    dueDate = billDate;
    flags.push("due_date_missing");
  } else if (dueDate < billDate) {
    flags.push("due_date_before_bill_date");
  }

  let total = inv.total_amount;
  const subtotal = inv.subtotal;
  const tax = inv.tax_amount;
  if (total === null) {
    if (subtotal !== null) {
      total = Math.round((subtotal + (tax ?? 0)) * 100) / 100;
      flags.push("total_derived_from_subtotal");
    } else {
      total = 0;
      flags.push("amount_missing");
    }
  } else if (subtotal !== null && tax !== null && Math.abs(subtotal + tax - total) > 0.01) {
    flags.push("amount_mismatch");
  }
  if (total === 0 && !flags.includes("amount_missing")) flags.push("amount_missing");

  const currency = inv.currency ?? "MYR";
  if (!inv.currency) flags.push("currency_assumed");
  if (currency !== "MYR") flags.push("non_myr_currency");

  if (!inv.number) flags.push("invoice_number_missing");

  if (supplier.status === "candidates") flags.push("supplier_ambiguous");
  else if (supplier.status === "none") flags.push("supplier_unmatched");

  if (category.status !== "exact") flags.push(category.status === "candidates" ? "category_ambiguous" : "category_unmatched");

  const supplierText = intake.supplier.name ?? "unknown supplier";
  let description = inv.description;
  if (!description) {
    description = `Supplier invoice${inv.number ? ` ${inv.number}` : ""} - ${supplierText}`.slice(0, 500);
    flags.push("description_inferred");
  }

  for (const [field, entry] of Object.entries(intake.extraction.fields)) {
    if (entry && entry.confidence < LOW_CONFIDENCE_THRESHOLD) flags.push(`low_confidence:${field}`);
  }
  if (intake.extraction.overall_confidence < LOW_CONFIDENCE_THRESHOLD) flags.push("low_confidence:overall");

  return {
    kind: "draft",
    proposal: {
      bill: {
        entity_code: intake.entity_code,
        supplier_id: supplier.status === "exact" ? supplier.supplierId : null,
        bill_number: inv.number,
        description,
        bill_type: "supplier_invoice",
        bill_date: billDate,
        due_date: dueDate,
        subtotal: subtotal ?? total,
        tax_amount: tax ?? 0,
        total_amount: total,
        outstanding_amount: total,
        currency,
        expense_category_id: category.status === "exact" ? category.categoryId : null,
        payment_status: "draft",
        supporting_document_status: "no_document",
        remarks: intake.notes,
        is_demo: false,
        data_origin: "imported",
      },
      flags: Array.from(new Set(flags)),
    },
  };
}

// Human-verification rules live in ./verification.ts (no Node imports) so client components can use them.
export { VERIFY_BLOCKING_FLAGS, canVerifyIntake, verificationBlockers, type VerificationState } from "./verification.ts";
