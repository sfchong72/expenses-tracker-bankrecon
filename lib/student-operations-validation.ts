const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const NATIONALITIES = new Map([
  ["malaysian", "Malaysian"],
  ["japanese", "Japanese"],
  ["korean", "Korean"],
  ["chinese", "Chinese"],
  ["indonesian", "Indonesian"],
  ["vietnamese", "Vietnamese"],
  ["filipino", "Filipino"],
  ["thai", "Thai"],
  ["singaporean", "Singaporean"],
  ["kazakhstani", "Kazakhstani"],
]);

export function textOrNull(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

export function uuidOrNull(value: unknown) {
  const text = textOrNull(value);
  return text && UUID_PATTERN.test(text) ? text : null;
}

export type FieldErrors = Record<string, string>;

export function requiredUuid(value: unknown, message: string, field?: string) {
  const text = textOrNull(value);
  if (!text || !UUID_PATTERN.test(text)) throw new ValidationError(message, field ? { [field]: message } : {});
  return text;
}

export function optionalUuid(value: unknown, message: string, field?: string) {
  const text = textOrNull(value);
  if (!text) return null;
  if (!UUID_PATTERN.test(text)) throw new ValidationError(message, field ? { [field]: message } : {});
  return text;
}

export function numberOrNull(value: unknown) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function integerOrNull(value: unknown) {
  const number = numberOrNull(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

export function normaliseNationality(value: unknown) {
  const text = textOrNull(value);
  if (!text) return "Malaysian";
  return NATIONALITIES.get(text.toLowerCase()) || text.replace(/\s+/g, " ");
}

export class ValidationError extends Error {
  fieldErrors: FieldErrors;

  constructor(message: string, fieldErrors: FieldErrors = {}) {
    super(message);
    this.name = "ValidationError";
    this.fieldErrors = fieldErrors;
  }
}

export function fieldValidation(field: string, message: string): never {
  throw new ValidationError(message, { [field]: message });
}

export function validationResponse(error: ValidationError) {
  return {
    error: error.message,
    field_errors: error.fieldErrors,
  };
}

export function throwFieldErrors(
  fieldErrors: FieldErrors,
  message = "Please review the highlighted fields.",
) {
  if (Object.keys(fieldErrors).length > 0) {
    throw new ValidationError(message, fieldErrors);
  }
}

export function databaseFieldErrors(
  operation: "student" | "programme" | "intake" | "enrolment",
  error: { message?: string; code?: string; details?: string } | null,
): FieldErrors {
  const message = `${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  if (operation === "student") {
    if (error?.code === "42501" || message.includes("row-level security")) {
      return {
        entity_id: "You do not have access to save students for this entity.",
        home_branch_id: "You do not have access to save students for this branch.",
      };
    }
    if (message.includes("students_entity_id_student_number_key")) {
      return { full_name: "A student-number conflict occurred. Please try saving again." };
    }
    if (message.includes("students_identity_document_type_check")) {
      return { identity_document_type: "Please select a valid IC or passport type." };
    }
  }
  if (operation === "programme" && message.includes("programmes_entity_id_programme_code_key")) {
    return { programme_code: "This programme code is already in use for the selected entity." };
  }
  if (operation === "intake" && message.includes("programme_intakes_entity_id_branch_id_intake_code_key")) {
    return { intake_code: "This intake code is already in use for the selected branch." };
  }
  if (operation === "enrolment" && message.includes("enrolments_entity_id_enrolment_number_key")) {
    return { intake_id: "The enrolment number could not be reserved. Please save again." };
  }
  return {};
}

export function friendlyDatabaseError(
  operation: "student" | "programme" | "intake" | "enrolment",
  error: { message?: string; code?: string; details?: string } | null,
) {
  if (error) console.error(`Student Operations ${operation} save failed`, error);
  const labels = {
    student: "Student",
    programme: "Programme",
    intake: "Intake",
    enrolment: "Enrolment",
  };
  return `${labels[operation]} could not be saved. Please review the highlighted fields.`;
}
