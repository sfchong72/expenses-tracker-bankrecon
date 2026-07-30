import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  ValidationError,
  friendlyDatabaseError,
  integerOrNull,
  normaliseNationality,
  numberOrNull,
  optionalUuid,
  requiredUuid,
  textOrNull,
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
  active_status?: boolean;
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
    const body = (await request.json()) as StudentPayload;
    const entityId = requiredUuid(body.entity_id, "Please select an entity.");
    const existingId = optionalUuid(body.id, "Please open a valid student record.");
    const homeBranchId = optionalUuid(body.home_branch_id, "Please select a valid branch.");
    const fullName = textOrNull(body.full_name);
    const gender = textOrNull(body.gender);
    const graduationYear = integerOrNull(body.graduation_year);
    const heightCm = numberOrNull(body.height_cm);
    const weightKg = numberOrNull(body.weight_kg);
    const address = textOrNull(body.address);
    const city = textOrNull(body.city);
    const state = textOrNull(body.state);
    const postcode = textOrNull(body.postcode);
    const country = textOrNull(body.country) || "Malaysia";

    if (!fullName) throw new ValidationError("Please enter the student's full name.");
    if (!address) throw new ValidationError("Please enter the student's address.");
    if (!city) throw new ValidationError("Please enter the student's city.");
    if (!state) throw new ValidationError("Please select or enter the student's state.");
    if (!postcode) throw new ValidationError("Please enter the student's postcode.");
    if (gender && !["female", "male"].includes(gender)) {
      throw new ValidationError("Please select Female or Male.");
    }
    if (body.graduation_year !== "" && body.graduation_year != null && (graduationYear === null || graduationYear < 1900 || graduationYear > 2100)) {
      throw new ValidationError("Please enter a valid completion or graduation year.");
    }
    if (heightCm !== null && heightCm <= 0) throw new ValidationError("Height must be greater than zero.");
    if (weightKg !== null && weightKg <= 0) throw new ValidationError("Weight must be greater than zero.");

    const entityRes = await db.from("entities").select("id, short_code").eq("id", entityId).maybeSingle();
    if (entityRes.error || !entityRes.data) throw new ValidationError("Please select a valid entity.");

    if (homeBranchId) {
      const branchRes = await db.from("branches").select("id, entity_id, branch_code").eq("id", homeBranchId).maybeSingle();
      if (branchRes.error || !branchRes.data || branchRes.data.entity_id !== entityId) {
        throw new ValidationError("Please select a valid branch.");
      }
      if (entityRes.data.short_code === "IETA" && !["KL", "PG"].includes(branchRes.data.branch_code)) {
        throw new ValidationError("Please select KL or Penang for an IETA student.");
      }
    }

    const duplicateRes = await db.rpc("find_student_duplicate_warnings", {
      p_student_id: existingId,
      p_entity_id: entityId,
      p_full_name: fullName,
      p_identity_document_type: textOrNull(body.identity_document_type),
      p_identity_number: textOrNull(body.identity_number_protected),
      p_phone: textOrNull(body.phone),
      p_email: textOrNull(body.email),
      p_date_of_birth: textOrNull(body.date_of_birth),
    });

    const id = existingId || crypto.randomUUID();
    let studentNumber: string | null = null;

    if (!existingId) {
      const numberRes = await db.rpc("generate_student_number", { p_entity_id: entityId });
      if (numberRes.error || !numberRes.data) {
        console.error("Student number generation failed", numberRes.error);
        return NextResponse.json({ error: "Could not generate the student number. Please try again." }, { status: 403 });
      }
      studentNumber = String(numberRes.data);
    }

    const payload: Record<string, unknown> = {
      id,
      entity_id: entityId,
      full_name: fullName,
      preferred_name: textOrNull(body.preferred_name),
      identity_document_type: textOrNull(body.identity_document_type),
      nationality: normaliseNationality(body.nationality),
      date_of_birth: textOrNull(body.date_of_birth),
      gender,
      phone: textOrNull(body.phone),
      email: textOrNull(body.email),
      address,
      city,
      state,
      postcode,
      country,
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
      active_status: body.active_status ?? true,
      remarks: textOrNull(body.remarks),
      updated_by: user.id,
    };

    if (studentNumber) payload.student_number = studentNumber;
    if (!existingId) payload.created_by = user.id;
    if (textOrNull(body.identity_number_protected)) {
      payload.identity_number_protected = textOrNull(body.identity_number_protected);
    }

    const saveRes = existingId
      ? await db.from("students").update(payload).eq("id", id)
      : await db.from("students").insert(payload);

    if (saveRes.error) {
      return NextResponse.json({ error: friendlyDatabaseError("student", saveRes.error) }, { status: 400 });
    }

    return NextResponse.json({
      id,
      student_number: studentNumber,
      duplicate_warnings: duplicateRes.data || [],
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Unexpected student save error", error);
    return NextResponse.json({ error: friendlyDatabaseError("student", null) }, { status: 500 });
  }
}
