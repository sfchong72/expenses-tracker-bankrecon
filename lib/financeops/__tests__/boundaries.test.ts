import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { handleBillIntake } from "../handler";
import { readFinanceOpsDbConfig } from "../db-session";
import { classifyDbError } from "../store";
import { createSupabaseIntakeStore } from "../store-supabase";
import { CONFIG, PDF, depsFor, metadata, multipart, PATH, NOW, SECRET } from "./harness";
import { sha256Hex, signRequest } from "../auth";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const realConsoleError = console.error;
before(() => { console.error = () => {}; });
after(() => { console.error = realConsoleError; });

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("20: no service role, and no bank / payment / voucher / reconciliation access, anywhere in the FinanceOps code", () => {
  const sources = readdirSync(join(ROOT, "lib", "financeops"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ name: `lib/financeops/${f}`, text: read(`lib/financeops/${f}`) }))
    .concat(
      ["app/api/integrations/financeops/v1/bill-intakes/route.ts", "app/api/integrations/financeops/v1/bill-intakes/[intake_id]/route.ts", "app/finance-intake-workspace.tsx"].map((name) => ({ name, text: read(name) })),
    );

  it("never references a service-role key", () => {
    for (const s of sources) assert.equal(/service[_-]?role|SERVICE_ROLE|supabase_admin|auth\.admin/i.test(s.text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), false, s.name);
  });

  it("never touches bank, payment, voucher, reconciliation, claims or SQL Account tables", () => {
    const forbidden = /bank_|bill_payments|payment_vouchers|payment_voucher_items|reconcil|claims|claim_|sql_account|\.from\(\s*["']app_profiles["']\s*\)\s*\.(insert|update|delete)/i;
    for (const s of sources.filter((x) => !x.name.endsWith("schema.ts"))) {
      const code = s.text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      assert.equal(forbidden.test(code), false, s.name);
    }
  });

  it("the Supabase store touches exactly the tables the intake flow needs", () => {
    const text = read("lib/financeops/store-supabase.ts");
    const tables = Array.from(new Set(Array.from(text.matchAll(/\.from\("([a-z_]+)"\)/g)).map((m) => m[1]))).sort();
    assert.deepEqual(tables, ["app_profiles", "categories", "document_links", "documents", "entities", "finance_intake_submissions", "finance_integration_identities", "supplier_bills", "supplier_entities", "suppliers_app_safe"]);
    assert.deepEqual(Array.from(text.matchAll(/storage\.from\("([^"]+)"\)/g)).map((m) => m[1]), ["bill-documents"]);
  });

  it("writes only: intakes (insert/update), supplier_bills (insert), documents (insert), document_links (insert); never deletes or updates anything else", () => {
    const text = read("lib/financeops/store-supabase.ts");
    assert.equal(/\.delete\(/.test(text), false);
    assert.equal(/\.upsert\(/.test(text), false);
    const updates = Array.from(text.matchAll(/\.from\("([a-z_]+)"\)\s*\.update\(/g)).map((m) => m[1]);
    assert.deepEqual(updates, ["finance_intake_submissions"]);
    const inserts = Array.from(text.matchAll(/\.from\("([a-z_]+)"\)\s*\.insert\(/g)).map((m) => m[1]).sort();
    assert.deepEqual(inserts, ["document_links", "documents", "finance_intake_submissions", "supplier_bills"]);
  });

  it("the FinanceOps code never writes payment_status other than the literal draft", () => {
    const code = read("lib/financeops/persist.ts") + read("lib/financeops/intake.ts") + read("lib/financeops/store-supabase.ts");
    const statuses = Array.from(code.matchAll(/payment_status\s*:\s*"([a-z_]+)"/g)).map((m) => m[1]);
    assert.ok(statuses.length > 0);
    for (const status of statuses) assert.equal(status, "draft");
    assert.equal(/"unpaid"|'unpaid'|"scheduled"|"paid"/.test(code.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), false);
  });

  it("the middleware exemption is still exactly one prefix", () => {
    const text = read("lib/financeops/routes.ts");
    assert.equal(Array.from(text.matchAll(/FINANCEOPS_API_PREFIX\s*=\s*"([^"]+)"/g)).length, 1);
    assert.match(text, /\/api\/integrations\/financeops\/v1\//);
  });
});

describe("database session wiring", () => {
  it("is not configured (no credentials) unless every FinanceOps database setting is present", () => {
    assert.equal(readFinanceOpsDbConfig({}), null);
    const base = { NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon", FINANCEOPS_DB_USER_EMAIL: "fo@example.invalid", FINANCEOPS_DB_USER_PASSWORD: "pw" };
    assert.notEqual(readFinanceOpsDbConfig(base), null);
    for (const key of Object.keys(base)) assert.equal(readFinanceOpsDbConfig({ ...base, [key]: "" }), null, key);
    // a service-role key in the environment is simply never read
    assert.equal(JSON.stringify(readFinanceOpsDbConfig({ ...base, SUPABASE_SERVICE_ROLE_KEY: "secret" })).includes("secret"), false);
  });

  async function authed(storeProvider: Parameters<typeof depsFor>[0]) {
    const parts = await multipart(metadata());
    const timestamp = String(NOW);
    const headers = new Headers({ "content-type": parts.contentType, "x-financeops-key-id": "kid-current", "x-financeops-timestamp": timestamp, "x-financeops-signature": signRequest(SECRET, { timestamp, method: "POST", path: PATH, query: "", bodySha256: sha256Hex(parts.raw) }) });
    return handleBillIntake({ method: "POST", path: PATH, query: "", headers, rawBody: parts.raw }, CONFIG, depsFor(storeProvider));
  }

  it("with no store provider the endpoint stays the 503 placeholder and stores nothing", async () => {
    const parts = await multipart(metadata());
    const timestamp = String(NOW);
    const headers = new Headers({ "content-type": parts.contentType, "x-financeops-key-id": "kid-current", "x-financeops-timestamp": timestamp, "x-financeops-signature": signRequest(SECRET, { timestamp, method: "POST", path: PATH, query: "", bodySha256: sha256Hex(parts.raw) }) });
    const r = await handleBillIntake({ method: "POST", path: PATH, query: "", headers, rawBody: parts.raw }, CONFIG, { nowSeconds: NOW });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "intake_persistence_not_ready");
  });

  it("a provider that reports 'not configured' gives 503 integration_db_not_configured; a throwing provider gives a retryable 503", async () => {
    const off = await authed(null);
    assert.equal(off.status, 503);
    assert.equal(off.body.error, "integration_db_not_configured");
    const boom = await authed(async () => { throw new Error("FinanceOps identity sign-in failed"); });
    assert.equal(boom.status, 503);
    assert.equal(boom.body.error, "integration_identity_unavailable");
    assert.equal(JSON.stringify(boom.body).includes("sign-in"), false);
  });

  it("unauthenticated and invalid requests never reach the store provider", async () => {
    let calls = 0;
    const parts = await multipart(metadata());
    const r = await handleBillIntake({ method: "POST", path: PATH, query: "", headers: new Headers({ "content-type": parts.contentType }), rawBody: parts.raw }, CONFIG, depsFor(async () => { calls += 1; return null; }));
    assert.equal(r.status, 401);
    assert.equal(calls, 0);
  });
});

describe("database error classification", () => {
  it("maps Postgres / PostgREST errors to store error kinds and constraint names", () => {
    assert.deepEqual(classifyDbError({ code: "23505", message: 'duplicate key value violates unique constraint "fis_intake_id_key"' }), { kind: "conflict", constraint: "fis_intake_id_key", message: 'duplicate key value violates unique constraint "fis_intake_id_key"' });
    assert.equal(classifyDbError({ code: "42501", message: "new row violates row-level security policy" }).kind, "denied");
    assert.equal(classifyDbError({ code: "P0001", message: "The supplier bill link can only be set once" }).kind, "rejected");
    assert.equal(classifyDbError({ code: "23514", message: 'new row violates check constraint "fis_supersede_has_entity"' }).constraint, "fis_supersede_has_entity");
    assert.equal(classifyDbError({ code: "23503", message: "fk" }).kind, "constraint");
    assert.equal(classifyDbError({ code: "", message: "fetch failed" }).kind, "unavailable");
    assert.equal(classifyDbError({ code: "57014", message: "statement timeout" }).kind, "unavailable");
  });
});

describe("supabase store: statement shapes", () => {
  type Call = { table: string; chain: string[] };
  function recorder(result: Record<string, unknown> = { data: null, error: null }) {
    const calls: Call[] = [];
    const client = {
      from(table: string) {
        const call: Call = { table, chain: [] };
        calls.push(call);
        const proxy: unknown = new Proxy(() => undefined, {
          get(_t, prop) {
            if (prop === "then") return (res: (v: unknown) => unknown) => res(result);
            return (...args: unknown[]) => { call.chain.push(String(prop)); void args; return proxy; };
          },
        });
        return proxy;
      },
      storage: { from: () => ({ upload: async () => ({ error: { message: "The resource already exists", statusCode: "409" } }) }) },
    };
    return { client, calls };
  }

  it("inserts the document WITHOUT reading it back (an unlinked document is invisible to its uploader)", async () => {
    const { client, calls } = recorder();
    const store = createSupabaseIntakeStore(client as never);
    await store.insertDocument({ id: "d", entity_id: "e", document_type: "supplier_invoice", original_filename: "a.pdf", storage_path: "p", mime_type: "application/pdf", file_size: 1, file_hash: "h", uploaded_by: "u", version_number: 1, is_demo: false, data_origin: "imported" });
    assert.deepEqual(calls[0].chain, ["insert"]);
    await store.linkDocument({ document_id: "d", entity_id: "e", linked_record_type: "supplier_bill", linked_record_id: "b", created_by: "u", is_demo: false, data_origin: "imported" });
    assert.deepEqual(calls[1].chain, ["insert"]);
  });

  it("an object that already exists at the deterministic path counts as uploaded", async () => {
    const { client } = recorder();
    const store = createSupabaseIntakeStore(client as never);
    const r = await store.uploadObject("p", PDF, "application/pdf");
    assert.deepEqual(r, { ok: true, value: { alreadyExisted: true } });
  });

  it("intake updates are always by primary key", async () => {
    const { client, calls } = recorder({ data: { id: "r" }, error: null });
    const store = createSupabaseIntakeStore(client as never);
    await store.updateIntake("row-1", { process_state: "complete" });
    assert.deepEqual(calls[0].chain.slice(0, 2), ["update", "eq"]);
  });
});
