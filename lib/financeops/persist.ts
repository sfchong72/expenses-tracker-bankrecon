import { classifyDuplicates } from "./duplicates";
import { billIdFor, documentIdFor } from "./ids";
import { buildDraftBillProposal } from "./intake";
import { respond, type HandlerResponse } from "./responses";
import type { AllowedMime, FinanceOpsBillIntake } from "./schema";
import { summarizeIntake } from "./status";
import { identityUsable, type EntityRef, type FinanceOpsIdentity, type IntakePatch, type IntakeRow, type IntakeStore, type NewBill, type StoreError } from "./store";
import { matchCategory, matchSupplier } from "./supplier-match";

/**
 * Intake persistence (Phase 1, after migration 0023).
 *
 * Flow per request:   INSERT the intake first (intake_id is the idempotency key)
 *                     -> resolved entity?  no: stop here, answer `needs_entity` (no bill, no file, no document)
 *                     -> exact duplicate?  yes: flag the intake `duplicate_suspected`, no bill
 *                     -> draft supplier bill  (state: bill_created)
 *                     -> original document: storage object, documents row, document_links row, THEN the intake link (state: document_attached)
 *                     -> complete
 *
 * Every write runs as the FinanceOps identity (data_entry) through RLS. 0023 and Stage 1B triggers remain
 * authoritative; this module never tries to be cleverer than they are. The bill and document primary keys are
 * derived from the intake id, so a retry adopts what an earlier attempt already created and resumes from the
 * stored process_state. A failed step is reported as such; the intake is never reported complete early.
 */

export type PersistInput = {
  intake: FinanceOpsBillIntake;
  payloadHash: string;
  file: { bytes: Uint8Array; size: number; mimeType: AllowedMime; sha256: string };
  keyId: string;
  requestId: string;
  /** Entity codes this HMAC key may act for (the per-key allow-list from configuration). */
  allowedEntityCodes: readonly string[];
};

const RETRY_AFTER = { "Retry-After": "30" };

function unavailable(error: StoreError | string, intakeId?: string, code = "persistence_unavailable"): HandlerResponse {
  // The database message is logged server-side only (never the payload, never returned to the caller).
  console.error("financeops persistence unavailable", { code, intakeId, detail: typeof error === "string" ? error : `${error.kind}: ${error.message}` });
  return respond(503, { error: code, ...(intakeId ? { intake_id: intakeId } : {}), retryable: true }, RETRY_AFTER);
}

function mapInsertError(error: StoreError, intakeId: string): HandlerResponse {
  const msg = error.message;
  if (error.kind === "conflict" && error.constraint === "fis_supersedes_uidx") {
    return respond(409, { error: "already_superseded", intake_id: intakeId, message: "The intake to supersede already has a successor." });
  }
  if (error.kind === "denied") return respond(403, { error: "integration_not_permitted", intake_id: intakeId });
  if (error.kind === "rejected") {
    if (msg.includes("intake_already_resolved")) return respond(409, { error: "intake_already_resolved", intake_id: intakeId, message: "The intake to supersede already has an entity." });
    if (msg.includes("to supersede was not found")) return respond(422, { error: "supersedes_intake_not_found", intake_id: intakeId });
    if (msg.includes("originating FinanceOps identity")) return respond(403, { error: "supersede_not_permitted", intake_id: intakeId });
    if (msg.includes("rejected intake cannot be superseded")) return respond(409, { error: "supersede_rejected_intake", intake_id: intakeId });
    return respond(409, { error: "intake_rejected_by_database", intake_id: intakeId });
  }
  if (error.kind === "constraint") {
    if (error.constraint === "fis_supersede_has_entity") return respond(422, { error: "supersede_requires_entity", intake_id: intakeId, message: "A superseding intake must declare an approved entity." });
    if (error.constraint === "fis_no_self_supersede") return respond(422, { error: "supersedes_self", intake_id: intakeId });
    if (error.constraint === "fis_supersedes_fk") return respond(422, { error: "supersedes_intake_not_found", intake_id: intakeId });
    return respond(422, { error: "intake_invalid", intake_id: intakeId });
  }
  return unavailable(error, intakeId);
}

