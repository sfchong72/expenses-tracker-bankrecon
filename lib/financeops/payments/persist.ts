import { respond, type HandlerResponse } from "../responses";
import { identityUsable, type StoreError } from "../store";
import { entityFromText } from "./register-import";
import { ensureEvidenceRequired, missingDocuments, requirementsFor } from "./requirements";
import type { PaymentIntake, PaymentIntakeDocument } from "./intake-schema";
import { paymentDocumentIdFor, paymentIdFor, type PaymentRow, type PaymentStore } from "./store";
import type { DocRole } from "./types";

/**
 * Hermes payment capture -> an OPERATIONAL Payment Register row (never an official bill_payment).
 *
 *   identity check -> INSERT the payment first (intake_id is the idempotency key; deterministic id) ->
 *   attach each declared document (storage object, then the document row) -> finalise the status:
 *   documents_pending (something required is missing) or ready_for_bank_match.
 *
 * FinanceOps can capture and attach evidence. It can NOT confirm a bank match, mark finance_review / ready_for_sql /
 * posted_to_sql / reconciled, approve an exception, or set any human-only field: the 0024 trigger refuses those and
 * this module never tries. A failed step is reported as such (503, retryable); the payment is never reported complete early.
 */

export type PaymentFile = { bytes: Uint8Array; size: number; mimeType: string; sha256: string };

export type PersistPaymentInput = {
  intake: PaymentIntake;
  payloadHash: string;
  files: ReadonlyMap<string, PaymentFile>;
  keyId: string;
  requestId: string;
  allowedEntityCodes: readonly string[];
};

const RETRY_AFTER = { "Retry-After": "30" };
const EXT: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "text/csv": "csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx" };

function unavailable(error: StoreError | string, intakeId: string, code = "persistence_unavailable"): HandlerResponse {
  console.error("financeops payment persistence unavailable", { code, intakeId, detail: typeof error === "string" ? error : `${error.kind}: ${error.message}` });
  return respond(503, { error: code, intake_id: intakeId, retryable: true }, RETRY_AFTER);
}

export function storagePathForPayment(entityId: string, receivedAt: string, paymentId: string, documentId: string, mime: string): string {
  const d = new Date(receivedAt);
  const stamp = Number.isNaN(d.getTime()) ? new Date(0) : d;
  return `${entityId}/${stamp.getUTCFullYear()}/${String(stamp.getUTCMonth() + 1).padStart(2, "0")}/payments/${paymentId}/${documentId}.${EXT[mime] ?? "bin"}`;
}

const clean = (name: string): string => name.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 140) || "document";

/** What a human should look at, never a reason to refuse the capture. */
export function attentionReasons(intake: PaymentIntake, extra: { duplicateReference: boolean; samePayment: boolean }): string[] {
  const out: string[] = [];
  const p = intake.payment;
  if (intake.payment_type === "other") out.push("payment_type_unclear");
  if (!p.purpose) out.push("purpose_missing");
  if (!p.beneficiary_name && !p.beneficiary_account_no) out.push("beneficiary_missing");
  if (p.method === "cash") out.push("cash_no_bank_match_expected");
  if (extra.duplicateReference) out.push("possible_duplicate_bank_reference");
  if (extra.samePayment) out.push("possible_duplicate_payment");
  const fromName = entityFromText(p.pay_from_name);
  if (fromName && fromName !== intake.entity_code) out.push("pay_from_name_suggests_other_entity");
  if (intake.extraction.overall_confidence < 0.8) out.push("low_extraction_confidence");
  if (p.currency !== "MYR") out.push("non_myr_currency");
  return Array.from(new Set(out));
}

export function summarizePayment(row: PaymentRow, entityCode: string | null, docs: { required: readonly DocRole[]; available: readonly DocRole[] }, replay: boolean): Record<string, unknown> {
  const missing = missingDocuments({ required: docs.required, notApplicable: [], available: docs.available });
  return {
    intake_id: row.intake_id,
    status: row.status,
    payment_type: row.payment_type,
    entity_code: entityCode,
    needs_attention: row.needs_attention,
    attention_reasons: row.attention_reasons,
    documents_required: docs.required,
    documents_available: Array.from(new Set(docs.available)),
    documents_missing: missing,
    documents_complete: missing.length === 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(replay ? { idempotent_replay: true } : { idempotent_replay: false }),
  };
}

