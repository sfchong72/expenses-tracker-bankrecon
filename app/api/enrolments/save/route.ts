import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  ValidationError,
  databaseFieldErrors,
  friendlyDatabaseError,
  numberOrNull,
  optionalUuid,
  requiredUuid,
  textOrNull,
  throwFieldErrors,
  uuidOrNull,
  validationResponse,
} from "@/lib/student-operations-validation";

type EnrolmentPayload = {
  id?: string;
  student_id?: string;
  programme_id?: string;
  intake_id?: string;
  branch_id?: string;
  counsellor_user_id?: string;
  counsellor_name_snapshot?: string;
  enrolment_date?: string;
  expected_completion_date?: string;
  status?: string;
  referral_source?: string;
  remarks?: string;
  registration_fee_amount?: string | number;
  registration_fee_paid_amount?: string | number;
  registration_payment_date?: string;
  registration_payment_method?: string;
  registration_payment_reference?: string;
  registration_payment_remarks?: string;
  registration_payment_status?: string;
  save_action?: "draft" | "continue";
};

const ENROLMENT_STATUSES = ["draft", "applied", "enrolled", "active", "deferred", "transferred", "completed", "withdrawn", "cancelled", "inactive"];
const REGISTRATION_STATUSES = ["not_paid", "partially_paid", "paid", "waived", "pending_confirmation"];