export async function persistBillIntake(store: IntakeStore, input: PersistInput): Promise<HandlerResponse> {
  const { intake, payloadHash, file } = input;

  // ---- who are we? (kill switch and role are checked here as well as by RLS)
  const who = await store.identity();
  if (!who.ok) return unavailable(who.error, intake.intake_id, "integration_identity_unavailable");
  const identity = who.value;
  if (!identityUsable(identity)) {
    console.error("financeops identity is not an active data_entry registry identity", { role: identity.role, profileActive: identity.profileActive, registryActive: identity.registryActive });
    return respond(503, { error: "integration_identity_inactive", intake_id: intake.intake_id });
  }

  // ---- declared entity -> id, within the registry's allowed entities
  let entity: EntityRef | null = null;
  if (intake.entity_code !== null) {
    const found = await store.entityByCode(intake.entity_code);
    if (!found.ok) return unavailable(found.error, intake.intake_id);
    if (!found.value) return respond(503, { error: "entity_not_configured", intake_id: intake.intake_id });
    if (!identity.allowedEntityIds.includes(found.value.id)) return respond(403, { error: "entity_not_permitted", intake_id: intake.intake_id });
    entity = found.value;
  }

  // ---- INSERT FIRST. intake_id is unique; the database arbitrates replays and races.
  const inserted = await store.insertIntake({
    intake_id: intake.intake_id,
    payload_hash: payloadHash,
    integration_key_id: input.keyId,
    request_id: input.requestId,
    source: intake.source as unknown as Record<string, unknown>,
    payload: intake as unknown as Record<string, unknown>,
    entity_code_declared: entity ? entity.code : null,
    entity_id: entity ? entity.id : null,
    document_sha256: file.sha256,
    document_mime_type: file.mimeType,
    document_filename: intake.document.filename,
    document_size_bytes: file.size,
    flags: entity ? [] : ["entity_unresolved"],
    duplicate_matches: [],
    review_status: "pending_review",
    supersedes_intake_id: intake.supersedes_intake_id ?? null,
    created_by: identity.userId,
  });

  let row: IntakeRow;
  let replay = false;
  if (inserted.ok) {
    row = inserted.value;
  } else if (inserted.error.kind === "conflict" && inserted.error.constraint !== "fis_supersedes_uidx") {
    const existing = await store.getIntake(intake.intake_id);
    if (!existing.ok) return unavailable(existing.error, intake.intake_id);
    // Present but invisible to this identity, or a different payload: never reuse the id, never touch the row.
    // (RLS also lets the identity SEE other intakes in its entities; only rows it created can be replayed.)
    if (!existing.value || existing.value.created_by !== identity.userId || existing.value.payload_hash !== payloadHash) {
      return respond(409, { error: "intake_conflict", intake_id: intake.intake_id, message: "This intake_id was already used with a different payload. Use a new intake_id." });
    }
    row = existing.value;
    replay = true;
  } else {
    return mapInsertError(inserted.error, intake.intake_id);
  }

  return advance(store, identity, { intake, file, replay, allowedEntityCodes: input.allowedEntityCodes }, row);
}

type Ctx = { intake: FinanceOpsBillIntake; file: PersistInput["file"]; replay: boolean; allowedEntityCodes: readonly string[] };

async function entityCodeOf(store: IntakeStore, row: IntakeRow): Promise<{ ok: true; code: string | null } | { ok: false; error: StoreError }> {
  if (row.entity_code_declared) return { ok: true, code: row.entity_code_declared };
  if (!row.entity_id) return { ok: true, code: null };
  const found = await store.entityById(row.entity_id);
  if (!found.ok) return { ok: false, error: found.error };
  return { ok: true, code: found.value ? found.value.code : null };
}

