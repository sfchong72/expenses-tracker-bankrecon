import { randomUUID } from "node:crypto";
import { FINANCEOPS_HEADERS, verifyRequest } from "./auth";
import type { FinanceOpsConfig } from "./config";
import { computePayloadHash, verifyDocumentBytes } from "./intake";
import { persistBillIntake } from "./persist";
import type { RateLimiter } from "./rate-limit";
import { respond, type HandlerResponse } from "./responses";
import { checkFileEnvelope, MAX_FILE_BYTES, parseBillIntake } from "./schema";
import { summarizeIntake } from "./status";
import type { IntakeStore } from "./store";

/**
 * Framework-free handlers for the FinanceOps bill-intake endpoints:
 *   POST /api/integrations/financeops/v1/bill-intakes              (handleBillIntake)
 *   GET  /api/integrations/financeops/v1/bill-intakes/:intake_id   (handleBillIntakeStatus)
 *
 * Authentication, validation and document verification are unchanged from the Phase 1 prep. After they pass,
 * `handleBillIntake` persists through the injected IntakeStore (the FinanceOps identity's own RLS session).
 * With NO store provider injected it still answers 503 `intake_persistence_not_ready` and touches nothing, so a
 * caller that forgets to wire persistence fails closed.
 */

export type { HandlerResponse } from "./responses";

export type HandlerRequest = {
  method: string;
  /** Pathname only, exactly as received (percent-encoded); signed. */
  path: string;
  /** Raw query string as received (with or without "?"); canonicalised and signed. */
  query: string;
  headers: { get(name: string): string | null };
  rawBody: Uint8Array;
};

/** Slack above the file cap for multipart framing and the metadata part. */
export const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 256 * 1024;

/** Cheap checks that need no body and no secret. Call before reading the request body. */
export function precheckBillIntake(config: FinanceOpsConfig, method: string, contentLength: number | null): HandlerResponse | null {
  if (!config.enabled) return respond(503, { error: "integration_disabled" });
  if (config.keys.length === 0 || config.allowedEntities.length === 0) return respond(503, { error: "integration_not_configured" });
  if (method.toUpperCase() !== "POST") return respond(405, { error: "method_not_allowed" }, { Allow: "POST" });
  if (contentLength !== null && contentLength > MAX_REQUEST_BYTES) {
    return respond(413, { error: "file_too_large", message: "Request exceeds the 4 MB Phase 1 limit. Manual upload in the Hub is required for this document." });
  }
  return null;
}

export type StoreProvider = () => Promise<IntakeStore | null>;

export type HandlerDeps = { nowSeconds?: number; rateLimiter?: RateLimiter; storeProvider?: StoreProvider };

/** The same opaque answer for every authentication failure; the reason is never returned. */
function authenticate(req: HandlerRequest, config: FinanceOpsConfig, deps: HandlerDeps): { ok: true; keyId: string } | { ok: false; response: HandlerResponse } {
  const auth = verifyRequest({
    keyId: req.headers.get(FINANCEOPS_HEADERS.keyId),
    timestamp: req.headers.get(FINANCEOPS_HEADERS.timestamp),
    signature: req.headers.get(FINANCEOPS_HEADERS.signature),
    method: req.method,
    path: req.path,
    query: req.query,
    rawBody: req.rawBody,
    keys: config.keys,
    nowSeconds: deps.nowSeconds,
    maxSkewSeconds: config.maxSkewSeconds,
  });
  if (!auth.ok) return { ok: false, response: respond(401, { error: "unauthorized" }) };

  // Best-effort per-key rate limit, only for authenticated callers (see rate-limit.ts).
  const limited = deps.rateLimiter?.check(auth.keyId);
  if (limited && !limited.allowed) return { ok: false, response: respond(429, { error: "rate_limited" }, { "Retry-After": String(limited.retryAfterSeconds) }) };
  return { ok: true, keyId: auth.keyId };
}

function requestIdFrom(headers: { get(name: string): string | null }): string {
  const supplied = headers.get("x-request-id");
  return supplied && /^[A-Za-z0-9._:-]{1,64}$/.test(supplied) ? supplied : randomUUID();
}

async function resolveStore(deps: HandlerDeps): Promise<{ store: IntakeStore } | { response: HandlerResponse } | { notWired: true }> {
  if (!deps.storeProvider) return { notWired: true };
  try {
    const store = await deps.storeProvider();
    if (!store) return { response: respond(503, { error: "integration_db_not_configured", retryable: false }) };
    return { store };
  } catch (e) {
    console.error("financeops store unavailable", { detail: e instanceof Error ? e.message : "unknown" });
    return { response: respond(503, { error: "integration_identity_unavailable", retryable: true }, { "Retry-After": "30" }) };
  }
}

