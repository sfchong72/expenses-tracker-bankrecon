import { NextResponse } from "next/server";
import { readStatementForm } from "@/lib/financeops/payments/http";
import { prepareStatementImport, requireCaller } from "@/lib/financeops/payments/services";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** Preview a bank statement import (CSV, XLSX or pasted rows). Reviewers with MFA only; nothing is written. */
export async function POST(request: Request) {
  const supabase = await createClient();
  const caller = await requireCaller(supabase, process.env, { reviewer: true, aal2: true });
  if (!caller.ok) return NextResponse.json(caller.body, { status: caller.status });
  const { input } = await readStatementForm(await request.formData());
  const result = await prepareStatementImport(supabase, input);
  return result.ok ? NextResponse.json(result.value) : NextResponse.json(result.body, { status: result.status });
}
