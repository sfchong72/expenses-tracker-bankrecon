import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  ValidationError,
  friendlyDatabaseError,
  numberOrNull,
  optionalUuid,
  requiredUuid,
  textOrNull,
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
  active_status?: boolean;
};

const DURATION_UNITS = ["days", "weeks", "months", "years"];

function durationLabel(minimum: number, maximum: number | null, unit: string) {
  const value = maximum === null ? `${minimum}` : `${minimum}\u2013${maximum}`;
  const label = maximum === null && minimum === 1 ? unit.replace(/s$/, "") : unit;
  return `${value} ${label}`;
}

export async function POST(request: Request) {
  const db = await createClient();
  const { data: userData } = await db.auth.getUser();
  const user = userData.user;

  if (!user) return NextResponse.json({ error: "Please log in first." }, { status: 401 });

  try {
    const body = (await request.json()) as ProgrammePayload;
    const existingId = optionalUuid(body.id, "Please open a valid programme record.");
    const entityId = requiredUuid(body.entity_id, "Please select an entity.");
    const code = textOrNull(body.programme_code)?.toUpperCase();
    const name = textOrNull(body.programme_name);
    const durationValue = numberOrNull(body.duration_value);
    const durationMaximum = numberOrNull(body.duration_max_value);
    const durationUnit = textOrNull(body.duration_unit);
    const indicativeFee = numberOrNull(body.indicative_standard_fee);

    if (!code) throw new ValidationError("Please enter a programme code.");
    if (!name) throw new ValidationError("Please enter a programme name.");
    if (durationValue === null || durationValue <= 0) throw new ValidationError("Please enter a valid programme duration.");
    if (!durationUnit || !DURATION_UNITS.includes(durationUnit)) throw new ValidationError("Please select a duration unit.");
    if (durationMaximum !== null && durationMaximum < durationValue) {
      throw new ValidationError("Maximum duration cannot be shorter than the minimum duration.");
    }
    if (indicativeFee !== null && indicativeFee < 0) throw new ValidationError("Indicative tuition fee cannot be negative.");

    const entityRes = await db.from("entities").select("id").eq("id", entityId).maybeSingle();
    if (entityRes.error || !entityRes.data) throw new ValidationError("Please select a valid entity.");

    const payload: Record<string, unknown> = {
      entity_id: entityId,
      programme_code: code,
      programme_name: name,
      programme_type: textOrNull(body.programme_type),
      description: textOrNull(body.description),
      duration_value: durationMaximum === null ? durationValue : null,
      duration_min_value: durationMaximum === null ? null : durationValue,
      duration_max_value: durationMaximum,
      duration_unit: durationUnit,
      duration_text: durationLabel(durationValue, durationMaximum, durationUnit),
      indicative_standard_fee: indicativeFee,
      active_status: body.active_status ?? true,
      updated_by: user.id,
    };
    if (!existingId) payload.created_by = user.id;

    const saveRes = existingId
      ? await db.from("programmes").update(payload).eq("id", existingId)
      : await db.from("programmes").insert(payload);

    if (saveRes.error) {
      return NextResponse.json({ error: friendlyDatabaseError("programme", saveRes.error) }, { status: 400 });
    }
    return NextResponse.json({ id: existingId });
  } catch (error) {
    if (error instanceof ValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error("Unexpected programme save error", error);
    return NextResponse.json({ error: friendlyDatabaseError("programme", null) }, { status: 500 });
  }
}
