import { sha256Hex } from "../auth";
import type { FinanceOpsConfig } from "../config";
import { authenticate, requestIdFrom, MAX_REQUEST_BYTES, type HandlerRequest } from "../handler";
import { canonicalJson, sniffMime } from "../intake";
import type { RateLimiter } from "../rate-limit";
import { respond, type HandlerResponse } from "../responses";
import { identityUsable } from "../store";
import { MAX_PAYMENT_FILE_BYTES, parsePaymentIntake, type PaymentDocMime } from "./intake-schema";
import { persistPaymentIntake, summarizePayment, type PaymentFile } from "./persist";
import type { PaymentStore } from "./store";
import { missingDocuments } from "./requirements";

/**
 * POST /api/integrations/financeops/v1/payment-intakes        (handlePaymentIntake)
 * GET  /api/integrations/financeops/v1/payment-intakes/:id    (handlePaymentStatus)
 *
 * Same security design as invoice intake: HMAC (five-line signature, timestamp window, key rotation), per-key entity
 * allow-list, FinanceOps registry identity, fail-closed. In addition the whole module sits behind its own feature flag
 * (FINANCEOPS_PAYMENT_REGISTER_ENABLED, default OFF), so a deployment that has the invoice endpoint enabled does not
 * thereby accept payment captures.
 */

export type PaymentStoreProvider = () => Promise<PaymentStore | null>;
export type PaymentHandlerDeps = { nowSeconds?: number; rateLimiter?: RateLimiter; paymentStoreProvider?: PaymentStoreProvider; paymentRegisterEnabled?: boolean };

export function precheckPaymentIntake(config: FinanceOpsConfig, enabled: boolean | undefined, method: string, expected: "POST" | "GET", contentLength: number | null): HandlerResponse | null {
  if (!enabled) return respond(503, { error: "payment_register_disabled" });
  if (!config.enabled) return respond(503, { error: "integration_disabled" });
  if (config.keys.length === 0 || config.allowedEntities.length === 0) return respond(503, { error: "integration_not_configured" });
  if (method.toUpperCase() !== expected) return respond(405, { error: "method_not_allowed" }, { Allow: expected });
  if (contentLength !== null && contentLength > MAX_REQUEST_BYTES) return respond(413, { error: "file_too_large", message: "Request exceeds the 4 MB limit." });
  return null;
}

/** pdf / jpeg / png via the shared sniffer, plus xlsx (zip signature) and csv (plain text) for wage schedules. */
export function sniffPaymentMime(bytes: Uint8Array): PaymentDocMime | null {
  const base = sniffMime(bytes);
  if (base) return base;
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const head = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (head.length > 0 && !head.includes(0)) {
    try {
      const t = new TextDecoder("utf-8", { fatal: true }).decode(head);
      if (/[,\n;\t]/.test(t)) return "text/csv";
    } catch {
      return null;
    }
  }
  return null;
}

async function provide(deps: PaymentHandlerDeps): Promise<{ store: PaymentStore } | { response: HandlerResponse } | { notWired: true }> {
  if (!deps.paymentStoreProvider) return { notWired: true };
  try {
    const store = await deps.paymentStoreProvider();
    if (!store) return { response: respond(503, { error: "integration_db_not_configured", retryable: false }) };
    return { store };
  } catch (e) {
    console.error("financeops payment store unavailable", { detail: e instanceof Error ? e.message : "unknown" });
    return { response: respond(503, { error: "integration_identity_unavailable", retryable: true }, { "Retry-After": "30" }) };
  }
}

