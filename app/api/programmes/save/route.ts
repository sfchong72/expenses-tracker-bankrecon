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

type ProgrammePayload = {
  id?: string;
  entity_id?: string;
  programme_code?: string;
  programme_name?: string;
  programme_type?: string;
  description?: string;
  duration_value?: string | number;
  duration_max_value?: string | number;
  duration_unit?: string;
  indicative_standard_fee?: string | number;
  record_status?: string;
  save_action?: "draft" | "continue";
};

const DURATION_UNITS = ["days", "weeks", "months", "years"];
const PROGRAMME_STATUSES = ["draft", "active", "incomplete", "inactive", "archived"];

function durationLabel(minimum: number, maximum: number | null, unit: string) {
  const value = maximum === null ? `${minimum}` : `${minimum}\u2013${maximum}`;
  const label = maximum === null && minimum === 1 ? unit.replace(/s$/, "") : unit;
  return `${value} ${label}`;
}

export async function POST(request: Request) {
  const db = await createClient();
  const { data: userData } = await db.auth.getUser();
  const user = userData.user;

  if (!user) return NextResponse.json({ error: "Please log in first.", field_errors: {} }, { status: 401 });

  try {
    const body = (await request.json()) as ProgrammePayload;
    const code = textOrNull(body.programme_code)?.toUpperCase();
    const name = textOrNull(body.programme_name);
    const durationValue = numberOrNull(body.duration_value);
    const durationMaximum = numberOrNull(body.duration_max_value);
    const submittedDurationUnit = textOrNull(body.duration_unit);
    const indicativeFee = numberOrNull(body.indicative_standard_fee);
    const requestedStatus = textOrNull(body.record_status) || "draft";
    const fieldErrors: Record<string, string> = {};

    if (!uuidOrNull(body.entity_id)) fieldErrors.entity_id = "Please select an entity.";
    if (textOrNull(body.id) && !uuidOrNull(body.id)) fieldErrors.id = "Please open a valid programme record.";
    if (!code) fieldErrors.programme_code = "Please enter a programme code.";
    if (!name) fieldErrors.programme_name = "Please enter a programme name.";
    if (body.duration_value !== "" && body.duration_value != null && (durationValue === null || durationValue <= 0)) {
      fieldErrors.duration_value = "Duration must be greater than zero.";
    }
    if (body.duration_max_value !== "" && body.duration_max_value != null && (durationMaximum === null || durationMaximum <= 0)) {
      fieldErrors.duration_max_value = "Maximum duration must be greater than zero.";
    }
    if (durationMaximum !== null && durationValue === null) {
      fieldErrors.duration_value = "Enter the minimum duration before adding a maximum.";
    }
    if (durationValue !== null && (!submittedDurationUnit || !DURATION_UNITS.includes(submittedDurationUnit))) {
      fieldErrors.duration_unit = "Please select a duration unit.";
    }
    if (durationMaximum !== null && durationValue !== null && durationMaximum < durationValue) {
      fieldErrors.duration_max_value = "Maximum duration cannot be shorter than the minimum duration.";
    }
    if (indicativeFee !== null && indicativeFee < 0) {
      fieldErrors.indicative_standard_fee = "Indicative tuition fee cannot be negative.";
    }
    if (!PROGRAMME_STATUSES.includes(requestedStatus)) {
      fieldErrors.record_status = "Please select a valid programme status.";
    }
    throwFieldErrors(fieldErrors);

    const existingId = optionalUuid(body.id, "Please open a valid programme record.", "id");
    const entityId = requiredUuid(body.entity_id, "Please select an entity.", "entity_id");

    const entityRes = await db.from("entities").select("id").eq("id", entityId).maybeSingle();
    if (entityRes.error || !entityRes.data) {
      throwFieldErrors({ entity_id: "Please select a valid entity." });
    }

    const durationUnit = durationValue === null ? null : submittedDurationUnit;
    const recordStatus = body.save_action === "draft" ? "draft" : requestedStatus === "draft" ? "active" : requestedStatus;
    const id = existingId || crypto.randomUUID();
    const payload: Record<string, unknown> = {
      id,
      entity_id: entityId,
      programme_code: code,
      programme_name: name,
      programme_type: textOrNull(body.programme_type),
      description: textOrNull(body.description),
      duration_value: durationValue !== null && durationMaximum === null ? durationValue : null,
      duration_min_value: durationMaximum === null ? null : durationValue,
      duration_max_value: durationMaximum,
      duration_unit: durationUnit,
      duration_text: durationValue !== null && durationUnit ? durationLabel(durationValue, durationMaximum, durationUnit) : null,
      indicative_standard_fee: indicativeFee,
      record_status: recordStatus,
      active_status: !["inactive", "archived"].includes(recordStatus),
      updated_by: user.id,
    };
    if (!existingId) payload.created_by = user.id;

    const saveRes = existingId
      ? await db.from("programmes").update(payload).eq("id", existingId)
      : await db.from("programmes").insert(payload);

    if (saveRes.error) {
      return NextResponse.json({
        error: friendlyDatabaseError("programme", saveRes.error),
        field_errors: databaseFieldErrors("programme", saveRes.error),
      }, { status: 400 });
    }
    return NextResponse.json({ id, record_status: recordStatus });
  } catch (error) {
    if (error instanceof ValidationError) return NextResponse.json(validationResponse(error), { status: 400 });
    console.error("Unexpected programme save error", error);
    return NextResponse.json({
      error: friendlyDatabaseError("programme", null),
      field_errors: {},
    }, { status: 500 });
  }
}
