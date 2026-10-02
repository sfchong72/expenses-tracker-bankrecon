import { readFinanceOpsConfig } from "@/lib/financeops/config";
import { handlePaymentIntake, precheckPaymentIntake } from "@/lib/financeops/payments/handler";
import { paymentHandlerDeps, toResponse } from "@/lib/financeops/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * FinanceOps -> Hub payment capture (an operational Payment Register record, never an official payment).
 * HMAC-authenticated like invoice intake, and additionally behind FINANCEOPS_PAYMENT_REGISTER_ENABLED (default OFF).
 * Runs as the FinanceOps data_entry identity through RLS; without its credentials it answers 503 and stores nothing.
 */
export async function POST(request: Request) {
  const config = readFinanceOpsConfig(process.env);
  const deps = paymentHandlerDeps(config);
  const declared = request.headers.get("content-length");
  const early = precheckPaymentIntake(config, deps.paymentRegisterEnabled, request.method, "POST", declared !== null && /^\d+$/.test(declared) ? Number(declared) : null);
  if (early) return toResponse(early);
  const url = new URL(request.url);
  const rawBody = new Uint8Array(await request.arrayBuffer());
  return toResponse(await handlePaymentIntake({ method: request.method, path: url.pathname, query: url.search, headers: request.headers, rawBody }, config, deps));
}
