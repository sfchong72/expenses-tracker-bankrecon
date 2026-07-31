import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const db = await createClient();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Please log in first." }, { status: 401 });

  const result = await db.from("student_import_batches")
    .select("id, entity_id, default_branch_id, filename, file_type, worksheet_name, import_mode, status, total_rows, successful_rows, skipped_rows, failed_rows, result_summary, confirmed_at, reverted_at, created_at")
    .order("created_at", { ascending: false })
    .limit(20);
  if (result.error) {
    return NextResponse.json({
      error: result.error.message.includes("student_import_batches")
        ? "Student Import history will be available after migration 0018 is applied."
        : result.error.message,
    }, { status: 400 });
  }
  return NextResponse.json({ batches: result.data ?? [] });
}