async function advance(store: IntakeStore, identity: FinanceOpsIdentity, ctx: Ctx, start: IntakeRow): Promise<HandlerResponse> {
  let row = start;
  const code = await entityCodeOf(store, row);
  if (!code.ok) return unavailable(code.error, row.intake_id);
  const summary = (r: IntakeRow, c: string | null = code.code) => ({ ...summarizeIntake(r, c), idempotent_replay: ctx.replay });

  if (row.review_status === "rejected") {
    return respond(409, { error: "intake_rejected", message: "A reviewer rejected this intake; nothing further will be created.", ...summary(row) });
  }

  // Unresolved entity: the intake exists, nothing else does. Never guess; a Finance Staff-or-above reviewer resolves it.
  if (row.entity_id === null) {
    return respond(202, { status: "needs_entity", message: "Stored for entity resolution. No bill or document was created.", ...summary(row) });
  }
  const entityId = row.entity_id;
  const entityCode = code.code;
  if (!entityCode) return unavailable("entity code could not be resolved", row.intake_id);
  // A reviewer may have resolved the entity to one this registry identity or this key is not allowed to act for.
  // Nothing is created for it (the same limits that apply to a declared entity apply to a resolved one).
  if (row.process_state !== "complete" && (!identity.allowedEntityIds.includes(entityId) || !ctx.allowedEntityCodes.includes(entityCode))) {
    return respond(403, { error: "entity_not_permitted", message: "The resolved entity is outside what this integration may act for. No bill or document was created.", ...summary(row, entityCode) });
  }

  for (let guard = 0; guard < 6; guard += 1) {
    if (row.process_state === "complete") {
      return respond(ctx.replay ? 200 : 201, { status: "complete", ...summary(row, entityCode) });
    }
    if (row.process_state === "received") {
      const step = await stepCreateBill(store, identity, ctx, row, entityId, entityCode);
      if ("response" in step) return step.response;
      row = step.row;
    } else if (row.process_state === "bill_created") {
      const step = await stepAttachDocument(store, identity, ctx, row, entityId, entityCode);
      if ("response" in step) return step.response;
      row = step.row;
    } else if (row.process_state === "document_attached") {
      const done = await store.updateIntake(row.id, { process_state: "complete" });
      if (!done.ok) return mapUpdateError(done.error, row);
      row = done.value;
    } else {
      // awaiting_entity with an entity cannot exist (database constraint); fail closed.
      return unavailable(`unexpected process_state ${row.process_state}`, row.intake_id);
    }
  }
  return unavailable("state machine did not converge", row.intake_id);
}

function mapUpdateError(error: StoreError, row: IntakeRow): HandlerResponse {
  if (error.kind === "rejected" || error.kind === "denied" || error.kind === "constraint") {
    console.error("financeops intake update rejected", { intakeId: row.intake_id, detail: `${error.kind}: ${error.message}` });
    return respond(409, { error: "intake_update_rejected", intake_id: row.intake_id, process_state: row.process_state, message: "The database refused the next step. A reviewer must look at this intake.", retryable: false });
  }
  return unavailable(error, row.intake_id);
}

type Step = { row: IntakeRow } | { response: HandlerResponse };

// ------------------------------------------------------------------ received -> bill_created

