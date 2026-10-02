import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSigningString, canonicalizeQuery, loadKeys, sha256Hex, signRequest, verifyRequest, type FinanceOpsKey } from "../auth";

// Test-only fake secrets (never real credentials).
const CURRENT: FinanceOpsKey = { keyId: "fo-key-current", secret: "test-secret-current-0123456789abcdef0123", slot: "current" };
const NEXT: FinanceOpsKey = { keyId: "fo-key-next", secret: "test-secret-next-0123456789abcdef012345", slot: "next" };
const KEYS = [CURRENT, NEXT];

const NOW = 1_800_000_000;
const PATH = "/api/integrations/financeops/v1/bill-intakes";
const BODY = new TextEncoder().encode("--boundary\r\nfake multipart body\r\n--boundary--");

type Over = Partial<{ timestamp: string; method: string; path: string; query: string; body: Uint8Array }>;

function signed(key: FinanceOpsKey, over: Over = {}) {
  const timestamp = over.timestamp ?? String(NOW);
  const body = over.body ?? BODY;
  return {
    keyId: key.keyId,
    timestamp,
    signature: signRequest(key.secret, { timestamp, method: over.method ?? "POST", path: over.path ?? PATH, query: over.query ?? "", bodySha256: sha256Hex(body) }),
  };
}

function verify(h: { keyId: string; timestamp: string; signature: string }, over: Over & { now?: number; keys?: FinanceOpsKey[]; skew?: number } = {}) {
  return verifyRequest({
    ...h,
    method: over.method ?? "POST",
    path: over.path ?? PATH,
    query: over.query ?? "",
    rawBody: over.body ?? BODY,
    keys: over.keys ?? KEYS,
    nowSeconds: over.now ?? NOW,
    maxSkewSeconds: over.skew,
  });
}

const BAD = { ok: false, reason: "bad_signature" } as const;

