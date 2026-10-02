import { NextResponse } from "next/server";
import { readRegisterForm } from "@/lib/financeops/payments/http";
import { prepareRegisterImport, requireCaller } from "@/lib/financeops/payments/services";
import { canCapturePayments } from "@/lib/financeops/payments/types";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** Preview the one-time import of the old Excel Payment Register. Nothing is written. */
export async function POST(request: Request) {
  const supabase = await createClient();
  const caller = await requireCaller(supabase, process.env, {});
  if (!caller.ok) return NextResponse.json(caller.body, { status: caller.status });
  if (!canCapturePayments(caller.value.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const input = await readRegisterForm(await request.formData());
  if (!input) return NextResponse.json({ error: "file_required" }, { status: 422 });
  const result = await prepareRegisterImport(supabase, input);
  return result.ok ? NextResponse.json(result.value) : NextResponse.json(result.body, { status: result.status });
}
