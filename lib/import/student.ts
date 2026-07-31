import { parseCsv, parseXlsx } from "@/lib/import/supplier-recurring";

export type StudentImportMode = "standard" | "legacy";

export type StudentImportRow = {
  rowNumber: number;
  original: Record<string, string>;
  mapped: Record<string, unknown>;
  validationErrors: string[];
  duplicateWarnings: Array<Record<string, unknown>>;
  duplicateDecision: "pending" | "import_as_new" | "link_existing" | "skip";
  matchedStudentId: string;
  excluded: boolean;
};

export const studentImportFields = [
  "full_name",
  "preferred_name",
  "student_number",
  "identity_document_type",
  "identity_number",
  "nationality",
  "date_of_birth",
  "gender",
  "phone",
  "email",
  "address",
  "city",
  "state",
  "postcode",
  "country",
  "previous_school",
  "education_level",
  "qualification_details",
  "education_institution",
  "field_of_study",
  "graduation_year",
  "programme",
  "intake",
  "enrolment_year",
  "completion_year",
  "status",
  "course_arrangement",
  "counsellor_name",
  "remarks",
] as const;

const aliases: Record<string, string> = {
  name: "full_name",
  full_name: "full_name",
  student_name: "full_name",
  student: "full_name",
  preferred_name: "preferred_name",
  nickname: "preferred_name",
  student_no: "student_number",
  student_number: "student_number",
  student_id: "student_number",
  ic: "identity_number",
  ic_no: "identity_number",
  ic_number: "identity_number",
  passport: "identity_number",
  passport_no: "identity_number",
  passport_number: "identity_number",
  identity_number: "identity_number",
  ic_passport: "identity_number",
  identity_type: "identity_document_type",
  ic_passport_type: "identity_document_type",
  nationality: "nationality",
  dob: "date_of_birth",
  date_of_birth: "date_of_birth",
  birth_date: "date_of_birth",
  gender: "gender",
  sex: "gender",
  phone: "phone",
  phone_no: "phone",
  contact_no: "phone",
  mobile: "phone",
  email: "email",
  email_address: "email",
  address: "address",
  home_address: "address",
  city: "city",
  state: "state",
  postcode: "postcode",
  postal_code: "postcode",
  country: "country",
  previous_school: "previous_school",
  school: "previous_school",
  education: "education_level",
  education_level: "education_level",
  qualification: "qualification_details",
  qualification_details: "qualification_details",
  institution: "education_institution",
  education_institution: "education_institution",
  field_of_study: "field_of_study",
  graduation_year: "graduation_year",
  programme: "programme",
  program: "programme",
  course: "programme",
  class: "intake",
  intake: "intake",
  intake_code: "intake",
  class_name: "intake",
  enrolment_year: "enrolment_year",
  enrollment_year: "enrolment_year",
  year_joined: "enrolment_year",
  completion_year: "completion_year",
  graduation_completion_year: "completion_year",
  status: "status",
  study_status: "status",
  arrangement: "course_arrangement",
  course_arrangement: "course_arrangement",
  counsellor: "counsellor_name",
  counselor: "counsellor_name",
  agent: "counsellor_name",
  remarks: "remarks",
  notes: "remarks",
};

export function parseStudentImportFile(bytes: Buffer, fileType: "csv" | "xlsx") {
  return fileType === "csv"
    ? [{ name: "CSV", rows: parseCsv(bytes.toString("utf8")) }]
    : parseXlsx(bytes);
}

export function inferStudentMapping(headers: string[]) {
  return Object.fromEntries(headers.map((header) => [header, aliases[toKey(header)] || ""]));
}

export function mapStudentRows(
  rows: Record<string, string>[],
  mapping: Record<string, string>,
  mode: StudentImportMode,
  programmes: Array<Record<string, unknown>>,
  intakes: Array<Record<string, unknown>>,
): StudentImportRow[] {
  return rows.map((row, index) => {
    const mapped: Record<string, unknown> = {};
    for (const [header, field] of Object.entries(mapping)) {
      if (field) mapped[field] = row[header] ?? "";
    }
    normaliseMapped(mapped);
    resolveLegacyRelationships(mapped, programmes, intakes);
    const validationErrors = validateStudentImportMapped(mapped, mode);
    return {
      rowNumber: index + 2,
      original: row,
      mapped,
      validationErrors,
      duplicateWarnings: [],
      duplicateDecision: "import_as_new",
      matchedStudentId: "",
      excluded: false,
    };
  });
}

