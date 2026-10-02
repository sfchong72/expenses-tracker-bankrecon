import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isFinanceOpsIntegrationPath } from "../routes.ts";

describe("middleware exemption matcher", () => {
  it("exempts only paths under the exact FinanceOps integration prefix", () => {
    assert.equal(isFinanceOpsIntegrationPath("/api/integrations/financeops/v1/bill-intakes"), true);
    assert.equal(isFinanceOpsIntegrationPath("/api/integrations/financeops/v1/bill-intakes/abc"), true);
  });

  it("does not exempt the prefix itself, lookalikes, or other integrations", () => {
    for (const p of [
      "/api/integrations/financeops",
      "/api/integrations/financeops/",
      "/api/integrations/financeops-evil/v1/x",
      "/api/integrations/other/v1/x",
      "/api/integrations/",
      "/api/integrationsfinanceops/",
      "/API/integrations/financeops/v1/x",
    ]) assert.equal(isFinanceOpsIntegrationPath(p), false, p);
  });

  it("leaves admin and every existing application route untouched", () => {
    for (const p of [
      "/api/admin/users/create",
      "/api/documents/upload",
      "/api/documents/123/download",
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

  it("refuses traversal, encoded and backslash tricks", () => {
    for (const p of [
      "/api/integrations/financeops/../admin/users/create",
      "/api/integrations/financeops/v1/..%2fadmin",
      "/api/integrations/financeops/%2e%2e/admin",
      "/api/integrations/financeops//admin",
      "/api/integrations/financeops/v1\\..\\admin",
    ]) assert.equal(isFinanceOpsIntegrationPath(p), false, p);
  });
});
