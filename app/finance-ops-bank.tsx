"use client";

import Link from "next/link";
import { useMemo, useState, type FormEvent } from "react";
import { PageTabs } from "@/app/ui-v2";
import { dateText, FinanceOpsShell, money, StatusTag, useFinanceOpsData, type FinanceOpsData, type Row } from "@/app/finance-ops-shared";
import { statementFieldLabel, STATEMENT_FIELDS, type ParsedBankRow, type StatementMapping } from "@/lib/financeops/payments/statement-fields";
import { classifyBankRow } from "@/lib/financeops/payments/matching";
import { EARLY_STATUSES, isFinanceReviewer } from "@/lib/financeops/payments/types";

type Preview = {
  fileHash: string; sheets: string[]; sheet: string; headers: string[]; mapping: StatementMapping; rows: ParsedBankRow[];
  summary: { total: number; new: number; duplicate: number; invalid: number; empty: number; debits: number; credits: number; fees: number; debitTotal: number; creditTotal: number };
  alreadyImportedBatchId: string | null; mappingProblems: string[];
};

function BankGate({ data, children, title, subtitle, active }: { data: FinanceOpsData; children: React.ReactNode; title: string; subtitle: string; active: string }) {
  const reviewer = isFinanceReviewer(data.me.role);
  return (
    <FinanceOpsShell title={title} subtitle={subtitle} active={active} message={data.message} error={data.error}>
      {data.loading ? <div className="empty">Loading...</div> : !reviewer ? (
        <div className="notice error"><p>Bank statement data is limited to Owner, Finance Manager and Finance Staff.</p></div>
      ) : !data.me.aal2 ? (
        <div className="notice error"><p>Bank data needs two-step verification. <Link href="/mfa">Verify with your authenticator</Link>, then come back.</p></div>
      ) : children}
    </FinanceOpsShell>
  );
}

// ====================================================================== bank statement import

