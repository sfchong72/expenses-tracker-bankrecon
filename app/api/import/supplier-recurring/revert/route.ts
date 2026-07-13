import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const profile = await supabase.from("app_profiles").select("role, active_status").eq("id", userData.user.id).maybeSingle();
  if (profile.error || profile.data?.role !== "owner" || !profile.data?.active_status) return NextResponse.json({ error: "Owner access is required" }, { status: 403 });
  const { batchId } = await request.json();
  if (!batchId) return NextResponse.json({ error: "Batch is required" }, { status: 400 });
  const reverted = await supabase.rpc("revert_supplier_recurring_import_batch", { p_batch_id: batchId });
  if (reverted.error) return NextResponse.json({ error: reverted.error.message }, { status: 400 });
  return NextResponse.json({ reverted: reverted.data });
}