export async function POST(request: Request) {
  const db = await createClient();
  const { data: userData } = await db.auth.getUser();
  const user = userData.user;

  if (!user) {
    return NextResponse.json({ error: "Please log in first.", field_errors: {} }, { status: 401 });
  }

  try {
    const body = (await request.json()) as EnrolmentPayload;
    const enrolmentDate = textOrNull(body.enrolment_date);
    const submittedStatus = textOrNull(body.status) || "enrolled";
    const status = body.save_action === "draft" ? "draft" : submittedStatus === "draft" ? "enrolled" : submittedStatus;
    const registrationFeeAmount = numberOrNull(body.registration_fee_amount);
    const registrationPaidAmount = numberOrNull(body.registration_fee_paid_amount);
    const paymentDate = textOrNull(body.registration_payment_date);
    const submittedRegistrationStatus = textOrNull(body.registration_payment_status) || "not_paid";
    const fieldErrors: Record<string, string> = {};

    if (!uuidOrNull(body.student_id)) fieldErrors.student_id = "Please select a student.";
    if (!uuidOrNull(body.programme_id)) fieldErrors.programme_id = "Please select a programme.";
    if (!uuidOrNull(body.intake_id)) fieldErrors.intake_id = "Please select an intake.";
    if (!uuidOrNull(body.branch_id)) fieldErrors.branch_id = "Please select a branch.";
    if (textOrNull(body.id) && !uuidOrNull(body.id)) fieldErrors.id = "Please open a valid enrolment record.";
    if (textOrNull(body.counsellor_user_id) && !uuidOrNull(body.counsellor_user_id)) {
      fieldErrors.counsellor_user_id = "Please select a valid counsellor.";
    }
    if (!enrolmentDate) fieldErrors.enrolment_date = "Please select an enrolment date.";
    if (!ENROLMENT_STATUSES.includes(status)) fieldErrors.status = "Please select a valid enrolment status.";
    if (!REGISTRATION_STATUSES.includes(submittedRegistrationStatus)) {
      fieldErrors.registration_payment_status = "Please select a valid registration payment status.";
    }
    if (
      body.registration_fee_amount !== ""
      && body.registration_fee_amount != null
      && (registrationFeeAmount === null || registrationFeeAmount < 0)
    ) {
      fieldErrors.registration_fee_amount = "Registration fee amount must be zero or more.";
    }
    if (
      body.registration_fee_paid_amount !== ""
      && body.registration_fee_paid_amount != null
      && (registrationPaidAmount === null || registrationPaidAmount < 0)
    ) {
      fieldErrors.registration_fee_paid_amount = "Registration fee paid amount must be zero or more.";
    }
    if (registrationPaidAmount !== null && registrationFeeAmount === null) {
      fieldErrors.registration_fee_amount = "Enter the registration fee amount before recording payment.";
    }
    if (
      registrationFeeAmount !== null
      && registrationPaidAmount !== null
      && registrationPaidAmount > registrationFeeAmount
    ) {
      fieldErrors.registration_fee_paid_amount = "Paid amount cannot exceed the registration fee amount.";
    }
    if (registrationPaidAmount !== null && registrationPaidAmount > 0 && !paymentDate) {
      fieldErrors.registration_payment_date = "Please select the registration payment date.";
    }
    throwFieldErrors(fieldErrors);

    const existingId = optionalUuid(body.id, "Please open a valid enrolment record.", "id");
    const studentId = requiredUuid(body.student_id, "Please select a student.", "student_id");
    const programmeId = requiredUuid(body.programme_id, "Please select a programme.", "programme_id");
    const intakeId = requiredUuid(body.intake_id, "Please select an intake.", "intake_id");
    const submittedBranchId = requiredUuid(body.branch_id, "Please select a branch.", "branch_id");
    const counsellorId = optionalUuid(body.counsellor_user_id, "Please select a valid counsellor.", "counsellor_user_id");

    const [intakeRes, studentRes, counsellorRes] = await Promise.all([
      db.from("programme_intakes").select("id, programme_id, entity_id, branch_id, expected_completion_date").eq("id", intakeId).maybeSingle(),
      db.from("students").select("id, entity_id").eq("id", studentId).maybeSingle(),
      counsellorId
        ? db.from("app_profiles").select("id, display_name, role").eq("id", counsellorId).eq("active_status", true).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

    const relationshipErrors: Record<string, string> = {};
    if (intakeRes.error || !intakeRes.data) relationshipErrors.intake_id = "Please select a valid intake.";
    if (intakeRes.data && intakeRes.data.programme_id !== programmeId) {
      relationshipErrors.intake_id = "Please select an intake for the chosen programme.";
    }
    if (intakeRes.data && intakeRes.data.branch_id !== submittedBranchId) {
      relationshipErrors.branch_id = "The branch must match the selected intake.";
    }
    if (studentRes.error || !studentRes.data) relationshipErrors.student_id = "Please select a valid student.";
    if (studentRes.data && intakeRes.data && studentRes.data.entity_id !== intakeRes.data.entity_id) {
      relationshipErrors.student_id = "The student and intake must belong to the same entity.";
    }
    if (counsellorId && (counsellorRes.error || !counsellorRes.data)) {
      relationshipErrors.counsellor_user_id = "Please select a valid counsellor profile.";
    }
    throwFieldErrors(relationshipErrors);
    const intake = intakeRes.data!;

    const entityId = intake.entity_id;
    const branchId = intake.branch_id;
    const id = existingId || crypto.randomUUID();
    const counsellorName = textOrNull(body.counsellor_name_snapshot) || counsellorRes.data?.display_name || null;
    const paidAmount = registrationPaidAmount ?? 0;
    const registrationStatus = ["waived", "pending_confirmation"].includes(submittedRegistrationStatus)
      ? submittedRegistrationStatus
      : registrationFeeAmount === null || paidAmount === 0
        ? "not_paid"
        : paidAmount >= registrationFeeAmount
          ? "paid"
          : "partially_paid";

    const sharedPayload = {
      p_student_id: studentId,
      p_programme_id: programmeId,
      p_intake_id: intakeId,
      p_entity_id: entityId,
      p_branch_id: branchId,
      p_counsellor_user_id: counsellorId,
      p_counsellor_name_snapshot: counsellorName,
      p_enrolment_date: enrolmentDate,
      p_expected_completion_date: textOrNull(body.expected_completion_date) || intake.expected_completion_date,
      p_status: status,
      p_referral_source: textOrNull(body.referral_source),
      p_remarks: textOrNull(body.remarks),
      p_registration_fee_amount: registrationFeeAmount,
      p_registration_fee_paid_amount: registrationPaidAmount,
      p_registration_payment_date: paymentDate,
      p_registration_payment_method: textOrNull(body.registration_payment_method),
      p_registration_payment_reference: textOrNull(body.registration_payment_reference),
      p_registration_payment_remarks: textOrNull(body.registration_payment_remarks),
      p_registration_payment_status: registrationStatus,
    };

    if (!existingId) {
      const createRes = await db.rpc("create_enrolment_with_number", {
        p_enrolment_id: id,
        ...sharedPayload,
      });
      if (createRes.error || !createRes.data?.length) {
        console.error("Enrolment creation failed", createRes.error);
        return NextResponse.json({
          error: friendlyDatabaseError("enrolment", createRes.error),
          field_errors: databaseFieldErrors("enrolment", createRes.error),
        }, { status: 400 });
      }
      return NextResponse.json({
        id,
        enrolment_number: createRes.data[0].enrolment_number,
        registration_payment_status: registrationStatus,
      });
    }

    const updatePayload = {
      student_id: sharedPayload.p_student_id,
      programme_id: sharedPayload.p_programme_id,
      intake_id: sharedPayload.p_intake_id,
      entity_id: sharedPayload.p_entity_id,
      branch_id: sharedPayload.p_branch_id,
      counsellor_user_id: sharedPayload.p_counsellor_user_id,
      counsellor_name_snapshot: sharedPayload.p_counsellor_name_snapshot,
      enrolment_date: sharedPayload.p_enrolment_date,
      expected_completion_date: sharedPayload.p_expected_completion_date,
      status: sharedPayload.p_status,
      referral_source: sharedPayload.p_referral_source,
      remarks: sharedPayload.p_remarks,
      registration_fee_amount: sharedPayload.p_registration_fee_amount,
      registration_fee_paid_amount: sharedPayload.p_registration_fee_paid_amount,
      registration_payment_date: sharedPayload.p_registration_payment_date,
      registration_payment_method: sharedPayload.p_registration_payment_method,
      registration_payment_reference: sharedPayload.p_registration_payment_reference,
      registration_payment_remarks: sharedPayload.p_registration_payment_remarks,
      registration_payment_status: sharedPayload.p_registration_payment_status,
      updated_by: user.id,
    };
    const saveRes = await db.from("enrolments").update(updatePayload).eq("id", existingId);
    if (saveRes.error) {
      return NextResponse.json({
        error: friendlyDatabaseError("enrolment", saveRes.error),
        field_errors: databaseFieldErrors("enrolment", saveRes.error),
      }, { status: 400 });
    }

    return NextResponse.json({ id, enrolment_number: null, registration_payment_status: registrationStatus });
  } catch (error) {
    if (error instanceof ValidationError) {
      return NextResponse.json(validationResponse(error), { status: 400 });
    }
    console.error("Unexpected enrolment save error", error);
    return NextResponse.json({
      error: friendlyDatabaseError("enrolment", null),
      field_errors: {},
    }, { status: 500 });
  }
}
