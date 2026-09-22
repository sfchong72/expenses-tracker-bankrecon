import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request, context: any) {
  const { id } = await context.params;
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const reason = String(body.reason || "").trim();
  if (!reason) return NextResponse.json({ error: "Deletion reason is required" }, { status: 400 });

  const document = await supabase
    .from("documents")
    .select("id, storage_path, mime_type")
    .eq("id", id)
    .maybeSingle();
  if (document.error || !document.data) {
    return NextResponse.json({ error: "Document not found or not accessible" }, { status: 404 });
  }

  const downloaded = await supabase.storage.from("bill-documents").download(document.data.storage_path);
  if (downloaded.error || !downloaded.data) {
    return NextResponse.json({ error: downloaded.error?.message || "Could not stage the file for safe deletion" }, { status: 400 });
  }
  const bytes = Buffer.from(await downloaded.data.arrayBuffer());

  const removed = await supabase.storage.from("bill-documents").remove([document.data.storage_path]);
  if (removed.error) return NextResponse.json({ error: removed.error.message }, { status: 400 });

  const metadata = await supabase.rpc("delete_document_metadata", {
    p_document_id: id,
    p_reason: reason,
  });
  if (metadata.error) {
    const restored = await supabase.storage.from("bill-documents").upload(
      document.data.storage_path,
      bytes,
      { contentType: document.data.mime_type, upsert: false },
    );
    const suffix = restored.error ? " The Storage restore also failed; operator review is required." : " The Storage object was restored.";
    return NextResponse.json({ error: `${metadata.error.message}${suffix}` }, { status: 500 });
  }

  return NextResponse.json({ status: "deleted" });
}