async function stepCreateBill(store: IntakeStore, identity: FinanceOpsIdentity, ctx: Ctx, row: IntakeRow, entityId: string, entityCode: string): Promise<Step> {
  const { intake, file } = ctx;
  const summary = (r: IntakeRow) => ({ ...summarizeIntake(r, entityCode), idempotent_replay: ctx.replay });

  // A flagged intake is held for a human; replays do not push it through.
  if (row.review_status !== "pending_review") {
    return {
      response: respond(409, {
        error: row.review_status === "duplicate_suspected" ? "duplicate_suspected" : "intake_needs_attention",
        message: "This intake is held for human review; no bill was created.",
        ...summary(row),
      }),
    };
  }

  const [suppliers, categories] = await Promise.all([store.loadSuppliers(entityId), store.loadCategories(entityId)]);
  if (!suppliers.ok) return { response: unavailable(suppliers.error, row.intake_id) };
  if (!categories.ok) return { response: unavailable(categories.error, row.intake_id) };

  const supplier = matchSupplier({ name: intake.supplier.name, registrationNumber: intake.supplier.registration_number }, suppliers.value);
  const category = matchCategory(intake.category_hint.name, categories.value);
  // When a reviewer resolved the entity, the request still says entity_code = null; use the stored entity.
  const proposed = buildDraftBillProposal({ ...intake, entity_code: entityCode as FinanceOpsBillIntake["entity_code"] }, supplier, category);
  if (proposed.kind !== "draft") return { response: unavailable("proposal needs human review", row.intake_id) };
  const { bill, flags: proposalFlags } = proposed.proposal;

  const context = await store.loadDuplicateContext({ entityId, fileSha256: file.sha256, supplierId: supplier.status === "exact" ? supplier.supplierId : null });
  if (!context.ok) return { response: unavailable(context.error, row.intake_id) };
  // A retry after a lagged link can see this intake's OWN earlier draft bill; it is not a duplicate of itself.
  const ownBillId = billIdFor(intake.intake_id);
  const dup = classifyDuplicates(
    { entityId, supplierId: supplier.status === "exact" ? supplier.supplierId : null, invoiceNumber: intake.invoice.number, totalAmount: bill.total_amount, billDate: bill.bill_date, fileSha256: file.sha256 },
    context.value.bills.filter((b) => b.id !== ownBillId),
    context.value.documents.filter((d) => d.billId !== ownBillId),
  );
  const flags = Array.from(new Set([...proposalFlags, ...dup.flags]));

  // Exact duplicate (same file, same entity, active bill): no second bill. Flag it for a human.
  if (dup.decision === "block_duplicate_file") {
    const flagged = await store.updateIntake(row.id, { flags, duplicate_matches: dup.matches, review_status: "duplicate_suspected" });
    if (!flagged.ok) return { response: mapUpdateError(flagged.error, row) };
    return {
      response: respond(409, {
        error: "duplicate_file",
        message: "The identical file is already on an active bill in this entity. No bill was created; the intake is flagged for review.",
        duplicate_of: dup.matches.map((m) => ({ type: m.type, strength: m.strength })),
        ...summary(flagged.value),
      }),
    };
  }

  // Draft bill, created as FinanceOps (data_entry). Deterministic id: a retry adopts the earlier bill.
  const billId = billIdFor(intake.intake_id);
  const wanted: NewBill = {
    id: billId,
    entity_id: entityId,
    supplier_id: bill.supplier_id,
    bill_number: bill.bill_number,
    description: bill.description,
    bill_type: "supplier_invoice",
    bill_date: bill.bill_date,
    due_date: bill.due_date,
    subtotal: bill.subtotal,
    tax_amount: bill.tax_amount,
    total_amount: bill.total_amount,
    outstanding_amount: bill.outstanding_amount,
    currency: bill.currency,
    expense_category_id: bill.expense_category_id,
    payment_status: "draft",
    supporting_document_status: "no_document",
    remarks: bill.remarks,
    created_by: identity.userId,
    is_demo: false,
    data_origin: "imported",
  };
  let existing = await store.getBill(billId);
  if (!existing.ok) return { response: unavailable(existing.error, row.intake_id) };
  if (!existing.value) {
    const made = await store.insertBill(wanted);
    if (made.ok) existing = { ok: true, value: made.value };
    else if (made.error.kind === "conflict") {
      existing = await store.getBill(billId);
      if (!existing.ok) return { response: unavailable(existing.error, row.intake_id) };
    } else if (made.error.kind === "unavailable") {
      return { response: unavailable(made.error, row.intake_id) };
    } else {
      console.error("financeops draft bill insert refused", { intakeId: row.intake_id, detail: `${made.error.kind}: ${made.error.message}` });
      return { response: respond(422, { error: "draft_bill_rejected", message: "The database refused the draft bill. A reviewer must look at this intake.", ...summary(row) }) };
    }
  }
  const adopted = existing.value;
  if (!adopted || adopted.entity_id !== entityId || adopted.created_by !== identity.userId || adopted.payment_status !== "draft") {
    return { response: respond(409, { error: "bill_conflict", message: "The bill for this intake is not in the expected state. A reviewer must look at it.", ...summary(row) }) };
  }

  const patch: IntakePatch = { supplier_bill_id: billId, process_state: "bill_created", flags, duplicate_matches: dup.matches };
  const linked = await store.updateIntake(row.id, patch);
  if (!linked.ok) return { response: mapUpdateError(linked.error, row) };
  return { row: linked.value };
}

