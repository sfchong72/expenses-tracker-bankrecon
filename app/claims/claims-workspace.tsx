"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AuthBar } from "@/app/auth-bar";
import { createClient } from "@/lib/supabase/client";

type Row = Record<string, any>;
type ViewMode = "all" | "new" | "mine" | "review" | "reimbursements";

const today = new Date().toISOString().slice(0, 10);
const month = `${today.slice(0, 7)}-01`;
const money = (value: unknown) => `MYR ${Number(value || 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const blankClaim = {
  id: "",
  entity_id: "",
  claim_mode: "staff_cash_travel",
  claim_type: "travel_claim",
  claimant_user_id: "",
  claimant_name: "",
  designation: "",
  department: "",
  claim_period_start: today,
  claim_period_end: today,
  statement_date: today,
  statement_month: month,
  trip_or_business_purpose: "",
  currency: "MYR",
  remarks: "",
};

const blankLine = {
  client_key: "",
  line_type: "transport",
  expense_date: today,
  statement_date: today,
  transaction_date: today,
  from_location: "",
  to_location: "",
  transport_mode: "",
  distance_km: "",
  mileage_rate: "",
  check_in_date: today,
  check_out_date: today,
  number_of_nights: "1",
  hotel_name: "",
  merchant_or_supplier: "",
  invoice_or_receipt_number: "",
  payment_method: "",
  receipt_date: today,
  cardholder_name: "",
  card_last_four: "",
  card_type: "personal",
  transaction_description: "",
  business_purpose: "",
  description: "",
  expense_category_id: "",
  amount: "",
  tax_amount: "0",
  original_currency: "MYR",
  exchange_rate: "1",
  myr_converted_amount: "",
  requires_receipt: true,
};

const blankAdvance = { advance_amount: "", advance_date: today, advance_reference: "", amount_utilised: "", remarks: "" };

export function ClaimsWorkspace({ mode = "all", claimId }: { mode?: ViewMode; claimId?: string }) {
  const db = useMemo(() => createClient(), []);
  const [entities, setEntities] = useState<Row[]>([]);
  const [profiles, setProfiles] = useState<Row[]>([]);
  const [categories, setCategories] = useState<Row[]>([]);
  const [claims, setClaims] = useState<Row[]>([]);
  const [lines, setLines] = useState<Row[]>([]);
  const [advances, setAdvances] = useState<Row[]>([]);
  const [documents, setDocuments] = useState<Row[]>([]);
  const [links, setLinks] = useState<Row[]>([]);
  const [vouchers, setVouchers] = useState<Row[]>([]);
  const [currentUserId, setCurrentUserId] = useState("");
  const [claim, setClaim] = useState<Row>(blankClaim);
  const [formLines, setFormLines] = useState<Row[]>([{ ...blankLine, client_key: crypto.randomUUID?.() ?? `${Date.now()}` }]);
  const [formAdvances, setFormAdvances] = useState<Row[]>([]);
  const [lineFiles, setLineFiles] = useState<Record<string, File[]>>({});
  const [message, setMessage] = useState("Loading claims workspace...");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState(claimId || "");

  useEffect(() => { void load(); }, []);

  async function load() {
    setError("");
    const user = await db.auth.getUser();
    setCurrentUserId(user.data.user?.id ?? "");
    const [entityRes, profileRes, categoryRes, claimRes, lineRes, advanceRes, docRes, linkRes, voucherRes] = await Promise.all([
      db.from("entities").select("id, short_code, display_name").eq("active_status", true).order("short_code"),
      db.from("app_profiles").select("id, email, display_name, role").order("display_name"),
      db.from("categories").select("id, name, account_code, active_status").eq("category_type", "expense").eq("active_status", true).order("name"),
      db.from("claims").select("*").eq("is_demo", false).order("created_at", { ascending: false }),
      db.from("claim_lines").select("*").order("sort_order"),
      db.from("claim_advances").select("*").order("created_at"),
      db.from("documents").select("*").eq("is_demo", false).order("uploaded_at", { ascending: false }),
      db.from("document_links").select("*").eq("is_demo", false).order("created_at", { ascending: false }),
      db.from("payment_vouchers").select("id, voucher_number, status, claim_id").eq("is_demo", false).order("created_at", { ascending: false }),
    ]);
    const firstError = entityRes.error || profileRes.error || categoryRes.error || claimRes.error || lineRes.error || advanceRes.error || docRes.error || linkRes.error || voucherRes.error;
    if (firstError) {
      setError(firstError.message);
      setMessage("Apply migration 0011_staff_director_claims.sql before testing claims.");
      return;
    }
    setEntities(entityRes.data ?? []);
    setProfiles(profileRes.data ?? []);
    setCategories(categoryRes.data ?? []);
    setClaims(claimRes.data ?? []);
    setLines(lineRes.data ?? []);
    setAdvances(advanceRes.data ?? []);
    setDocuments(docRes.data ?? []);
    setLinks(linkRes.data ?? []);
    setVouchers(voucherRes.data ?? []);
    setMessage("Claims workspace ready. Release 1 is finance/admin internal entry only.");
    if (claimId) loadIntoForm((claimRes.data ?? []).find((item) => item.id === claimId));
  }

  function resetForm(nextMode = "staff_cash_travel") {
    setClaim({ ...blankClaim, claim_mode: nextMode, claim_type: nextMode === "credit_card" ? "personal_credit_card_claim" : "travel_claim" });
    setFormLines([{ ...blankLine, line_type: nextMode === "credit_card" ? "credit_card_transaction" : "transport", client_key: key() }]);
    setFormAdvances([]);
    setLineFiles({});
    setSelectedId("");
  }

  function loadIntoForm(row?: Row) {
    if (!row) return;
    setSelectedId(row.id);
    setClaim({
      ...blankClaim,
      ...row,
      claimant_user_id: row.claimant_user_id || "",
      claim_period_start: row.claim_period_start || today,
      claim_period_end: row.claim_period_end || today,
      statement_date: row.statement_date || today,
      statement_month: row.statement_month || month,
    });
    const rowLines = lines.filter((line) => line.claim_id === row.id);
    setFormLines(rowLines.length ? rowLines.map((line) => ({ ...blankLine, ...line, client_key: line.client_key || line.id })) : [{ ...blankLine, client_key: key() }]);
    const rowAdvances = advances.filter((advance) => advance.claim_id === row.id);
    setFormAdvances(rowAdvances.length ? rowAdvances : []);
    setLineFiles({});
    setMessage(`Loaded ${row.claim_number || "draft claim"} for review.`);
  }

  async function saveClaim(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/claims/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claim, lines: formLines, advances: formAdvances }),
    });
    const body = await res.json();
    if (!res.ok) {
      setBusy(false);
      setError(body.error || "Claim save failed");
      return;
    }
    await uploadLineFiles(body.lines || [], claim.entity_id);
    setBusy(false);
    setSelectedId(body.claim.id);
    setClaim({ ...claim, ...body.claim });
    setMessage("Claim saved. Totals were recalculated from lines and advances.");
    await load();
  }

  async function uploadLineFiles(savedLines: Row[], entityId: string) {
    for (const saved of savedLines) {
      const files = lineFiles[saved.client_key] || [];
      for (const file of files) {
        const form = new FormData();
        form.set("file", file);
        form.set("entity_id", entityId);
        form.set("linked_record_type", "claim_line");
        form.set("linked_record_id", saved.id);
        form.set("document_type", documentTypeFor(formLines.find((line) => line.client_key === saved.client_key)?.line_type));
        const res = await fetch("/api/documents/upload", { method: "POST", body: form });
        if (!res.ok) {
          const body = await res.json();
          setError(body.error || `Upload failed for ${file.name}`);
        }
      }
    }
  }

  async function moveStatus(row: Row, status: string) {
    const reason = ["rejected", "more_information_required"].includes(status) ? window.prompt("Reason / notes") || "" : "";
    if (["rejected", "more_information_required"].includes(status) && !reason) return;
    const payload: Row = { claimId: row.id, status, reason };
    if (status === "reimbursed") {
      payload.reimbursementDate = window.prompt("Reimbursement date", today) || today;
      payload.paymentReference = window.prompt("Payment reference", row.payment_reference || "") || "";
    }
    if (status === "entered_in_sql_accounting") {
      payload.sqlReference = window.prompt("SQL Accounting reference") || "";
      if (!payload.sqlReference) return;
    }
    const res = await fetch("/api/claims/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const body = await res.json();
    if (!res.ok) setError(body.error || "Status update failed");
    else setMessage(`Claim moved to ${status}.`);
    await load();
  }

  async function prepareVoucher(row: Row) {
    const res = await fetch("/api/claims/prepare-voucher", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ claimId: row.id }) });
    const body = await res.json();
    if (!res.ok) setError(body.error || "Voucher preparation failed");
    else setMessage("Reimbursement voucher draft created and linked to the claim.");
    await load();
  }

  const filteredClaims = claims.filter((row) => {
    if (claimId) return row.id === claimId;
    if (mode === "mine") return row.claimant_user_id === currentUserId;
    if (mode === "review") return ["submitted", "under_review", "more_information_required", "checked"].includes(row.status);
    if (mode === "reimbursements") return ["approved", "payment_prepared", "reimbursed"].includes(row.status);
    return true;
  });
  const selected = claims.find((row) => row.id === selectedId) || filteredClaims[0];
  const selectedLines = selected ? lines.filter((line) => line.claim_id === selected.id) : [];
  const selectedAdvances = selected ? advances.filter((advance) => advance.claim_id === selected.id) : [];
  const missingEvidence = lines.filter((line) => line.requires_receipt && line.document_status === "missing");

  return (
    <main>
      <header>
        <div>
          <span>Release 1</span>
          <h1>Staff & Director Claims</h1>
          <p className="subtitle">Finance/admin internal entry for cash, travel and credit-card claims. SQL Accounting remains the official accounting system.</p>
        </div>
        <div className="actions">
          <Link className="button secondary" href="/claims/import">Credit Card Import</Link>
          <a className="button neutral" href="/api/claims/export">SQL Export</a>
        </div>
        <AuthBar />
      </header>

      <nav className="page-tabs">
        <Link className={mode === "all" ? "active" : ""} href="/claims">All Claims</Link>
        <Link className={mode === "new" ? "active" : ""} href="/claims/new">New Claim</Link>
        <Link className={mode === "review" ? "active" : ""} href="/claims/review">Review</Link>
        <Link className={mode === "reimbursements" ? "active" : ""} href="/claims/reimbursements">Reimbursements</Link>
        <Link className={mode === "mine" ? "active" : ""} href="/claims/my-claims">My Claims</Link>
      </nav>

      <section className={error ? "notice error" : "notice"}>
        <p>{error || message}</p>
        <button onClick={() => void load()}>Refresh</button>
      </section>

      <section className="metric-grid">
        <Metric label="Claims" value={claims.length} />
        <Metric label="Pending review" value={claims.filter((row) => ["submitted", "under_review", "checked"].includes(row.status)).length} />
        <Metric label="Missing evidence" value={missingEvidence.length} />
        <Metric label="Outstanding reimbursements" value={claims.filter((row) => ["approved", "payment_prepared"].includes(row.status)).length} />
      </section>

      {(mode === "new" || selectedId) && <section className="panel">
        <h2>{claim.id ? "Edit Draft Claim" : "Create Claim"}</h2>
        <ClaimForm claim={claim} setClaim={setClaim} entities={entities} profiles={profiles} save={saveClaim} resetForm={resetForm} busy={busy} />
        <LineEditor claimMode={claim.claim_mode} lines={formLines} setLines={setFormLines} categories={categories} lineFiles={lineFiles} setLineFiles={setLineFiles} />
        <AdvanceEditor advances={formAdvances} setAdvances={setFormAdvances} />
        <DerivedTotals lines={formLines} advances={formAdvances} />
      </section>}

      <section className="grid">
        <section className="panel">
          <h2>Claim List</h2>
          <ClaimTable rows={filteredClaims} entities={entities} vouchers={vouchers} onOpen={loadIntoForm} onSelect={setSelectedId} onStatus={moveStatus} onVoucher={prepareVoucher} onPrint={(row: Row) => printClaim(row, lines.filter((line) => line.claim_id === row.id), advances.filter((advance) => advance.claim_id === row.id), categories, links, documents)} />
        </section>
        <section className="panel">
          <h2>Claim Detail</h2>
          {selected ? <ClaimDetail claim={selected} lines={selectedLines} advances={selectedAdvances} entities={entities} categories={categories} docs={documents} links={links} onPrint={() => printClaim(selected, selectedLines, selectedAdvances, categories, links, documents)} /> : <div className="empty">Select a claim to view details.</div>}
        </section>
      </section>

      <section className="panel">
        <h2>Missing Claim Evidence</h2>
        <MissingEvidence rows={missingEvidence} claims={claims} categories={categories} />
      </section>
    </main>
  );
}

function ClaimForm({ claim, setClaim, entities, profiles, save, resetForm, busy }: Row) {
  return <form onSubmit={save}>
    <label>Claim mode<select value={claim.claim_mode} onChange={(event) => resetForm(event.target.value)}><option value="staff_cash_travel">Staff Cash / Travel</option><option value="credit_card">Credit Card</option></select></label>
    <label>Claim type<select value={claim.claim_type} onChange={(event) => setClaim({ ...claim, claim_type: event.target.value })}>{claim.claim_mode === "credit_card" ? <><option value="personal_credit_card_claim">Personal credit card claim</option><option value="company_credit_card_claim">Company credit card claim</option><option value="director_claim">Director claim</option></> : <><option value="travel_claim">Travel claim</option><option value="staff_cash_claim">Staff cash claim</option><option value="director_claim">Director claim</option><option value="staff_advance">Staff advance</option><option value="director_advance">Director advance</option><option value="petty_cash">Petty cash</option><option value="mileage_claim">Mileage claim</option></>}</select></label>
    <Select label="Entity" value={claim.entity_id} onChange={(v) => setClaim({ ...claim, entity_id: v })} rows={entities} />
    <label>Claimant user<select value={claim.claimant_user_id} onChange={(event) => { const profile = profiles.find((p: Row) => p.id === event.target.value); setClaim({ ...claim, claimant_user_id: event.target.value, claimant_name: profile?.display_name || profile?.email || claim.claimant_name }); }}><option value="">Manual claimant</option>{profiles.map((profile: Row) => <option key={profile.id} value={profile.id}>{profile.display_name || profile.email}</option>)}</select></label>
    <label>Claimant name<input value={claim.claimant_name} onChange={(event) => setClaim({ ...claim, claimant_name: event.target.value })} required /></label>
    <label>Designation<input value={claim.designation || ""} onChange={(event) => setClaim({ ...claim, designation: event.target.value })} /></label>
    <label>Department<input value={claim.department || ""} onChange={(event) => setClaim({ ...claim, department: event.target.value })} /></label>
    {claim.claim_mode === "credit_card" ? <>
      <label>Statement date<input type="date" value={claim.statement_date || today} onChange={(event) => setClaim({ ...claim, statement_date: event.target.value, statement_month: `${event.target.value.slice(0, 7)}-01` })} /></label>
      <label>Statement month<input type="month" value={(claim.statement_month || month).slice(0, 7)} onChange={(event) => setClaim({ ...claim, statement_month: `${event.target.value}-01` })} /></label>
    </> : <>
      <label>Claim period start<input type="date" value={claim.claim_period_start || today} onChange={(event) => setClaim({ ...claim, claim_period_start: event.target.value })} /></label>
      <label>Claim period end<input type="date" value={claim.claim_period_end || today} onChange={(event) => setClaim({ ...claim, claim_period_end: event.target.value })} /></label>
    </>}
    <label className="wide">Trip / business purpose<input value={claim.trip_or_business_purpose || ""} onChange={(event) => setClaim({ ...claim, trip_or_business_purpose: event.target.value })} /></label>
    <label className="wide">Remarks<textarea value={claim.remarks || ""} onChange={(event) => setClaim({ ...claim, remarks: event.target.value })} /></label>
    <button disabled={busy}>{busy ? "Saving..." : "Save Claim"}</button>
  </form>;
}

function LineEditor({ claimMode, lines, setLines, categories, lineFiles, setLineFiles }: Row) {
  function addLine(lineType?: string) {
    setLines([...lines, { ...blankLine, client_key: key(), line_type: lineType || (claimMode === "credit_card" ? "credit_card_transaction" : "miscellaneous"), requires_receipt: true }]);
  }
  return <div className="mini wide">
    <div className="section-heading"><b>Claim Lines</b><span className="actions"><button type="button" className="secondary" onClick={() => addLine("transport")}>Add Transport</button><button type="button" className="secondary" onClick={() => addLine("accommodation")}>Add Accommodation</button><button type="button" className="secondary" onClick={() => addLine(claimMode === "credit_card" ? "credit_card_transaction" : "miscellaneous")}>Add Line</button></span></div>
    {lines.map((line: Row, index: number) => <div className="claim-line-card" key={line.client_key}>
      <label>Line type<select value={line.line_type} onChange={(event) => updateLine(lines, setLines, index, "line_type", event.target.value)}><option value="transport">Transport</option><option value="mileage">Mileage</option><option value="accommodation">Accommodation</option><option value="miscellaneous">Miscellaneous</option><option value="credit_card_transaction">Credit-card transaction</option><option value="petty_cash">Petty cash</option></select></label>
      <label>Date<input type="date" value={line.expense_date || line.transaction_date || today} onChange={(event) => updateLine(lines, setLines, index, "expense_date", event.target.value)} /></label>
      <CategorySelect value={line.expense_category_id || ""} onChange={(v) => updateLine(lines, setLines, index, "expense_category_id", v)} categories={categories} />
      <label>Merchant / supplier<input value={line.merchant_or_supplier || ""} onChange={(event) => updateLine(lines, setLines, index, "merchant_or_supplier", event.target.value)} /></label>
      <label className="wide">Description<input value={line.description || ""} onChange={(event) => updateLine(lines, setLines, index, "description", event.target.value)} required /></label>
      {line.line_type === "transport" || line.line_type === "mileage" ? <><label>From<input value={line.from_location || ""} onChange={(event) => updateLine(lines, setLines, index, "from_location", event.target.value)} /></label><label>To<input value={line.to_location || ""} onChange={(event) => updateLine(lines, setLines, index, "to_location", event.target.value)} /></label><label>Mode<input value={line.transport_mode || ""} onChange={(event) => updateLine(lines, setLines, index, "transport_mode", event.target.value)} /></label><label>Distance km<input type="number" step="0.01" value={line.distance_km || ""} onChange={(event) => updateLine(lines, setLines, index, "distance_km", event.target.value)} /></label><label>Mileage rate<input type="number" step="0.0001" value={line.mileage_rate || ""} onChange={(event) => updateLine(lines, setLines, index, "mileage_rate", event.target.value)} /></label></> : null}
      {line.line_type === "accommodation" ? <><label>Check-in<input type="date" value={line.check_in_date || today} onChange={(event) => updateLine(lines, setLines, index, "check_in_date", event.target.value)} /></label><label>Check-out<input type="date" value={line.check_out_date || today} onChange={(event) => updateLine(lines, setLines, index, "check_out_date", event.target.value)} /></label><label>Nights<input type="number" min="1" value={line.number_of_nights || "1"} onChange={(event) => updateLine(lines, setLines, index, "number_of_nights", event.target.value)} /></label><label>Hotel<input value={line.hotel_name || ""} onChange={(event) => updateLine(lines, setLines, index, "hotel_name", event.target.value)} /></label></> : null}
      {line.line_type === "credit_card_transaction" ? <><label>Cardholder<input value={line.cardholder_name || ""} onChange={(event) => updateLine(lines, setLines, index, "cardholder_name", event.target.value)} /></label><label>Card last four<input maxLength={4} value={line.card_last_four || ""} onChange={(event) => updateLine(lines, setLines, index, "card_last_four", event.target.value.replace(/\D/g, "").slice(-4))} /></label><label>Card type<select value={line.card_type || "personal"} onChange={(event) => updateLine(lines, setLines, index, "card_type", event.target.value)}><option value="personal">Personal</option><option value="company">Company</option></select></label><label>Transaction date<input type="date" value={line.transaction_date || today} onChange={(event) => updateLine(lines, setLines, index, "transaction_date", event.target.value)} /></label></> : null}
      <label>Receipt / invoice no<input value={line.invoice_or_receipt_number || ""} onChange={(event) => updateLine(lines, setLines, index, "invoice_or_receipt_number", event.target.value)} /></label>
      <label>Payment method<input value={line.payment_method || ""} onChange={(event) => updateLine(lines, setLines, index, "payment_method", event.target.value)} /></label>
      <label>Amount<input type="number" step="0.01" value={line.amount || ""} onChange={(event) => updateLine(lines, setLines, index, "amount", event.target.value)} required /></label>
      <label>Tax<input type="number" step="0.01" value={line.tax_amount || "0"} onChange={(event) => updateLine(lines, setLines, index, "tax_amount", event.target.value)} /></label>
      <label>Original currency<input value={line.original_currency || "MYR"} onChange={(event) => updateLine(lines, setLines, index, "original_currency", event.target.value)} /></label>
      <label>Exchange rate<input type="number" step="0.000001" value={line.exchange_rate || "1"} onChange={(event) => updateLine(lines, setLines, index, "exchange_rate", event.target.value)} /></label>
      <label className="inline"><input type="checkbox" checked={line.requires_receipt !== false} onChange={(event) => updateLine(lines, setLines, index, "requires_receipt", event.target.checked)} /> Evidence required</label>
      <label className="wide">Receipt / support for this line<input type="file" multiple accept="application/pdf,image/jpeg,image/png,image/*" onChange={(event) => setLineFiles({ ...lineFiles, [line.client_key]: Array.from(event.target.files ?? []) })} /></label>
      <button type="button" className="danger" onClick={() => setLines(lines.filter((_: Row, i: number) => i !== index))}>Remove line</button>
    </div>)}
  </div>;
}

function AdvanceEditor({ advances, setAdvances }: Row) {
  return <div className="mini wide">
    <div className="section-heading"><b>Advances</b><button type="button" className="secondary" onClick={() => setAdvances([...advances, { ...blankAdvance }])}>Add advance</button></div>
    {!advances.length ? <p className="help">No advances recorded.</p> : advances.map((advance: Row, index: number) => <div className="itemrow" key={index}>
      <input placeholder="Advance amount" value={advance.advance_amount || ""} onChange={(event) => setAdvances(advances.map((item: Row, i: number) => i === index ? { ...item, advance_amount: event.target.value } : item))} />
      <input type="date" value={advance.advance_date || today} onChange={(event) => setAdvances(advances.map((item: Row, i: number) => i === index ? { ...item, advance_date: event.target.value } : item))} />
      <input placeholder="Reference" value={advance.advance_reference || ""} onChange={(event) => setAdvances(advances.map((item: Row, i: number) => i === index ? { ...item, advance_reference: event.target.value } : item))} />
      <input placeholder="Utilised" value={advance.amount_utilised || ""} onChange={(event) => setAdvances(advances.map((item: Row, i: number) => i === index ? { ...item, amount_utilised: event.target.value } : item))} />
      <button type="button" className="danger" onClick={() => setAdvances(advances.filter((_: Row, i: number) => i !== index))}>Remove</button>
    </div>)}
  </div>;
}

function DerivedTotals({ lines, advances }: Row) {
  const totals = calculateTotals(lines, advances);
  return <div className="metric-grid wide">
    <Metric label="Transport" value={money(totals.transport)} />
    <Metric label="Accommodation" value={money(totals.accommodation)} />
    <Metric label="Misc / Card" value={money(totals.misc)} />
    <Metric label="Tax" value={money(totals.tax)} />
    <Metric label="Gross" value={money(totals.gross)} />
    <Metric label="Advance utilised" value={money(totals.advanceUtilised)} />
    <Metric label="Net payable" value={money(totals.netPayable)} />
    <Metric label="Refundable" value={money(totals.refundable)} />
  </div>;
}

function ClaimTable({ rows, entities, vouchers, onOpen, onSelect, onStatus, onVoucher, onPrint }: Row) {
  if (!rows.length) return <div className="empty">No claims in this view.</div>;
  return <div className="table-wrap"><table><thead><tr><th>No</th><th>Entity</th><th>Claimant</th><th>Type</th><th>Total</th><th>Evidence</th><th>Status</th><th /></tr></thead><tbody>{rows.map((row: Row) => <tr key={row.id}><td>{row.claim_number || "Draft"}</td><td>{entityName(entities, row.entity_id)}</td><td>{row.claimant_name}</td><td>{label(row.claim_type)}</td><td>{money(row.gross_claim_total)}<br />Net: {money(row.net_payable_amount)}</td><td>{label(row.evidence_status)}</td><td><span className={`status-pill status-${row.status}`}>{label(row.status)}</span><br />{vouchers.find((v: Row) => v.id === row.payment_voucher_id)?.voucher_number}</td><td className="actions"><button className="secondary" onClick={() => onSelect(row.id)}>Detail</button>{row.status === "draft" && <button onClick={() => onOpen(row)}>Edit</button>}{row.status === "draft" && <button onClick={() => onStatus(row, "submitted")}>Submit</button>}{row.status === "submitted" && <button onClick={() => onStatus(row, "under_review")}>Start Review</button>}{row.status === "under_review" && <button onClick={() => onStatus(row, "checked")}>Check</button>}{row.status === "checked" && <button onClick={() => onStatus(row, "approved")}>Approve</button>}{row.status === "approved" && <button onClick={() => onVoucher(row)}>Prepare Voucher</button>}{row.status === "payment_prepared" && <button onClick={() => onStatus(row, "reimbursed")}>Mark Reimbursed</button>}{row.status === "reimbursed" && <button onClick={() => onStatus(row, "entered_in_sql_accounting")}>Mark SQL Entered</button>}<button className="neutral" onClick={() => onPrint(row)}>Print</button><a className="button neutral" href={`/api/claims/export?claimId=${row.id}`}>Export</a></td></tr>)}</tbody></table></div>;
}

function ClaimDetail({ claim, lines, advances, entities, categories, docs, links, onPrint }: Row) {
  const docList = links.filter((link: Row) => ["claim", "claim_line"].includes(link.linked_record_type) && (link.linked_record_id === claim.id || lines.some((line: Row) => line.id === link.linked_record_id))).map((link: Row) => docs.find((doc: Row) => doc.id === link.document_id)?.original_filename).filter(Boolean);
  return <div>
    <div className="preview-grid"><p><b>Claim</b>{claim.claim_number || "Draft"}</p><p><b>Entity</b>{entityName(entities, claim.entity_id)}</p><p><b>Status</b>{label(claim.status)}</p><p><b>Claimant</b>{claim.claimant_name}</p><p><b>Gross</b>{money(claim.gross_claim_total)}</p><p><b>Net payable</b>{money(claim.net_payable_amount)}</p></div>
    <h3>Lines</h3>
    <table><thead><tr><th>Type</th><th>Date</th><th>Description</th><th>Category</th><th>Amount</th><th>Evidence</th></tr></thead><tbody>{lines.map((line: Row) => <tr key={line.id}><td>{label(line.line_type)}</td><td>{line.expense_date || line.transaction_date}</td><td>{line.description}<br />{line.merchant_or_supplier}</td><td>{categoryName(categories, line.expense_category_id)}</td><td>{money(line.myr_converted_amount || line.amount)}</td><td>{label(line.document_status)}</td></tr>)}</tbody></table>
    <p><b>Advances:</b> {advances.length ? advances.map((a: Row) => `${money(a.advance_amount)} ${a.advance_reference || ""}`).join(", ") : "None"}</p>
    <p><b>Documents:</b> {docList.length ? docList.join(", ") : "No documents linked yet"}</p>
    <button onClick={onPrint}>Print / Save PDF</button>
  </div>;
}

function MissingEvidence({ rows, claims, categories }: Row) {
  if (!rows.length) return <div className="empty">No missing claim evidence.</div>;
  return <table><thead><tr><th>Claim</th><th>Line</th><th>Category</th><th>Expected evidence</th></tr></thead><tbody>{rows.map((line: Row) => <tr key={line.id}><td>{claims.find((claim: Row) => claim.id === line.claim_id)?.claim_number || "Draft"}</td><td>{line.description}</td><td>{categoryName(categories, line.expense_category_id)}</td><td>{line.line_type === "mileage" ? "Route screenshot" : line.line_type === "accommodation" ? "Hotel invoice / receipt" : line.line_type === "credit_card_transaction" ? "Receipt or redacted card statement" : "Receipt or supporting document"}</td></tr>)}</tbody></table>;
}

function calculateTotals(lines: Row[], advances: Row[]) {
  const amount = (line: Row) => Number(line.myr_converted_amount || 0) || Number(line.amount || 0) * Number(line.exchange_rate || 1);
  const transport = lines.filter((line) => ["transport", "mileage"].includes(line.line_type)).reduce((sum, line) => sum + amount(line), 0);
  const accommodation = lines.filter((line) => line.line_type === "accommodation").reduce((sum, line) => sum + amount(line), 0);
  const misc = lines.filter((line) => !["transport", "mileage", "accommodation"].includes(line.line_type)).reduce((sum, line) => sum + amount(line), 0);
  const tax = lines.reduce((sum, line) => sum + Number(line.tax_amount || 0), 0);
  const gross = transport + accommodation + misc;
  const advancePaid = advances.reduce((sum, advance) => sum + Number(advance.advance_amount || 0), 0);
  const advanceUtilised = advances.reduce((sum, advance) => sum + Number(advance.amount_utilised || advance.advance_amount || 0), 0);
  return { transport, accommodation, misc, tax, gross, advancePaid, advanceUtilised, netPayable: Math.max(gross - advanceUtilised, 0), refundable: Math.max(advanceUtilised - gross, 0) };
}

function printClaim(claim: Row, lines: Row[], advances: Row[], categories: Row[], links: Row[], docs: Row[]) {
  const w = window.open("", "_blank");
  if (!w) return;
  const totals = calculateTotals(lines, advances);
  const transport = rowsForPrint(lines.filter((line) => ["transport", "mileage"].includes(line.line_type)), categories);
  const accommodation = rowsForPrint(lines.filter((line) => line.line_type === "accommodation"), categories);
  const misc = rowsForPrint(lines.filter((line) => !["transport", "mileage", "accommodation"].includes(line.line_type)), categories);
  const docList = links.filter((link: Row) => ["claim", "claim_line"].includes(link.linked_record_type) && (link.linked_record_id === claim.id || lines.some((line) => line.id === link.linked_record_id))).map((link: Row) => docs.find((doc: Row) => doc.id === link.document_id)?.original_filename).filter(Boolean).join(", ") || "None";
  w.document.write(`<html><head><title>${claim.claim_number || "Claim"}</title><style>body{font-family:Arial;padding:24px}table{width:100%;border-collapse:collapse;margin-bottom:18px}td,th{border:1px solid #999;padding:8px;text-align:left}.totals{font-weight:bold}@media print{button{display:none}}</style></head><body><h1>${claim.claim_mode === "credit_card" ? "Credit Card Claim" : "Staff Cash / Travel Claim"}</h1><p><b>Claim:</b> ${claim.claim_number || "Draft"} &nbsp; <b>Claimant:</b> ${claim.claimant_name}</p><p><b>Purpose:</b> ${claim.trip_or_business_purpose || ""}</p><h2>Transport</h2>${transport}<h2>Accommodation</h2>${accommodation}<h2>Miscellaneous / Credit Card</h2>${misc}<p class="totals">Gross: ${money(totals.gross)} | Advance utilised: ${money(totals.advanceUtilised)} | Net payable: ${money(totals.netPayable)} | Refundable: ${money(totals.refundable)}</p><p><b>Supporting documents:</b> ${docList}</p><p>Claimant signature: ____________________ Checked by: ____________________ Approved by: ____________________</p><button onclick="window.print()">Print / Save PDF</button></body></html>`);
  w.document.close();
}

