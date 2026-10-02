import { readFinanceOpsConfig } from "@/lib/financeops/config";
import { handlePaymentStatus, precheckPaymentIntake } from "@/lib/financeops/payments/handler";
import { paymentHandlerDeps, toResponse } from "@/lib/financeops/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Status of one payment this FinanceOps identity captured: HMAC-signed, own captures only, operational fields only. */
export async function GET(request: Request, context: { params: Promise<{ intake_id: string }> }) {
  const config = readFinanceOpsConfig(process.env);
  const deps = paymentHandlerDeps(config);
  const early = precheckPaymentIntake(config, deps.paymentRegisterEnabled, request.method, "GET", null);
  if (early) return toResponse(early);
  const { intake_id: intakeId } = await context.params;
  const url = new URL(request.url);
  return toResponse(await handlePaymentStatus({ method: request.method, path: url.pathname, query: url.search, headers: request.headers, rawBody: new Uint8Array(0) }, intakeId, config, deps));
}