export async function handlePaymentIntake(req: HandlerRequest, config: FinanceOpsConfig, deps: PaymentHandlerDeps = {}): Promise<HandlerResponse> {
  const early = precheckPaymentIntake(config, deps.paymentRegisterEnabled, req.method, "POST", req.rawBody.byteLength);
  if (early) return early;
  const auth = authenticate(req, config, deps);
  if (!auth.ok) return auth.response;

  const contentType = req.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data;/i.test(contentType)) return respond(415, { error: "unsupported_media_type", message: "Use multipart/form-data with a `metadata` part and one `file_N` part per declared document." });
  let form: FormData;
  try {
    form = await new Response(req.rawBody as BodyInit, { headers: { "content-type": contentType } }).formData();
  } catch {
    return respond(400, { error: "invalid_multipart" });
  }
  const names = Array.from(new Set(Array.from(form.keys())));
  if (names.some((n) => n !== "metadata" && !/^file_[0-9]$/.test(n)) || form.getAll("metadata").length !== 1 || names.some((n) => form.getAll(n).length !== 1)) {
    return respond(422, { error: "validation_failed", issues: [{ path: "", code: "unknown_field" }] });
  }
  const metadataPart = form.get("metadata");
  if (typeof metadataPart !== "string") return respond(422, { error: "validation_failed", issues: [{ path: "metadata", code: "invalid_type" }] });
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataPart);
  } catch {
    return respond(400, { error: "invalid_metadata_json" });
  }
  const parsed = parsePaymentIntake(metadata);
  if (!parsed.ok) return respond(422, { error: "validation_failed", issues: parsed.issues });
  const intake = parsed.value;

  const allowedForKey = config.keyEntities[auth.keyId] ?? [];
  if (!allowedForKey.includes(intake.entity_code)) return respond(403, { error: "entity_not_permitted", intake_id: intake.intake_id });

  // every declared document needs its file, every file must be declared; re-hash and sniff each one
  const declared = new Set(intake.documents.map((d) => d.part));
  const stray = names.filter((n) => n !== "metadata" && !declared.has(n));
  if (stray.length > 0) return respond(422, { error: "validation_failed", intake_id: intake.intake_id, issues: stray.map((n) => ({ path: n, code: "unknown_field" })) });
  const files = new Map<string, PaymentFile>();
  for (const doc of intake.documents) {
    const part = form.get(doc.part);
    if (part === null || typeof part === "string") return respond(422, { error: "validation_failed", intake_id: intake.intake_id, issues: [{ path: `documents.${doc.part}`, code: "required" }] });
    const file = part as File;
    if (file.size <= 0) return respond(422, { error: "empty_file", intake_id: intake.intake_id, part: doc.part });
    if (file.size > MAX_PAYMENT_FILE_BYTES) return respond(413, { error: "file_too_large", intake_id: intake.intake_id, part: doc.part, manual_upload_required: true });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sniffed = sniffPaymentMime(bytes);
    if (!sniffed) return respond(415, { error: "unrecognised_file_content", intake_id: intake.intake_id, part: doc.part });
    if (sniffed !== doc.mime_type) return respond(415, { error: "content_type_mismatch", intake_id: intake.intake_id, part: doc.part });
    const sha = sha256Hex(bytes);
    if (sha !== doc.sha256) return respond(422, { error: "document_hash_mismatch", intake_id: intake.intake_id, part: doc.part });
    files.set(doc.part, { bytes, size: file.size, mimeType: doc.mime_type, sha256: sha });
  }

  const resolved = await provide(deps);
  if ("notWired" in resolved) return respond(503, { error: "intake_persistence_not_ready", validated: true, intake_id: intake.intake_id }, { "Retry-After": "3600" });
  if ("response" in resolved) return resolved.response;
  return persistPaymentIntake(resolved.store, {
    intake,
    payloadHash: sha256Hex(canonicalJson(intake)),
    files,
    keyId: auth.keyId,
    requestId: requestIdFrom(req.headers),
    allowedEntityCodes: allowedForKey,
  });
}

const INTAKE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export async function handlePaymentStatus(req: HandlerRequest, intakeId: string, config: FinanceOpsConfig, deps: PaymentHandlerDeps = {}): Promise<HandlerResponse> {
  const early = precheckPaymentIntake(config, deps.paymentRegisterEnabled, req.method, "GET", null);
  if (early) return early;
  const auth = authenticate(req, config, deps);
  if (!auth.ok) return auth.response;
  if (!INTAKE_ID.test(intakeId)) return respond(404, { error: "not_found" });

  const resolved = await provide(deps);
  if ("notWired" in resolved) return respond(503, { error: "intake_persistence_not_ready" }, { "Retry-After": "3600" });
  if ("response" in resolved) return resolved.response;
  const store = resolved.store;

  const who = await store.identity();
  if (!who.ok) return respond(503, { error: "integration_identity_unavailable", retryable: true }, { "Retry-After": "30" });
  if (!identityUsable(who.value)) return respond(503, { error: "integration_identity_inactive" });
  const found = await store.getPaymentByIntake(intakeId);
  if (!found.ok) return respond(503, { error: "persistence_unavailable", retryable: true }, { "Retry-After": "30" });
  // RLS lets the identity read every payment in its entities; this endpoint only reports what it captured itself
  if (!found.value || found.value.created_by !== who.value.userId) return respond(404, { error: "not_found" });
  const docs = await store.listPaymentDocuments(found.value.id);
  if (!docs.ok) return respond(503, { error: "persistence_unavailable", retryable: true }, { "Retry-After": "30" });
  const entity = await store.entityById(found.value.entity_id);
  const live = docs.value.filter((d) => d.removed_at === null).map((d) => d.doc_role);
  const row = found.value;
  const body = summarizePayment(row, entity.ok && entity.value ? entity.value.code : null, { required: row.required_documents, available: live }, false);
  delete body.idempotent_replay;
  return respond(200, { ...body, documents_missing: missingDocuments({ required: row.required_documents, notApplicable: [], available: live }) });
}
