import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { StudentImportMode, validateStudentImportMapped } from "@/lib/import/student";

type ConfirmRow = {
  id?: string;
  mapped?: Record<string, unknown>;
  duplicateDecision?: "pending" | "import_as_new" | "link_existing" | "skip";
  matchedStudentId?: string;
  excluded?: boolean;
};

export async function POST(request: Request) {
  const db = await createClient();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Please log in first." }, { status: 401 });

  const body = await request.json() as { batchId?: string; rows?: ConfirmRow[] };
  if (!body.batchId || !Array.isArray(body.rows)) {
    return NextResponse.json({ error: "Import batch and preview rows are required." }, { status: 400 });
  }

  const batch = await db.from("student_import_batches")
    .select("id, import_mode, status")
    .eq("id", body.batchId)
    .maybeSingle();
  if (batch.error || !batch.data) {
    return NextResponse.json({ error: "Import batch was not found or migration 0018 is not applied." }, { status: 404 });
  }
  if (!["mapping", "ready", "failed"].includes(batch.data.status)) {
    return NextResponse.json({ error: `This import cannot be confirmed because it is ${batch.data.status}.` }, { status: 409 });
  }

  const mode = batch.data.import_mode as StudentImportMode;
  const prepared = body.rows.map((row) => {
    const decision = row.excluded ? "skip" : row.duplicateDecision || "pending";
    const errors = decision === "skip" ? [] : validateStudentImportMapped(row.mapped || {}, mode);
    if (decision === "pending") errors.push("Resolve the duplicate warning");
    if (decision === "link_existing" && !row.matchedStudentId) errors.push("Select the existing student to link");
    return { ...row, decision, errors };
  });
  const invalid = prepared.filter((row) => row.errors.length);
  if (invalid.length) {
    return NextResponse.json({
      error: `${invalid.length} row(s) still need attention.`,
      row_errors: Object.fromEntries(invalid.map((row) => [String(row.id), row.errors])),
    }, { status: 400 });
  }

  const started = await db.from("student_import_batches").update({
    status: "processing",
    confirmed_by: userData.user.id,
    confirmed_at: new Date().toISOString(),
  }).eq("id", body.batchId);
  if (started.error) return NextResponse.json({ error: started.error.message }, { status: 400 });

  const results: Array<Record<string, unknown>> = [];
  let successful = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of prepared) {
    if (!row.id) {
      failed += 1;
      results.push({ status: "failed", error: "Preview row ID is missing." });
      continue;
    }

    const result = await db.rpc("confirm_student_import_row", {
      p_row_id: row.id,
      p_mapped_data: row.mapped || {},
      p_duplicate_decision: row.decision,
      p_matched_student_id: row.matchedStudentId || null,
    });
    if (result.error) {
      failed += 1;
      const message = friendlyRowError(result.error.message);
      results.push({ row_id: row.id, status: "failed", error: message });
      await db.from("student_import_rows").update({
        mapped_data: row.mapped || {},
        validation_errors: [message],
        row_status: "failed",
        error_message: message,
      }).eq("id", row.id);
      continue;
    }

    const item = result.data as Record<string, unknown>;
    results.push(item);
    if (item.status === "skipped") skipped += 1;
    else successful += 1;
  }

  const status = failed === 0 ? "completed" : successful > 0 || skipped > 0 ? "completed_with_errors" : "failed";
  const finished = await db.from("student_import_batches").update({
    status,
    successful_rows: successful,
    skipped_rows: skipped,
    failed_rows: failed,
    result_summary: { results },
  }).eq("id", body.batchId);
  if (finished.error) return NextResponse.json({ error: finished.error.message }, { status: 400 });

  return NextResponse.json({ status, successful, skipped, failed, results });
}

function friendlyRowError(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes("full name")) return "Full name is required.";
  if (lower.includes("date/time field") || lower.includes("date of birth")) return "A date value is invalid.";
  if (lower.includes("between 1900 and 2100") || lower.includes("integer")) return "A year value is invalid.";
  if (lower.includes("duplicate") || lower.includes("link")) return message;
  if (lower.includes("authorised") || lower.includes("permission") || lower.includes("row-level security")) {
    return "You do not have permission to import this row.";
  }
  console.error("Student import row failed", message);
  return "This row could not be imported. Review its mapped values.";
}
