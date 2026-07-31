import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  ValidationError,
  databaseFieldErrors,
  fieldValidation,
  friendlyDatabaseError,
  integerOrNull,
  optionalUuid,
  requiredUuid,
  textOrNull,
  throwFieldErrors,
  uuidOrNull,
  validationResponse,
} from "@/lib/student-operations-validation";

type IntakePayload = {
  id?: string;
  programme_id?: string;
  branch_id?: string;
  intake_code?: string;
  intake_name?: string;
  start_date?: string;
  original_expected_completion_date?: string;
  expected_completion_date?: string;
  application_closing_date?: string;
  actual_completion_date?: string;
  capacity?: string | number;
  status?: string;
  completion_timing?: string;
  completion_reason?: string;
  save_action?: "draft" | "continue";
  remarks?: string;
};

const OPERATIONAL_STATUSES = ["planning", "open", "closed", "in_progress", "completed", "cancelled", "inactive"];
const COMPLETION_TIMINGS = ["not_applicable", "on_time", "prolonged", "shortened", "partially_completed", "discontinued"];

export async function POST(request: Request) {
  const db = await createClient();
  const { data: userData } = await db.auth.getUser();
  const user = userData.user;

  if (!user) return NextResponse.json({ error: "Please log in first.", field_errors: {} }, { status: 401 });

  try {
    const body = (await request.json()) as IntakePayload;
    const code = textOrNull(body.intake_code)?.toUpperCase();
    const startDate = textOrNull(body.start_date);
    const submittedOriginalExpectedDate = textOrNull(body.original_expected_completion_date);
    const expectedDate = textOrNull(body.expected_completion_date);
    const closingDate = textOrNull(body.application_closing_date);
    const actualDate = textOrNull(body.actual_completion_date);
    const capacity = integerOrNull(body.capacity);
    const submittedStatus = textOrNull(body.status) || "planning";
    const status = body.save_action === "draft" ? "planning" : submittedStatus;
    const completionTiming = textOrNull(body.completion_timing) || "not_applicable";
    const completionReason = textOrNull(body.completion_reason);
    const fieldErrors: Record<string, string> = {};

    if (!uuidOrNull(body.programme_id)) fieldErrors.programme_id = "Please select a programme.";
    if (!uuidOrNull(body.branch_id)) fieldErrors.branch_id = "Please select a branch.";
    if (textOrNull(body.id) && !uuidOrNull(body.id)) fieldErrors.id = "Please open a valid intake record.";
    if (!code) fieldErrors.intake_code = "Please enter an intake code.";
    if (!OPERATIONAL_STATUSES.includes(status)) fieldErrors.status = "Please select a valid operational status.";
    if (!COMPLETION_TIMINGS.includes(completionTiming)) {
      fieldErrors.completion_timing = "Please select a valid completion timing.";
    }
    if (status !== "planning" && !startDate) {
      fieldErrors.start_date = "Please select a start date before activating this intake.";
    }
    if (!startDate && (expectedDate || closingDate || actualDate)) {
      fieldErrors.start_date = "Please select a start date before adding scheduling dates.";
    }
    if (startDate && expectedDate && expectedDate < startDate) {
      fieldErrors.expected_completion_date = "Current expected completion date cannot be before the start date.";
    }
    if (startDate && closingDate && closingDate > startDate) {
      fieldErrors.application_closing_date = "Application closing date cannot be after the start date.";
    }
    if (startDate && actualDate && actualDate < startDate) {
      fieldErrors.actual_completion_date = "Actual completion date cannot be before the start date.";
    }
    if (body.capacity !== "" && body.capacity != null && (capacity === null || capacity < 0)) {
      fieldErrors.capacity = "Capacity must be a whole number of zero or more.";
    }
    throwFieldErrors(fieldErrors);

    const existingId = optionalUuid(body.id, "Please open a valid intake record.", "id");
    const programmeId = requiredUuid(body.programme_id, "Please select a programme.", "programme_id");
    const branchId = requiredUuid(body.branch_id, "Please select a branch.", "branch_id");

    const [programmeRes, branchRes] = await Promise.all([
      db.from("programmes").select("id, entity_id, programme_code").eq("id", programmeId).maybeSingle(),
      db.from("branches").select("id, entity_id, branch_code").eq("id", branchId).maybeSingle(),
    ]);
    const relationshipErrors: Record<string, string> = {};
    if (programmeRes.error || !programmeRes.data) relationshipErrors.programme_id = "Please select a valid programme.";
    if (
      branchRes.error
      || !branchRes.data
      || (programmeRes.data && branchRes.data.entity_id !== programmeRes.data.entity_id)
    ) {
      relationshipErrors.branch_id = "Please select a valid branch.";
    }
    throwFieldErrors(relationshipErrors);
    const programme = programmeRes.data!;
    const branch = branchRes.data!;

    const entityId = programme.entity_id;
    const entityRes = await db.from("entities").select("short_code").eq("id", entityId).maybeSingle();
    if (entityRes.error || !entityRes.data) fieldValidation("programme_id", "Please select a valid programme.");
    if (entityRes.data.short_code === "IETA" && !["KL", "PG"].includes(branch.branch_code)) {
      fieldValidation("branch_id", "Please select KL or Penang for an IETA intake.");
    }

    const intakeName = textOrNull(body.intake_name)
      || `${programme.programme_code} ${branch.branch_code} ${code}`;

    let originalExpectedDate = submittedOriginalExpectedDate || expectedDate;
    let revisedBy: string | null = null;
    let revisedAt: string | null = null;
    if (existingId) {
      const existingRes = await db
        .from("programme_intakes")
        .select("expected_completion_date, original_expected_completion_date")
        .eq("id", existingId)
        .maybeSingle();
      if (existingRes.error || !existingRes.data) fieldValidation("id", "Please open a valid intake record.");
      originalExpectedDate = existingRes.data.original_expected_completion_date
        || existingRes.data.expected_completion_date
        || expectedDate;
      if (existingRes.data.expected_completion_date && existingRes.data.expected_completion_date !== expectedDate) {
        if (!completionReason) {
          fieldValidation("completion_reason", "Please enter a reason for changing the expected completion date.");
        }
        revisedBy = user.id;
        revisedAt = new Date().toISOString();
      }
    }

    const payload: Record<string, unknown> = {
      id: existingId || crypto.randomUUID(),
      programme_id: programmeId,
      entity_id: entityId,
      branch_id: branchId,
      intake_code: code,
      intake_name: intakeName,
      start_date: startDate,
      original_expected_completion_date: originalExpectedDate,
      expected_completion_date: expectedDate,
      application_closing_date: closingDate,
      actual_completion_date: actualDate,
      capacity,
      status,
      completion_timing: completionTiming,
      completion_reason: completionReason,
      remarks: textOrNull(body.remarks),
      updated_by: user.id,
    };
    if (!existingId) payload.created_by = user.id;
    if (revisedBy) {
      payload.revised_by = revisedBy;
      payload.revised_at = revisedAt;
    }

    const saveRes = existingId
      ? await db.from("programme_intakes").update(payload).eq("id", existingId)
      : await db.from("programme_intakes").insert(payload);

    if (saveRes.error) {
      return NextResponse.json({
        error: friendlyDatabaseError("intake", saveRes.error),
        field_errors: databaseFieldErrors("intake", saveRes.error),
      }, { status: 400 });
    }
    return NextResponse.json({ id: payload.id, intake_name: intakeName, status });
  } catch (error) {
    if (error instanceof ValidationError) return NextResponse.json(validationResponse(error), { status: 400 });
    console.error("Unexpected intake save error", error);
    return NextResponse.json({
      error: friendlyDatabaseError("intake", null),
      field_errors: {},
    }, { status: 500 });
  }
}
