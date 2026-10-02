import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSigningString, loadKeys, sha256Hex, signRequest, verifyRequest, type FinanceOpsKey } from "../auth.ts";

// Test-only fake secrets (never real credentials).
const CURRENT: FinanceOpsKey = { keyId: "fo-key-current", secret: "test-secret-current-0123456789abcdef0123", slot: "current" };
const NEXT: FinanceOpsKey = { keyId: "fo-key-next", secret: "test-secret-next-0123456789abcdef012345", slot: "next" };
const KEYS = [CURRENT, NEXT];

const NOW = 1_800_000_000;
const PATH = "/api/integrations/financeops/v1/bill-intakes";
const BODY = new TextEncoder().encode("--boundary\r\nfake multipart body\r\n--boundary--");

function signed(key: FinanceOpsKey, over: Partial<{ timestamp: string; method: string; path: string; body: Uint8Array }> = {}) {
  const timestamp = over.timestamp ?? String(NOW);
  const method = over.method ?? "POST";
  const path = over.path ?? PATH;
  const body = over.body ?? BODY;
  return { keyId: key.keyId, timestamp, signature: signRequest(key.secret, { timestamp, method, path, bodySha256: sha256Hex(body) }) };
}

function verify(h: { keyId: string; timestamp: string; signature: string }, over: Partial<{ path: string; body: Uint8Array; method: string; now: number; keys: FinanceOpsKey[]; skew: number }> = {}) {
  return verifyRequest({
    ...h,
    method: over.method ?? "POST",
    path: over.path ?? PATH,
    rawBody: over.body ?? BODY,
    keys: over.keys ?? KEYS,
    nowSeconds: over.now ?? NOW,
    maxSkewSeconds: over.skew,
  });
}

describe("FinanceOps HMAC verification", () => {
  it("accepts a valid signature (current key)", () => {
    assert.deepEqual(verify(signed(CURRENT)), { ok: true, keyId: CURRENT.keyId, slot: "current" });
  });

  it("accepts a valid signature (next key) during rotation", () => {
    assert.deepEqual(verify(signed(NEXT)), { ok: true, keyId: NEXT.keyId, slot: "next" });
  });

  it("rejects an invalid signature", () => {
    const h = signed(CURRENT);
    const bad = { ...h, signature: `v1=${"0".repeat(64)}` };
    assert.deepEqual(verify(bad), { ok: false, reason: "bad_signature" });
  });

  it("rejects a signature made with the wrong secret for a known key id", () => {
    const h = signed({ ...CURRENT, secret: "a-completely-different-secret-0123456789abc" });
    assert.deepEqual(verify(h), { ok: false, reason: "bad_signature" });
  });

  it("rejects an unknown key id", () => {
    const h = signed({ ...CURRENT, keyId: "someone-else" });
    assert.deepEqual(verify(h), { ok: false, reason: "unknown_key" });
  });

  it("rejects a key id used with the other slot's secret", () => {
    const h = { ...signed(NEXT), keyId: CURRENT.keyId };
    assert.deepEqual(verify(h), { ok: false, reason: "bad_signature" });
  });

  it("rejects an expired timestamp", () => {
    const h = signed(CURRENT, { timestamp: String(NOW - 301) });
    assert.deepEqual(verify(h), { ok: false, reason: "timestamp_expired" });
  });

  it("accepts a timestamp exactly at the skew boundary", () => {
    assert.equal(verify(signed(CURRENT, { timestamp: String(NOW - 300) })).ok, true);
    assert.equal(verify(signed(CURRENT, { timestamp: String(NOW + 300) })).ok, true);
  });

  it("rejects a future timestamp outside tolerance", () => {
    const h = signed(CURRENT, { timestamp: String(NOW + 301) });
    assert.deepEqual(verify(h), { ok: false, reason: "timestamp_in_future" });
  });

  it("honours a configurable skew", () => {
    const h = signed(CURRENT, { timestamp: String(NOW - 20) });
    assert.equal(verify(h, { skew: 30 }).ok, true);
    assert.deepEqual(verify(h, { skew: 10 }), { ok: false, reason: "timestamp_expired" });
  });

  it("rejects a tampered request body", () => {
    const h = signed(CURRENT);
    const tampered = new TextEncoder().encode("--boundary\r\nTAMPERED body\r\n--boundary--");
    assert.deepEqual(verify(h, { body: tampered }), { ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered path", () => {
    const h = signed(CURRENT);
    assert.deepEqual(verify(h, { path: "/api/integrations/financeops/v1/other" }), { ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered query string", () => {
    const h = signed(CURRENT, { path: `${PATH}?entity_code=IEA` });
    assert.deepEqual(verify(h, { path: `${PATH}?entity_code=KALER` }), { ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered method", () => {
    const h = signed(CURRENT);
    assert.deepEqual(verify(h, { method: "GET" }), { ok: false, reason: "bad_signature" });
  });

  it("rejects a replayed timestamp that was altered after signing", () => {
    const h = signed(CURRENT);
    assert.deepEqual(verify({ ...h, timestamp: String(NOW + 1) }), { ok: false, reason: "bad_signature" });
  });

  it("rejects missing, malformed and unsupported-version headers", () => {
    const h = signed(CURRENT);
    assert.deepEqual(verify({ ...h, keyId: "" }), { ok: false, reason: "missing_headers" });
    assert.deepEqual(verify({ ...h, signature: h.signature.replace("v1=", "v2=") }), { ok: false, reason: "unsupported_version" });
    assert.deepEqual(verify({ ...h, signature: "v1=abc" }), { ok: false, reason: "malformed_signature" });
    assert.deepEqual(verify({ ...h, timestamp: "12.5" }), { ok: false, reason: "malformed_timestamp" });
  });

  it("fails closed with no configured keys", () => {
    assert.deepEqual(verify(signed(CURRENT), { keys: [] }), { ok: false, reason: "unknown_key" });
  });

  it("signing string layout is stable", () => {
    assert.equal(buildSigningString({ timestamp: "1", method: "post", path: "/p?q=1", bodySha256: "ABC" }), "1\nPOST\n/p?q=1\nabc");
  });
});

describe("FinanceOps key loading", () => {
  const env = {
    FINANCEOPS_HMAC_KEY_ID_CURRENT: "kid-a",
    FINANCEOPS_HMAC_SECRET_CURRENT: "x".repeat(32),
    FINANCEOPS_HMAC_KEY_ID_NEXT: "kid-b",
    FINANCEOPS_HMAC_SECRET_NEXT: "y".repeat(32),
  };

  it("loads current and next", () => {
    assert.deepEqual(loadKeys(env).map((k) => [k.keyId, k.slot]), [["kid-a", "current"], ["kid-b", "next"]]);
  });

  it("ignores incomplete or short-secret slots", () => {
    assert.equal(loadKeys({ ...env, FINANCEOPS_HMAC_SECRET_NEXT: "short" }).length, 1);
    assert.equal(loadKeys({ ...env, FINANCEOPS_HMAC_KEY_ID_CURRENT: "" }).length, 1);
    assert.equal(loadKeys({}).length, 0);
  });

  it("does not allow current and next to share a key id", () => {
    assert.equal(loadKeys({ ...env, FINANCEOPS_HMAC_KEY_ID_NEXT: "kid-a" }).length, 1);
  });
});
