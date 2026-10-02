"use client";

import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { PageTabs } from "@/app/ui-v2";
import { ageDays, dateText, FinanceOpsShell, money, StatusTag, todayIso, useFinanceOpsData, type FinanceOpsData, type Row } from "@/app/finance-ops-shared";
import { attachFileToPayments, PaymentDrawer, syncEarlyStatus } from "@/app/finance-ops-payments";
import { buildSqlPackage, sqlPackagesToCsv } from "@/lib/financeops/payments/sql-package";
import { DOC_ROLE_LABELS, DOC_ROLES, ENTITY_CODES, isFinanceReviewer, isOwnerOrFinanceManager, PAYMENT_TYPE_LABELS, PAYMENT_TYPES, type DocRole, type PaymentType } from "@/lib/financeops/payments/types";

// ====================================================================== missing documents

export function MissingDocumentsView() {
  const data = useFinanceOpsData({ bank: true });
  const [entity, setEntity] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRole, setBulkRole] = useState<DocRole>("wage_schedule");
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reviewer = isFinanceReviewer(data.me.role);

  const rows = useMemo(() => data.payments
    .filter((p) => p.status !== "reconciled" && (!entity || p.entity_id === entity))
    .map((p) => ({ p, ds: data.documentState(p) }))
    .filter(({ p, ds }) => ds.missing.length > 0 && !p.document_exception_approved_at)
    .sort((a, b) => String(a.p.payment_instruction_date).localeCompare(String(b.p.payment_instruction_date))), [data, entity]);

  const bankStatus = (p: Row) => (["bank_matched", "finance_review", "ready_for_sql", "posted_to_sql"].includes(p.status) ? "Matched" : p.status === "bank_match_suggested" ? "Match suggested" : p.bank_match_not_applicable ? "Not applicable" : "Not matched");

  async function act(label: string, work: () => Promise<string | null | void>) {
    setBusy(true); data.setError(""); data.setMessage("");
    try { const err = await work(); if (err) data.setError(err); else data.setMessage(`${label} saved.`); } finally { setBusy(false); await data.reload(); }
  }

  async function attachOne(p: Row, role: DocRole, file: File | undefined) {
    if (!file) return;
    await act("Document", async () => { const err = await attachFileToPayments(data, [p], role, file); if (!err) await syncEarlyStatus(data, p); return err; });
  }

  async function attachBulk(file: File | undefined) {
    if (!file) return;
    const chosen = rows.filter(({ p }) => selected.has(p.id)).map(({ p }) => p);
    if (chosen.length === 0) return data.setError("Tick the payments this file supports first.");
    await act(`${DOC_ROLE_LABELS[bulkRole]} for ${chosen.length} payment(s)`, async () => {
      const err = await attachFileToPayments(data, chosen, bulkRole, file);
      if (!err) for (const p of chosen) await syncEarlyStatus(data, p);
      return err;
    });
    setSelected(new Set());
  }

  return (
    <FinanceOpsShell title="Missing documents" subtitle="Everything a payment still needs. A missing document never rejects a payment: it waits here until it is attached, marked not applicable, or a finance reviewer approves an exception." active="/finance-ops/missing-documents" message={data.message} error={data.error}>
      {data.loading ? <div className="empty">Loading...</div> : (
        <>
          <section className="panel">
            <div className="panel-head"><h2>{rows.length} payment(s) with missing documents</h2>
              <label>Entity<select value={entity} onChange={(e) => { setEntity(e.target.value); setSelected(new Set()); }}><option value="">All</option>{data.entities.map((x) => <option key={x.id} value={x.id}>{x.short_code}</option>)}</select></label></div>
            {data.me.role !== "management" && (
              <div className="mini" role="group" aria-label="Attach one file to several payments">
                <b>One file, several payments (e.g. one wage schedule for all interns)</b>
                <label>Document<select value={bulkRole} onChange={(e) => setBulkRole(e.target.value as DocRole)}>{DOC_ROLES.map((r) => <option key={r} value={r}>{DOC_ROLE_LABELS[r]}</option>)}</select></label>
                <label>File for the {selected.size} ticked payment(s)<input type="file" disabled={busy || selected.size === 0} accept=".pdf,.jpg,.jpeg,.png,.csv,.xlsx" onChange={(e) => void attachBulk(e.target.files?.[0])} /></label>
              </div>
            )}
          </section>
          {!rows.length ? <div className="empty">Nothing is missing.</div> : (
            <div style={{ overflowX: "auto" }}><table>
              <thead><tr><th /><th>Entity</th><th>Date</th><th>Payee</th><th>Amount</th><th>Purpose</th><th>Bank match</th><th>Required</th><th>Have</th><th>Missing</th><th>Age</th><th>Follow-up</th><th>Actions</th></tr></thead>
              <tbody>
                {rows.map(({ p, ds }) => (
                  <tr key={p.id}>
                    <td><input type="checkbox" aria-label="Select payment" checked={selected.has(p.id)} onChange={(e) => { const next = new Set(selected); if (e.target.checked) next.add(p.id); else next.delete(p.id); setSelected(next); }} /></td>
                    <td>{data.entityCode(p.entity_id)}</td><td>{dateText(p.payment_instruction_date)}</td><td>{p.beneficiary_name ?? <em>not stated</em>}</td><td>{money(p.amount, p.currency)}</td><td>{p.purpose ?? <em>not stated</em>}</td>
                    <td>{bankStatus(p)}</td>
                    <td>{ds.required.map((r) => DOC_ROLE_LABELS[r]).join(", ")}</td>
                    <td>{ds.available.length ? Array.from(new Set(ds.available)).map((r) => DOC_ROLE_LABELS[r]).join(", ") : "—"}</td>
                    <td><b>{ds.missing.map((r) => DOC_ROLE_LABELS[r]).join(", ")}</b></td>
                    <td>{ageDays(p.payment_instruction_date)}d</td>
                    <td>{p.followup_note ?? ""}</td>
                    <td>
                      {data.me.role !== "management" && <input type="file" aria-label={`Attach ${DOC_ROLE_LABELS[ds.missing[0]]}`} accept=".pdf,.jpg,.jpeg,.png,.csv,.xlsx" disabled={busy} onChange={(e) => void attachOne(p, ds.missing[0], e.target.files?.[0])} />}
                      {reviewer && <button type="button" className="neutral" disabled={busy} onClick={() => { const note = window.prompt(`Approve an exception for ${p.beneficiary_name ?? "this payment"}? Why can it proceed without ${ds.missing.map((r) => DOC_ROLE_LABELS[r]).join(", ")}?`); if (note && note.trim().length >= 3) void act("Exception", async () => { const r = await data.db.from("finance_payment_register").update({ document_exception_note: note.trim() }).eq("id", p.id).select("id"); if (!r.error) await syncEarlyStatus(data, { ...p, document_exception_approved_at: "now" }); return r.error?.message ?? null; }); }}>Approve exception</button>}
                      {reviewer && ds.missing.length === 1 && <button type="button" className="neutral" disabled={busy} onClick={() => void act("Not applicable", async () => { const r = await data.db.from("finance_payment_register").update({ not_applicable_documents: [...(p.not_applicable_documents ?? []), ds.missing[0]], not_applicable_note: `${DOC_ROLE_LABELS[ds.missing[0]]} marked not applicable by a reviewer` }).eq("id", p.id).select("id"); if (!r.error) await syncEarlyStatus(data, { ...p, not_applicable_documents: [...(p.not_applicable_documents ?? []), ds.missing[0]] }); return r.error?.message ?? null; })}>Mark not applicable</button>}
                      {data.me.role !== "management" && <button type="button" className="neutral" disabled={busy} onClick={() => { const note = window.prompt("Follow-up note (who is chasing what)", p.followup_note ?? ""); if (note !== null) void act("Follow-up", async () => (await data.db.from("finance_payment_register").update({ followup_note: note.trim() || null }).eq("id", p.id).select("id")).error?.message ?? null); }}>Follow-up note</button>}
                      <button type="button" className="neutral" onClick={() => setOpenId(p.id)}>Open</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
          {openId && data.payments.find((p) => p.id === openId) && <PaymentDrawer key={openId} data={data} payment={data.payments.find((p) => p.id === openId)!} onClose={() => setOpenId(null)} />}
        </>
      )}
    </FinanceOpsShell>
  );
}

// ====================================================================== SQL queue

function packagesFor(data: FinanceOpsData, rows: Row[]) {
  return rows.map((p) => {
    const match = data.matches.find((m) => m.payment_register_id === p.id && m.status === "confirmed");
    const tx = match ? data.bankRows.find((r) => r.id === match.bank_transaction_id) : undefined;
    const bill = p.supplier_bill_id ? data.bills.find((b) => b.id === p.supplier_bill_id) : undefined;
    return buildSqlPackage({ payment: p as never, entityCode: data.entityCode(p.entity_id), bill: (bill ?? null) as never, bankRow: (tx ?? null) as never, documents: data.docs.filter((d) => d.payment_register_id === p.id) as never });
  });
}

export function SqlQueueView() {
  const data = useFinanceOpsData({ bank: true });
  const params = useSearchParams();
  const [tab, setTab] = useState<"ready" | "posted" | "reconciled">(params.get("tab") === "posted" ? "posted" : "ready");
  const [openId, setOpenId] = useState<string | null>(null);
  const reviewer = isFinanceReviewer(data.me.role);
  const ready = data.payments.filter((p) => p.status === "ready_for_sql");
  const posted = data.payments.filter((p) => p.status === "posted_to_sql");
  const reconciled = data.payments.filter((p) => p.status === "reconciled").slice(0, 100);
  const list = tab === "ready" ? ready : tab === "posted" ? posted : reconciled;
  const packages = useMemo(() => packagesFor(data, list), [data, list]);

  function download() {
    const csv = sqlPackagesToCsv(packages);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `sql-posting-package-${todayIso()}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <FinanceOpsShell title="SQL posting queue" subtitle="Prepare and track what goes into SQL Account. The Hub does not connect to SQL Account: a person posts it there, then records the SQL reference here." active="/finance-ops/sql-queue" message={data.message} error={data.error}>
      {data.loading ? <div className="empty">Loading...</div> : (
        <>
          <PageTabs tabs={[{ id: "ready", label: "Ready for SQL", count: ready.length }, { id: "posted", label: "Posted: reconciliation pending", count: posted.length }, { id: "reconciled", label: "Reconciled", count: reconciled.length }]} active={tab} onChange={(id) => setTab(id as typeof tab)} label="SQL queue views" />
          {!list.length ? <div className="empty">{tab === "ready" ? "Nothing is ready for SQL." : tab === "posted" ? "Nothing is waiting for reconciliation." : "Nothing reconciled yet."}</div> : (
            <>
              <div className="record-actions"><button type="button" className="neutral" onClick={download}>Download posting package (CSV)</button></div>
              <div style={{ overflowX: "auto" }}><table>
                <thead><tr><th /><th>Entity</th><th>Date</th><th>Payee</th><th>Description</th><th>Amount</th><th>Account code</th><th>Pay from</th><th>Invoice / ref</th><th>Bank txn ref</th><th>Hub ID</th><th>{tab === "ready" ? "" : "SQL reference"}</th><th /></tr></thead>
                <tbody>
                  {list.map((p, i) => {
                    const k = packages[i];
                    return (
                      <tr key={p.id}>
                        <td>{reviewer ? <button type="button" className="primary" onClick={() => setOpenId(p.id)}>{tab === "ready" ? "Record posted" : tab === "posted" ? "Track reconciled" : "Open"}</button> : <button type="button" className="neutral" onClick={() => setOpenId(p.id)}>Open</button>}</td>
                        <td>{k.entity}</td><td>{dateText(k.paymentDate)}</td><td>{k.payee}</td><td>{k.description}</td><td>{money(k.amount, k.currency)}</td><td>{k.accountCode || <em>not set</em>}</td><td>{k.payFromAccount}</td><td>{k.invoiceReference || k.voucherReference}</td><td>{k.bankTransactionReference}</td>
                        <td title={k.hubPaymentId}>{k.hubPaymentId.slice(0, 8)}</td>
                        <td>{tab === "ready" ? <StatusTag status={p.status} /> : <>{p.sql_reference} · {dateText(p.sql_posting_date)}{p.reconciled_date ? ` · reconciled ${dateText(p.reconciled_date)}` : ""}</>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table></div>
            </>
          )}
          {openId && data.payments.find((p) => p.id === openId) && <PaymentDrawer key={openId} data={data} payment={data.payments.find((p) => p.id === openId)!} onClose={() => setOpenId(null)} />}
        </>
      )}
    </FinanceOpsShell>
  );
}

// ====================================================================== one-time import of the old Excel register

type RegPreview = {
  sheets: string[]; sheet: string; headers: string[]; mapping: Record<string, string>;
  rows: { rowNumber: number; legacyPaymentId: string | null; entityCode: string | null; entityBasis: string; instructionDate: string | null; beneficiaryName: string | null; amount: number | null; purpose: string | null; paymentType: PaymentType; targetStatus: string; needsAttention: boolean; attentionReasons: string[]; errors: string[]; warnings: string[]; state: string; duplicateOf: string | null }[];
  summary: { total: number; new: number; duplicate: number; invalid: number; empty: number; needsAttention: number; byType: Record<string, number>; byEntity: Record<string, number> };
};

export function RegisterImportView() {
  const data = useFinanceOpsData();
  const [file, setFile] = useState<File | null>(null);
  const [defaultEntity, setDefaultEntity] = useState("");
  const [accountMap, setAccountMap] = useState("8001344252=IETA");
  const [waive, setWaive] = useState(false);
  const [preview, setPreview] = useState<RegPreview | null>(null);
  const [overrides, setOverrides] = useState<Record<string, { paymentType?: PaymentType; entityCode?: string }>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ imported: number; skipped: number; failed: { rowNumber: number; message: string }[] } | null>(null);
  const ownerFm = isOwnerOrFinanceManager(data.me.role);
  const canImport = ["owner", "finance_manager", "finance_staff", "data_entry"].includes(data.me.role ?? "");

  function form(): FormData {
    const fd = new FormData();
    if (file) fd.set("file", file);
    fd.set("default_entity", defaultEntity);
    const map: Record<string, string> = {};
    for (const part of accountMap.split(/[\n;,]+/)) { const [a, b] = part.split("="); if (a && b) map[a.trim()] = b.trim(); }
    fd.set("account_entity_map", JSON.stringify(map));
    fd.set("waive_documents", String(waive && ownerFm));
    fd.set("overrides", JSON.stringify(overrides));
    return fd;
  }

  async function call(path: string) {
    if (!file) { data.setError("Choose the Excel (XLSX) or CSV file."); return null; }
    setBusy(true); data.setError(""); data.setMessage("");
    try {
      const res = await fetch(path, { method: "POST", body: form() });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { data.setError(json.message || json.error || "The request failed."); return null; }
      return json;
    } finally { setBusy(false); }
  }

  return (
    <FinanceOpsShell title="Import the old Excel Payment Register" subtitle="One-time and optional. Preview first: new, duplicate, invalid. Nothing is overwritten; the old statuses are kept for reference." active="/finance-ops/register-import" message={data.message} error={data.error}>
      {data.loading ? <div className="empty">Loading...</div> : !canImport ? <div className="notice error"><p>Importing the register is limited to finance and data entry users.</p></div> : (
        <>
          <section className="panel">
            <h2>File</h2>
            <div className="mini">
              <label>Excel (XLSX) or CSV<input type="file" accept=".xlsx,.csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setResult(null); setOverrides({}); }} /></label>
              <label>Entity to use when a row does not show one<select value={defaultEntity} onChange={(e) => setDefaultEntity(e.target.value)}><option value="">None: ask me per row</option>{ENTITY_CODES.map((c) => <option key={c}>{c}</option>)}</select></label>
              <label>Company account numbers (account=ENTITY, one per line)<textarea value={accountMap} onChange={(e) => setAccountMap(e.target.value)} /></label>
              {ownerFm && <label><input type="checkbox" checked={waive} onChange={(e) => setWaive(e.target.checked)} /> The supporting documents are held outside the Hub: record an approved exception on each imported payment</label>}
              <div className="record-actions"><button type="button" className="primary" disabled={busy || !file} onClick={async () => { const json = await call("/api/finance-ops/register-import/preview"); if (json) setPreview(json); }}>Preview</button></div>
            </div>
          </section>
          {preview && (
            <section className="panel" aria-label="Register import preview">
              <h2>Preview</h2>
              <p className="help">{preview.summary.total} rows: <b>{preview.summary.new} new</b> ({preview.summary.needsAttention} flagged for attention), {preview.summary.duplicate} duplicate, {preview.summary.invalid} invalid, {preview.summary.empty} empty. Sheet "{preview.sheet}".</p>
              <table>
                <thead><tr><th>Row</th><th>Old ID</th><th>Date</th><th>Entity</th><th>Payee</th><th>Amount</th><th>Type</th><th>Starts as</th><th>Result</th></tr></thead>
                <tbody>
                  {preview.rows.filter((r) => r.state !== "empty").map((r) => (
                    <tr key={r.rowNumber}>
                      <td>{r.rowNumber}</td><td>{r.legacyPaymentId}</td><td>{r.instructionDate ?? "—"}</td>
                      <td>{r.entityCode ?? <select aria-label="Entity for this row" value={overrides[String(r.rowNumber)]?.entityCode ?? ""} onChange={(e) => setOverrides({ ...overrides, [String(r.rowNumber)]: { ...overrides[String(r.rowNumber)], entityCode: e.target.value } })}><option value="">Choose</option>{ENTITY_CODES.map((c) => <option key={c}>{c}</option>)}</select>}</td>
                      <td>{r.beneficiaryName ?? ""}</td><td>{r.amount === null ? "—" : money(r.amount)}</td>
                      <td><select aria-label="Payment type for this row" value={overrides[String(r.rowNumber)]?.paymentType ?? r.paymentType} onChange={(e) => setOverrides({ ...overrides, [String(r.rowNumber)]: { ...overrides[String(r.rowNumber)], paymentType: e.target.value as PaymentType } })}>{PAYMENT_TYPES.map((t) => <option key={t} value={t}>{PAYMENT_TYPE_LABELS[t]}</option>)}</select></td>
                      <td>{r.targetStatus.replace(/_/g, " ")}{r.needsAttention ? ` · ${r.attentionReasons.join(", ").replace(/_/g, " ")}` : ""}</td>
                      <td>{r.state === "new" ? "New" : r.state === "duplicate" ? `Skipped: ${r.duplicateOf}` : `Invalid: ${r.errors.join("; ")}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="record-actions">
                <button type="button" className="neutral" disabled={busy} onClick={async () => { const json = await call("/api/finance-ops/register-import/preview"); if (json) setPreview(json); }}>Refresh preview with my choices</button>
                <button type="button" className="primary" disabled={busy || preview.summary.new === 0} onClick={async () => { const json = await call("/api/finance-ops/register-import/confirm"); if (json) { setResult(json); setPreview(null); await data.reload(); } }}>Import {preview.summary.new} new row(s)</button>
              </div>
            </section>
          )}
          {result && <section className="notice"><p>Imported {result.imported}; skipped {result.skipped}; {result.failed.length} failed.{result.failed.length > 0 && ` ${result.failed.map((f) => `row ${f.rowNumber}: ${f.message}`).join(" | ")}`}</p></section>}
        </>
      )}
    </FinanceOpsShell>
  );
}
