import { randomUUID, createHash } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const allowedTypes = new Set(["application/pdf", "image/jpeg", "image/png"]);
const maxSize = 10 * 1024 * 1024;
const validRecordTypes = new Set(["supplier_bill", "payment_voucher", "bill_payment", "bank_transaction", "recurring_obligation", "other"]);
const validDocumentTypes = new Set(["supplier_invoice", "receipt", "payment_slip", "payment_voucher", "quotation", "contract", "payroll_support", "other"]);

function cleanName(name: string) {
  return name.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 140) || "document";
}

function extension(mime: string) {
  if (mime === "application/pdf") return "pdf";
  if (mime === "image/png") return "png";
  return "jpg";
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const form = await request.formData();
  const file = form.get("file");
  const entityId = String(form.get("entity_id") ?? "");
  const linkedRecordType = String(form.get("linked_record_type") ?? "");
  const linkedRecordId = String(form.get("linked_record_id") ?? "");
  const documentType = String(form.get("document_type") ?? "");
  const replacesDocumentId = String(form.get("replaces_document_id") ?? "");

  if (!(file instanceof File)) return NextResponse.json({ error: "Missing file" }, { status: 400 });
  if (!entityId || !linkedRecordId) return NextResponse.json({ error: "Entity and linked record are required" }, { status: 400 });
  if (!validRecordTypes.has(linkedRecordType) || !validDocumentTypes.has(documentType)) return NextResponse.json({ error: "Unsupported document link or type" }, { status: 400 });
  if (!allowedTypes.has(file.type)) return NextResponse.json({ error: "Only PDF, JPG, JPEG and PNG files are allowed" }, { status: 400 });
  if (file.size > maxSize) return NextResponse.json({ error: "Maximum file size is 10 MB" }, { status: 400 });

  const bytes = Buffer.from(await file.arrayBuffer());
  const hash = createHash("sha256").update(bytes).digest("hex");
  const duplicate = await supabase.from("documents").select("id").eq("file_hash", hash).is("deleted_at", null).limit(1);
  const originalName = cleanName(file.name);
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const storageName = `${randomUUID()}.${extension(file.type)}`;
  const storagePath = `${entityId}/${year}/${month}/${documentType}/${linkedRecordId}/${storageName}`;

  const upload = await supabase.storage.from("bill-documents").upload(storagePath, bytes, { contentType: file.type, upsert: false });
  if (upload.error) return NextResponse.json({ error: upload.error.message }, { status: 400 });

  let version = 1;
  if (replacesDocumentId) {
    const oldDoc = await supabase.from("documents").select("version_number").eq("id", replacesDocumentId).maybeSingle();
    version = Number(oldDoc.data?.version_number ?? 0) + 1;
  }

  const inserted = await supabase.from("documents").insert({
    entity_id: entityId,
    document_type: documentType,
    original_filename: originalName,
    storage_path: storagePath,
    mime_type: file.type,
    file_size: file.size,
    file_hash: hash,
    uploaded_by: userData.user.id,
    version_number: version,
    replaces_document_id: replacesDocumentId || null,
  }).select("id").single();

  if (inserted.error) {
    await supabase.storage.from("bill-documents").remove([storagePath]);
    return NextResponse.json({ error: inserted.error.message }, { status: 400 });
  }

  const link = await supabase.from("document_links").insert({ document_id: inserted.data.id, entity_id: entityId, linked_record_type: linkedRecordType, linked_record_id: linkedRecordId, created_by: userData.user.id });
  if (link.error) return NextResponse.json({ error: link.error.message }, { status: 400 });

  if (replacesDocumentId) {
    await supabase.from("documents").update({ status: "replaced", is_archived: true, archived_at: new Date().toISOString(), archived_by: userData.user.id }).eq("id", replacesDocumentId);
  }

  await supabase.from("audit_logs").insert({ actor_user_id: userData.user.id, action: replacesDocumentId ? "document_replaced" : "document_uploaded", entity_type: "document", entity_id: entityId, payload: { document_id: inserted.data.id, linked_record_type: linkedRecordType, linked_record_id: linkedRecordId, duplicate_hash: Boolean(duplicate.data?.length) } });

  return NextResponse.json({ id: inserted.data.id, duplicate_warning: Boolean(duplicate.data?.length) });
}
