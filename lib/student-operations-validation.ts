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

export function requiredUuid(value: unknown, message: string) {
  const text = textOrNull(value);
  if (!text || !UUID_PATTERN.test(text)) throw new ValidationError(message);
  return text;
}

export function optionalUuid(value: unknown, message: string) {
  const text = textOrNull(value);
  if (!text) return null;
  if (!UUID_PATTERN.test(text)) throw new ValidationError(message);
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

export class ValidationError extends Error {}

export function friendlyDatabaseError(
  operation: "student" | "programme" | "intake" | "enrolment",
  error: { message?: string; code?: string } | null,
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