// ------------------------------------------------------------------ bill_created -> document_attached

const EXT: Record<AllowedMime, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" };

function cleanFilename(name: string): string {
  return name.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 140) || "document";
}

/** Storage key: entity / yyyy / mm / document type / bill id / document id . ext  - same shape as the Hub's own uploads. */
export function storagePathFor(entityId: string, receivedAt: string, billId: string, documentId: string, mime: AllowedMime): string {
  const d = new Date(receivedAt);
  const stamp = Number.isNaN(d.getTime()) ? new Date(0) : d;
  const yyyy = String(stamp.getUTCFullYear());
  const mm = String(stamp.getUTCMonth() + 1).padStart(2, "0");
  return `${entityId}/${yyyy}/${mm}/supplier_invoice/${billId}/${documentId}.${EXT[mime]}`;
}

async function stepAttachDocument(store: IntakeStore, identity: FinanceOpsIdentity, ctx: Ctx, row: IntakeRow, entityId: string, entityCode: string): Promise<Step> {
  const { intake, file } = ctx;
  const billId = row.supplier_bill_id;
  if (!billId) return { response: unavailable("bill link missing in bill_created state", row.intake_id) };
  // The bytes were verified against the declared hash and MIME by the handler; the stored row must agree.
  if (file.sha256 !== row.document_sha256) return { response: respond(409, { error: "intake_conflict", intake_id: row.intake_id }) };

  const documentId = documentIdFor(intake.intake_id);
  const path = storagePathFor(entityId, intake.source.received_at, billId, documentId, file.mimeType);

  // Order matters (documents are visible only through document_links, and the intake trigger reads the document as
  // the caller): storage object -> documents row -> document_links row -> intake link.
  const uploaded = await store.uploadObject(path, file.bytes, file.mimeType);
  if (!uploaded.ok) return { response: unavailable(uploaded.error, row.intake_id) };

  const doc = await store.insertDocument({
    id: documentId,
    entity_id: entityId,
    document_type: "supplier_invoice",
    original_filename: cleanFilename(intake.document.filename),
    storage_path: path,
    mime_type: file.mimeType,
    file_size: file.size,
    file_hash: file.sha256,
    uploaded_by: identity.userId,
    version_number: 1,
    is_demo: false,
    data_origin: "imported",
  });
  // A primary-key conflict means an earlier attempt already inserted it: carry on to the link.
  if (!doc.ok && doc.error.kind !== "conflict") {
    if (doc.error.kind === "unavailable") return { response: unavailable(doc.error, row.intake_id) };
    console.error("financeops document insert refused", { intakeId: row.intake_id, detail: `${doc.error.kind}: ${doc.error.message}` });
    return { response: respond(422, { error: "document_rejected", message: "The database refused the document. A reviewer must look at this intake.", ...summarizeIntake(row, entityCode) }) };
  }

  const link = await store.linkDocument({
    document_id: documentId,
    entity_id: entityId,
    linked_record_type: "supplier_bill",
    linked_record_id: billId,
    created_by: identity.userId,
    is_demo: false,
    data_origin: "imported",
  });
  if (!link.ok && link.error.kind !== "conflict") {
    if (link.error.kind === "unavailable") return { response: unavailable(link.error, row.intake_id) };
    console.error("financeops document link refused", { intakeId: row.intake_id, detail: `${link.error.kind}: ${link.error.message}` });
    return { response: respond(422, { error: "document_link_rejected", message: "The database refused the document link. A reviewer must look at this intake.", ...summarizeIntake(row, entityCode) }) };
  }

  const attached = await store.updateIntake(row.id, { document_id: documentId, process_state: "document_attached" });
  if (!attached.ok) return { response: mapUpdateError(attached.error, row) };
  return { row: attached.value };
}
