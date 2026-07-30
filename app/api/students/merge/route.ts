import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type MergePayload = {
  source_student_id?: string;
  target_student_id?: string;
  reason?: string;
};

export async function POST(request: Request) {
  const db = await createClient();
  const { data: userData } = await db.auth.getUser();

  if (!userData.user) {
    return NextResponse.json({ error: "Please log in first." }, { status: 401 });
  }

  const body = (await request.json()) as MergePayload;
  const source = body.source_student_id?.trim();
  const target = body.target_student_id?.trim();
  const reason = body.reason?.trim();

  if (!source || !target || !reason) {
    return NextResponse.json({ error: "Source student, target student and reason are required." }, { status: 400 });
  }

  const result = await db.rpc("merge_students", {
    p_source_student_id: source,
    p_target_student_id: target,
    p_reason: reason,
  });

  if (result.error) {
    return NextResponse.json({ error: result.error.message }, { status: 400 });
  }

  return NextResponse.json({ result: result.data });
}
