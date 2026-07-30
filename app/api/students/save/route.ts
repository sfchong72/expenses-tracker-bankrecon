import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

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
  home_branch_id?: string;
  active_status?: boolean;
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

  const body = (await request.json()) as StudentPayload;
  const entityId = textOrNull(body.entity_id);
  const fullName = textOrNull(body.full_name);

  if (!entityId || !fullName) {
    return NextResponse.json({ error: "Entity and full name are required." }, { status: 400 });
  }

  const duplicateRes = await db.rpc("find_student_duplicate_warnings", {
    p_student_id: textOrNull(body.id),
    p_entity_id: entityId,
    p_full_name: fullName,
    p_identity_document_type: textOrNull(body.identity_document_type),
    p_identity_number: textOrNull(body.identity_number_protected),
    p_phone: textOrNull(body.phone),
    p_email: textOrNull(body.email),
    p_date_of_birth: textOrNull(body.date_of_birth),
  });

  const id = textOrNull(body.id) || crypto.randomUUID();
  let studentNumber: string | null = null;

  if (!body.id) {
    const numberRes = await db.rpc("generate_student_number", { p_entity_id: entityId });
    if (numberRes.error || !numberRes.data) {
      return NextResponse.json({ error: numberRes.error?.message || "Could not generate the student number." }, { status: 403 });
    }
    studentNumber = String(numberRes.data);
  }

  const payload: Record<string, unknown> = {
    id,
    entity_id: entityId,
    full_name: fullName,
    preferred_name: textOrNull(body.preferred_name),
    identity_document_type: textOrNull(body.identity_document_type),
    nationality: textOrNull(body.nationality),
    date_of_birth: textOrNull(body.date_of_birth),
    gender: textOrNull(body.gender),
    phone: textOrNull(body.phone),
    email: textOrNull(body.email),
    address: textOrNull(body.address),
    emergency_contact: body.emergency_contact || {},
    previous_school: textOrNull(body.previous_school),
    education_level: textOrNull(body.education_level),
    home_branch_id: textOrNull(body.home_branch_id),
    active_status: body.active_status ?? true,
    remarks: textOrNull(body.remarks),
    updated_by: user.id,
  };

  if (studentNumber) payload.student_number = studentNumber;
  if (!body.id) payload.created_by = user.id;
  if (textOrNull(body.identity_number_protected)) {
    payload.identity_number_protected = textOrNull(body.identity_number_protected);
  }

  const saveRes = body.id
    ? await db.from("students").update(payload).eq("id", id)
    : await db.from("students").insert(payload);

  if (saveRes.error) {
    return NextResponse.json({ error: saveRes.error.message }, { status: 400 });
  }

  return NextResponse.json({
    id,
    student_number: studentNumber,
    duplicate_warnings: duplicateRes.data || [],
  });
}
