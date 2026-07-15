"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AuthBar } from "@/app/auth-bar";
import { createClient } from "@/lib/supabase/client";

type Row = Record<string, any>;

const today = new Date().toISOString().slice(0, 10);
const month = today.slice(0, 7);
const claimImportFields = [
  "statement_date",
  "transaction_date",
  "cardholder_name",
  "card_last_four",
  "card_type",
  "merchant_or_supplier",
  "transaction_description",
  "business_purpose",
  "expense_category",
  "amount",
  "tax_amount",
  "original_currency",
  "exchange_rate",
  "payment_method",
  "invoice_or_receipt_number",
  "receipt_date",
  "remarks",
];

export default function ClaimImportPage() {
  const db = useMemo(() => createClient(), []);
  const [entities, setEntities] = useState<Row[]>([]);
  const [profiles, setProfiles] = useState<Row[]>([]);
  const [categories, setCategories] = useState<Row[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [entityId, setEntityId] = useState("");
  const [statementMonth, setStatementMonth] = useState(month);
  const [sheets, setSheets] = useState<Row[]>([]);
  const [sheet, setSheet] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<Row[]>([]);
  const [batchId, setBatchId] = useState("");
  const [claim, setClaim] = useState({ claim_type: "personal_credit_card_claim", claimant_user_id: "", claimant_name: "", designation: "", department: "", statement_date: today, trip_or_business_purpose: "Monthly credit-card claim", remarks: "" });
  const [message, setMessage] = useState("Upload CSV or XLSX to preview. No claim is created until Confirm Import.");
  const [busy, setBusy] = useState(false);

  useEffect(() => { void loadLookups(); }, []);

  async function loadLookups() {
    const [entityRes, profileRes, categoryRes] = await Promise.all([
      db.from("entities").select("id, short_code, display_name").eq("active_status", true).order("short_code"),
      db.from("app_profiles").select("id, display_name, email").order("display_name"),
      db.from("categories").select("id, name, account_code").eq("category_type", "expense").eq("active_status", true).order("name"),
    ]);
    setEntities(entityRes.data || []);
    setProfiles(profileRes.data || []);
    setCategories(categoryRes.data || []);
  }

  async function parseUpload(event?: FormEvent, selectedSheet = sheet) {
    event?.preventDefault();
    if (!file || !entityId) return setMessage("Choose an entity and file first.");
    setBusy(true);
    const form = new FormData();
    form.set("file", file);
    form.set("entity_id", entityId);
    form.set("statement_month", `${statementMonth}-01`);
    if (selectedSheet) form.set("worksheet", selectedSheet);
    const res = await fetch("/api/claims/import/parse", { method: "POST", body: form });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) return setMessage(json.error || "Could not parse file.");
    setSheets(json.sheets || []);
    setSheet(json.selectedSheet || "");
    setHeaders(json.headers || []);
    setMapping(json.mapping || {});
    setRows((json.rows || []).map((row: Row) => ({ ...row, duplicateDecision: row.duplicateWarnings?.length ? "pending" : "import_as_new" })));
    setBatchId(json.batchId);
    setMessage(`Preview loaded from ${json.selectedSheet}. Map, correct, resolve duplicates, then confirm.`);
  }

  function applyMapping() {
    setRows(rows.map((row) => {
      const mapped: Row = {};
      for (const [header, field] of Object.entries(mapping)) {
        if (field) mapped[field] = row.original?.[header] ?? "";
      }
      return { ...row, mapped: { ...row.mapped, ...mapped } };
    }));
    setMessage("Mapping applied to preview rows. Review corrections before confirming.");
  }

  function updateRow(index: number, field: string, value: unknown) {
    setRows(rows.map((row, rowIndex) => rowIndex === index ? { ...row, mapped: { ...row.mapped, [field]: value } } : row));
  }

  async function confirmImport() {
    if (!batchId) return setMessage("No import batch is ready.");
    const unresolved = rows.filter((row) => !row.excluded && row.duplicateWarnings?.length && row.duplicateDecision === "pending");
    if (unresolved.length) return setMessage("Resolve duplicate warnings before confirming.");
    const invalid = rows.filter((row) => !row.excluded && row.validationErrors?.length);
    if (invalid.length) return setMessage("Correct or exclude rows with validation errors before confirming.");
    setBusy(true);
    const res = await fetch("/api/claims/import/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchId, claim, rows }),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) return setMessage(json.error || "Import failed.");
    setMessage(`Import ${json.status}: ${json.successful} imported, ${json.skipped} skipped, ${json.failed} failed. Claim created.`);
    if (json.claimId) window.location.href = `/claims/${json.claimId}`;
  }

  return (
    <main>
      <header>
        <div>
          <span>Claims Import</span>
          <h1>Credit Card Claim Import</h1>
          <p className="subtitle">CSV is recommended. XLSX is available for simple worksheets only; formulas are not calculated and merged cells are not reliable.</p>
        </div>
        <div className="actions">
          <Link className="button neutral" href="/claims">Claims</Link>
          <Link className="button secondary" href="/api/claims/import/template">Download CSV Template</Link>
        </div>
        <AuthBar />
      </header>

      <section className="notice"><p>{message}</p></section>

      <section className="panel">
        <h2>1. Claim Header and File</h2>
        <form onSubmit={parseUpload}>
          <label>Entity<select value={entityId} onChange={(event) => setEntityId(event.target.value)} required><option value="">Choose</option>{entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.short_code}</option>)}</select></label>
          <label>Statement month<input type="month" value={statementMonth} onChange={(event) => setStatementMonth(event.target.value)} /></label>
          <label>Claim type<select value={claim.claim_type} onChange={(event) => setClaim({ ...claim, claim_type: event.target.value })}><option value="personal_credit_card_claim">Personal credit card claim</option><option value="company_credit_card_claim">Company credit card claim</option><option value="director_claim">Director claim</option></select></label>
          <label>Claimant user<select value={claim.claimant_user_id} onChange={(event) => { const profile = profiles.find((item) => item.id === event.target.value); setClaim({ ...claim, claimant_user_id: event.target.value, claimant_name: profile?.display_name || profile?.email || claim.claimant_name }); }}><option value="">Manual claimant</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.display_name || profile.email}</option>)}</select></label>
          <label>Claimant name<input value={claim.claimant_name} onChange={(event) => setClaim({ ...claim, claimant_name: event.target.value })} required /></label>
          <label>Statement date<input type="date" value={claim.statement_date} onChange={(event) => setClaim({ ...claim, statement_date: event.target.value })} /></label>
          <label className="wide">Business purpose<input value={claim.trip_or_business_purpose} onChange={(event) => setClaim({ ...claim, trip_or_business_purpose: event.target.value })} /></label>
          <label className="wide">CSV or XLSX file<input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => setFile(event.target.files?.[0] || null)} /></label>
          {sheets.length > 1 && <label>Worksheet<select value={sheet} onChange={(event) => { setSheet(event.target.value); void parseUpload(undefined, event.target.value); }}>{sheets.map((item) => <option key={item.name} value={item.name}>{item.name} ({item.rowCount} rows)</option>)}</select></label>}
          <button disabled={busy}>{busy ? "Working..." : "Upload and Preview"}</button>
        </form>
      </section>

      {headers.length > 0 && <section className="panel">
        <h2>2. Map Columns</h2>
        <div className="mapping-grid">{headers.map((header) => <label key={header}>{header}<select value={mapping[header] || ""} onChange={(event) => setMapping({ ...mapping, [header]: event.target.value })}><option value="">Do not import</option>{claimImportFields.map((field) => <option key={field} value={field}>{field}</option>)}</select></label>)}</div>
        <button onClick={applyMapping}>Apply Mapping</button>
      </section>}

      {rows.length > 0 && <section className="panel">
        <h2>3. Preview and Confirm</h2>
        <div className="wide-table">
          <table>
            <thead><tr><th>Use</th><th>Row</th><th>Date</th><th>Card</th><th>Merchant</th><th>Description</th><th>Category</th><th>Amount</th><th>Duplicate</th><th>Warnings</th></tr></thead>
            <tbody>{rows.map((row, index) => <tr key={row.rowNumber}>
              <td><input type="checkbox" checked={!row.excluded} onChange={(event) => setRows(rows.map((item, i) => i === index ? { ...item, excluded: !event.target.checked } : item))} /></td>
              <td>{row.rowNumber}</td>
              <td><input value={row.mapped.transaction_date || row.mapped.statement_date || ""} onChange={(event) => updateRow(index, "transaction_date", event.target.value)} /></td>
              <td><input value={row.mapped.card_last_four || ""} onChange={(event) => updateRow(index, "card_last_four", event.target.value.replace(/\D/g, "").slice(-4))} /></td>
              <td><input value={row.mapped.merchant_or_supplier || ""} onChange={(event) => updateRow(index, "merchant_or_supplier", event.target.value)} /></td>
              <td><input value={row.mapped.transaction_description || ""} onChange={(event) => updateRow(index, "transaction_description", event.target.value)} /></td>
              <td><select value={row.mapped.expense_category_id || ""} onChange={(event) => updateRow(index, "expense_category_id", event.target.value)}><option value="">Uncategorised</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></td>
              <td><input value={row.mapped.amount || ""} onChange={(event) => updateRow(index, "amount", event.target.value)} /></td>
              <td>{row.duplicateWarnings?.length ? <select value={row.duplicateDecision || "pending"} onChange={(event) => setRows(rows.map((item, i) => i === index ? { ...item, duplicateDecision: event.target.value } : item))}><option value="pending">Choose</option><option value="skip">Skip</option><option value="import_as_new">Import as new</option></select> : "No duplicate"}</td>
              <td>{row.validationErrors?.map((item: string) => <p className="error-text" key={item}>{item}</p>)}{row.duplicateWarnings?.map((warning: Row, i: number) => <p className="help" key={i}>Possible duplicate: {warning.existing?.description}</p>)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <button disabled={busy} onClick={confirmImport}>{busy ? "Importing..." : "Confirm Import"}</button>
      </section>}
    </main>
  );
}
