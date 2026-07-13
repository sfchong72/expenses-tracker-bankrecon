import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

async function requireOwner() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return { supabase, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const profile = await supabase.from("app_profiles").select("role, active_status").eq("id", userData.user.id).maybeSingle();
  if (profile.error || profile.data?.role !== "owner" || !profile.data?.active_status) return { supabase, error: NextResponse.json({ error: "Owner access is required" }, { status: 403 }) };
  return { supabase, error: null };
}

export async function POST(request: Request) {
  const { supabase, error } = await requireOwner();
  if (error) return error;
  const body = await request.json();
  const batchId = String(body.batchId ?? "");
  const action = String(body.action ?? "");
  const reason = String(body.reason ?? "").trim() || null;
  if (!batchId) return NextResponse.json({ error: "Batch is required" }, { status: 400 });
  if (!["discard", "archive"].includes(action)) return NextResponse.json({ error: "Unsupported batch action" }, { status: 400 });
  const rpcName = action === "discard" ? "discard_supplier_recurring_import_batch" : "archive_supplier_recurring_import_batch";
  const result = await supabase.rpc(rpcName, { p_batch_id: batchId, p_reason: reason });
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 400 });
  return NextResponse.json({ action, result: result.data });
}
