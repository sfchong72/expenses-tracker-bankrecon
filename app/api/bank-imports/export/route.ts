import { csvResponse, requireBankAccess } from "@/app/api/bank-imports/_shared";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const batchId = searchParams.get("batchId") ?? "";
  if (!batchId) return NextResponse.json({ error: "batchId is required" }, { status: 400 });

  const access = await requireBankAccess(undefined, "read");
  if (access.error) return access.error;
  const batch = await access.supabase.from("bank_import_batches_staff_safe").select("*").eq("id", batchId).maybeSingle();
  if (batch.error || !batch.data) return NextResponse.json({ error: "Bank import batch not found" }, { status: 404 });

  const rowTable = access.canViewBalances ? "bank_import_rows" : "bank_import_rows_staff_safe";
  const rows = await access.supabase
    .from(rowTable)
    .select("*")
    .eq("bank_import_batch_id", batchId)
    .order("row_number", { ascending: true });
  if (rows.error) return NextResponse.json({ error: rows.error.message }, { status: 400 });

  const output = (rows.data ?? []).map((row) => ({
    row_number: row.row_number,
    result_status: row.result_status,
    result_message: row.result_message,
    excluded: row.excluded,
    duplicate_decision: row.duplicate_decision,
    mapped_data: JSON.stringify(row.mapped_data ?? {}),
    bank_transaction_id: row.bank_transaction_id ?? "",
  }));

  return csvResponse(`bank-import-${batchId}.csv`, output);
}