export function BankImportView() {
  const data = useFinanceOpsData({ bank: true });
  const [entity, setEntity] = useState("");
  const [account, setAccount] = useState("");
  const [bankName, setBankName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [pasted, setPasted] = useState("");
  const [sheet, setSheet] = useState("");
  const [mapping, setMapping] = useState<StatementMapping | null>(null);
  const [includeDuplicates, setIncludeDuplicates] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  function form(): FormData {
    const fd = new FormData();
    fd.set("entity_id", entity);
    fd.set("company_account_ref", account);
    fd.set("bank_name", bankName);
    if (file) fd.set("file", file);
    else fd.set("pasted_text", pasted);
    if (sheet) fd.set("sheet", sheet);
    if (mapping) fd.set("mapping", JSON.stringify(mapping));
    fd.set("include_duplicates", String(includeDuplicates));
    return fd;
  }

  async function call(path: string) {
    setBusy(true); data.setError(""); data.setMessage("");
    try {
      const res = await fetch(path, { method: "POST", body: form() });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { data.setError(json.message || json.error || "The request failed."); return null; }
      return json;
    } finally { setBusy(false); }
  }

  async function doPreview(e: FormEvent) {
    e.preventDefault();
    if (!entity || !account.trim()) return data.setError("Choose the entity and enter the company bank account this statement belongs to.");
    if (!file && !pasted.trim()) return data.setError("Choose a CSV or XLSX file, or paste the rows.");
    const json = await call("/api/finance-ops/bank-import/preview");
    if (json) { setPreview(json); setMapping(json.mapping); setSheet(json.sheet); }
  }

  async function doImport() {
    const json = await call("/api/finance-ops/bank-import/confirm");
    if (!json) return;
    data.setMessage(`Imported ${json.imported} row(s)${json.skipped ? `, skipped ${json.skipped}` : ""}${json.resumed ? " (resumed an earlier partial import)" : ""}. Open the Matching queue to run matching.`);
    setPreview(null); setFile(null); setPasted("");
    await data.reload();
  }

  return (
    <BankGate data={data} title="Bank statement import" subtitle="Transactions only: balances are not needed and are never stored. Nothing is overwritten; rows already imported are skipped." active="/finance-ops/bank-import">
      <section className="panel">
        <h2>Import a statement</h2>
        <form className="mini" onSubmit={doPreview} aria-label="Import a statement">
          <label>Entity<select value={entity} onChange={(e) => setEntity(e.target.value)} required><option value="">Choose</option>{data.entities.map((x) => <option key={x.id} value={x.id}>{x.short_code}</option>)}</select></label>
          <label>Company bank account<input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="e.g. 8001344252" required /></label>
          <label>Bank (optional)<input value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="e.g. Public Bank" /></label>
          <label>CSV or XLSX file<input type="file" accept=".csv,.xlsx" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setMapping(null); setSheet(""); }} /></label>
          <label>...or paste rows from the bank's page<textarea value={pasted} onChange={(e) => { setPasted(e.target.value); setPreview(null); }} placeholder="Copy the table including its header row" disabled={Boolean(file)} /></label>
          <div className="record-actions"><button type="submit" className="primary" disabled={busy}>Preview</button></div>
        </form>
      </section>

      {preview && (
        <section className="panel" aria-label="Import preview">
          <h2>Preview</h2>
          <p className="help">
            {preview.summary.total} rows: <b>{preview.summary.new} new</b>, {preview.summary.duplicate} already imported, {preview.summary.invalid} invalid, {preview.summary.empty} empty. New debits {money(preview.summary.debitTotal)} ({preview.summary.debits}), credits {money(preview.summary.creditTotal)} ({preview.summary.credits}); {preview.summary.fees} bank-fee row(s) are kept for the record but never matched to a payment.
          </p>
          {preview.alreadyImportedBatchId && <div className="notice"><p>This exact file was imported before. Only rows not yet stored can still be added (a partial import resumes).</p></div>}
          {preview.mappingProblems.map((m) => <div key={m} className="notice error"><p>{m}</p></div>)}
          {preview.sheets.length > 1 && <label>Worksheet<select value={sheet} onChange={(e) => { setSheet(e.target.value); setMapping(null); }}>{preview.sheets.map((s) => <option key={s}>{s}</option>)}</select></label>}
          <details>
            <summary>Check how the columns were understood</summary>
            <div className="mini">
              {preview.headers.map((h) => (
                <label key={h}>{h}
                  <select value={mapping?.[h] ?? ""} onChange={(e) => setMapping({ ...(mapping ?? preview.mapping), [h]: e.target.value as never })}>
                    <option value="">Ignore</option>
                    {STATEMENT_FIELDS.map((f) => <option key={f} value={f}>{statementFieldLabel(f)}</option>)}
                  </select>
                </label>
              ))}
              <div className="record-actions"><button type="button" className="neutral" disabled={busy} onClick={(e) => void doPreview(e as never)}>Re-read with this mapping</button></div>
            </div>
          </details>
          <table>
            <thead><tr><th>Row</th><th>Date</th><th>Dr/Cr</th><th>Amount</th><th>Reference</th><th>Payee</th><th>Description</th><th>Result</th></tr></thead>
            <tbody>
              {preview.rows.slice(0, 80).map((r) => (
                <tr key={r.rowNumber}>
                  <td>{r.rowNumber}</td><td>{r.transactionDate ?? "—"} {r.transactionTime?.slice(0, 5) ?? ""}</td><td>{r.direction ?? "—"}</td><td>{r.amount === null ? "—" : money(r.amount)}</td>
                  <td>{r.bankReference ?? ""}</td><td>{r.payeeName ?? ""}</td><td>{r.description ?? ""}</td>
                  <td>{r.state === "new" ? (r.kind === "bank_fee" ? "New (bank fee)" : "New") : r.state === "duplicate" ? "Duplicate: skipped" : r.state === "empty" ? "Empty" : `Invalid: ${r.errors.join("; ")}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.rows.length > 80 && <p className="help">Showing the first 80 of {preview.rows.length} rows.</p>}
          <label><input type="checkbox" checked={includeDuplicates} onChange={(e) => setIncludeDuplicates(e.target.checked)} /> Import rows marked duplicate anyway (only if the bank really posted identical transactions twice)</label>
          <div className="record-actions"><button type="button" className="primary" disabled={busy || preview.summary.new + (includeDuplicates ? preview.summary.duplicate : 0) === 0 || preview.mappingProblems.length > 0} onClick={() => void doImport()}>Import {preview.summary.new + (includeDuplicates ? preview.summary.duplicate : 0)} row(s)</button></div>
        </section>
      )}

      <section className="panel">
        <h2>Recent imports</h2>
        {!data.batches.length ? <div className="empty">No statements imported yet.</div> : (
          <table>
            <thead><tr><th>Imported</th><th>Entity</th><th>Account</th><th>File</th><th>Rows</th><th>Imported</th><th>Skipped</th></tr></thead>
            <tbody>{data.batches.map((b) => <tr key={b.id}><td>{dateText(b.imported_at)}</td><td>{data.entityCode(b.entity_id)}</td><td>{b.company_account_ref}</td><td>{b.filename}</td><td>{b.total_rows}</td><td>{b.imported_rows}</td><td>{b.skipped_rows}</td></tr>)}</tbody>
          </table>
        )}
      </section>
    </BankGate>
  );
}

// ====================================================================== matching queue

export function MatchingView() {
  const data = useFinanceOpsData({ bank: true });
  const [entity, setEntity] = useState("");
  const [tab, setTab] = useState<"suggested" | "confirmed" | "manual">("suggested");
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState({ paymentId: "", txId: "" });

  const payById = useMemo(() => new Map(data.payments.map((p) => [p.id, p])), [data.payments]);
  const txById = useMemo(() => new Map(data.bankRows.map((r) => [r.id, r])), [data.bankRows]);
  const confirmedTx = new Set(data.matches.filter((m) => m.status === "confirmed").map((m) => m.bank_transaction_id));
  const confirmedPay = new Set(data.matches.filter((m) => m.status === "confirmed").map((m) => m.payment_register_id));
  const inEntity = (m: Row) => !entity || m.entity_id === entity;
  const suggestions = data.matches.filter((m) => m.status === "suggested" && inEntity(m) && payById.has(m.payment_register_id) && txById.has(m.bank_transaction_id) && !confirmedTx.has(m.bank_transaction_id) && !confirmedPay.has(m.payment_register_id)
    && EARLY_STATUSES.includes(payById.get(m.payment_register_id)?.status));
  const confirmed = data.matches.filter((m) => m.status === "confirmed" && inEntity(m));
  const openPayments = data.payments.filter((p) => EARLY_STATUSES.includes(p.status) && !confirmedPay.has(p.id) && (!entity || p.entity_id === entity));
  const openTx = data.bankRows.filter((r) => r.direction === "debit" && !confirmedTx.has(r.id) && classifyBankRow({ direction: "debit", description: r.description, amount: Number(r.amount), payeeName: r.payee_name }) === "payment_candidate" && (!entity || r.entity_id === entity));
  const fees = data.bankRows.filter((r) => classifyBankRow({ direction: r.direction, description: r.description, amount: Number(r.amount), payeeName: r.payee_name }) === "bank_fee").length;

  async function run() {
    if (!entity) return data.setError("Choose the entity to match.");
    setBusy(true); data.setError(""); data.setMessage("");
    try {
      const res = await fetch("/api/finance-ops/matching/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entity_id: entity }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return data.setError(json.message || json.error || "Matching failed.");
      data.setMessage(`${json.suggested} new suggestion(s) from ${json.paymentsConsidered} payment(s) and ${json.bankRowsConsidered} bank debit(s); ${json.feeRowsIgnored} bank-fee row(s) ignored.`);
    } finally { setBusy(false); await data.reload(); }
  }

  async function decide(m: Row, action: "confirm" | "reject" | "later" | "unmatch") {
    setBusy(true); data.setError(""); data.setMessage("");
    try {
      if (action === "later") {
        const r = await data.db.from("finance_payment_bank_matches").update({ review_later: !m.review_later }).eq("id", m.id).select("id");
        if (r.error) data.setError(r.error.message);
        return;
      }
      if (action === "reject") {
        const r = await data.db.from("finance_payment_bank_matches").update({ status: "rejected" }).eq("id", m.id).select("id");
        if (r.error) data.setError(r.error.message); else data.setMessage("Marked: not a match. It will not be suggested again.");
        return;
      }
      if (action === "unmatch") {
        const r = await data.db.from("finance_payment_bank_matches").update({ status: "rejected" }).eq("id", m.id).select("id");
        if (r.error) return data.setError(r.error.message);
        const p = await data.db.from("finance_payment_register").update({ status: "ready_for_bank_match" }).eq("id", m.payment_register_id).eq("status", "bank_matched").select("id");
        if (p.error) data.setError(p.error.message); else data.setMessage("Unmatched. The payment is back to ready for bank match.");
        return;
      }
      const c = await data.db.from("finance_payment_bank_matches").update({ status: "confirmed" }).eq("id", m.id).select("id");
      if (c.error) return data.setError(/fbm_one_confirmed/.test(c.error.message) ? "That bank row or payment is already confirmed to another match." : c.error.message);
      const p = await data.db.from("finance_payment_register").update({ status: "bank_matched" }).eq("id", m.payment_register_id).in("status", ["captured", "documents_pending", "ready_for_bank_match", "bank_match_suggested"]).select("id");
      if (p.error) return data.setError(`Match confirmed, but the payment status could not be updated: ${p.error.message}`);
      data.setMessage("Match confirmed: the payment is now Bank matched.");
    } finally { setBusy(false); await data.reload(); }
  }

  async function manualMatch(e: FormEvent) {
    e.preventDefault();
    if (!manual.paymentId || !manual.txId) return data.setError("Choose a payment and a bank row.");
    const p = payById.get(manual.paymentId);
    if (!p) return;
    setBusy(true); data.setError(""); data.setMessage("");
    try {
      const ins = await data.db.from("finance_payment_bank_matches").insert({ entity_id: p.entity_id, payment_register_id: p.id, bank_transaction_id: manual.txId, status: "confirmed", score: 0, reasons: [{ text: "matched manually by a reviewer", kind: "match" }] });
      if (ins.error) return data.setError(ins.error.message);
      const up = await data.db.from("finance_payment_register").update({ status: "bank_matched" }).eq("id", p.id).in("status", ["captured", "documents_pending", "ready_for_bank_match", "bank_match_suggested"]).select("id");
      if (up.error) return data.setError(`Match recorded, but the payment status could not be updated: ${up.error.message}`);
      data.setMessage("Manual match recorded: the payment is now Bank matched.");
      setManual({ paymentId: "", txId: "" });
    } finally { setBusy(false); await data.reload(); }
  }

  const tag = (m: Row) => (m.score >= 90 ? "Strong" : m.score >= 70 ? "Likely" : "Weak / review");

  return (
    <BankGate data={data} title="Matching queue" subtitle="Suggested Match: rule-based and explained, never a verdict. Only a person confirms." active="/finance-ops/matching">
      <section className="panel">
        <div className="panel-head">
          <h2>Match payments to bank rows</h2>
          <div className="mini">
            <label>Entity<select value={entity} onChange={(e) => setEntity(e.target.value)}><option value="">All</option>{data.entities.map((x) => <option key={x.id} value={x.id}>{x.short_code}</option>)}</select></label>
            <button type="button" className="primary" disabled={busy || !entity} onClick={() => void run()}>Run matching</button>
          </div>
        </div>
        <p className="help">{openPayments.length} payment(s) waiting, {openTx.length} unmatched bank debit(s), {fees} bank-fee row(s) set aside (e.g. "OTHER TRANSFER FEE" rows are never matched to a payment).</p>
      </section>
      <PageTabs tabs={[{ id: "suggested", label: "Suggested", count: suggestions.length }, { id: "confirmed", label: "Confirmed", count: confirmed.length }, { id: "manual", label: "Match manually" }]} active={tab} onChange={(id) => setTab(id as typeof tab)} label="Matching views" />

      {tab === "suggested" && (!suggestions.length ? <div className="empty">No suggestions. Import a statement, then run matching.</div> : suggestions.map((m) => {
        const p = payById.get(m.payment_register_id)!; const t = txById.get(m.bank_transaction_id)!;
        return (
          <section key={m.id} className="panel" aria-label="Suggested match">
            <h2>{tag(m)} <span className="tag">{m.score}</span>{m.review_later && <span className="tag">Review later</span>}</h2>
            <div className="grid">
              <div className="mini"><b>Payment</b><p>{p.beneficiary_name ?? "—"} · {money(p.amount, p.currency)}<br />{dateText(p.payment_instruction_date)} {String(p.payment_instruction_time ?? "").slice(0, 5)} · ref {p.bank_reference ?? "—"}<br />{p.purpose ?? ""} <StatusTag status={p.status} /></p></div>
              <div className="mini"><b>Bank statement row</b><p>{t.payee_name ?? "—"} · {money(t.amount, t.currency)}<br />{dateText(t.transaction_date)} {String(t.transaction_time ?? "").slice(0, 5)} · ref {t.bank_reference ?? "—"}<br />{t.description ?? ""}</p></div>
            </div>
            <ul className="mini" aria-label="Why">{(m.reasons as { text: string; kind: string }[]).map((r) => <li key={r.text}><span className="tag">{r.kind === "warn" ? "Check" : "✓"}</span> {r.text}</li>)}</ul>
            <div className="record-actions">
              <button type="button" className="primary" disabled={busy} onClick={() => void decide(m, "confirm")}>Confirm Match</button>
              <button type="button" className="neutral" disabled={busy} onClick={() => void decide(m, "reject")}>Not Match</button>
              <button type="button" className="neutral" disabled={busy} onClick={() => void decide(m, "later")}>{m.review_later ? "Clear review later" : "Review Later"}</button>
            </div>
          </section>
        );
      }))}

      {tab === "confirmed" && (!confirmed.length ? <div className="empty">No confirmed matches yet.</div> : (
        <table>
          <thead><tr><th>Payment</th><th>Amount</th><th>Bank row</th><th>How</th><th>Payment status</th><th /></tr></thead>
          <tbody>{confirmed.map((m) => {
            const p = payById.get(m.payment_register_id); const t = txById.get(m.bank_transaction_id);
            return <tr key={m.id}><td>{p?.beneficiary_name ?? "—"} · {dateText(p?.payment_instruction_date)}</td><td>{p ? money(p.amount) : "—"}</td><td>{t ? `${t.payee_name ?? ""} ${t.bank_reference ?? ""} ${dateText(t.transaction_date)}` : "—"}</td><td>{m.match_method === "manual" ? "Manual" : "Suggested, confirmed"} · {dateText(m.confirmed_at)}</td><td>{p && <StatusTag status={p.status} />}</td>
              <td>{p && ["bank_matched", "ready_for_bank_match", "bank_match_suggested", "documents_pending", "captured"].includes(p.status) && <button type="button" className="neutral" disabled={busy} onClick={() => window.confirm("Unmatch this payment from the bank row?") && void decide(m, "unmatch")}>Unmatch</button>}</td></tr>;
          })}</tbody>
        </table>
      ))}

      {tab === "manual" && (
        <form className="panel mini" onSubmit={manualMatch} aria-label="Match manually">
          <h2>Match manually</h2>
          <label>Payment<select value={manual.paymentId} onChange={(e) => setManual({ ...manual, paymentId: e.target.value })}><option value="">Choose</option>{openPayments.map((p) => <option key={p.id} value={p.id}>{data.entityCode(p.entity_id)} · {dateText(p.payment_instruction_date)} · {p.beneficiary_name ?? "—"} · {money(p.amount)}</option>)}</select></label>
          <label>Bank row (debit)<select value={manual.txId} onChange={(e) => setManual({ ...manual, txId: e.target.value })}><option value="">Choose</option>{openTx.filter((r) => !manual.paymentId || r.entity_id === payById.get(manual.paymentId)?.entity_id).map((r) => <option key={r.id} value={r.id}>{dateText(r.transaction_date)} · {r.payee_name ?? r.description ?? "—"} · {money(r.amount)} · {r.bank_reference ?? ""}</option>)}</select></label>
          <p className="help">For split or combined payments, match the part you can and add a note on the payment: the Phase 1 rule is one payment to one bank row.</p>
          <div className="record-actions"><button type="submit" className="primary" disabled={busy}>Confirm manual match</button></div>
        </form>
      )}
    </BankGate>
  );
}