export function validateStudentImportMapped(
  mapped: Record<string, unknown>,
  _mode: StudentImportMode,
) {
  const errors: string[] = [];
  if (!text(mapped.full_name)) errors.push("Full name is required");
  if (text(mapped.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(mapped.email))) {
    errors.push("Email address is invalid");
  }
  if (text(mapped.date_of_birth) && !parseDate(mapped.date_of_birth)) {
    errors.push("Date of birth is invalid");
  }
  const gender = normaliseGender(mapped.gender);
  if (text(mapped.gender) && !gender) errors.push("Gender must be Female or Male");
  for (const [field, label] of [
    ["graduation_year", "Graduation year"],
    ["enrolment_year", "Enrolment year"],
    ["completion_year", "Completion year"],
  ]) {
    const value = text(mapped[field]);
    if (value && parseYear(value) == null) errors.push(`${label} must be between 1900 and 2100`);
  }
  return errors;
}

export function normaliseMapped(mapped: Record<string, unknown>) {
  if (text(mapped.date_of_birth)) mapped.date_of_birth = parseDate(mapped.date_of_birth) || text(mapped.date_of_birth);
  if (text(mapped.gender)) mapped.gender = normaliseGender(mapped.gender) || text(mapped.gender);
  if (text(mapped.identity_document_type)) {
    mapped.identity_document_type = normaliseIdentityType(mapped.identity_document_type);
  } else if (text(mapped.identity_number)) {
    mapped.identity_document_type = looksMalaysianIc(mapped.identity_number) ? "ic" : "other";
  }
  for (const field of ["graduation_year", "enrolment_year", "completion_year"]) {
    if (text(mapped[field])) mapped[field] = parseYear(mapped[field]) ?? text(mapped[field]);
  }
  if (!text(mapped.nationality)) mapped.nationality = "Malaysian";
  if (!text(mapped.country)) mapped.country = "Malaysia";
  mapped.full_name = text(mapped.full_name);
  mapped.email = text(mapped.email).toLowerCase();
  return mapped;
}

export function duplicateInputs(mapped: Record<string, unknown>) {
  return {
    fullName: text(mapped.full_name),
    identityDocumentType: text(mapped.identity_document_type) || null,
    identityNumber: text(mapped.identity_number) || null,
    phone: text(mapped.phone) || null,
    email: text(mapped.email) || null,
    dateOfBirth: parseDate(mapped.date_of_birth),
  };
}

function resolveLegacyRelationships(
  mapped: Record<string, unknown>,
  programmes: Array<Record<string, unknown>>,
  intakes: Array<Record<string, unknown>>,
) {
  const programmeText = normalise(text(mapped.programme));
  if (programmeText) {
    const matches = programmes.filter((programme) =>
      [programme.programme_code, programme.programme_name].some((value) => normalise(value) === programmeText));
    if (matches.length === 1) mapped.programme_id = matches[0].id;
  }

  const intakeText = normalise(text(mapped.intake));
  if (intakeText) {
    const matches = intakes.filter((intake) => {
      const sameProgramme = !mapped.programme_id || intake.programme_id === mapped.programme_id;
      return sameProgramme && [intake.intake_code, intake.intake_name].some((value) => normalise(value) === intakeText);
    });
    if (matches.length === 1) {
      mapped.intake_id = matches[0].id;
      mapped.programme_id ||= matches[0].programme_id;
    }
  }
}

function normaliseIdentityType(value: unknown) {
  const key = normalise(value);
  if (["ic", "mykad", "nric", "identity card"].includes(key)) return "ic";
  if (key.includes("passport")) return "passport";
  return "other";
}

function normaliseGender(value: unknown) {
  const key = normalise(value);
  if (["female", "f", "woman", "girl"].includes(key)) return "female";
  if (["male", "m", "man", "boy"].includes(key)) return "male";
  return "";
}

function looksMalaysianIc(value: unknown) {
  return String(value ?? "").replace(/\D/g, "").length === 12;
}

function parseDate(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(Date.UTC(1899, 11, 30 + Math.floor(value)));
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  const raw = text(value);
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return parseDate(Number(raw));
  const dmy = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (dmy) {
    const year = Number(dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3]);
    const date = new Date(Date.UTC(year, Number(dmy[2]) - 1, Number(dmy[1])));
    if (
      date.getUTCFullYear() !== year
      || date.getUTCMonth() !== Number(dmy[2]) - 1
      || date.getUTCDate() !== Number(dmy[1])
    ) return null;
    return date.toISOString().slice(0, 10);
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function parseYear(value: unknown) {
  const match = text(value).match(/\b(19|20)\d{2}\b/);
  const year = match ? Number(match[0]) : Number(value);
  return Number.isInteger(year) && year >= 1900 && year <= 2100 ? year : null;
}

function normalise(value: unknown) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function toKey(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}