describe("FinanceOps HMAC verification", () => {
  it("accepts a valid signature (current key)", () => {
    assert.deepEqual(verify(signed(CURRENT)), { ok: true, keyId: CURRENT.keyId, slot: "current" });
  });

  it("accepts a valid signature (next key) during rotation", () => {
    assert.deepEqual(verify(signed(NEXT)), { ok: true, keyId: NEXT.keyId, slot: "next" });
  });

  it("rejects an invalid signature", () => {
    const h = signed(CURRENT);
    assert.deepEqual(verify({ ...h, signature: `v1=${"0".repeat(64)}` }), BAD);
  });

  it("rejects a signature made with the wrong secret for a known key id", () => {
    assert.deepEqual(verify(signed({ ...CURRENT, secret: "a-completely-different-secret-0123456789abc" })), BAD);
  });

  it("rejects an unknown key id", () => {
    assert.deepEqual(verify(signed({ ...CURRENT, keyId: "someone-else" })), { ok: false, reason: "unknown_key" });
  });

  it("rejects a key id used with the other slot's secret", () => {
    assert.deepEqual(verify({ ...signed(NEXT), keyId: CURRENT.keyId }), BAD);
  });

  it("rejects an expired timestamp", () => {
    assert.deepEqual(verify(signed(CURRENT, { timestamp: String(NOW - 301) })), { ok: false, reason: "timestamp_expired" });
  });

  it("accepts a timestamp exactly at the skew boundary", () => {
    assert.equal(verify(signed(CURRENT, { timestamp: String(NOW - 300) })).ok, true);
    assert.equal(verify(signed(CURRENT, { timestamp: String(NOW + 300) })).ok, true);
  });

  it("rejects a future timestamp outside tolerance", () => {
    assert.deepEqual(verify(signed(CURRENT, { timestamp: String(NOW + 301) })), { ok: false, reason: "timestamp_in_future" });
  });

  it("honours a configurable skew", () => {
    const h = signed(CURRENT, { timestamp: String(NOW - 20) });
    assert.equal(verify(h, { skew: 30 }).ok, true);
    assert.deepEqual(verify(h, { skew: 10 }), { ok: false, reason: "timestamp_expired" });
  });

  it("rejects a tampered request body", () => {
    const tampered = new TextEncoder().encode("--boundary\r\nTAMPERED body\r\n--boundary--");
    assert.deepEqual(verify(signed(CURRENT), { body: tampered }), BAD);
  });

  it("rejects a tampered path", () => {
    assert.deepEqual(verify(signed(CURRENT), { path: "/api/integrations/financeops/v1/other" }), BAD);
  });

  it("rejects a signature minted for another path (valid signature, wrong path)", () => {
    const other = signed(CURRENT, { path: "/api/integrations/financeops/v1/payment-evidences" });
    assert.deepEqual(verify(other), BAD);
    assert.deepEqual(verify(signed(CURRENT), { path: `${PATH}/` }), BAD);
  });

  it("rejects a tampered method", () => {
    assert.deepEqual(verify(signed(CURRENT), { method: "GET" }), BAD);
  });

  it("rejects a replayed signature with an altered timestamp", () => {
    const h = signed(CURRENT);
    assert.deepEqual(verify({ ...h, timestamp: String(NOW + 1) }), BAD);
  });

  it("rejects missing, malformed and unsupported-version headers", () => {
    const h = signed(CURRENT);
    assert.deepEqual(verify({ ...h, keyId: "" }), { ok: false, reason: "missing_headers" });
    assert.deepEqual(verify({ ...h, signature: "" }), { ok: false, reason: "missing_headers" });
    assert.deepEqual(verify({ ...h, signature: h.signature.replace("v1=", "v2=") }), { ok: false, reason: "unsupported_version" });
    assert.deepEqual(verify({ ...h, signature: "v1=abc" }), { ok: false, reason: "malformed_signature" });
    assert.deepEqual(verify({ ...h, timestamp: "12.5" }), { ok: false, reason: "malformed_timestamp" });
  });

  it("fails closed with no configured keys", () => {
    assert.deepEqual(verify(signed(CURRENT), { keys: [] }), { ok: false, reason: "unknown_key" });
  });

  it("signing string is five lines: timestamp, METHOD, path, canonical query, body hash", () => {
    assert.equal(
      buildSigningString({ timestamp: "1", method: "get", path: "/p", query: "?b=2&a=1", bodySha256: "ABC" }),
      "1\nGET\n/p\na=1&b=2\nabc",
    );
    assert.equal(buildSigningString({ timestamp: "1", method: "POST", path: "/p", query: "", bodySha256: "abc" }), "1\nPOST\n/p\n\nabc");
  });
});

