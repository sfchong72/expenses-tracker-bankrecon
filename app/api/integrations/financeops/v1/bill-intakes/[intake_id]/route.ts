import { readFinanceOpsConfig } from "@/lib/financeops/config";
import { handleBillIntakeStatus, precheckStatus } from "@/lib/financeops/handler";
import { handlerDeps, toResponse } from "@/lib/financeops/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * FinanceOps -> Hub: status of one intake this identity submitted. HMAC-authenticated (GET, empty body signed),
 * read through the FinanceOps identity's own RLS, returns only operational fields.
 */
export async function GET(request: Request, context: { params: Promise<{ intake_id: string }> }) {
  const config = readFinanceOpsConfig(process.env);
  const early = precheckStatus(config, request.method);
  if (early) return toResponse(early);

  const { intake_id: intakeId } = await context.params;
  const url = new URL(request.url);
  return toResponse(await handleBillIntakeStatus({ method: request.method, path: url.pathname, query: url.search, headers: request.headers, rawBody: new Uint8Array(0) }, intakeId, config, handlerDeps(config)));
}
