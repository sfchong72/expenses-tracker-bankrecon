"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AuthBar } from "@/app/auth-bar";
import { createClient } from "@/lib/supabase/client";

type Row = Record<string, any>;

const fields = [
  "transaction_date",
  "transaction_time",
  "value_date",
  "description",
  "additional_description",
  "reference_number",
  "debit",
  "credit",
  "amount",
  "direction",
  "running_balance",
];

export default function BankImportsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [entities, setEntities] = useState<Row[]>([]);
  const [accounts, setAccounts] = useState<Row[]>([]);
  const [history, setHistory] = useState<Row[]>([]);
  const [entityId, setEntityId] = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [statementMonth, setStatementMonth] = useState(new Date().toISOString().slice(0, 7));
  const [preset, setPreset] = useState("generic");
  const [file, setFile] = useState<File | null>(null);
  const [pastedRows, setPastedRows] = useState("");
  const [sheets, setSheets] = useState<Row[]>([]);
  const [sheet, setSheet] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<Row[]>([]);
  const [batchId, setBatchId] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [acknowledgeReview, setAcknowledgeReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("CSV is recommended. Preview and Confirm Import are required before production bank transactions are created.");

  useEffect(() => { void loadLookups(); }, []);
  useEffect(() => { void loadHistory(); }, [showArchived]);
  useEffect(() => {
    if (!entityId && entities[0]) setEntityId(entities[0].id);
  }, [entities, entityId]);
  useEffect(() => {
    const first = accounts.find((account) => account.entity_id === entityId);
    if (first && !accounts.some((account) => account.id === bankAccountId && account.entity_id === entityId)) setBankAccountId(first.id);
  }, [accounts, bankAccountId, entityId]);

  async function loadLookups() {
    const [entityRes, accountRes] = await Promise.all([
      supabase.from("entities").select("id, short_code, display_name, legal_name").eq("active_status", true).order("short_code"),
      supabase.from("bank_accounts_staff_safe").select("*").order("bank_name"),
    ]);
    setEntities(entityRes.data || []);
    setAccounts(accountRes.data || []);
  }

  async function loadHistory() {
    let query = supabase.from("bank_import_batches_staff_safe").select("*").order("uploaded_at", { ascending: false }).limit(30);
    query = showArchived ? query.eq("status", "archived") : query.not("status", "in", "(discarded,archived)");
    const { data } = await query;
    setHistory(data || []);
  }

  async function parseImport(event?: FormEvent, selectedSheet = sheet) {
    event?.preventDefault();
    if (!entityId || !bankAccountId) return setMessage("Select an entity and bank account first.");
    if (!file && !pastedRows.trim()) return setMessage("Upload a CSV/XLSX file or paste spreadsheet rows.");
    setBusy(true);
    const form = new FormData();
    form.append("entityId", entityId);
    form.append("bankAccountId", bankAccountId);
    form.append("statementMonth", statementMonth);
    form.append("preset", preset);
    if (selectedSheet) form.append("worksheet", selectedSheet);
    if (file) form.append("file", file);
    if (pastedRows.trim()) form.append("pastedRows", pastedRows);
    const res = await fetch("/api/bank-imports/parse", { method: "POST", body: form });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) return setMessage(json.error || "Could not parse bank import. CSV is the safe fallback.");
    setSheets(json.sheets || []);
    setSheet(json.selectedSheet || "");
    setHeaders(json.headers || []);
    setMapping(json.mapping || {});
    setRows((json.rows || []).map((row: Row) => ({ ...row, duplicateDecision: row.duplicateWarnings?.length ? "pending" : "import_as_new" })));
    setBatchId(json.batchId);
    setMessage(`Preview loaded from ${json.selectedSheet}. No production data has been created.`);
    void loadHistory();
  }

  async function applyMapping() {
    if (!rows.length) return;
    setBusy(true);
    const res = await fetch("/api/bank-imports/reprocess", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows, mapping, bankAccountId, entityId, statementMonth }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) return setMessage(json.error || "Could not apply mapping.");
    setRows(json.rows || []);
    setMessage("Mapping applied. Dates, debit/credit direction and amounts were recalculated for the preview.");
  }

  function updateMapped(index: number, field: string, value: unknown) {
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, mapped: { ...row.mapped, [field]: value } } : row));
  }

  async function confirmImport() {
    if (!batchId) return setMessage("No preview batch is ready.");
    const pending = rows.filter((row) => !row.excluded && row.duplicateWarnings?.length && row.duplicateDecision === "pending");
    if (pending.length) return setMessage("Resolve duplicate warnings before confirming.");
    const critical = rows.filter(rowHasCriticalError);
    if (critical.length) return setMessage(`Exclude or correct ${critical.length} row(s) with missing date, direction or amount before confirming.`);
    setBusy(true);
    const res = await fetch("/api/bank-imports/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchId, rows, acknowledgeReview }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) return setMessage(json.error || "Confirm Import failed.");
    setMessage(`Import ${json.status}: ${json.successful} imported, ${json.skipped} skipped, ${json.failed} failed.`);
    setRows([]);
    setBatchId("");
    void loadHistory();
  }

  async function runBatchAction(batch: Row, action: "discard" | "archive") {
    const text = [
      action === "discard" ? "Discard Batch" : "Archive Batch",
      "",
      `Filename: ${batch.filename}`,
      `Upload date: ${new Date(batch.uploaded_at).toLocaleString()}`,
      `Status: ${batch.status}`,
      `Rows: ${batch.total_rows}`,
      "",
      action === "discard"
        ? "Only unconfirmed preview rows will be removed. Production bank transactions are not touched."
        : "The batch remains preserved for audit and disappears from the active list.",
      "",
      "Type YES to continue.",
    ].join("\n");
    if (window.prompt(text) !== "YES") return;
    const res = await fetch("/api/bank-imports/batch-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchId: batch.id, action }),
    });
    const json = await res.json();
    setMessage(res.ok ? `${action === "discard" ? "Discarded" : "Archived"} ${batch.filename}.` : json.error || "Batch action failed.");
    void loadHistory();
  }

  const entityAccounts = accounts.filter((account) => account.entity_id === entityId);
  const criticalCount = rows.filter(rowHasCriticalError).length;
  const pendingDuplicateCount = rows.filter((row) => !row.excluded && row.duplicateWarnings?.length && row.duplicateDecision === "pending").length;

  return (
    <main className="page-shell">
      <div className="page-header">
        <div>
          <p className="eyebrow">PHASE 3A</p>
          <h1>Bank Statement Imports</h1>
          <p className="subtitle">CSV recommended. XLSX formulas are not calculated, merged cells are limited, and preview is mandatory.</p>
        </div>
        <AuthBar />
      </div>

      <div className="statusbar"><span>{message}</span><button onClick={() => void loadHistory()}>Refresh</button></div>

      <section className="split-grid">
        <form className="panel" onSubmit={(event) => void parseImport(event)}>
          <h2>Import Monthly Statement</h2>
          <div className="form-grid">
            <label>Entity<select value={entityId} onChange={(event) => setEntityId(event.target.value)}>{entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.short_code}</option>)}</select></label>
            <label>Bank account<select value={bankAccountId} onChange={(event) => setBankAccountId(event.target.value)}>{entityAccounts.map((account) => <option key={account.id} value={account.id}>{account.bank_name} - {account.account_name}</option>)}</select></label>
            <label>Statement month<input type="month" value={statementMonth} onChange={(event) => setStatementMonth(event.target.value)} /></label>
            <label>Bank preset<select value={preset} onChange={(event) => setPreset(event.target.value)}><option value="generic">Generic CSV/XLSX</option><option value="cimb">CIMB</option><option value="public_bank">Public Bank</option></select></label>
          </div>
          <label>CSV/XLSX file<input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
          <label>Pasted spreadsheet rows<textarea value={pastedRows} onChange={(event) => setPastedRows(event.target.value)} placeholder="Paste copied spreadsheet rows here for exception imports" /></label>
          <button className="primary" disabled={busy}>Preview Import</button>
          {sheets.length > 1 && <label>Worksheet<select value={sheet} onChange={(event) => { setSheet(event.target.value); void parseImport(undefined, event.target.value); }}>{sheets.map((item) => <option key={item.name} value={item.name}>{item.name} ({item.rowCount} rows)</option>)}</select></label>}
        </form>

        <section className="panel">
          <h2>Import Batch History</h2>
          <label className="inline-check"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived</label>
          <div className="table-wrap">
            <table>
              <thead><tr><th>File</th><th>Month</th><th>Status</th><th>Rows</th><th>Actions</th></tr></thead>
              <tbody>{history.map((batch) => (
                <tr key={batch.id}>
                  <td><Link href={`/bank-imports/${batch.id}`}>{batch.filename}</Link></td>
                  <td>{new Date(batch.statement_month).toLocaleDateString("en-MY", { month: "long", year: "numeric" })}</td>
                  <td>{batch.status}</td>
                  <td>{batch.successful_rows}/{batch.total_rows}</td>
                  <td className="button-row">
                    {["uploaded", "mapping", "review", "ready", "failed"].includes(batch.status) && <button onClick={() => void runBatchAction(batch, "discard")}>Discard</button>}
                    {["completed", "completed_with_errors"].includes(batch.status) && <a href={`/api/bank-imports/export?batchId=${batch.id}`}>Export Result</a>}
                    {["completed", "completed_with_errors"].includes(batch.status) && <button onClick={() => void runBatchAction(batch, "archive")}>Archive</button>}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      </section>

      {headers.length > 0 && <section className="panel">
        <h2>Column Mapping</h2>
        <div className="mapping-grid">
          {headers.map((header) => <label key={header}>{header}<select value={mapping[header] || ""} onChange={(event) => setMapping({ ...mapping, [header]: event.target.value })}><option value="">Ignore</option>{fields.map((field) => <option key={field} value={field}>{field}</option>)}</select></label>)}
        </div>
        <button onClick={() => void applyMapping()} disabled={busy}>Apply Mapping</button>
      </section>}

      {rows.length > 0 && <section className="panel">
        <div className="section-heading">
          <h2>Preview Rows</h2>
          <label className="inline-check"><input type="checkbox" checked={acknowledgeReview} onChange={(event) => setAcknowledgeReview(event.target.checked)} /> I understand incomplete or suspicious rows require later review</label>
          <button className="primary" onClick={() => void confirmImport()} disabled={busy || criticalCount > 0 || pendingDuplicateCount > 0}>Confirm Import</button>
        </div>
        {criticalCount > 0 && <p className="error-text">{criticalCount} included row(s) still need a usable transaction date, direction and amount. Exclude or correct them before confirming.</p>}
        {pendingDuplicateCount > 0 && <p className="error-text">{pendingDuplicateCount} duplicate warning(s) still need a decision.</p>}
        <div className="table-wrap bank-preview-wrap">
          <table className="bank-preview-table">
            <thead><tr><th>Use</th><th>Transaction date</th><th>Value date</th><th>Description</th><th>Reference</th><th>Debit</th><th>Credit</th><th>Direction</th><th>Amount</th><th>Warnings</th><th>Duplicate</th></tr></thead>
            <tbody>{rows.map((row, index) => (
              <tr key={row.rowNumber} className={row.excluded ? "muted-row" : rowHasCriticalError(row) ? "selected-row" : ""}>
                <td><input type="checkbox" checked={!row.excluded} onChange={(event) => setRows((current) => current.map((item, i) => i === index ? { ...item, excluded: !event.target.checked } : item))} /></td>
                <td><input value={row.mapped?.transaction_date || ""} onChange={(event) => updateMapped(index, "transaction_date", event.target.value)} /></td>
                <td><input value={row.mapped?.value_date || ""} onChange={(event) => updateMapped(index, "value_date", event.target.value)} /></td>
                <td><textarea className="compact-textarea" value={row.mapped?.description || ""} onChange={(event) => updateMapped(index, "description", event.target.value)} /></td>
                <td><input value={row.mapped?.reference_number || ""} onChange={(event) => updateMapped(index, "reference_number", event.target.value)} /></td>
                <td><input value={row.mapped?.source_debit_amount ?? row.mapped?.debit_amount ?? ""} onChange={(event) => updateMapped(index, "debit", event.target.value)} /></td>
                <td><input value={row.mapped?.source_credit_amount ?? row.mapped?.credit_amount ?? ""} onChange={(event) => updateMapped(index, "credit", event.target.value)} /></td>
                <td><select value={row.mapped?.direction || ""} onChange={(event) => updateMapped(index, "direction", event.target.value)}><option value="">Choose</option><option value="debit">Debit</option><option value="credit">Credit</option></select></td>
                <td><input value={row.mapped?.amount || row.mapped?.debit_amount || row.mapped?.credit_amount || ""} onChange={(event) => updateMapped(index, "amount", event.target.value)} /></td>
                <td><WarningBadges row={row} /></td>
                <td><select value={row.duplicateDecision || "import_as_new"} onChange={(event) => setRows((current) => current.map((item, i) => i === index ? { ...item, duplicateDecision: event.target.value } : item))}><option value="import_as_new">Import as new</option><option value="skip">Skip</option><option value="review_manually">Review manually</option><option value="pending">Pending</option></select></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>}
    </main>
  );
}

function WarningBadges({ row }: { row: Row }) {
  const critical = row.validationErrors || [];
  const review = row.mapped?.review_warnings || [];
  const duplicates = (row.duplicateWarnings || []).map((item: Row) => item.reason || item.type);
  const warnings = [
    ...critical.map((text: string) => ({ text, tone: "danger" })),
    ...review.map((text: string) => ({ text, tone: "review" })),
    ...duplicates.map((text: string) => ({ text, tone: "review" })),
  ];
  if (row.excluded) return <span className="status-pill">Excluded</span>;
  if (!warnings.length) return <span className="status-pill status-paid">OK</span>;
  return (
    <div className="warning-stack">
      {warnings.map((warning, index) => <span className={`warning-badge ${warning.tone}`} key={`${warning.text}-${index}`}>{warning.text}</span>)}
    </div>
  );
}

function rowHasCriticalError(row: Row) {
  if (row.excluded) return false;
  const mapped = row.mapped || {};
  const amount = parseUiAmount(mapped.amount ?? mapped.debit_amount ?? mapped.credit_amount);
  return !mapped.transaction_date
    || !String(mapped.description ?? "").trim()
    || !["debit", "credit"].includes(String(mapped.direction))
    || amount <= 0;
}

function parseUiAmount(value: unknown) {
  const cleaned = String(value ?? "").replace(/rm/gi, "").replace(/,/g, "").replace(/[()]/g, (char) => char === "(" ? "-" : "").replace(/[^\d.-]/g, "");
  const number = Number(cleaned);
  return Number.isFinite(number) ? Math.abs(number) : 0;
}