describe("canonical query signing", () => {
  const Q = "?entity_code=IEA&supplier=Mega%20Supplies&amount=106.00";

  it("accepts a valid query", () => {
    assert.equal(verify(signed(CURRENT, { query: Q }), { query: Q }).ok, true);
  });

  it("accepts the same query with or without the leading '?'", () => {
    assert.equal(verify(signed(CURRENT, { query: Q }), { query: Q.slice(1) }).ok, true);
  });

  it("accepts a reordered equivalent query", () => {
    const reordered = "?amount=106.00&supplier=Mega%20Supplies&entity_code=IEA";
    assert.equal(verify(signed(CURRENT, { query: Q }), { query: reordered }).ok, true);
  });

  it("rejects a tampered query value", () => {
    assert.deepEqual(verify(signed(CURRENT, { query: Q }), { query: "?entity_code=KALER&supplier=Mega%20Supplies&amount=106.00" }), BAD);
    assert.deepEqual(verify(signed(CURRENT, { query: Q }), { query: "?entity_code=IEA&supplier=Mega%20Supplies&amount=1.00" }), BAD);
  });

  it("rejects an added query parameter", () => {
    assert.deepEqual(verify(signed(CURRENT, { query: Q }), { query: `${Q}&extra=1` }), BAD);
    assert.deepEqual(verify(signed(CURRENT), { query: "?injected=1" }), BAD);
  });

  it("rejects a removed query parameter", () => {
    assert.deepEqual(verify(signed(CURRENT, { query: Q }), { query: "?entity_code=IEA&supplier=Mega%20Supplies" }), BAD);
    assert.deepEqual(verify(signed(CURRENT, { query: Q }), { query: "" }), BAD);
  });

  it("treats an absent query, '' and a bare '?' as the same empty query", () => {
    const h = signed(CURRENT);
    for (const q of ["", "?", "&", "?&&"]) assert.equal(verify(h, { query: q }).ok, true, JSON.stringify(q));
  });

  it("supports duplicate keys: order among duplicates is irrelevant, count and values are not", () => {
    const dup = "?id=2&id=1&id=3";
    const h = signed(CURRENT, { query: dup });
    assert.equal(verify(h, { query: "?id=3&id=2&id=1" }).ok, true);
    assert.deepEqual(verify(h, { query: "?id=1&id=2" }), BAD);
    assert.deepEqual(verify(h, { query: "?id=1&id=2&id=2" }), BAD);
    assert.deepEqual(verify(h, { query: "?id=1&id=2&id=4" }), BAD);
  });

  it("treats encoded and decoded forms of the same value as equivalent", () => {
    const h = signed(CURRENT, { query: "?supplier=Mega Supplies&slash=a/b" });
    assert.equal(verify(h, { query: "?supplier=Mega%20Supplies&slash=a%2Fb" }).ok, true);
    assert.equal(verify(h, { query: "?supplier=Mega+Supplies&slash=a%2fb" }).ok, true);
    assert.equal(verify(signed(CURRENT, { query: "?k=%41" }), { query: "?k=A" }).ok, true);
  });

  it("distinguishes values that are genuinely different once decoded", () => {
    // '+' means space; a literal plus must be %2B.
    assert.deepEqual(verify(signed(CURRENT, { query: "?k=a+b" }), { query: "?k=a%2Bb" }), BAD);
    assert.deepEqual(verify(signed(CURRENT, { query: "?k=a%2Fb" }), { query: "?k=a%252Fb" }), BAD);
  });

  it("fails verification on malformed percent-encoding", () => {
    const h = signed(CURRENT);
    assert.deepEqual(verify(h, { query: "?k=%E0%A4%A" }), { ok: false, reason: "malformed_query" });
    assert.deepEqual(verify(h, { query: "?k=%zz" }), { ok: false, reason: "malformed_query" });
    assert.throws(() => signRequest(CURRENT.secret, { timestamp: "1", method: "GET", path: "/p", query: "?k=%", bodySha256: "x" }));
  });

  it("canonicalizeQuery output is deterministic and RFC 3986 encoded", () => {
    assert.equal(canonicalizeQuery(""), "");
    assert.equal(canonicalizeQuery("?"), "");
    assert.equal(canonicalizeQuery("b=2&a=1&a=0"), "a=0&a=1&b=2");
    assert.equal(canonicalizeQuery("flag&k="), "flag=&k=");
    assert.equal(canonicalizeQuery("q=a b&r=a+b&s=%e2%82%ac"), "q=a%20b&r=a%20b&s=%E2%82%AC");
    assert.equal(canonicalizeQuery("x=!'()*~-._"), "x=%21%27%28%29%2A~-._");
    assert.equal(canonicalizeQuery("%61=%62"), "a=b");
    assert.equal(canonicalizeQuery("k=%"), null);
  });

  it("does not leak the signature or secret in any verification result", () => {
    const h = signed(CURRENT, { query: Q });
    const out = JSON.stringify([verify(h, { query: Q }), verify(h, { query: "?x=1" }), verify({ ...h, signature: "v1=zz" })]);
    assert.ok(!out.includes(CURRENT.secret) && !out.includes(h.signature));
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
