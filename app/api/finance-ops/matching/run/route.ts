import { NextResponse } from "next/server";
import { requireCaller, runMatching } from "@/lib/financeops/payments/services";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** Run the rule-based matching engine for one entity. It only SUGGESTS; a human confirms in the queue. */
export async function POST(request: Request) {
  const supabase = await createClient();
  const caller = await requireCaller(supabase, process.env, { reviewer: true, aal2: true });
  if (!caller.ok) return NextResponse.json(caller.body, { status: caller.status });
  const body = await request.json().catch(() => null);
  const entityId = typeof body?.entity_id === "string" ? body.entity_id : "";
  const result = await runMatching(supabase, caller.value, entityId);
  return result.ok ? NextResponse.json(result.value) : NextResponse.json(result.body, { status: result.status });
}
