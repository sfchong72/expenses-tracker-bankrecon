import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  duplicateInputs,
  inferStudentMapping,
  mapStudentRows,
  parseStudentImportFile,
  StudentImportMode,
} from "@/lib/import/student";

export const runtime = "nodejs";

const maxSize = 10 * 1024 * 1024;
const maxRows = 2000;

export async function POST(request: Request) {
  const db = await createClient();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Please log in first." }, { status: 401 });

  const form = await request.formData();
  const file = form.get("file");
  const entityId = String(form.get("entity_id") ?? "").trim();
  const branchId = String(form.get("default_branch_id") ?? "").trim();
  const worksheetName = String(form.get("worksheet") ?? "").trim();
  const batchId = String(form.get("batch_id") ?? "").trim();
  const mode = String(form.get("import_mode") ?? "standard") as StudentImportMode;
  const suppliedMapping = parseMapping(form.get("mapping"));

  if (!(file instanceof File)) return NextResponse.json({ error: "Choose a CSV or XLSX file." }, { status: 400 });
  if (!entityId || !branchId) return NextResponse.json({ error: "Choose the entity and default home branch." }, { status: 400 });
  if (!["standard", "legacy"].includes(mode)) return NextResponse.json({ error: "Choose a valid import mode." }, { status: 400 });
  if (file.size <= 0 || file.size > maxSize) return NextResponse.json({ error: "File must be between 1 byte and 10 MB." }, { status: 400 });

  const branch = await db.from("branches").select("id, entity_id, branch_code").eq("id", branchId).eq("entity_id", entityId).maybeSingle();
  if (branch.error || !branch.data) {
    return NextResponse.json({ error: "The default branch does not belong to the selected entity." }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const head = bytes.slice(0, 4).toString("hex");
  const lowerName = file.name.toLowerCase();
  const looksXlsx = head.startsWith("504b0304");
  const textSample = bytes.slice(0, Math.min(bytes.length, 512)).toString("utf8");
  const looksCsv = !textSample.includes("\u0000");
  let fileType: "csv" | "xlsx";
  if (looksXlsx && lowerName.endsWith(".xlsx")) fileType = "xlsx";
  else if (looksCsv && lowerName.endsWith(".csv")) fileType = "csv";
  else {
    return NextResponse.json({
      error: "Only genuine CSV and XLSX files are supported. The file content did not match its extension.",
    }, { status: 400 });
  }

  const sheets = parseStudentImportFile(bytes, fileType);
  if (!sheets.length) return NextResponse.json({ error: "No readable worksheet was found." }, { status: 400 });
  const selected = sheets.find((sheet) => sheet.name === worksheetName) ?? sheets[0];
  if (selected.rows.length > maxRows) {
    return NextResponse.json({ error: `This worksheet has ${selected.rows.length} rows. Split it into files of ${maxRows} rows or fewer.` }, { status: 400 });
  }

  const headers = Object.keys(selected.rows[0] ?? {});
  if (!headers.length) return NextResponse.json({ error: "The selected worksheet has no header row or data rows." }, { status: 400 });
  const mapping = suppliedMapping || inferStudentMapping(headers);

  const [programmeRes, intakeRes] = await Promise.all([
    db.from("programmes").select("id, entity_id, programme_code, programme_name").eq("entity_id", entityId).eq("is_demo", false),
    db.from("programme_intakes").select("id, entity_id, programme_id, intake_code, intake_name").eq("entity_id", entityId).eq("is_demo", false),
  ]);
  if (programmeRes.error || intakeRes.error) {
    return NextResponse.json({ error: "Programme and intake references could not be loaded." }, { status: 400 });
  }

  const preview = mapStudentRows(
    selected.rows,
    mapping,
    mode,
    programmeRes.data ?? [],
    intakeRes.data ?? [],
  );
  const rows = await addDuplicateWarnings(db, entityId, preview);

  let workingBatchId = batchId;
  if (workingBatchId) {
    const existing = await db.from("student_import_batches")
      .select("id, status")
      .eq("id", workingBatchId)
      .maybeSingle();
    if (existing.error || !existing.data || !["mapping", "ready", "failed"].includes(existing.data.status)) {
      return NextResponse.json({ error: "This preview batch can no longer be replaced." }, { status: 409 });
    }
    const cleared = await db.from("student_import_rows").delete().eq("student_import_batch_id", workingBatchId);
    if (cleared.error) return NextResponse.json({ error: cleared.error.message }, { status: 400 });
    const updated = await db.from("student_import_batches").update({
      entity_id: entityId,
      default_branch_id: branchId,
      filename: file.name,
      file_type: fileType,
      worksheet_name: selected.name,
      import_mode: mode,
      status: "mapping",
      mapping_config: mapping,
      total_rows: rows.length,
      successful_rows: 0,
      skipped_rows: 0,
      failed_rows: 0,
      result_summary: {},
    }).eq("id", workingBatchId);
    if (updated.error) return NextResponse.json({ error: updated.error.message }, { status: 400 });
  } else {
    const created = await db.from("student_import_batches").insert({
      entity_id: entityId,
      default_branch_id: branchId,
      filename: file.name,
      file_type: fileType,
      worksheet_name: selected.name,
      import_mode: mode,
      status: "mapping",
      mapping_config: mapping,
      total_rows: rows.length,
      uploaded_by: userData.user.id,
    }).select("id").single();
    if (created.error) return NextResponse.json({
      error: migrationMessage(created.error.message),
    }, { status: 400 });
    workingBatchId = created.data.id;
  }

  const insertedRows = rows.length
    ? await db.from("student_import_rows").insert(rows.map((row) => ({
      student_import_batch_id: workingBatchId,
      row_number: row.rowNumber,
      original_data: row.original,
      mapped_data: row.mapped,
      validation_errors: row.validationErrors,
      duplicate_warnings: row.duplicateWarnings,
      duplicate_decision: row.duplicateDecision,
      matched_student_id: row.matchedStudentId || null,
      row_status: "pending",
    }))).select("id, row_number, original_data, mapped_data, validation_errors, duplicate_warnings, duplicate_decision, matched_student_id, row_status")
    : { data: [], error: null };
  if (insertedRows.error) return NextResponse.json({ error: insertedRows.error.message }, { status: 400 });

  return NextResponse.json({
    batchId: workingBatchId,
    sheets: sheets.map((sheet) => ({ name: sheet.name, rowCount: sheet.rows.length })),
    selectedSheet: selected.name,
    headers,
    mapping,
    rows: (insertedRows.data ?? []).map(toClientRow),
    limitations: "XLSX formulas are read from their stored values. Merged-cell layouts should be normalised before import.",
  });
}

async function addDuplicateWarnings(
  db: Awaited<ReturnType<typeof createClient>>,
  entityId: string,
  rows: ReturnType<typeof mapStudentRows>,
) {
  const output = [];
  for (let start = 0; start < rows.length; start += 25) {
    const chunk = rows.slice(start, start + 25);
    const checked = await Promise.all(chunk.map(async (row) => {
      if (row.validationErrors.length) return row;
      const input = duplicateInputs(row.mapped);
      const duplicateRes = await db.rpc("find_student_duplicate_warnings", {
        p_student_id: null,
        p_entity_id: entityId,
        p_full_name: input.fullName,
        p_identity_document_type: input.identityDocumentType,
        p_identity_number: input.identityNumber,
        p_phone: input.phone,
        p_email: input.email,
        p_date_of_birth: input.dateOfBirth,
      });
      const warnings = duplicateRes.error ? [] : duplicateRes.data ?? [];
      return {
        ...row,
        duplicateWarnings: warnings,
        duplicateDecision: warnings.length ? "pending" as const : "import_as_new" as const,
        matchedStudentId: warnings.length === 1 ? String(warnings[0].student_id) : "",
      };
    }));
    output.push(...checked);
  }
  return output;
}

function parseMapping(value: FormDataEntryValue | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed as Record<string, string> : null;
  } catch {
    return null;
  }
}

function toClientRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    rowNumber: row.row_number,
    original: row.original_data,
    mapped: row.mapped_data,
    validationErrors: row.validation_errors,
    duplicateWarnings: row.duplicate_warnings,
    duplicateDecision: row.duplicate_decision,
    matchedStudentId: row.matched_student_id || "",
    rowStatus: row.row_status,
    excluded: row.duplicate_decision === "skip",
  };
}

function migrationMessage(message: string) {
  return message.includes("student_import_batches")
    ? "Student Import is not ready until migration 0018 is applied."
    : message;
}
