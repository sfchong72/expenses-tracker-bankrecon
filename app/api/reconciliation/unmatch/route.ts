import { NextResponse } from "next/server";
import { requireBankAccess } from "@/app/api/bank-imports/_shared";

export async function POST(request: Request) {
  const body = await request.json();
  const allocationId = String(body.allocationId ?? "");
  const reason = String(body.reason ?? "");
  if (!allocationId || !reason) return NextResponse.json({ error: "Allocation and reversal reason are required" }, { status: 400 });

  const preflight = await requireBankAccess(undefined, "read");
  if (preflight.error) return preflight.error;
  const allocation = await preflight.supabase.from("bank_reconciliation_allocations").select("id, entity_id").eq("id", allocationId).maybeSingle();
  if (allocation.error || !allocation.data) return NextResponse.json({ error: "Allocation not found" }, { status: 404 });

  const access = await requireBankAccess(allocation.data.entity_id, "reconcile");
  if (access.error) return access.error;
  const reversed = await access.supabase.rpc("reverse_bank_reconciliation_allocation", { p_allocation_id: allocationId, p_reason: reason });
  if (reversed.error) return NextResponse.json({ error: reversed.error.message }, { status: 400 });
  return NextResponse.json({ allocation: reversed.data });
}
