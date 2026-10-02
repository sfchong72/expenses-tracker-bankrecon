import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { sha256Hex, signRequest } from "../auth";
import { readFinanceOpsConfig, type FinanceOpsConfig } from "../config";
import { handleBillIntake, MAX_REQUEST_BYTES, type HandlerDeps } from "../handler";
import { createRateLimiter } from "../rate-limit";

const SECRET_CURRENT = "test-secret-current-0123456789abcdef0123";
const SECRET_NEXT = "test-secret-next-0123456789abcdef012345";
const PATH = "/api/integrations/financeops/v1/bill-intakes";
const NOW = 1_800_000_000;
const PDF = new TextEncoder().encode("%PDF-1.7\nfake invoice");

const ENV = {
  FINANCEOPS_INTAKE_ENABLED: "true",
  FINANCEOPS_ALLOWED_ENTITY_CODES: "IEA, plc ,bogus,KALER",
  FINANCEOPS_ALLOWED_ENTITY_CODES_NEXT: "PLC,IEA,IETA",
  FINANCEOPS_HMAC_KEY_ID_CURRENT: "kid-current",
  FINANCEOPS_HMAC_SECRET_CURRENT: SECRET_CURRENT,
  FINANCEOPS_HMAC_KEY_ID_NEXT: "kid-next",
  FINANCEOPS_HMAC_SECRET_NEXT: SECRET_NEXT,
};
const CONFIG: FinanceOpsConfig = readFinanceOpsConfig(ENV);
const DEPS: HandlerDeps = { nowSeconds: NOW };

function metadata(over: Record<string, unknown> = {}, bytes: Uint8Array = PDF) {
  return {
    intake_id: "fo_bill_01JABCDEF",
    source: { channel: "telegram", chat_id: "1", message_id: "2", received_at: "2026-10-02T03:04:05Z" },
    entity_code: "IEA",
    supplier: { name: "Mega Supplies", registration_number: null },
    invoice: { number: "INV-1", date: "2026-09-30", due_date: null, currency: "MYR", subtotal: null, tax_amount: null, total_amount: 106, description: null },
    extraction: { agent: "a", version: "1", overall_confidence: 0.9, fields: {} },
    document: { sha256: sha256Hex(bytes), mime_type: "application/pdf", filename: "a.pdf" },
    ...over,
  };
}

type Parts = { raw: Uint8Array; contentType: string };

