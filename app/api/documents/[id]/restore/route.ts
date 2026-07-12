import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function POST(_request: Request, context: any) {
  const { id } = await context.params;
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const res = await supabase.from("documents").update({ is_archived: false, status: "active", archived_at: null, archived_by: null }).eq("id", id);
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 403 });
  await supabase.from("audit_logs").insert({ actor_user_id: userData.user.id, action: "document_restored", entity_type: "document", payload: { document_id: id } });
  return NextResponse.json({ ok: true });
}
