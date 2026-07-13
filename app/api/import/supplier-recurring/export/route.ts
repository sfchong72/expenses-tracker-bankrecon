import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const batchId = new URL(request.url).searchParams.get("batchId");
  if (!batchId) return NextResponse.json({ error: "Batch is required" }, { status: 400 });
  const batch = await supabase.from("import_batches").select("filename").eq("id", batchId).maybeSingle();
  if (batch.error || !batch.data) return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  const rows = await supabase.from("import_batch_rows").select("row_number, result_status, result_message, mapped_data, validation_errors, duplicate_warnings, supplier_id, recurring_obligation_id").eq("import_batch_id", batchId).order("row_number");
  if (rows.error) return NextResponse.json({ error: rows.error.message }, { status: 400 });
  const header = ["row_number", "result_status", "result_message", "supplier", "entity", "description", "amount", "supplier_id", "recurring_obligation_id", "validation_errors", "duplicate_warnings"];
  const csvRows = [header, ...(rows.data ?? []).map((row) => { const mapped = row.mapped_data as Record<string, unknown>; return [row.row_number, row.result_status, row.result_message ?? "", mapped.supplier_name ?? "", mapped.entity ?? "", mapped.description ?? "", mapped.expected_amount ?? "", row.supplier_id ?? "", row.recurring_obligation_id ?? "", JSON.stringify(row.validation_errors ?? []), JSON.stringify(row.duplicate_warnings ?? [])]; })];
  const csv = csvRows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="import-result-${batchId}.csv"` } });
}