async function multipart(meta: unknown, file: { bytes: Uint8Array; type: string } | null = { bytes: PDF, type: "application/pdf" }, extra: Record<string, string> = {}): Promise<Parts> {
  const fd = new FormData();
  fd.set("metadata", typeof meta === "string" ? meta : JSON.stringify(meta));
  if (file) fd.set("file", new File([file.bytes as BlobPart], "a.pdf", { type: file.type }));
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  const res = new Response(fd);
  return { raw: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") as string };
}

type Over = { secret?: string; keyId?: string; signPath?: string; signQuery?: string; sign?: boolean; timestamp?: string; method?: string; path?: string; query?: string };

function request(parts: Parts, over: Over = {}) {
  const timestamp = over.timestamp ?? String(NOW);
  const method = over.method ?? "POST";
  const headers = new Headers({ "content-type": parts.contentType });
  if (over.sign !== false) {
    headers.set("x-financeops-key-id", over.keyId ?? "kid-current");
    headers.set("x-financeops-timestamp", timestamp);
    headers.set(
      "x-financeops-signature",
      signRequest(over.secret ?? SECRET_CURRENT, { timestamp, method, path: over.signPath ?? PATH, query: over.signQuery ?? "", bodySha256: sha256Hex(parts.raw) }),
    );
  }
  return { method, path: over.path ?? PATH, query: over.query ?? "", headers, rawBody: parts.raw };
}

async function run(parts: Parts, over: Over = {}, config: FinanceOpsConfig = CONFIG, deps: HandlerDeps = DEPS) {
  return handleBillIntake(request(parts, over), config, deps);
}

describe("config", () => {
  it("is disabled, keyless and entity-less by default", () => {
    assert.deepEqual(readFinanceOpsConfig({}), { enabled: false, keys: [], allowedEntities: [], keyEntities: {}, maxSkewSeconds: 300, rateLimitPerMinute: 30 });
  });

  it("parses and sanitises the entity ceiling", () => {
    assert.deepEqual(CONFIG.allowedEntities, ["IEA", "PLC", "KALER"]);
    assert.equal(readFinanceOpsConfig({ ...ENV, FINANCEOPS_INTAKE_ENABLED: "TRUE" }).enabled, false);
    assert.equal(readFinanceOpsConfig({ ...ENV, FINANCEOPS_MAX_SKEW_SECONDS: "5" }).maxSkewSeconds, 300);
    assert.equal(readFinanceOpsConfig({ ...ENV, FINANCEOPS_MAX_SKEW_SECONDS: "60" }).maxSkewSeconds, 60);
    assert.equal(readFinanceOpsConfig({ ...ENV, FINANCEOPS_RATE_LIMIT_PER_MINUTE: "0" }).rateLimitPerMinute, 30);
    assert.equal(readFinanceOpsConfig({ ...ENV, FINANCEOPS_RATE_LIMIT_PER_MINUTE: "5" }).rateLimitPerMinute, 5);
  });

  it("per-key entity lists narrow but never widen the ceiling", () => {
    assert.deepEqual(CONFIG.keyEntities["kid-current"], ["IEA", "PLC", "KALER"]); // unset -> ceiling
    assert.deepEqual(CONFIG.keyEntities["kid-next"], ["PLC", "IEA"]); // IETA is outside the ceiling and is dropped
    const empty = readFinanceOpsConfig({ ...ENV, FINANCEOPS_ALLOWED_ENTITY_CODES_CURRENT: "IETA" });
    assert.deepEqual(empty.keyEntities["kid-current"], []);
  });
});

describe("bill-intakes handler (prep state)", () => {
  it("answers 503 integration_disabled / not_configured before touching the request", async () => {
    const parts = await multipart(metadata());
    assert.equal((await run(parts, {}, { ...CONFIG, enabled: false })).body.error, "integration_disabled");
    assert.equal((await run(parts, {}, { ...CONFIG, keys: [] })).body.error, "integration_not_configured");
    assert.equal((await run(parts, {}, { ...CONFIG, allowedEntities: [] })).body.error, "integration_not_configured");
  });

  it("rejects a missing signature with an opaque 401", async () => {
    const r = await run(await multipart(metadata()), { sign: false });
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: "unauthorized" });
  });

  it("rejects wrong-key, wrong-secret and stale requests with the same opaque 401", async () => {
    const parts = await multipart(metadata());
    const results = [
      await run(parts, { keyId: "nope" }),
      await run(parts, { secret: "another-secret-0123456789abcdef012345" }),
      await run(parts, { timestamp: String(NOW - 3600) }),
    ];
    for (const r of results) {
      assert.equal(r.status, 401);
      assert.deepEqual(r.body, { error: "unauthorized" });
    }
  });

  it("rejects a valid signature that was minted for a different path", async () => {
    const parts = await multipart(metadata());
    for (const signPath of ["/api/integrations/financeops/v1/payment-evidences", "/api/integrations/financeops/v1/bill-intakes/", "/api/admin/users/create"]) {
      const r = await run(parts, { signPath });
      assert.equal(r.status, 401, signPath);
      assert.deepEqual(r.body, { error: "unauthorized" });
    }
    // and the converse: signed for the real path but delivered to another one
    assert.equal((await run(parts, { path: "/api/integrations/financeops/v1/payment-evidences" })).status, 401);
  });

  it("covers the query string: tampered, added or removed parameters fail with 401", async () => {
    const parts = await multipart(metadata());
    assert.equal((await run(parts, { signQuery: "?a=1&b=2", query: "?b=2&a=1" })).status, 503); // reordered equivalent: authenticated
    assert.equal((await run(parts, { signQuery: "?a=1", query: "?a=2" })).status, 401);
    assert.equal((await run(parts, { signQuery: "?a=1", query: "?a=1&b=2" })).status, 401);
    assert.equal((await run(parts, { signQuery: "?a=1&b=2", query: "?a=1" })).status, 401);
    assert.equal((await run(parts, { signQuery: "", query: "?entity_code=KALER" })).status, 401);
  });

  it("rejects unexpected HTTP methods", async () => {
    const parts = await multipart(metadata());
    for (const method of ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const r = await run(parts, { method });
      assert.equal(r.status, 405, method);
      assert.equal(r.headers?.Allow, "POST");
    }
    // a POST signature cannot be replayed as another method either
    assert.equal(request(parts, { method: "POST" }).method, "POST");
  });

  it("authenticates with either current or next key", async () => {
    const parts = await multipart(metadata());
    assert.equal((await run(parts)).status, 503);
    assert.equal((await run(parts, { keyId: "kid-next", secret: SECRET_NEXT })).body.error, "intake_persistence_not_ready");
  });

  it("validates and then reports persistence as not ready (nothing stored)", async () => {
    const r = await run(await multipart(metadata()));
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "intake_persistence_not_ready");
    assert.equal(r.body.validated, true);
    assert.equal(r.body.intake_id, "fo_bill_01JABCDEF");
    assert.match(String(r.body.payload_hash), /^[0-9a-f]{64}$/);
    assert.equal(r.headers?.["Retry-After"], "3600");
    assert.equal(r.headers?.["Cache-Control"], "no-store");
  });

  it("accepts an uncertain (null) entity as an intake for human review, never a bill", async () => {
    const r = await run(await multipart(metadata({ entity_code: null })));
    assert.equal(r.body.error, "intake_persistence_not_ready");
    assert.equal(r.body.entity_code, null);
  });

  it("rejects prohibited and unknown fields with 422 and no echoed values", async () => {
    const r = await run(await multipart(metadata({ payment_status: "paid", surprise: "secret-value-123" })));
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "validation_failed");
    const issues = r.body.issues as Array<{ path: string; code: string }>;
    assert.deepEqual(issues.map((i) => `${i.path}:${i.code}`).sort(), ["payment_status:forbidden_field", "surprise:unknown_field"]);
    assert.ok(!JSON.stringify(r.body).includes("secret-value-123"));
  });

  it("enforces the per-key entity allow-list", async () => {
    const kaler = await multipart(metadata({ entity_code: "KALER" }));
    assert.equal((await run(kaler)).status, 503); // current key: ceiling includes KALER
    const viaNext = await run(kaler, { keyId: "kid-next", secret: SECRET_NEXT });
    assert.equal(viaNext.status, 403); // next key is narrowed to PLC,IEA
    assert.equal(viaNext.body.error, "entity_not_permitted");
    assert.equal((await run(await multipart(metadata({ entity_code: "IETA" })))).status, 403); // outside the ceiling
  });

  it("requires multipart with exactly one metadata and one file part", async () => {
    assert.equal((await run({ raw: new TextEncoder().encode("{}"), contentType: "application/json" })).status, 415);
    assert.equal((await run(await multipart(metadata(), null))).status, 422);
    assert.equal((await run(await multipart(metadata(), undefined, { extra: "x" }))).status, 422);
    assert.equal((await run(await multipart("{not json"))).status, 400);
  });

  it("returns a manual-upload requirement for files over 4 MB", async () => {
    const big = new Uint8Array(4 * 1024 * 1024 + 1);
    big.set(PDF);
    const r = await run(await multipart(metadata({}, big), { bytes: big, type: "application/pdf" }));
    assert.equal(r.status, 413);
    assert.equal(r.body.manual_upload_required, true);
  });

  it("rejects oversized request bodies before parsing", async () => {
    const raw = new Uint8Array(MAX_REQUEST_BYTES + 1);
    const r = await handleBillIntake({ method: "POST", path: PATH, query: "", headers: new Headers(), rawBody: raw }, CONFIG, DEPS);
    assert.equal(r.status, 413);
  });

  it("rejects unsupported types, mismatched content and hash mismatch", async () => {
    assert.equal((await run(await multipart(metadata(), { bytes: PDF, type: "image/heic" }))).status, 415);
    assert.equal((await run(await multipart(metadata(), { bytes: new TextEncoder().encode("MZ not a pdf"), type: "application/pdf" }))).status, 415);
    const tampered = new TextEncoder().encode("%PDF-1.7\nTAMPERED");
    const r = await run(await multipart(metadata(), { bytes: tampered, type: "application/pdf" }));
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "document_hash_mismatch");
  });

  it("rate-limits per authenticated key only, with Retry-After", async () => {
    const limiter = createRateLimiter(2);
    const deps: HandlerDeps = { nowSeconds: NOW, rateLimiter: limiter };
    const parts = await multipart(metadata());
    assert.equal((await run(parts, {}, CONFIG, deps)).status, 503);
    assert.equal((await run(parts, {}, CONFIG, deps)).status, 503);
    const limited = await run(parts, {}, CONFIG, deps);
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, "rate_limited");
    assert.match(String(limited.headers?.["Retry-After"]), /^\d+$/);
    // another key has its own budget, and unauthenticated calls never consume anyone's budget
    assert.equal((await run(parts, { keyId: "kid-next", secret: SECRET_NEXT }, CONFIG, deps)).status, 503);
    for (let i = 0; i < 5; i++) assert.equal((await run(parts, { sign: false }, CONFIG, deps)).status, 401);
  });

  it("never returns secret material", async () => {
    const out = JSON.stringify([await run(await multipart(metadata())), await run(await multipart(metadata()), { sign: false })]);
    assert.ok(!out.includes(SECRET_CURRENT) && !out.includes(SECRET_NEXT));
  });

  it("has no database, storage or service-role access in the prep-state files", () => {
    for (const file of ["../handler.ts", "../config.ts", "../rate-limit.ts", "../../../app/api/integrations/financeops/v1/bill-intakes/route.ts"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      assert.ok(!/supabase|createClient|SERVICE_ROLE|\.from\(\s*["'`]|\.rpc\(|\.storage\b/i.test(src), file);
    }
  });
});

describe("rate limiter", () => {
  it("allows up to the limit per window, then recovers", () => {
    const rl = createRateLimiter(2, 1000);
    assert.deepEqual(rl.check("k", 0), { allowed: true });
    assert.deepEqual(rl.check("k", 100), { allowed: true });
    assert.deepEqual(rl.check("k", 200), { allowed: false, retryAfterSeconds: 1 });
    assert.deepEqual(rl.check("other", 200), { allowed: true });
    assert.deepEqual(rl.check("k", 1001), { allowed: true });
  });
});