function rowsForPrint(rows: Row[], categories: Row[]) {
  if (!rows.length) return "<p>None</p>";
  return `<table><thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Amount</th><th>Evidence</th></tr></thead><tbody>${rows.map((line) => `<tr><td>${line.expense_date || line.transaction_date || ""}</td><td>${line.description || ""}<br>${line.merchant_or_supplier || ""}</td><td>${categoryName(categories, line.expense_category_id)}</td><td>${money(line.myr_converted_amount || line.amount)}</td><td>${line.document_status || ""}</td></tr>`).join("")}</tbody></table>`;
}

function updateLine(lines: Row[], setLines: (rows: Row[]) => void, index: number, field: string, value: unknown) {
  setLines(lines.map((line, i) => i === index ? { ...line, [field]: value } : line));
}

function Select({ value, onChange, rows, label }: { value: string; onChange: (v: string) => void; rows: Row[]; label: string }) {
  return <label>{label}<select value={value || ""} onChange={(event) => onChange(event.target.value)} required><option value="">Choose</option>{rows.map((row) => <option key={row.id} value={row.id}>{row.short_code || row.display_name || row.name}</option>)}</select></label>;
}

function CategorySelect({ value, onChange, categories }: { value: string; onChange: (v: string) => void; categories: Row[] }) {
  return <label>Category<select value={value || ""} onChange={(event) => onChange(event.target.value)}><option value="">Uncategorised</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>;
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function entityName(entities: Row[], id: string) {
  return entities.find((entity) => entity.id === id)?.short_code ?? "-";
}

function categoryName(categories: Row[], id: string) {
  return categories.find((category) => category.id === id)?.name ?? "-";
}

function label(value: unknown) {
  return String(value ?? "-").replaceAll("_", " ");
}

function documentTypeFor(lineType: unknown) {
  if (lineType === "mileage") return "mileage_route_screenshot";
  if (lineType === "accommodation") return "tax_invoice";
  if (lineType === "credit_card_transaction") return "claim_receipt";
  return "claim_receipt";
}

function key() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}