export async function persistPaymentIntake(store: PaymentStore, input: PersistPaymentInput): Promise<HandlerResponse> {
  const { intake, payloadHash } = input;

  const who = await store.identity();
  if (!who.ok) return unavailable(who.error, intake.intake_id, "integration_identity_unavailable");
  const identity = who.value;
  if (!identityUsable(identity)) {
    console.error("financeops payment identity is not an active data_entry registry identity", { role: identity.role, profileActive: identity.profileActive, registryActive: identity.registryActive });
    return respond(503, { error: "integration_identity_inactive", intake_id: intake.intake_id });
  }

  const entity = await store.entityByCode(intake.entity_code);
  if (!entity.ok) return unavailable(entity.error, intake.intake_id);
  if (!entity.value) return respond(503, { error: "entity_not_configured", intake_id: intake.intake_id });
  if (!identity.allowedEntityIds.includes(entity.value.id) || !input.allowedEntityCodes.includes(intake.entity_code)) {
    return respond(403, { error: "entity_not_permitted", intake_id: intake.intake_id });
  }
  const entityId = entity.value.id;
  const paymentId = paymentIdFor(intake.intake_id);
  const required = ensureEvidenceRequired(requirementsFor(intake.payment_type));
  const p = intake.payment;

  // ---- INSERT FIRST (deterministic id + unique intake_id): the database arbitrates replays and races
  const inserted = await store.insertPayment({
    id: paymentId,
    entity_id: entityId,
    source_type: "financeops",
    intake_id: intake.intake_id,
    payload_hash: payloadHash,
    integration_key_id: input.keyId,
    request_id: input.requestId,
    source: intake.source as unknown as Record<string, unknown>,
    payload: intake as unknown as Record<string, unknown>,
    suggested_links: intake.suggested_links as unknown as Record<string, unknown>,
    payment_type: intake.payment_type,
    claim_ref: intake.suggested_links.claim_ref,
    payroll_ref: intake.suggested_links.payroll_ref,
    payment_instruction_date: p.instruction_date,
    payment_instruction_time: p.instruction_time,
    payment_method: p.method,
    pay_from_account_ref: p.pay_from_account_ref,
    beneficiary_name: p.beneficiary_name,
    beneficiary_account_no: p.beneficiary_account_no,
    beneficiary_bank: p.beneficiary_bank,
    amount: p.amount,
    currency: p.currency,
    bank_reference: p.bank_reference,
    purpose: p.purpose,
    required_documents: required,
    status: "captured",
    needs_attention: false,
    attention_reasons: [],
    created_by: identity.userId,
  });

  let row: PaymentRow;
  let replay = false;
  if (inserted.ok) row = inserted.value;
  else if (inserted.error.kind === "conflict") {
    const existing = await store.getPaymentByIntake(intake.intake_id);
    if (!existing.ok) return unavailable(existing.error, intake.intake_id);
    if (!existing.value || existing.value.created_by !== identity.userId || existing.value.payload_hash !== payloadHash) {
      return respond(409, { error: "intake_conflict", intake_id: intake.intake_id, message: "This intake_id was already used with a different payload. Use a new intake_id." });
    }
    row = existing.value;
    replay = true;
  } else if (inserted.error.kind === "denied") {
    return respond(403, { error: "integration_not_permitted", intake_id: intake.intake_id });
  } else if (inserted.error.kind === "rejected" || inserted.error.kind === "constraint") {
    console.error("financeops payment insert refused", { intakeId: intake.intake_id, detail: `${inserted.error.kind}: ${inserted.error.message}` });
    return respond(422, { error: "payment_rejected", intake_id: intake.intake_id, message: "The database refused this payment record." });
  } else return unavailable(inserted.error, intake.intake_id);

  // a payment a human has already moved on is reported as it is; nothing more is written to it
  const early = ["captured", "documents_pending", "ready_for_bank_match", "bank_match_suggested"];
  const existingDocs = await store.listPaymentDocuments(row.id);
  if (!existingDocs.ok) return unavailable(existingDocs.error, intake.intake_id);
  const live = existingDocs.value.filter((d) => d.removed_at === null);

  if (row.created_by === identity.userId && row.status && early.includes(row.status)) {
    // ---- documents: storage object, then the document row (deterministic ids make a retry adopt the earlier work)
    for (const doc of intake.documents) {
      const outcome = await attachDocument(store, { intake, doc, file: input.files.get(doc.part), entityId, paymentId, userId: identity.userId, live });
      if ("response" in outcome) return outcome.response;
      if (outcome.attached) live.push({ id: outcome.id, doc_role: doc.role, file_hash: doc.sha256, removed_at: null });
    }

    // ---- finalise (only mechanical columns): documents_pending or ready_for_bank_match, plus attention flags
    const dup = await store.findPossibleDuplicates({ entityId, excludeId: row.id, bankReference: p.bank_reference, beneficiaryAccountNo: p.beneficiary_account_no, amount: p.amount, instructionDate: p.instruction_date });
    if (!dup.ok) return unavailable(dup.error, intake.intake_id);
    const available = live.map((d) => d.doc_role);
    const missing = missingDocuments({ required, notApplicable: [], available });
    const reasons = attentionReasons(intake, { duplicateReference: dup.value.bankReference, samePayment: dup.value.samePayment });
    const finalStatus = missing.length > 0 ? "documents_pending" : "ready_for_bank_match";
    if (row.status === "captured" || row.status === "documents_pending" || row.status === "ready_for_bank_match") {
      const done = await store.updatePayment(row.id, { status: finalStatus, needs_attention: reasons.length > 0, attention_reasons: reasons });
      if (!done.ok) {
        if (done.error.kind === "rejected" || done.error.kind === "denied" || done.error.kind === "constraint") {
          console.error("financeops payment finalise refused", { intakeId: intake.intake_id, detail: `${done.error.kind}: ${done.error.message}` });
          return respond(409, { error: "payment_update_rejected", intake_id: intake.intake_id, retryable: false });
        }
        return unavailable(done.error, intake.intake_id);
      }
      row = done.value;
    }
  }

  const code = intake.entity_code;
  return respond(replay ? 200 : 201, { ...summarizePayment(row, code, { required: row.required_documents ?? required, available: live.map((d) => d.doc_role) }, replay) });
}

