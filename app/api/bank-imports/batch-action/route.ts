import { NextResponse } from "next/server";
import { requireBankAccess } from "@/app/api/bank-imports/_shared";

export async function POST(request: Request) {
  const body = await request.json();
  const batchId = String(body.batchId ?? "");
  const action = String(body.action ?? "");
  const reason = String(body.reason ?? "");
  if (!batchId || !["discard", "archive"].includes(action)) return NextResponse.json({ error: "Valid batch action is required" }, { status: 400 });

  const preflight = await requireBankAccess(undefined, "read");
  if (preflight.error) return preflight.error;
  const batch = await preflight.supabase.from("bank_import_batches_staff_safe").select("id, entity_id, filename, status").eq("id", batchId).maybeSingle();
  if (batch.error || !batch.data) return NextResponse.json({ error: "Bank import batch not found" }, { status: 404 });

  const access = await requireBankAccess(batch.data.entity_id, "import");
  if (access.error) return access.error;

  const rpc = action === "discard" ? "discard_bank_import_batch" : "archive_bank_import_batch";
  const result = await access.supabase.rpc(rpc, { p_batch_id: batchId, p_reason: reason || null });
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 400 });
  return NextResponse.json({ ok: true, action, batchId });
}
