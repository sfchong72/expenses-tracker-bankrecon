"use client";

import { FormEvent, useMemo, useState } from "react";
import Link from "next/link";
import { AuthBar } from "@/app/auth-bar";
import { createClient } from "@/lib/supabase/client";

type Row = Record<string, any>;

const fields = [
  "entity",
  "supplier_name",
  "registration_number",
  "contact_person",
  "email",
  "phone",
  "bank_name",
  "bank_account_number",
  "description",
  "expense_category",
  "fixed_or_variable",
  "expected_amount",
  "frequency",
  "due_day",
  "start_date",
  "end_date",
  "reminder_days",
  "required_document_type",
  "auto_generate_bill",
  "auto_generate_payment_voucher",
  "account_reference_details",
  "account_code_or_SQL_reference",
  "remarks",
  "active_status",
  "applicable_entities",
];

const labels: Record<string, string> = {
  entity: "Entity",
  supplier_name: "Supplier/payee",
  description: "Description",
  expense_category: "Category",
  fixed_or_variable: "Fixed/variable",
  expected_amount: "Amount",
  due_day: "Due day",
  account_reference_details: "Account/reference",
};

export default function SupplierImportPage() {
  const supabase = useMemo(() => createClient(), []);
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<Row[]>([]);
  const [sheet, setSheet] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<Row[]>([]);
  const [batchId, setBatchId] = useState("");
  const [history, setHistory] = useState<Row[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [message, setMessage] = useState("Upload a CSV or XLSX file to start. No production records are created until Confirm Import.");
  const [busy, setBusy] = useState(false);

  async function parseUpload(event?: FormEvent, selectedSheet = sheet) {
    event?.preventDefault();
    if (!file) return setMessage("Choose a CSV or XLSX file first.");
    setBusy(true);
    const form = new FormData();
    form.append("file", file);
    if (selectedSheet) form.append("worksheet", selectedSheet);
    const res = await fetch("/api/import/supplier-recurring/parse", { method: "POST", body: form });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) return setMessage(json.error || "Could not parse file.");
    setSheets(json.sheets || []);
    setSheet(json.selectedSheet || "");
    setHeaders(json.headers || []);
    setMapping(json.mapping || {});
    setRows((json.rows || []).map((row: Row) => ({ ...row, duplicateDecision: row.duplicateWarnings?.length ? "pending" : "import_as_new", createCategory: false })));
    setBatchId(json.batchId);
    setMessage(`Preview loaded from ${json.selectedSheet}. Review, map, correct, then confirm.`);
    void loadHistory();
  }

  function applyMapping() {
    setRows((current) => current.map((row) => {
      const mapped: Row = {};
      for (const [header, field] of Object.entries(mapping)) {
        if (field) mapped[field] = row.original?.[header] ?? "";
      }
      return { ...row, mapped: { ...row.mapped, ...mapped } };
    }));
    setMessage("Mapping applied to preview rows. Review row-level corrections before confirming.");
  }

  function updateRow(index: number, field: string, value: unknown) {
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, mapped: { ...row.mapped, [field]: value } } : row));
  }

  async function confirmImport() {
    if (!batchId) return setMessage("No import batch is ready.");
    const unresolved = rows.filter((row) => !row.excluded && row.duplicateWarnings?.length && row.duplicateDecision === "pending");
    if (unresolved.length) return setMessage("Resolve duplicate warnings before confirming.");
    const uncertain = rows.filter((row) => !row.excluded && row.requiresConfirmation && !row.userConfirmed);
    if (uncertain.length) return setMessage("Confirm uncertain supplier/payee rows before importing.");
    setBusy(true);
    const res = await fetch("/api/import/supplier-recurring/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchId, rows }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) return setMessage(json.error || "Import failed.");
    setMessage(`Import ${json.status}: ${json.successful} successful, ${json.skipped} skipped, ${json.failed} failed.`);
    void loadHistory();
  }

  async function loadHistory(archived = showArchived) {
    let query = supabase
      .from("import_batches")
      .select("*")
      .eq("import_type", "supplier_recurring")
      .order("uploaded_at", { ascending: false })
      .limit(20);
    query = archived ? query.not("archived_at", "is", null) : query.is("archived_at", null).is("discarded_at", null);
    const { data } = await query;
    setHistory(data || []);
  }

  async function resumeBatch(batch: Row) {
    const { data, error } = await supabase
      .from("import_batch_rows")
      .select("*")
      .eq("import_batch_id", batch.id)
      .order("row_number", { ascending: true });
    if (error) return setMessage(error.message);
    const sourceRows = data || [];
    const first = sourceRows[0]?.original_data || {};
    setBatchId(batch.id);
    setHeaders(Object.keys(first));
    setMapping(batch.mapping_config || {});
    setRows(sourceRows.map((row) => ({
      rowNumber: row.row_number,
      original: row.original_data || {},
      mapped: row.mapped_data || {},
      validationErrors: row.validation_errors || [],
      duplicateWarnings: row.duplicate_warnings || [],
      requiresConfirmation: row.requires_confirmation,
      excluded: row.excluded,
      duplicateDecision: row.duplicate_decision,
      existingSupplierId: row.supplier_id,
      existingRecurringId: row.recurring_obligation_id,
      createCategory: false,
    })));
    setMessage(`Resumed ${batch.filename}. Review the rows before confirming or retrying.`);
  }

  function productionExists(batch: Row) {
    return Boolean(batch.has_created_records || Number(batch.successful_rows || 0) > 0);
  }

  function actionEffect(action: "discard" | "archive" | "revert", batch: Row) {
    if (action === "discard") return "Preview rows for this unconfirmed batch will be removed from active history. No supplier or recurring-obligation production records will be changed.";
    if (action === "archive") return "This batch will disappear from the default active history list but will remain available under Show Archived for audit evidence.";
    return "Only supplier and recurring-obligation records created by this completed batch will be reverted where they are not already used by bills, vouchers, payments or documents.";
  }

  function confirmBatchAction(action: "discard" | "archive" | "revert", batch: Row) {
    const actionName = action === "discard" ? "Discard Batch" : action === "archive" ? "Archive Batch" : "Revert Import Batch";
    const text = [
      actionName,
      "",
      `Filename: ${batch.filename}`,
      `Upload date: ${new Date(batch.uploaded_at).toLocaleString()}`,
      `Status: ${batch.status}`,
      `Rows: ${batch.total_rows}`,
      `Production records exist: ${productionExists(batch) ? "Yes" : "No"}`,
      "",
      actionEffect(action, batch),
      "",
      "Type YES to continue.",
    ].join("\n");
    return window.prompt(text) === "YES";
  }

  async function runBatchAction(batch: Row, action: "discard" | "archive") {
    if (!confirmBatchAction(action, batch)) return;
    const res = await fetch("/api/import/supplier-recurring/batch-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchId: batch.id, action }),
    });
    const json = await res.json();
    if (!res.ok) setMessage(json.error || `${action} failed.`);
    else setMessage(action === "discard" ? "Batch discarded. No production records were changed." : "Batch archived. It remains available under Show Archived.");
    void loadHistory();
  }

  async function revertBatch(id: string) {
    const batch = history.find((item) => item.id === id);
    if (batch && !confirmBatchAction("revert", batch)) return;
    const res = await fetch("/api/import/supplier-recurring/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchId: id }),
    });
    const json = await res.json();
    if (!res.ok) setMessage(json.error || "Revert failed.");
    else setMessage(`Revert complete. Removed suppliers: ${json.reverted?.removed_suppliers ?? 0}; recurring: ${json.reverted?.removed_recurring_obligations ?? 0}. Production records remain: ${json.reverted?.production_records_remain ? "yes" : "no"}.`);
    void loadHistory();
  }

  function historyActions(batch: Row) {
    if (batch.status === "processing") return <span className="help">Processing</span>;
    if (["uploaded", "mapping", "review", "ready"].includes(batch.status)) {
      return <>
        <button onClick={() => void resumeBatch(batch)}>Resume</button>
        <button onClick={() => void runBatchAction(batch, "discard")}>Discard</button>
      </>;
    }
    if (["completed", "completed_with_errors"].includes(batch.status)) {
      return <>
        <a href={`/api/import/supplier-recurring/export?batchId=${batch.id}`}>Export Result</a>
        <button onClick={() => void revertBatch(batch.id)}>Revert Import Batch</button>
        <button onClick={() => void runBatchAction(batch, "archive")}>Archive</button>
      </>;
    }
    if (batch.status === "failed") {
      return <>
        <button onClick={() => void resumeBatch(batch)}>View Errors / Retry</button>
        <button onClick={() => void runBatchAction(batch, "discard")}>Discard</button>
      </>;
    }
    if (batch.status === "reverted") {
      return <>
        <a href={`/api/import/supplier-recurring/export?batchId=${batch.id}`}>Export Result</a>
        <button onClick={() => void runBatchAction(batch, "archive")}>Archive</button>
      </>;
    }
    return <a href={`/api/import/supplier-recurring/export?batchId=${batch.id}`}>Export Result</a>;
  }

  return (
    <main>
      <header>
        <div>
          <span>Supplier Import</span>
          <h1>Import Suppliers & Recurring Obligations</h1>
        </div>
        <div className="actions">
          <Link className="button neutral" href="/suppliers">Supplier List</Link>
          <Link className="button secondary" href="/api/import/supplier-recurring/template">Download Import Template</Link>
        </div>
        <AuthBar />
      </header>

      <div className="notice"><span>{message}</span></div>

      <section className="panel">
        <h2>CSV Recommended</h2>
        <p className="help">
          CSV is the safest production import format for now. XLSX is available for convenience, but the lightweight parser is limited: it reads simple worksheets and stored cell values only, does not calculate formulas, does not expand merged cells, and may not fully interpret Excel formatting metadata. If XLSX parsing fails, no supplier or recurring-obligation records are created.
        </p>
      </section>

      <section className="panel">
        <h2>1. Upload and Select Worksheet</h2>
        <form onSubmit={parseUpload}>
          <label className="wide">CSV or XLSX file<input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => setFile(event.target.files?.[0] || null)} /></label>
          {sheets.length > 1 && <label>Worksheet<select value={sheet} onChange={(event) => { setSheet(event.target.value); void parseUpload(undefined, event.target.value); }}>{sheets.map((item) => <option key={item.name} value={item.name}>{item.name} ({item.rowCount} rows)</option>)}</select></label>}
          <button disabled={busy}>{busy ? "Working..." : "Upload and Preview"}</button>
        </form>
      </section>

      {headers.length > 0 && <section className="panel">
        <h2>2. Map Columns</h2>
        <div className="mapping-grid">
          {headers.map((header) => <label key={header}>{header}<select value={mapping[header] || ""} onChange={(event) => setMapping({ ...mapping, [header]: event.target.value })}><option value="">Do not import</option>{fields.map((field) => <option key={field} value={field}>{field}</option>)}</select></label>)}
        </div>
        <button onClick={applyMapping}>Apply Mapping to Preview</button>
      </section>}

      {rows.length > 0 && <section className="panel">
        <h2>3. Preview, Correct, Exclude and Resolve Duplicates</h2>
        <div className="wide-table">
          <table>
            <thead><tr><th>Use</th><th>Row</th><th>Entity</th><th>Supplier/payee</th><th>Description</th><th>Category</th><th>Amount</th><th>Due</th><th>Account/reference</th><th>Duplicate decision</th><th>Checks</th></tr></thead>
            <tbody>
              {rows.map((row, index) => <tr key={row.rowNumber}>
                <td><input type="checkbox" checked={!row.excluded} onChange={(event) => setRows(rows.map((item, i) => i === index ? { ...item, excluded: !event.target.checked } : item))} /></td>
                <td>{row.rowNumber}</td>
                <td><input value={row.mapped.entity || ""} onChange={(event) => updateRow(index, "entity", event.target.value)} /></td>
                <td><input value={row.mapped.supplier_name || ""} onChange={(event) => updateRow(index, "supplier_name", event.target.value)} /></td>
                <td><input value={row.mapped.description || ""} onChange={(event) => updateRow(index, "description", event.target.value)} /></td>
                <td><input value={row.mapped.expense_category || ""} onChange={(event) => updateRow(index, "expense_category", event.target.value)} /><label className="inline"><input type="checkbox" checked={row.createCategory || false} onChange={(event) => setRows(rows.map((item, i) => i === index ? { ...item, createCategory: event.target.checked } : item))} /> create</label></td>
                <td><input value={row.mapped.expected_amount || ""} onChange={(event) => updateRow(index, "expected_amount", event.target.value)} /></td>
                <td><input value={row.mapped.due_day || ""} onChange={(event) => updateRow(index, "due_day", event.target.value)} /></td>
                <td><input value={row.mapped.account_reference_details || ""} onChange={(event) => updateRow(index, "account_reference_details", event.target.value)} /></td>
                <td>{row.duplicateWarnings?.length ? <select value={row.duplicateDecision || "pending"} onChange={(event) => setRows(rows.map((item, i) => i === index ? { ...item, duplicateDecision: event.target.value } : item))}><option value="pending">Choose</option><option value="skip">Skip</option><option value="update_existing">Update existing</option><option value="import_as_new">Import as new</option></select> : <span>No duplicate</span>}</td>
                <td>
                  {row.requiresConfirmation && <label className="inline"><input type="checkbox" checked={row.userConfirmed || false} onChange={(event) => setRows(rows.map((item, i) => i === index ? { ...item, userConfirmed: event.target.checked } : item))} /> confirm supplier</label>}
                  {row.validationErrors?.map((item: string) => <p className="error-text" key={item}>{item}</p>)}
                  {row.duplicateWarnings?.map((item: Row, warningIndex: number) => <p className="help" key={warningIndex}>Possible {item.type}: {item.existing?.supplier_name || item.existing?.description}</p>)}
                </td>
              </tr>)}
            </tbody>
          </table>
        </div>
        <div className="actions"><button disabled={busy} onClick={confirmImport}>Confirm Import</button>{batchId && <a className="button" href={`/api/import/supplier-recurring/export?batchId=${batchId}`}>Export Result</a>}</div>
      </section>}

      <section className="panel">
        <h2>Import Batch History <button onClick={() => void loadHistory()}>Refresh</button></h2>
        <label className="inline">
          <input type="checkbox" checked={showArchived} onChange={(event) => { const next = event.target.checked; setShowArchived(next); setHistory([]); void loadHistory(next); }} />
          Show archived
        </label>
        {!history.length ? <div className="empty">{showArchived ? "No archived import batches loaded." : "No active import batches loaded in this browser session yet."}</div> : <table><thead><tr><th>Date</th><th>File</th><th>Status</th><th>Rows</th><th>Production records</th><th>Result</th><th /></tr></thead><tbody>{history.map((batch) => <tr key={batch.id}><td>{new Date(batch.uploaded_at).toLocaleString()}</td><td>{batch.filename}</td><td>{batch.status}</td><td>{batch.total_rows}</td><td>{productionExists(batch) ? "Yes" : "No"}</td><td>{batch.successful_rows} successful, {batch.skipped_rows} skipped, {batch.failed_rows} failed</td><td className="actions">{historyActions(batch)}</td></tr>)}</tbody></table>}
      </section>
    </main>
  );
}
