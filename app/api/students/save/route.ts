import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  ValidationError,
  databaseFieldErrors,
  friendlyDatabaseError,
  integerOrNull,
  normaliseNationality,
  numberOrNull,
  optionalUuid,
  requiredUuid,
  textOrNull,
  throwFieldErrors,
  uuidOrNull,
  validationResponse,
} from "@/lib/student-operations-validation";

type StudentPayload = {
  id?: string;
  entity_id?: string;
  full_name?: string;
  preferred_name?: string;
  identity_document_type?: string;
  identity_number_protected?: string;
  nationality?: string;
  date_of_birth?: string;
  gender?: string;
  phone?: string;
  email?: string;
  address?: string;
  emergency_contact?: Record<string, unknown>;
  previous_school?: string;
  education_level?: string;
  qualification_details?: string;
  education_institution?: string;
  field_of_study?: string;
  graduation_year?: string | number;
  home_branch_id?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
  height_cm?: string | number;
  weight_kg?: string | number;
  uniform_size?: string;
  measurement_date?: string;
  measurement_remarks?: string;
  lifecycle_status?: string;
  save_action?: "draft" | "continue";
  remarks?: string;
};

const STUDENT_STATUSES = ["draft", "active", "incomplete", "inactive", "archived"];

function missingRecommendedFields(body: StudentPayload) {
  const checks: Array<[unknown, string]> = [
    [body.preferred_name, "Preferred name"],
    [body.identity_number_protected, "IC/passport number"],
    [body.date_of_birth, "Date of birth"],
    [body.gender, "Gender"],
    [body.phone, "Phone"],
    [body.email, "Email"],
    [body.education_level || body.qualification_details, "Education"],
    [body.address, "Address"],
    [body.height_cm, "Height"],
    [body.weight_kg, "Weight"],
    [body.uniform_size, "Uniform size"],
  ];
  return checks.filter(([value]) => textOrNull(value) === null).map(([, label]) => label);
}

