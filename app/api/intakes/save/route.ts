import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  ValidationError,
  friendlyDatabaseError,
  integerOrNull,
  optionalUuid,
  requiredUuid,
  textOrNull,
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
  remarks?: string;
};

const OPERATIONAL_STATUSES = ["planning", "open", "closed", "in_progress", "completed", "cancelled", "inactive"];
const COMPLETION_TIMINGS = ["not_applicable", "on_time", "prolonged", "shortened", "partially_completed", "discontinued"];

export async function POST(request: Request) {
  const db = await createClient();
  const { data: userData } = await db.auth.getUser();
  const user = userData.user;

  if (!user) return NextResponse.json({ error: "Please log in first." }, { status: 401 });

  try {
    const body = (await request.json()) as IntakePayload;
    const existingId = optionalUuid(body.id, "Please open a valid intake record.");
    const programmeId = requiredUuid(body.programme_id, "Please select a programme.");
    const branchId = requiredUuid(body.branch_id, "Please select a valid branch.");
    const code = textOrNull(body.intake_code)?.toUpperCase();
    const startDate = textOrNull(body.start_date);
    const submittedOriginalExpectedDate = textOrNull(body.original_expected_completion_date);
    const expectedDate = textOrNull(body.expected_completion_date);
    const closingDate = textOrNull(body.application_closing_date);
    const actualDate = textOrNull(body.actual_completion_date);
    const capacity = integerOrNull(body.capacity);
    const status = textOrNull(body.status) || "open";
    const completionTiming = textOrNull(body.completion_timing) || "not_applicable";
    const completionReason = textOrNull(body.completion_reason);

    if (!code) throw new ValidationError("Please enter an intake code.");
    if (!startDate) throw new ValidationError("Please select an intake start date.");
    if (expectedDate && expectedDate < startDate) throw new ValidationError("Current expected completion date cannot be before the start date.");
    if (closingDate && closingDate > startDate) throw new ValidationError("Application closing date cannot be after the start date.");
    if (actualDate && actualDate < startDate) throw new ValidationError("Actual completion date cannot be before the start date.");
    if (body.capacity !== "" && body.capacity != null && (capacity === null || capacity < 0)) {
      throw new ValidationError("Capacity must be a whole number of zero or more.");
    }
    if (!OPERATIONAL_STATUSES.includes(status)) throw new ValidationError("Please select a valid operational status.");
    if (!COMPLETION_TIMINGS.includes(completionTiming)) throw new ValidationError("Please select a valid completion timing.");

    const [programmeRes, branchRes] = await Promise.all([
      db.from("programmes").select("id, entity_id").eq("id", programmeId).maybeSingle(),
      db.from("branches").select("id, entity_id, branch_code").eq("id", branchId).maybeSingle(),
    ]);
    if (programmeRes.error || !programmeRes.data) throw new ValidationError("Please select a valid programme.");
    if (branchRes.error || !branchRes.data || branchRes.data.entity_id !== programmeRes.data.entity_id) {
      throw new ValidationError("Please select a valid branch.");
    }

    const entityId = programmeRes.data.entity_id;
    const entityRes = await db.from("entities").select("short_code").eq("id", entityId).maybeSingle();
    if (entityRes.error || !entityRes.data) throw new ValidationError("Please select a valid programme.");
    if (entityRes.data.short_code === "IETA" && !["KL", "PG"].includes(branchRes.data.branch_code)) {
      throw new ValidationError("Please select KL or Penang for an IETA intake.");
    }

    let originalExpectedDate = submittedOriginalExpectedDate || expectedDate;
    let revisedBy: string | null = null;
    let revisedAt: string | null = null;
    if (existingId) {
      const existingRes = await db
        .from("programme_intakes")
        .select("expected_completion_date, original_expected_completion_date")
        .eq("id", existingId)
        .maybeSingle();
      if (existingRes.error || !existingRes.data) throw new ValidationError("Please open a valid intake record.");
      originalExpectedDate = existingRes.data.original_expected_completion_date || existingRes.data.expected_completion_date || expectedDate;
      if (existingRes.data.expected_completion_date !== expectedDate) {
        if (!completionReason) throw new ValidationError("Please enter a revision or completion reason.");
        revisedBy = user.id;
        revisedAt = new Date().toISOString();
      }
    }

    const payload: Record<string, unknown> = {
      programme_id: programmeId,
      entity_id: entityId,
      branch_id: branchId,
      intake_code: code,
      intake_name: textOrNull(body.intake_name),
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
      return NextResponse.json({ error: friendlyDatabaseError("intake", saveRes.error) }, { status: 400 });
    }
    return NextResponse.json({ id: existingId });
  } catch (error) {
    if (error instanceof ValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error("Unexpected intake save error", error);
    return NextResponse.json({ error: friendlyDatabaseError("intake", null) }, { status: 500 });
  }
}
