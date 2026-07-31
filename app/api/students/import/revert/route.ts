import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const db = await createClient();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Please log in first." }, { status: 401 });

  const body = await request.json() as { batchId?: string };
  if (!body.batchId) return NextResponse.json({ error: "Import batch is required." }, { status: 400 });

  const result = await db.rpc("revert_student_import_batch", { p_batch_id: body.batchId });
  if (result.error) {
    console.error("Student import revert failed", result.error);
    return NextResponse.json({ error: friendlyRevertError(result.error.message) }, { status: 400 });
  }
  return NextResponse.json({ reverted: result.data });
}

function friendlyRevertError(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes("only completed")) return "Only a completed import can be reverted.";
  if (lower.includes("not authorised") || lower.includes("permission")) return "You do not have permission to revert this import.";
  if (lower.includes("not found")) return "The import batch was not found.";
  return "The import could not be reverted. No existing student activity was removed.";
}
