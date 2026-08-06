"use client";

import "../../student-operations-uat.css";
import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { AuthBar } from "@/app/auth-bar";
import { createClient } from "@/lib/supabase/client";

type Row = Record<string, any>;
type ImportMode = "standard" | "legacy";

const importFields = [
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
];

export default function StudentImportPage() {
  const db = useMemo(() => createClient(), []);
  const [entities, setEntities] = useState<Row[]>([]);
  const [branches, setBranches] = useState<Row[]>([]);
  const [entityId, setEntityId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [mode, setMode] = useState<ImportMode>("standard");
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<Row[]>([]);
  const [sheet, setSheet] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<Row[]>([]);
  const [batchId, setBatchId] = useState("");
  const [history, setHistory] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Choose an import mode and upload CSV or XLSX. Nothing is created until Confirm Import.");
  const [error, setError] = useState("");

  useEffect(() => { void loadLookups(); void loadHistory(); }, []);

  async function loadLookups() {
    const [entityRes, branchRes] = await Promise.all([
      db.from("entities").select("id, short_code, display_name").eq("active_status", true).order("short_code"),
      db.from("branches").select("id, entity_id, branch_code, branch_name").eq("active_status", true).order("branch_code"),
    ]);
    const nextEntities = entityRes.data ?? [];
    const nextBranches = branchRes.data ?? [];
    setEntities(nextEntities);
    setBranches(nextBranches);
    const ieta = nextEntities.find((entity) => entity.short_code === "IETA") || nextEntities[0];
    const nextEntityId = ieta?.id || "";
    setEntityId(nextEntityId);
    setBranchId(nextBranches.find((branch) => branch.entity_id === nextEntityId && branch.branch_code === "KL")?.id || "");
  }

  async function loadHistory() {
    const res = await fetch("/api/students/import/history");
    const json = await res.json();
    if (res.ok) setHistory(json.batches || []);
  }

  async function parseUpload(event?: FormEvent, selectedSheet = sheet, useMapping = false) {
    event?.preventDefault();
    setError("");
    if (!file || !entityId || !branchId) {
      setError("Choose an entity, default branch and file first.");
      return;
    }
    setBusy(true);
    const data = new FormData();
    data.set("file", file);
    data.set("entity_id", entityId);
    data.set("default_branch_id", branchId);
    data.set("import_mode", mode);
    if (selectedSheet) data.set("worksheet", selectedSheet);
    if (batchId) data.set("batch_id", batchId);
    if (useMapping) data.set("mapping", JSON.stringify(mapping));

    const res = await fetch("/api/students/import/parse", { method: "POST", body: data });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(json.error || "The file could not be previewed.");
      return;
    }
    setBatchId(json.batchId);
    setSheets(json.sheets || []);
    setSheet(json.selectedSheet || "");
    setHeaders(json.headers || []);
    setMapping(json.mapping || {});
    setRows(json.rows || []);
    setMessage(`Preview loaded from ${json.selectedSheet}. Review mapping, validation and duplicate warnings before confirming.`);
    await loadHistory();
  }

  function changeEntity(nextEntityId: string) {
    setEntityId(nextEntityId);
    const entityBranches = branches.filter((branch) => branch.entity_id === nextEntityId);
    setBranchId(entityBranches.find((branch) => branch.branch_code === "KL")?.id || entityBranches[0]?.id || "");
    resetPreview("Entity changed. Upload and preview the file again.");
  }

  function resetPreview(nextMessage = "Preview cleared.") {
    setSheets([]);
    setSheet("");
    setHeaders([]);
    setMapping({});
    setRows([]);
    setBatchId("");
    setMessage(nextMessage);
    setError("");
  }

  function updateMapped(index: number, field: string, value: unknown) {
    setRows((current) => current.map((row, rowIndex) =>
      rowIndex === index ? { ...row, mapped: { ...row.mapped, [field]: value } } : row));
  }

  function updateRow(index: number, patch: Row) {
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  }

  async function confirmImport() {
    setError("");
    if (!batchId) {
      setError("Upload and preview a file first.");
      return;
    }
    const unresolved = rows.filter((row) =>
      !row.excluded
      && row.duplicateWarnings?.length
      && (row.duplicateDecision === "pending" || (row.duplicateDecision === "link_existing" && !row.matchedStudentId)));
    if (unresolved.length) {
      setError(`Resolve duplicate warnings for ${unresolved.length} row(s) before importing.`);
      return;
    }
    const invalid = rows.filter((row) => !row.excluded && row.validationErrors?.length);
    if (invalid.length) {
      setError(`Correct or exclude ${invalid.length} row(s) with validation errors.`);
      return;
    }
    if (!window.confirm(`Import ${rows.filter((row) => !row.excluded).length} selected row(s) into Student Master?`)) return;

    setBusy(true);
    const res = await fetch("/api/students/import/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchId, rows }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      if (json.row_errors) {
        setRows((current) => current.map((row) => ({
          ...row,
          validationErrors: json.row_errors[row.id] || row.validationErrors,
        })));
      }
      setError(json.error || "Import failed.");
      return;
    }
    setMessage(`Import ${json.status}: ${json.successful} imported or linked, ${json.skipped} skipped, ${json.failed} failed.`);
    await loadHistory();
  }

  async function revertBatch(id: string) {
    if (!window.confirm("Revert this import? Only students created by this batch with no later activity will be removed.")) return;
    setBusy(true);
    setError("");
    const res = await fetch("/api/students/import/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchId: id }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(json.error || "Import could not be reverted.");
      return;
    }
    setMessage(`Revert complete: ${json.reverted?.removed_students ?? 0} student(s) and ${json.reverted?.removed_legacy_records ?? 0} legacy record(s) removed; ${json.reverted?.blocked_students ?? 0} protected by later activity.`);
    await loadHistory();
  }

  const scopedBranches = branches.filter((branch) => branch.entity_id === entityId
    && (entities.find((entity) => entity.id === entityId)?.short_code !== "IETA" || ["KL", "PG"].includes(branch.branch_code)));

  return (
    <main>
      <div className="page-header">
        <div>
          <p className="eyebrow">Student Operations</p>
          <h1>Student Import Wizard</h1>
          <p className="subtitle">Preview, validate and resolve duplicates before creating Student Master records. Every new student receives an automatic permanent master number.</p>
        </div>
        <AuthBar />
      </div>

      <nav>
        <Link href="/students">Students</Link>
        <Link href="/student-operations">Dashboard</Link>
      </nav>

      <section className={error ? "notice error" : "notice"}>
        <p>{error || message}</p>
      </section>

      <section className="panel">
        <h2>1. Import mode and file</h2>
        <div className="import-mode-grid">
          <label className={mode === "standard" ? "import-mode selected" : "import-mode"}>
            <input type="radio" name="mode" checked={mode === "standard"} onChange={() => { setMode("standard"); resetPreview("Standard Student Master import selected."); }} />
            <strong>Standard Student Master</strong>
            <span>Imports current students as Draft records. Entity, default branch and full name are the minimum.</span>
          </label>
          <label className={mode === "legacy" ? "import-mode selected" : "import-mode"}>
            <input type="radio" name="mode" checked={mode === "legacy"} onChange={() => { setMode("legacy"); resetPreview("Legacy Student import selected."); }} />
            <strong>Legacy Student / Alumni</strong>
            <span>Accepts incomplete historical records and preserves programme, intake, years and status for later enrichment.</span>
          </label>
        </div>

        <form onSubmit={parseUpload}>
          <label>Entity<select value={entityId} onChange={(event) => changeEntity(event.target.value)} required><option value="">Choose entity</option>{entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.short_code} - {entity.display_name}</option>)}</select></label>
          <label>Default home branch<select value={branchId} onChange={(event) => { setBranchId(event.target.value); resetPreview("Default branch changed. Upload and preview again."); }} required><option value="">Choose branch</option>{scopedBranches.map((branch) => <option key={branch.id} value={branch.id}>{branch.branch_code} - {branch.branch_name}</option>)}</select></label>
          <label className="wide">CSV or XLSX file<input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { setFile(event.target.files?.[0] || null); resetPreview("File selected. Upload it to create a safe preview."); }} /></label>
          {sheets.length > 1 && <label>Worksheet<select value={sheet} onChange={(event) => { setSheet(event.target.value); void parseUpload(undefined, event.target.value, false); }}>{sheets.map((item) => <option key={item.name} value={item.name}>{item.name} ({item.rowCount} rows)</option>)}</select></label>}
          <button disabled={busy}>{busy ? "Working..." : "Upload and Preview"}</button>
        </form>
        <p className="help">The source student number is retained as legacy reference only. It never replaces the automatically generated Student Master Number.</p>
      </section>

      {headers.length > 0 && <section className="panel">
        <h2>2. Map columns</h2>
        <div className="mapping-grid">
          {headers.map((header) => <label key={header}>{header}<select value={mapping[header] || ""} onChange={(event) => setMapping({ ...mapping, [header]: event.target.value })}><option value="">Do not import</option>{importFields.map((field) => <option key={field} value={field}>{field.replaceAll("_", " ")}</option>)}</select></label>)}
        </div>
        <button className="neutral" disabled={busy} onClick={() => void parseUpload(undefined, sheet, true)}>Apply Mapping and Revalidate</button>
      </section>}

      {rows.length > 0 && <section className="panel">
        <h2>3. Preview, validate and resolve duplicates</h2>
        <div className="preview-summary">
          <span>{rows.length} rows</span>
          <span>{rows.filter((row) => !row.excluded && !row.validationErrors?.length).length} ready</span>
          <span>{rows.filter((row) => !row.excluded && row.validationErrors?.length).length} invalid</span>
          <span>{rows.filter((row) => !row.excluded && row.duplicateWarnings?.length).length} duplicate warnings</span>
        </div>
        <div className="wide-table">
          <table>
            <thead><tr><th>Use</th><th>Row</th><th>Full name</th><th>Legacy student no.</th><th>Programme / Intake</th><th>Years / Status</th><th>Duplicate decision</th><th>Validation</th></tr></thead>
            <tbody>{rows.map((row, index) => <tr key={row.id || row.rowNumber} className={row.validationErrors?.length ? "row-invalid" : ""}>
              <td><input type="checkbox" checked={!row.excluded} onChange={(event) => updateRow(index, { excluded: !event.target.checked, duplicateDecision: event.target.checked ? row.duplicateDecision : "skip" })} /></td>
              <td>{row.rowNumber}</td>
              <td><input value={row.mapped?.full_name || ""} onChange={(event) => updateMapped(index, "full_name", event.target.value)} /></td>
              <td><input value={row.mapped?.student_number || ""} onChange={(event) => updateMapped(index, "student_number", event.target.value)} /></td>
              <td>
                <input aria-label={`Programme row ${row.rowNumber}`} value={row.mapped?.programme || ""} onChange={(event) => updateMapped(index, "programme", event.target.value)} placeholder="Programme" />
                <input aria-label={`Intake row ${row.rowNumber}`} value={row.mapped?.intake || ""} onChange={(event) => updateMapped(index, "intake", event.target.value)} placeholder="Intake/class" />
              </td>
              <td>
                <input aria-label={`Enrolment year row ${row.rowNumber}`} value={row.mapped?.enrolment_year || ""} onChange={(event) => updateMapped(index, "enrolment_year", event.target.value)} placeholder="Enrolment year" />
                <input aria-label={`Completion year row ${row.rowNumber}`} value={row.mapped?.completion_year || ""} onChange={(event) => updateMapped(index, "completion_year", event.target.value)} placeholder="Completion year" />
                <input aria-label={`Status row ${row.rowNumber}`} value={row.mapped?.status || ""} onChange={(event) => updateMapped(index, "status", event.target.value)} placeholder="Status" />
              </td>
              <td>{row.duplicateWarnings?.length
                ? <>
                  <select value={row.duplicateDecision || "pending"} onChange={(event) => updateRow(index, { duplicateDecision: event.target.value, matchedStudentId: event.target.value === "link_existing" ? row.matchedStudentId : "" })}>
                    <option value="pending">Choose action</option>
                    <option value="link_existing">Link existing student</option>
                    <option value="import_as_new">Import as new</option>
                    <option value="skip">Skip row</option>
                  </select>
                  {row.duplicateDecision === "link_existing" && <select value={row.matchedStudentId || ""} onChange={(event) => updateRow(index, { matchedStudentId: event.target.value })}><option value="">Choose match</option>{uniqueWarnings(row.duplicateWarnings).map((warning) => <option key={warning.student_id} value={warning.student_id}>{warning.student_number} - {warning.full_name}</option>)}</select>}
                  {row.duplicateWarnings.map((warning: Row, warningIndex: number) => <p className="help" key={`${warning.student_id}-${warningIndex}`}>{warning.match_reason}: {warning.student_number} - {warning.full_name}</p>)}
                </>
                : <span className="status-pill">No match found</span>}</td>
              <td>{row.validationErrors?.map((item: string) => <p className="field-error" key={item}>{item}</p>)}{!row.validationErrors?.length && <span className="status-pill">Ready</span>}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <div className="form-actions">
          <button disabled={busy} onClick={() => void confirmImport()}>{busy ? "Importing..." : "Confirm Import"}</button>
          <button className="neutral" disabled={busy} onClick={() => resetPreview("Preview cancelled. No students were created.")}>Cancel Preview</button>
        </div>
      </section>}

      <section className="panel">
        <h2>Import history and safe revert</h2>
        <p className="help">Revert removes only records created by that batch. Students with later enrolments, documents or edits are protected and reported as blocked.</p>
        <div className="wide-table">
          <table>
            <thead><tr><th>Date</th><th>File</th><th>Mode</th><th>Status</th><th>Rows</th><th>Imported</th><th>Skipped</th><th>Failed</th><th>Action</th></tr></thead>
            <tbody>{history.map((batch) => <tr key={batch.id}>
              <td>{String(batch.created_at || "").slice(0, 10)}</td>
              <td>{batch.filename}{batch.worksheet_name ? ` / ${batch.worksheet_name}` : ""}</td>
              <td>{batch.import_mode}</td>
              <td>{batch.status}</td>
              <td>{batch.total_rows}</td>
              <td>{batch.successful_rows}</td>
              <td>{batch.skipped_rows}</td>
              <td>{batch.failed_rows}</td>
              <td>{["completed", "completed_with_errors"].includes(batch.status) ? <button className="danger" disabled={busy} onClick={() => void revertBatch(batch.id)}>Revert</button> : batch.status === "reverted" ? <span className="help">No action</span> : <span className="help">Revert unavailable</span>}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {!history.length && <p className="empty-state">No Student Import batches yet.</p>}
      </section>
    </main>
  );
}

function uniqueWarnings(warnings: Row[]) {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    if (!warning.student_id || seen.has(warning.student_id)) return false;
    seen.add(warning.student_id);
    return true;
  });
}
