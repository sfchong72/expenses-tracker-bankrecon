import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  ValidationError,
  friendlyDatabaseError,
  optionalUuid,
  requiredUuid,
  textOrNull,
} from "@/lib/student-operations-validation";

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

export async function POST(request: Request) {
  const db = await createClient();
  const { data: userData } = await db.auth.getUser();
  const user = userData.user;

  if (!user) {
    return NextResponse.json({ error: "Please log in first." }, { status: 401 });
  }

  try {
    const body = (await request.json()) as EnrolmentPayload;
    const existingId = optionalUuid(body.id, "Please open a valid enrolment record.");
    const studentId = requiredUuid(body.student_id, "Please select a student.");
    const programmeId = requiredUuid(body.programme_id, "Please select a programme.");
    const intakeId = requiredUuid(body.intake_id, "Please select an intake.");
    const counsellorId = optionalUuid(body.counsellor_user_id, "Please select a valid counsellor.");

    const [intakeRes, studentRes] = await Promise.all([
      db.from("programme_intakes").select("id, programme_id, entity_id, branch_id, expected_completion_date").eq("id", intakeId).maybeSingle(),
      db.from("students").select("id, entity_id").eq("id", studentId).maybeSingle(),
    ]);

    if (intakeRes.error || !intakeRes.data) throw new ValidationError("Please select a valid intake.");
    if (intakeRes.data.programme_id !== programmeId) throw new ValidationError("Please select an intake for the chosen programme.");
    if (studentRes.error || !studentRes.data) throw new ValidationError("Please select a valid student.");
    if (studentRes.data.entity_id !== intakeRes.data.entity_id) {
      throw new ValidationError("The student and intake must belong to the same entity.");
    }

    const entityId = intakeRes.data.entity_id;
    const branchId = intakeRes.data.branch_id;
    const id = existingId || crypto.randomUUID();
    let enrolmentNumber: string | null = null;

    if (!existingId) {
      const numberRes = await db.rpc("generate_enrolment_number", {
        p_entity_id: entityId,
        p_branch_id: branchId,
        p_intake_id: intakeId,
      });
      if (numberRes.error || !numberRes.data) {
        console.error("Enrolment number generation failed", numberRes.error);
        return NextResponse.json({ error: "Could not generate the enrolment number. Please try again." }, { status: 403 });
      }
      enrolmentNumber = String(numberRes.data);
    }

    const payload: Record<string, unknown> = {
      id,
      student_id: studentId,
      programme_id: programmeId,
      intake_id: intakeId,
      entity_id: entityId,
      branch_id: branchId,
      counsellor_user_id: counsellorId,
      enrolment_date: textOrNull(body.enrolment_date),
      expected_completion_date: textOrNull(body.expected_completion_date) || intakeRes.data.expected_completion_date,
      status: textOrNull(body.status) || "enrolled",
      referral_source: textOrNull(body.referral_source),
      remarks: textOrNull(body.remarks),
      updated_by: user.id,
    };

    if (enrolmentNumber) payload.enrolment_number = enrolmentNumber;
    if (!existingId) payload.created_by = user.id;

    const saveRes = existingId
      ? await db.from("enrolments").update(payload).eq("id", id)
      : await db.from("enrolments").insert(payload);

    if (saveRes.error) {
      return NextResponse.json({ error: friendlyDatabaseError("enrolment", saveRes.error) }, { status: 400 });
    }

    return NextResponse.json({ id, enrolment_number: enrolmentNumber });
  } catch (error) {
    if (error instanceof ValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Unexpected enrolment save error", error);
    return NextResponse.json({ error: friendlyDatabaseError("enrolment", null) }, { status: 500 });
  }
}
