import { readFinanceOpsConfig } from "@/lib/financeops/config";
import { handleBillIntake, precheckBillIntake } from "@/lib/financeops/handler";
import { handlerDeps, toResponse } from "@/lib/financeops/route-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * FinanceOps -> Hub invoice intake. Authenticated by HMAC inside the handler (the cookie
 * gate in middleware is deliberately bypassed for this path prefix only). Disabled unless
 * FINANCEOPS_INTAKE_ENABLED=true. Persists through the FinanceOps database identity's own RLS
 * session (never a service-role key); without its credentials it answers 503 and stores nothing.
 */
export async function POST(request: Request) {
  const config = readFinanceOpsConfig(process.env);
  const declared = request.headers.get("content-length");
  const early = precheckBillIntake(config, request.method, declared !== null && /^\d+$/.test(declared) ? Number(declared) : null);
  if (early) return toResponse(early);

  const url = new URL(request.url);
  const rawBody = new Uint8Array(await request.arrayBuffer());
  return toResponse(await handleBillIntake({ method: request.method, path: url.pathname, query: url.search, headers: request.headers, rawBody }, config, handlerDeps(config)));
}
