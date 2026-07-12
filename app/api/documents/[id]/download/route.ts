import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function GET(_request: Request, context: any) {
  const { id } = await context.params;
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const doc = await supabase.from("documents").select("storage_path").eq("id", id).maybeSingle();
  if (doc.error || !doc.data) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  const signed = await supabase.storage.from("bill-documents").createSignedUrl(doc.data.storage_path, 60);
  if (signed.error) return NextResponse.json({ error: signed.error.message }, { status: 403 });
  return NextResponse.json({ url: signed.data.signedUrl });
}
