import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const deletableStatuses = new Set(["draft", "incomplete"]);

export async function POST(request: Request) {
  const db = await createClient();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Please log in first." }, { status: 401 });

  const { studentId, action, reason } = await request.json();
  const note = String(reason || "").trim();
  if (!studentId) return NextResponse.json({ error: "Choose a student record first." }, { status: 400 });
  if (!["delete", "archive", "duplicate"].includes(action)) return NextResponse.json({ error: "Choose delete, archive or mark as duplicate." }, { status: 400 });
  if (action !== "delete" && !note) return NextResponse.json({ error: "Enter a reason for the audit trail." }, { status: 400 });

  const studentRes = await db.from("students").select("id, student_number, full_name, lifecycle_status").eq("id", studentId).maybeSingle();
  if (studentRes.error) return NextResponse.json({ error: studentRes.error.message }, { status: 400 });
  if (!studentRes.data) return NextResponse.json({ error: "Student not found." }, { status: 404 });

  const [enrolments, documents, legacy, audits] = await Promise.all([
    db.from("enrolments").select("id", { count: "exact", head: true }).eq("student_id", studentId),
    db.from("document_links").select("id", { count: "exact", head: true }).eq("linked_record_type", "student").eq("linked_record_id", studentId),
    db.from("student_legacy_records").select("id", { count: "exact", head: true }).eq("student_id", studentId),
    db.from("audit_logs").select("id", { count: "exact", head: true }).eq("entity_type", "student").eq("entity_id", studentId),
  ]);
  const dependencyError = enrolments.error || documents.error || legacy.error || audits.error;
  if (dependencyError) return NextResponse.json({ error: dependencyError.message }, { status: 400 });

  const dependencyCount = (enrolments.count || 0) + (documents.count || 0) + (legacy.count || 0) + (audits.count || 0);

  if (action === "delete") {
    if (!deletableStatuses.has(studentRes.data.lifecycle_status) || dependencyCount > 0) {
      return NextResponse.json({
        error: "This student has linked records or is no longer a simple draft. Archive or mark as duplicate instead.",
        dependency_count: dependencyCount,
      }, { status: 400 });
    }
    const deleted = await db.from("students").delete().eq("id", studentId).in("lifecycle_status", [...deletableStatuses]);
    if (deleted.error) return NextResponse.json({ error: deleted.error.message }, { status: 400 });
    await db.from("audit_logs").insert({
      actor_user_id: userData.user.id,
      action: "student_draft_deleted",
      entity_type: "student",
      entity_id: studentId,
      payload: { student_number: studentRes.data.student_number, full_name: studentRes.data.full_name },
      data_origin: "manual",
    });
    return NextResponse.json({ status: "deleted" });
  }

  const patch = action === "archive"
    ? { lifecycle_status: "archived", active_status: false, remarks: note }
    : { duplicate_review_status: "possible_duplicate", remarks: note };
  const updated = await db.from("students").update({ ...patch, updated_by: userData.user.id }).eq("id", studentId);
  if (updated.error) return NextResponse.json({ error: updated.error.message }, { status: 400 });

  await db.from("audit_logs").insert({
    actor_user_id: userData.user.id,
    action: action === "archive" ? "student_archived" : "student_marked_duplicate",
    entity_type: "student",
    entity_id: studentId,
    payload: { student_number: studentRes.data.student_number, full_name: studentRes.data.full_name, reason: note },
    data_origin: "manual",
  });

  return NextResponse.json({ status: action === "archive" ? "archived" : "possible_duplicate" });
}