export async function POST(request: Request) {
  const db = await createClient();
  const { data: userData } = await db.auth.getUser();
  const user = userData.user;

  if (!user) {
    return NextResponse.json({ error: "Please log in first.", field_errors: {} }, { status: 401 });
  }

  try {
    const body = (await request.json()) as StudentPayload;
    const fullName = textOrNull(body.full_name);
    const identityType = textOrNull(body.identity_document_type);
    const identityNumber = textOrNull(body.identity_number_protected);
    const gender = textOrNull(body.gender);
    const graduationYear = integerOrNull(body.graduation_year);
    const heightCm = numberOrNull(body.height_cm);
    const weightKg = numberOrNull(body.weight_kg);
    const email = textOrNull(body.email);
    const requestedStatus = textOrNull(body.lifecycle_status) || "draft";
    const fieldErrors: Record<string, string> = {};

    if (!uuidOrNull(body.entity_id)) fieldErrors.entity_id = "Please select an entity.";
    if (!uuidOrNull(body.home_branch_id)) fieldErrors.home_branch_id = "Please select a home branch.";
    if (textOrNull(body.id) && !uuidOrNull(body.id)) fieldErrors.id = "Please open a valid student record.";
    if (!fullName) fieldErrors.full_name = "Please enter the student's full name.";
    if (identityType && !["ic", "passport", "other"].includes(identityType)) {
      fieldErrors.identity_document_type = "Please select a valid IC or passport type.";
    }
    if (identityNumber && !identityType) {
      fieldErrors.identity_document_type = "Please select the document type for this number.";
    }
    if (gender && !["female", "male"].includes(gender)) {
      fieldErrors.gender = "Please select Female or Male.";
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      fieldErrors.email = "Please enter a valid email address.";
    }
    if (
      body.graduation_year !== ""
      && body.graduation_year != null
      && (graduationYear === null || graduationYear < 1900 || graduationYear > 2100)
    ) {
      fieldErrors.graduation_year = "Please enter a valid completion or graduation year.";
    }
    if (heightCm !== null && heightCm <= 0) fieldErrors.height_cm = "Height must be greater than zero.";
    if (weightKg !== null && weightKg <= 0) fieldErrors.weight_kg = "Weight must be greater than zero.";
    if (!STUDENT_STATUSES.includes(requestedStatus)) {
      fieldErrors.lifecycle_status = "Please select a valid record status.";
    }
    throwFieldErrors(fieldErrors);

    const entityId = requiredUuid(body.entity_id, "Please select an entity.", "entity_id");
    const homeBranchId = requiredUuid(body.home_branch_id, "Please select a home branch.", "home_branch_id");
    const existingId = optionalUuid(body.id, "Please open a valid student record.", "id");

    const [entityRes, branchRes] = await Promise.all([
      db.from("entities").select("id, short_code").eq("id", entityId).maybeSingle(),
      db.from("branches").select("id, entity_id, branch_code").eq("id", homeBranchId).maybeSingle(),
    ]);
    const relationshipErrors: Record<string, string> = {};
    if (entityRes.error || !entityRes.data) relationshipErrors.entity_id = "Please select a valid entity.";
    if (branchRes.error || !branchRes.data || branchRes.data.entity_id !== entityId) {
      relationshipErrors.home_branch_id = "Please select a valid home branch.";
    }
    if (
      entityRes.data?.short_code === "IETA"
      && branchRes.data
      && !["KL", "PG"].includes(branchRes.data.branch_code)
    ) {
      relationshipErrors.home_branch_id = "Please select KL or Penang for an IETA student.";
    }
    throwFieldErrors(relationshipErrors);

    const missingFields = missingRecommendedFields(body);
    const lifecycleStatus = body.save_action === "draft"
      ? "draft"
      : ["inactive", "archived"].includes(requestedStatus)
        ? requestedStatus
        : missingFields.length
          ? "incomplete"
          : "active";

    const duplicateRes = await db.rpc("find_student_duplicate_warnings", {
      p_student_id: existingId,
      p_entity_id: entityId,
      p_full_name: fullName,
      p_identity_document_type: identityType,
      p_identity_number: identityNumber,
      p_phone: textOrNull(body.phone),
      p_email: email,
      p_date_of_birth: textOrNull(body.date_of_birth),
    });
    if (duplicateRes.error) console.error("Student duplicate check failed", duplicateRes.error);

    const id = existingId || crypto.randomUUID();
    let studentNumber: string | null = null;

    if (!existingId) {
      const numberRes = await db.rpc("generate_student_number", { p_entity_id: entityId });
      if (numberRes.error || !numberRes.data) {
        console.error("Student number generation failed", numberRes.error);
        return NextResponse.json({
          error: "The student number could not be generated.",
          field_errors: { entity_id: "Please confirm the entity and try again." },
        }, { status: 403 });
      }
      studentNumber = String(numberRes.data);
    }

    const payload: Record<string, unknown> = {
      id,
      entity_id: entityId,
      full_name: fullName,
      preferred_name: textOrNull(body.preferred_name),
      identity_document_type: identityType,
      nationality: normaliseNationality(body.nationality),
      date_of_birth: textOrNull(body.date_of_birth),
      gender,
      phone: textOrNull(body.phone),
      email,
      address: textOrNull(body.address),
      city: textOrNull(body.city),
      state: textOrNull(body.state),
      postcode: textOrNull(body.postcode),
      country: textOrNull(body.country),
      emergency_contact: body.emergency_contact || {},
      previous_school: textOrNull(body.previous_school),
      education_level: textOrNull(body.education_level),
      qualification_details: textOrNull(body.qualification_details),
      education_institution: textOrNull(body.education_institution),
      field_of_study: textOrNull(body.field_of_study),
      graduation_year: graduationYear,
      home_branch_id: homeBranchId,
      height_cm: heightCm,
      weight_kg: weightKg,
      uniform_size: textOrNull(body.uniform_size),
      measurement_date: textOrNull(body.measurement_date),
      measurement_remarks: textOrNull(body.measurement_remarks),
      lifecycle_status: lifecycleStatus,
      active_status: !["inactive", "archived"].includes(lifecycleStatus),
      missing_recommended_fields: missingFields,
      remarks: textOrNull(body.remarks),
      updated_by: user.id,
    };

    if (studentNumber) payload.student_number = studentNumber;
    if (!existingId) payload.created_by = user.id;
    if (identityNumber) payload.identity_number_protected = identityNumber;

    const saveRes = existingId
      ? await db.from("students").update(payload).eq("id", id)
      : await db.from("students").insert(payload);

    if (saveRes.error) {
      const fieldErrors = databaseFieldErrors("student", saveRes.error);
      return NextResponse.json({
        error: friendlyDatabaseError("student", saveRes.error),
        field_errors: fieldErrors,
      }, { status: 400 });
    }

    return NextResponse.json({
      id,
      student_number: studentNumber,
      lifecycle_status: lifecycleStatus,
      missing_recommended_fields: missingFields,
      duplicate_warnings: duplicateRes.data || [],
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      return NextResponse.json(validationResponse(error), { status: 400 });
    }
    console.error("Unexpected student save error", error);
    return NextResponse.json({
      error: friendlyDatabaseError("student", null),
      field_errors: {},
    }, { status: 500 });
  }
}
