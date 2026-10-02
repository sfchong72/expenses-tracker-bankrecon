import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { FINANCEOPS_API_PREFIX, isFinanceOpsIntegrationPath } from "../routes";

describe("middleware exemption matcher", () => {
  it("exempts only paths under the exact /api/integrations/financeops/v1/ prefix", () => {
    assert.equal(FINANCEOPS_API_PREFIX, "/api/integrations/financeops/v1/");
    assert.equal(isFinanceOpsIntegrationPath("/api/integrations/financeops/v1/bill-intakes"), true);
    assert.equal(isFinanceOpsIntegrationPath("/api/integrations/financeops/v1/bill-intakes/abc"), true);
    assert.equal(isFinanceOpsIntegrationPath("/api/integrations/financeops/v1/bill-candidates"), true);
  });

  it("does not exempt the bare prefix, the unversioned prefix, or other versions", () => {
    for (const p of [
      "/api/integrations/financeops/v1",
      "/api/integrations/financeops/v1/",
      "/api/integrations/financeops",
      "/api/integrations/financeops/",
      "/api/integrations/financeops/v2/bill-intakes",
      "/api/integrations/financeops/bill-intakes",
      "/api/integrations/financeops/v10/x",
    ]) assert.equal(isFinanceOpsIntegrationPath(p), false, p);
  });

  it("does not exempt lookalike prefixes (financeopsX) or other integrations", () => {
    for (const p of [
      "/api/integrations/financeopsX/v1/x",
      "/api/integrations/financeops-evil/v1/x",
      "/api/integrations/financeops_v1/x",
      "/api/integrations/other/v1/x",
      "/api/integrations/",
      "/api/integrationsfinanceops/v1/",
      "/API/integrations/financeops/v1/x",
      "/x/api/integrations/financeops/v1/x",
    ]) assert.equal(isFinanceOpsIntegrationPath(p), false, p);
  });

  it("leaves /api/admin and every existing application route unaffected", () => {
    for (const p of [
      "/api/admin/users/create",
      "/api/admin/anything",
      "/api/documents/upload",
      "/api/documents/123/download",
      "/api/documents/123/delete",
      "/api/payment-vouchers/issue",
      "/api/payment-vouchers/generate",
      "/api/bank-imports/confirm",
      "/api/reconciliation/confirm-match",
      "/api/claims/save",
      "/api/stripe/webhooks",
      "/settings/users",
      "/bills",
      "/",
    ]) assert.equal(isFinanceOpsIntegrationPath(p), false, p);
  });

  it("refuses dot-segment traversal", () => {
    for (const p of [
      "/api/integrations/financeops/v1/../admin/users/create",
      "/api/integrations/financeops/v1/..",
      "/api/integrations/financeops/v1/a/../../../admin",
      "/api/integrations/financeops/v1/.../x",
    ]) assert.equal(isFinanceOpsIntegrationPath(p), false, p);
  });

  it("refuses percent-encoded dots, slashes and backslashes (single and double encoding)", () => {
    for (const p of [
      "/api/integrations/financeops/v1/%2e%2e/admin",
      "/api/integrations/financeops/v1/%2E%2E/admin",
      "/api/integrations/financeops/v1/..%2fadmin",
      "/api/integrations/financeops/v1/a%2fb",
      "/api/integrations/financeops/v1/a%2Fb",
      "/api/integrations/financeops/v1/a%5cb",
      "/api/integrations/financeops/v1/a%5Cb",
      "/api/integrations/financeops/v1/%252e%252e/admin",
      "/api/integrations/financeops/v1/%252f",
      "/api/integrations/financeops/v1/%255c",
      "/api/integrations/financeops%2fv1/x",
      "/api%2fintegrations/financeops/v1/x",
    ]) assert.equal(isFinanceOpsIntegrationPath(p), false, p);
  });

  it("refuses literal backslashes, double slashes and path parameters", () => {
    for (const p of [
      "/api/integrations/financeops/v1\\..\\admin",
      "/api/integrations/financeops/v1/a\\b",
      "/api/integrations/financeops/v1//admin",
      "/api/integrations/financeops//v1/x",
      "/api/integrations/financeops/v1/x;/../admin",
    ]) assert.equal(isFinanceOpsIntegrationPath(p), false, p);
  });

  it("is used by the middleware before any cookie/profile logic, and only through this matcher", () => {
    const src = readFileSync(new URL("../../supabase/middleware.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    assert.match(src, /isFinanceOpsIntegrationPath\(pathname\)\) return NextResponse\.next\(\{ request \}\)/);
    assert.equal((src.match(/isFinanceOpsIntegrationPath/g) ?? []).length, 2); // import + the single use
    assert.ok(src.indexOf("isFinanceOpsIntegrationPath(pathname)") < src.indexOf("auth.getUser"));
    assert.ok(!/integrations\/financeops/.test(src.replace(/import[^\n]*\n/, ""))); // no second hard-coded exemption
  });
});