type AttachResult = { attached: boolean; id: string } | { response: HandlerResponse };

async function attachDocument(
  store: PaymentStore,
  a: { intake: PaymentIntake; doc: PaymentIntakeDocument; file: PaymentFile | undefined; entityId: string; paymentId: string; userId: string; live: { id: string; doc_role: DocRole; file_hash: string }[] },
): Promise<AttachResult> {
  const { intake, doc } = a;
  const docId = paymentDocumentIdFor(intake.intake_id, doc.part);
  if (a.live.some((d) => d.id === docId || (d.doc_role === doc.role && d.file_hash === doc.sha256))) return { attached: false, id: docId };
  if (!a.file) return { response: respond(422, { error: "validation_failed", intake_id: intake.intake_id, issues: [{ path: `documents.${doc.part}`, code: "required" }] }) };

  const path = storagePathForPayment(a.entityId, intake.source.received_at, a.paymentId, docId, doc.mime_type);
  const uploaded = await store.uploadPaymentObject(path, a.file.bytes, doc.mime_type);
  if (!uploaded.ok) return { response: unavailable(uploaded.error, intake.intake_id) };
  const inserted = await store.insertPaymentDocument({
    id: docId,
    payment_register_id: a.paymentId,
    entity_id: a.entityId,
    doc_role: doc.role,
    storage_path: path,
    original_filename: clean(doc.filename),
    mime_type: doc.mime_type,
    file_size: a.file.size,
    file_hash: doc.sha256,
    uploaded_by: a.userId,
  });
  if (!inserted.ok && inserted.error.kind !== "conflict") {
    if (inserted.error.kind === "unavailable") return { response: unavailable(inserted.error, intake.intake_id) };
    console.error("financeops payment document refused", { intakeId: intake.intake_id, detail: `${inserted.error.kind}: ${inserted.error.message}` });
    return { response: respond(422, { error: "document_rejected", intake_id: intake.intake_id, message: "The database refused a document." }) };
  }
  return { attached: true, id: docId };
}
