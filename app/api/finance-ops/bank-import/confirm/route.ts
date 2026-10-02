import { NextResponse } from "next/server";
import { readStatementForm } from "@/lib/financeops/payments/http";
import { confirmStatementImport, requireCaller } from "@/lib/financeops/payments/services";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** Import the statement rows (insert-only, duplicates skipped). The file is re-read here: client-held rows are never trusted. */
export async function POST(request: Request) {
  const supabase = await createClient();
  const caller = await requireCaller(supabase, process.env, { reviewer: true, aal2: true });
  if (!caller.ok) return NextResponse.json(caller.body, { status: caller.status });
  const { input, bankName } = await readStatementForm(await request.formData());
  const result = await confirmStatementImport(supabase, caller.value, input, bankName);
  return result.ok ? NextResponse.json(result.value) : NextResponse.json(result.body, { status: result.status });
}
