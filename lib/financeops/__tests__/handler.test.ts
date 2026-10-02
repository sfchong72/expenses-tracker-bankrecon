import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { sha256Hex, signRequest } from "../auth.ts";
import { readFinanceOpsConfig, type FinanceOpsConfig } from "../config.ts";
import { handleBillIntake, MAX_REQUEST_BYTES } from "../handler.ts";

const SECRET_CURRENT = "test-secret-current-0123456789abcdef0123";
const SECRET_NEXT = "test-secret-next-0123456789abcdef012345";
const PATH = "/api/integrations/financeops/v1/bill-intakes";
const NOW = 1_800_000_000;
const PDF = new TextEncoder().encode("%PDF-1.7\nfake invoice");

const ENV = {
  FINANCEOPS_INTAKE_ENABLED: "true",
  FINANCEOPS_ALLOWED_ENTITY_CODES: "IEA, plc ,bogus",
  FINANCEOPS_HMAC_KEY_ID_CURRENT: "kid-current",
  FINANCEOPS_HMAC_SECRET_CURRENT: SECRET_CURRENT,
  FINANCEOPS_HMAC_KEY_ID_NEXT: "kid-next",
  FINANCEOPS_HMAC_SECRET_NEXT: SECRET_NEXT,
};
const CONFIG: FinanceOpsConfig = readFinanceOpsConfig(ENV);

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

async function multipart(meta: unknown, file: { bytes: Uint8Array; type: string } | null = { bytes: PDF, type: "application/pdf" }, extra: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("metadata", typeof meta === "string" ? meta : JSON.stringify(meta));
  if (file) fd.set("file", new File([file.bytes as BlobPart], "a.pdf", { type: file.type }));
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  const res = new Response(fd);
  return { raw: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") as string };
}

function request(parts: { raw: Uint8Array; contentType: string }, over: { secret?: string; keyId?: string; path?: string; sign?: boolean; timestamp?: string } = {}) {
  const timestamp = over.timestamp ?? String(NOW);
  const headers = new Headers({ "content-type": parts.contentType });
  if (over.sign !== false) {
    headers.set("x-financeops-key-id", over.keyId ?? "kid-current");
    headers.set("x-financeops-timestamp", timestamp);
    headers.set("x-financeops-signature", signRequest(over.secret ?? SECRET_CURRENT, { timestamp, method: "POST", path: over.path ?? PATH, bodySha256: sha256Hex(parts.raw) }));
  }
  return { method: "POST", pathAndQuery: PATH, headers, rawBody: parts.raw };
}

async function run(parts: { raw: Uint8Array; contentType: string }, over: Parameters<typeof request>[1] = {}, config: FinanceOpsConfig = CONFIG) {
  return handleBillIntake(request(parts, over), config, NOW);
}

describe("config", () => {
  it("is disabled, keyless and entity-less by default", () => {
    assert.deepEqual(readFinanceOpsConfig({}), { enabled: false, keys: [], allowedEntities: [], maxSkewSeconds: 300 });
  });
  it("parses and sanitises the entity allow-list", () => {
    assert.deepEqual(CONFIG.allowedEntities, ["IEA", "PLC"]);
    assert.equal(readFinanceOpsConfig({ ...ENV, FINANCEOPS_INTAKE_ENABLED: "TRUE" }).enabled, false);
    assert.equal(readFinanceOpsConfig({ ...ENV, FINANCEOPS_MAX_SKEW_SECONDS: "5" }).maxSkewSeconds, 300);
    assert.equal(readFinanceOpsConfig({ ...ENV, FINANCEOPS_MAX_SKEW_SECONDS: "60" }).maxSkewSeconds, 60);
  });
});

describe("bill-intakes handler (prep state)", () => {
  it("answers 503 integration_disabled / not_configured before touching the request", async () => {
    const parts = await multipart(metadata());
    assert.equal((await run(parts, {}, { ...CONFIG, enabled: false })).body.error, "integration_disabled");
    assert.equal((await run(parts, {}, { ...CONFIG, keys: [] })).body.error, "integration_not_configured");
    assert.equal((await run(parts, {}, { ...CONFIG, allowedEntities: [] })).body.error, "integration_not_configured");
  });

  it("rejects missing, wrong-key, wrong-secret, tampered-path and stale requests with an opaque 401", async () => {
    const parts = await multipart(metadata());
    const results = [
      await run(parts, { sign: false }),
      await run(parts, { keyId: "nope" }),
      await run(parts, { secret: "another-secret-0123456789abcdef012345" }),
      await run(parts, { path: "/api/integrations/financeops/v1/other" }),
      await run(parts, { timestamp: String(NOW - 3600) }),
    ];
    for (const r of results) {
      assert.equal(r.status, 401);
      assert.deepEqual(r.body, { error: "unauthorized" });
    }
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

  it("accepts an uncertain (null) entity and leaves it for human review", async () => {
    const r = await run(await multipart(metadata({ entity_code: null })));
    assert.equal(r.body.error, "intake_persistence_not_ready");
    assert.equal(r.body.entity_code, null);
  });

  it("rejects forbidden and unknown fields with 422 and no echoed values", async () => {
    const r = await run(await multipart(metadata({ payment_status: "paid", surprise: "secret-value-123" })));
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "validation_failed");
    assert.ok(!JSON.stringify(r.body).includes("secret-value-123"));
    assert.ok(!JSON.stringify(r.body).includes("paid"));
  });

  it("enforces the entity allow-list", async () => {
    assert.equal((await run(await multipart(metadata({ entity_code: "KALER" })))).status, 403);
    assert.equal((await run(await multipart(metadata({ entity_code: "PLC" })))).status, 503);
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
    const r = await handleBillIntake({ method: "POST", pathAndQuery: PATH, headers: new Headers(), rawBody: raw }, CONFIG, NOW);
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

  it("never returns secret material", async () => {
    const out = JSON.stringify([await run(await multipart(metadata())), await run(await multipart(metadata()), { sign: false })]);
    assert.ok(!out.includes(SECRET_CURRENT) && !out.includes(SECRET_NEXT));
  });

  it("has no database, storage or service-role access in the prep-state files", () => {
    for (const file of ["../handler.ts", "../config.ts", "../../../app/api/integrations/financeops/v1/bill-intakes/route.ts"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      assert.ok(!/supabase|createClient|SERVICE_ROLE|\.from\(\s*["'`]|\.rpc\(|\.storage\b/i.test(src), file);
    }
  });
});
