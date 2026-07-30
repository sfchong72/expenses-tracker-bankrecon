import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type EnrolmentPayload = {
  id?: string;
  student_id?: string;
  programme_id?: string;
  intake_id?: string;
  entity_id?: string;
  branch_id?: string;
  counsellor_user_id?: string;
  enrolment_date?: string;
  expected_completion_date?: string;
  status?: string;
  referral_source?: string;
  remarks?: string;
};

const textOrNull = (value: unknown) => {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
};

export async function POST(request: Request) {
  const db = await createClient();
  const { data: userData } = await db.auth.getUser();
  const user = userData.user;

  if (!user) {
    return NextResponse.json({ error: "Please log in first." }, { status: 401 });
  }

  const body = (await request.json()) as EnrolmentPayload;
  const entityId = textOrNull(body.entity_id);
  const branchId = textOrNull(body.branch_id);
  const intakeId = textOrNull(body.intake_id);

  if (!entityId || !branchId || !intakeId || !textOrNull(body.student_id) || !textOrNull(body.programme_id)) {
    return NextResponse.json({ error: "Student, programme, intake, entity and branch are required." }, { status: 400 });
  }

  const id = textOrNull(body.id) || crypto.randomUUID();
  let enrolmentNumber: string | null = null;

  if (!body.id) {
    const numberRes = await db.rpc("generate_enrolment_number", {
      p_entity_id: entityId,
      p_branch_id: branchId,
      p_intake_id: intakeId,
    });
    if (numberRes.error || !numberRes.data) {
      return NextResponse.json({ error: numberRes.error?.message || "Could not generate the enrolment number." }, { status: 403 });
    }
    enrolmentNumber = String(numberRes.data);
  }

  const payload: Record<string, unknown> = {
    id,
    student_id: textOrNull(body.student_id),
    programme_id: textOrNull(body.programme_id),
    intake_id: intakeId,
    entity_id: entityId,
    branch_id: branchId,
    counsellor_user_id: textOrNull(body.counsellor_user_id),
    enrolment_date: textOrNull(body.enrolment_date),
    expected_completion_date: textOrNull(body.expected_completion_date),
    status: textOrNull(body.status) || "enrolled",
    referral_source: textOrNull(body.referral_source),
    remarks: textOrNull(body.remarks),
    updated_by: user.id,
  };

  if (enrolmentNumber) payload.enrolment_number = enrolmentNumber;
  if (!body.id) payload.created_by = user.id;

  const saveRes = body.id
    ? await db.from("enrolments").update(payload).eq("id", id)
    : await db.from("enrolments").insert(payload);

  if (saveRes.error) {
    return NextResponse.json({ error: saveRes.error.message }, { status: 400 });
  }

  return NextResponse.json({ id, enrolment_number: enrolmentNumber });
}