export async function handleBillIntake(req: HandlerRequest, config: FinanceOpsConfig, deps: HandlerDeps = {}): Promise<HandlerResponse> {
  const early = precheckBillIntake(config, req.method, req.rawBody.byteLength);
  if (early) return early;

  // 1. Authenticate.
  const auth = authenticate(req, config, deps);
  if (!auth.ok) return auth.response;

  // 2. Parse the multipart envelope: exactly `metadata` (JSON text) and `file`.
  const contentType = req.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data;/i.test(contentType)) return respond(415, { error: "unsupported_media_type", message: "Use multipart/form-data with `metadata` and `file` parts." });
  let form: FormData;
  try {
    form = await new Response(req.rawBody as BodyInit, { headers: { "content-type": contentType } }).formData();
  } catch {
    return respond(400, { error: "invalid_multipart" });
  }
  const names = Array.from(new Set(Array.from(form.keys())));
  if (names.some((n) => n !== "metadata" && n !== "file") || form.getAll("metadata").length !== 1 || form.getAll("file").length !== 1) {
    return respond(422, { error: "validation_failed", issues: [{ path: "", code: "unknown_field" }] });
  }
  const metadataPart = form.get("metadata");
  const filePart = form.get("file");
  if (typeof metadataPart !== "string" || typeof filePart === "string" || filePart === null) {
    return respond(422, { error: "validation_failed", issues: [{ path: "metadata", code: "invalid_type" }] });
  }

  // 3. Validate metadata (strict, fail closed).
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataPart);
  } catch {
    return respond(400, { error: "invalid_metadata_json" });
  }
  const parsed = parseBillIntake(metadata);
  if (!parsed.ok) return respond(422, { error: "validation_failed", issues: parsed.issues });
  const intake = parsed.value;

  // 4. Per-key entity allow-list (a subset of the integration ceiling). An uncertain (null) entity is
  //    accepted as an INTAKE for human review, but must never become a supplier bill and is never guessed.
  const allowedForKey = config.keyEntities[auth.keyId] ?? [];
  if (intake.entity_code !== null && !allowedForKey.includes(intake.entity_code)) {
    return respond(403, { error: "entity_not_permitted", intake_id: intake.intake_id });
  }

  // 5. File envelope, then server-side recomputation of content type and hash.
  const file = filePart as File;
  const envelope = checkFileEnvelope({ size: file.size, mimeType: file.type });
  if (!envelope.ok) return respond(envelope.status, { error: envelope.code, message: envelope.message, intake_id: intake.intake_id, manual_upload_required: envelope.code === "file_too_large" });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const verified = verifyDocumentBytes(bytes, { sha256: intake.document.sha256, mimeType: intake.document.mime_type, uploadedMimeType: file.type });
  if (!verified.ok) return respond(verified.code === "document_hash_mismatch" ? 422 : 415, { error: verified.code, intake_id: intake.intake_id });

  // 6. Persist (insert-first, idempotent, resumable) as the FinanceOps database identity.
  const resolved = await resolveStore(deps);
  if ("notWired" in resolved) {
    return respond(
      503,
      {
        error: "intake_persistence_not_ready",
        message: "The request is authenticated and valid, but nothing was stored. Finance intake persistence is not enabled yet. Retry later with the same intake_id.",
        validated: true,
        intake_id: intake.intake_id,
        payload_hash: computePayloadHash(intake, verified.sha256),
        entity_code: intake.entity_code,
      },
      { "Retry-After": "3600" },
    );
  }
  if ("response" in resolved) return resolved.response;
  return persistBillIntake(resolved.store, {
    intake,
    payloadHash: computePayloadHash(intake, verified.sha256),
    file: { bytes, size: file.size, mimeType: intake.document.mime_type, sha256: verified.sha256 },
    keyId: auth.keyId,
    requestId: requestIdFrom(req.headers),
  });
}

// ------------------------------------------------------------------ status

const INTAKE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Cheap checks for the status endpoint (no body expected). */
export function precheckStatus(config: FinanceOpsConfig, method: string): HandlerResponse | null {
  if (!config.enabled) return respond(503, { error: "integration_disabled" });
  if (config.keys.length === 0 || config.allowedEntities.length === 0) return respond(503, { error: "integration_not_configured" });
  if (method.toUpperCase() !== "GET") return respond(405, { error: "method_not_allowed" }, { Allow: "GET" });
  return null;
}

/**
 * Read-only status of ONE intake that this FinanceOps identity submitted. Reads through the identity's own RLS
 * (finance_intake_submissions_select: creator only); an unknown id and an id that is not ours are indistinguishable (404).
 */
export async function handleBillIntakeStatus(req: HandlerRequest, intakeId: string, config: FinanceOpsConfig, deps: HandlerDeps = {}): Promise<HandlerResponse> {
  const early = precheckStatus(config, req.method);
  if (early) return early;
  const auth = authenticate(req, config, deps);
  if (!auth.ok) return auth.response;

  if (!INTAKE_ID_PATTERN.test(intakeId)) return respond(404, { error: "not_found" });
  const resolved = await resolveStore(deps);
  if ("notWired" in resolved) return respond(503, { error: "intake_persistence_not_ready" }, { "Retry-After": "3600" });
  if ("response" in resolved) return resolved.response;
  const store = resolved.store;

  const who = await store.identity();
  if (!who.ok) {
    console.error("financeops status identity failed", { detail: `${who.error.kind}: ${who.error.message}` });
    return respond(503, { error: "integration_identity_unavailable", retryable: true }, { "Retry-After": "30" });
  }
  const found = await store.getIntake(intakeId);
  if (!found.ok) {
    console.error("financeops status read failed", { detail: `${found.error.kind}: ${found.error.message}` });
    return respond(503, { error: "persistence_unavailable", retryable: true }, { "Retry-After": "30" });
  }
  // RLS lets the identity read every intake in its entities; this endpoint only reports what it submitted itself.
  if (!found.value || found.value.created_by !== who.value.userId) return respond(404, { error: "not_found" });
  const row = found.value;
  let entityCode = row.entity_code_declared;
  if (!entityCode && row.entity_id) {
    const entity = await store.entityById(row.entity_id);
    entityCode = entity.ok && entity.value ? entity.value.code : null;
  }
  return respond(200, summarizeIntake(row, entityCode));
}
