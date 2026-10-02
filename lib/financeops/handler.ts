import { FINANCEOPS_HEADERS, verifyRequest } from "./auth";
import type { FinanceOpsConfig } from "./config";
import { computePayloadHash, verifyDocumentBytes } from "./intake";
import type { RateLimiter } from "./rate-limit";
import { checkFileEnvelope, MAX_FILE_BYTES, parseBillIntake } from "./schema";

/**
 * Framework-free handler for POST /api/integrations/financeops/v1/bill-intakes.
 *
 * PHASE 1 PREP STATE: authenticates, validates and verifies the document, then answers
 * 503 `intake_persistence_not_ready`. It performs NO database or storage access because
 * the intake/idempotency/review tables (future migration) do not exist yet, and an
 * idempotency check-then-insert would be unsafe. Wire persistence here only after that
 * migration is approved and released.
 */

export type HandlerResponse = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };

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

const NO_STORE = { "Cache-Control": "no-store" };

function respond(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): HandlerResponse {
  return { status, body, headers: { ...NO_STORE, ...headers } };
}

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

export type HandlerDeps = { nowSeconds?: number; rateLimiter?: RateLimiter };

export async function handleBillIntake(req: HandlerRequest, config: FinanceOpsConfig, deps: HandlerDeps = {}): Promise<HandlerResponse> {
  const early = precheckBillIntake(config, req.method, req.rawBody.byteLength);
  if (early) return early;

  // 1. Authenticate. Every failure gets the same opaque answer; the reason is never returned.
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
  if (!auth.ok) return respond(401, { error: "unauthorized" });

  // Best-effort per-key rate limit, only for authenticated callers (see rate-limit.ts).
  const limited = deps.rateLimiter?.check(auth.keyId);
  if (limited && !limited.allowed) return respond(429, { error: "rate_limited" }, { "Retry-After": String(limited.retryAfterSeconds) });

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

  // 6. Persistence is intentionally not available yet.
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
