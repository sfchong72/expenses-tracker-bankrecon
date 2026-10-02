import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * FinanceOps -> Hub request authentication (HMAC-SHA256).
 *
 * Signing string (UTF-8, five lines separated by "\n"):
 *   {unix_timestamp_seconds}
 *   {METHOD}
 *   {canonical_path}            pathname exactly as sent (already percent-encoded), no query
 *   {canonical_query_string}    see canonicalizeQuery(); empty line when there is no query
 *   {sha256_hex(raw_body)}      lower-case hex; hash of the empty string when there is no body
 * Header:  X-FinanceOps-Signature: v1=<hex(HMAC_SHA256(secret, signing_string))>
 *
 * This module is pure: it never reads the environment on its own, never logs and
 * never returns secret material. Failure reasons are for internal diagnostics only;
 * the HTTP layer must answer every failure with the same opaque 401.
 */

export const FINANCEOPS_HEADERS = {
  keyId: "x-financeops-key-id",
  timestamp: "x-financeops-timestamp",
  signature: "x-financeops-signature",
} as const;

export const SIGNATURE_VERSION = "v1";
export const DEFAULT_MAX_SKEW_SECONDS = 300;
export const MIN_SECRET_LENGTH = 32;

export type KeySlot = "current" | "next";

export type FinanceOpsKey = {
  keyId: string;
  secret: string;
  slot: KeySlot;
};

export type VerifyFailureReason =
  | "missing_headers"
  | "unsupported_version"
  | "malformed_signature"
  | "malformed_timestamp"
  | "malformed_query"
  | "timestamp_expired"
  | "timestamp_in_future"
  | "unknown_key"
  | "bad_signature";

export type VerifyResult =
  | { ok: true; keyId: string; slot: KeySlot }
  | { ok: false; reason: VerifyFailureReason };

export type SigningParts = {
  timestamp: string;
  method: string;
  /** Pathname only, exactly as sent (e.g. "/api/x/y"); never includes "?". */
  path: string;
  /** Raw query string as sent, with or without the leading "?"; "" when none. */
  query: string;
  bodySha256: string;
};

function decodeComponent(text: string): string | null {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

function encodeComponent(text: string): string {
  // RFC 3986 unreserved set only; everything else is percent-encoded with upper-case hex.
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Canonical query string used in the signature.
 *  - leading "?" ignored; empty pairs ("a=1&&b=2") ignored; "" when no pairs
 *  - each key and value is percent-decoded ("+" means space, as in form encoding; a literal
 *    plus must be sent as %2B), then re-encoded with the RFC 3986 unreserved set and
 *    upper-case hex, so %2f / %2F / "/"-style variants of the same value are equivalent
 *  - "a" and "a=" are equivalent (value ""); duplicate keys are kept (never merged)
 *  - pairs are sorted by encoded key, then encoded value (plain code-unit order), so the
 *    result does not depend on the order the client happened to send them
 * Returns null for malformed percent-encoding (the request must then fail verification).
 */
export function canonicalizeQuery(rawQuery: string): string | null {
  const q = rawQuery.startsWith("?") ? rawQuery.slice(1) : rawQuery;
  if (q === "") return "";
  const pairs: Array<[string, string]> = [];
  for (const part of q.split("&")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    const key = decodeComponent(eq === -1 ? part : part.slice(0, eq));
    const value = decodeComponent(eq === -1 ? "" : part.slice(eq + 1));
    if (key === null || value === null) return null;
    pairs.push([encodeComponent(key), encodeComponent(value)]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => k + "=" + v).join("&");
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Throws on a malformed query string; verifyRequest turns that into a failed verification. */
export function buildSigningString(parts: SigningParts): string {
  const query = canonicalizeQuery(parts.query);
  if (query === null) throw new Error("malformed query string");
  return [parts.timestamp, parts.method.toUpperCase(), parts.path, query, parts.bodySha256.toLowerCase()].join("\n");
}

export function signRequest(secret: string, parts: SigningParts): string {
  const mac = createHmac("sha256", secret).update(buildSigningString(parts), "utf8").digest("hex");
  return `${SIGNATURE_VERSION}=${mac}`;
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Keep the work comparable, then fail.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export type VerifyInput = {
  keyId: string | null | undefined;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  method: string;
  /** Pathname only (no query). */
  path: string;
  /** Raw query string as received ("" or "?a=1&b=2" or "a=1&b=2"). */
  query: string;
  rawBody: Uint8Array;
  keys: readonly FinanceOpsKey[];
  /** Current time as unix seconds; injectable for tests. */
  nowSeconds?: number;
  maxSkewSeconds?: number;
};

export function verifyRequest(input: VerifyInput): VerifyResult {
  const { keyId, timestamp, signature } = input;
  if (!keyId || !timestamp || !signature) return { ok: false, reason: "missing_headers" };

  const eq = signature.indexOf("=");
  const version = eq === -1 ? "" : signature.slice(0, eq);
  const provided = eq === -1 ? "" : signature.slice(eq + 1).toLowerCase();
  if (version !== SIGNATURE_VERSION) return { ok: false, reason: "unsupported_version" };
  if (!/^[0-9a-f]{64}$/.test(provided)) return { ok: false, reason: "malformed_signature" };

  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "malformed_timestamp" };
  const ts = Number(timestamp);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = input.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  if (ts < now - skew) return { ok: false, reason: "timestamp_expired" };
  if (ts > now + skew) return { ok: false, reason: "timestamp_in_future" };

  if (canonicalizeQuery(input.query) === null) return { ok: false, reason: "malformed_query" };

  const candidates = input.keys.filter((k) => k.keyId === keyId);
  if (candidates.length === 0) return { ok: false, reason: "unknown_key" };

  const bodySha256 = sha256Hex(input.rawBody);
  let matched: FinanceOpsKey | null = null;
  for (const key of candidates) {
    const expected = signRequest(key.secret, { timestamp, method: input.method, path: input.path, query: input.query, bodySha256 });
    // Evaluate every candidate so timing does not reveal which slot matched.
    if (safeEqualHex(expected.slice(SIGNATURE_VERSION.length + 1), provided) && !matched) matched = key;
  }
  if (!matched) return { ok: false, reason: "bad_signature" };
  return { ok: true, keyId: matched.keyId, slot: matched.slot };
}

/**
 * Builds the key list from environment variable VALUES passed in by the caller.
 * A slot is active only when both its key id and secret are present; secrets
 * shorter than MIN_SECRET_LENGTH are ignored (fail closed). Current and next
 * must use different key ids so a rotation is observable in audit logs.
 */
export function loadKeys(env: Record<string, string | undefined>): FinanceOpsKey[] {
  const keys: FinanceOpsKey[] = [];
  for (const slot of ["current", "next"] as const) {
    const suffix = slot.toUpperCase();
    const keyId = env[`FINANCEOPS_HMAC_KEY_ID_${suffix}`]?.trim();
    const secret = env[`FINANCEOPS_HMAC_SECRET_${suffix}`];
    if (!keyId || !secret || secret.length < MIN_SECRET_LENGTH) continue;
    if (keys.some((k) => k.keyId === keyId)) continue;
    keys.push({ keyId, secret, slot });
  }
  return keys;
}
