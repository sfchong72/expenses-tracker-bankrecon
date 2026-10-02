import { NextResponse } from "next/server";
import { readFinanceOpsConfig } from "@/lib/financeops/config";
import { handleBillIntake, precheckBillIntake, type HandlerResponse } from "@/lib/financeops/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toResponse(result: HandlerResponse) {
  return NextResponse.json(result.body, { status: result.status, headers: result.headers });
}

/**
 * FinanceOps -> Hub invoice intake. Authenticated by HMAC inside the handler (the cookie
 * gate in middleware is deliberately bypassed for this path prefix only).
 * Disabled unless FINANCEOPS_INTAKE_ENABLED=true; currently performs no finance writes.
 */
export async function POST(request: Request) {
  const config = readFinanceOpsConfig(process.env);
  const declared = request.headers.get("content-length");
  const early = precheckBillIntake(config, request.method, declared !== null && /^\d+$/.test(declared) ? Number(declared) : null);
  if (early) return toResponse(early);

  const url = new URL(request.url);
  const rawBody = new Uint8Array(await request.arrayBuffer());
  return toResponse(
    await handleBillIntake(
      { method: request.method, pathAndQuery: `${url.pathname}${url.search}`, headers: request.headers, rawBody },
      config,
    ),
  );
}
