"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { DetailDrawer, FieldValue } from "@/app/ui-v2";
import { ageDays, dateText, FinanceOpsShell, money, StatusTag, todayIso, useFinanceOpsData, type FinanceOpsData, type Row } from "@/app/finance-ops-shared";
import { documentChecklist, requirementsFor } from "@/lib/financeops/payments/requirements";
import { allowedMoves, canEditDetails } from "@/lib/financeops/payments/rules";
import {
  DOC_ROLE_LABELS, DOC_ROLES, EARLY_STATUSES, isFinanceReviewer, PAYMENT_METHODS, PAYMENT_STATUSES, PAYMENT_TYPE_LABELS, PAYMENT_TYPES, STATUS_LABELS,
  type DocRole, type PaymentStatus, type PaymentType,
} from "@/lib/financeops/payments/types";

const ALLOWED_UPLOAD_TYPES = ["application/pdf", "image/jpeg", "image/png", "text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"];
const EXT: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "text/csv": "csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx" };

export async function sha256OfFile(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Upload (or reuse) one file and attach it to payments of ONE entity. Insert-only; no read-back of the new row. */
export async function attachFileToPayments(data: FinanceOpsData, payments: Row[], role: DocRole, file: File): Promise<string | null> {
  if (!ALLOWED_UPLOAD_TYPES.includes(file.type)) return "Only PDF, JPEG, PNG, CSV or XLSX files are accepted.";
  if (file.size > 10 * 1024 * 1024) return "Files are limited to 10 MB.";
  if (!data.me.id) return "Your session has expired.";
  const entityIds = new Set(payments.map((p) => p.entity_id));
  if (entityIds.size !== 1) return "Choose payments of one entity at a time.";
  const entityId = payments[0].entity_id as string;
  const hash = await sha256OfFile(file);
  // the same file already stored for this entity (e.g. one wage schedule for ten payments) is reused, not uploaded again
  const existing = data.docs.find((d) => d.entity_id === entityId && d.file_hash === hash);
  let path = existing?.storage_path as string | undefined;
  if (!path) {
    const now = new Date();
    path = `${entityId}/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/payments/${crypto.randomUUID()}.${EXT[file.type] ?? "bin"}`;
    const up = await data.db.storage.from("finance-payment-documents").upload(path, file, { contentType: file.type, upsert: false });
    if (up.error) return up.error.message;
  }
  for (const p of payments) {
    const res = await data.db.from("finance_payment_documents").insert({
      payment_register_id: p.id, entity_id: entityId, doc_role: role, storage_path: path, original_filename: file.name.replace(/[^\w.\- ]+/g, "_").slice(0, 200) || "document",
      mime_type: file.type, file_size: file.size, file_hash: hash, uploaded_by: data.me.id,
    });
    if (res.error && !/duplicate|fpd_live_hash_uidx|fpd_storage_path_key/i.test(res.error.message)) return `${p.beneficiary_name ?? "payment"}: ${res.error.message}`;
  }
  return null;
}

/** After documents change, keep an EARLY payment's status honest: documents_pending <-> ready_for_bank_match. */
export async function syncEarlyStatus(data: FinanceOpsData, p: Row): Promise<void> {
  if (!["captured", "documents_pending", "ready_for_bank_match"].includes(p.status)) return;
  const fresh = await data.db.from("finance_payment_documents").select("doc_role").eq("payment_register_id", p.id).is("removed_at", null);
  const available = (fresh.data ?? []).map((d) => d.doc_role as DocRole);
  const required = ((p.required_documents as DocRole[] | null)?.length ? p.required_documents : requirementsFor(p.payment_type)) as DocRole[];
  const na = (p.not_applicable_documents ?? []) as DocRole[];
  const missing = required.filter((r) => !na.includes(r) && !available.includes(r));
  const want: PaymentStatus = missing.length > 0 && !p.document_exception_approved_at ? "documents_pending" : "ready_for_bank_match";
  if (want !== p.status) await data.db.from("finance_payment_register").update({ status: want }).eq("id", p.id).in("status", ["captured", "documents_pending", "ready_for_bank_match"]);
}

// ====================================================================== dashboard

export function DashboardView() {
  const data = useFinanceOpsData({ bank: true });
  const { payments, matches } = data;
  const open = payments.filter((p) => p.status !== "reconciled");
  const today = todayIso();
  const cards: { label: string; value: number; href: string; hint: string }[] = [
    { label: "Captured today", value: payments.filter((p) => String(p.created_at).slice(0, 10) === today).length, href: "/finance-ops/payments?created=today", hint: "new in the register today" },
    { label: "Documents pending", value: payments.filter((p) => p.status === "documents_pending").length, href: "/finance-ops/missing-documents", hint: "something required is missing" },
    { label: "Ready for bank match", value: payments.filter((p) => p.status === "ready_for_bank_match").length, href: "/finance-ops/payments?status=ready_for_bank_match", hint: "waiting for a statement row" },
    { label: "Suggested matches", value: matches.filter((m) => m.status === "suggested").length || payments.filter((p) => p.status === "bank_match_suggested").length, href: "/finance-ops/matching", hint: "a human confirms or rejects" },
    { label: "Bank matched", value: payments.filter((p) => p.status === "bank_matched").length, href: "/finance-ops/payments?status=bank_matched", hint: "matched, awaiting finance review" },
    { label: "Finance review", value: payments.filter((p) => p.status === "finance_review").length, href: "/finance-ops/payments?status=finance_review", hint: "ready for a reviewer's decision" },
    { label: "Ready for SQL", value: payments.filter((p) => p.status === "ready_for_sql").length, href: "/finance-ops/sql-queue", hint: "to post in SQL Account" },
    { label: "Posted to SQL", value: payments.filter((p) => p.status === "posted_to_sql").length, href: "/finance-ops/sql-queue?tab=posted", hint: "posted; reconciliation pending" },
    { label: "Needs attention", value: open.filter((p) => p.needs_attention).length, href: "/finance-ops/payments?attention=1", hint: "flagged for a human" },
  ];
  return (
    <FinanceOpsShell title="Finance Operations" subtitle="Payment evidence in, bank statement matched, documents checked, handed to SQL Account. SQL Account stays the official accounting and bank reconciliation system." active="/finance-ops" message={data.message} error={data.error}>
      {data.loading ? <div className="empty">Loading...</div> : (
        <>
          <section className="metric-grid">
            {cards.map((c) => (
              <Link key={c.label} href={c.href} className="inline-card" title={c.hint}><strong>{c.label}</strong><span>{c.value}</span><span>{c.hint}</span></Link>
            ))}
          </section>
          <section className="panel">
            <h2>How a payment moves</h2>
            <p className="help">Captured, Documents pending, Ready for bank match, Bank match suggested, Bank matched, Finance review, Ready for SQL, Posted to SQL, Reconciled. A payment instruction or screenshot is not a bank transaction, a bank transaction is not an accounting posting, and none of them is the bank reconciliation: those four stay separate. Anything uncertain is flagged for a person, never guessed.</p>
          </section>
        </>
      )}
    </FinanceOpsShell>
  );
}

// ====================================================================== payment register

const emptyForm = { entity_id: "", payment_type: "supplier_expense" as PaymentType, payment_instruction_date: todayIso(), payment_instruction_time: "", payment_method: "bank_transfer", pay_from_account_ref: "", beneficiary_name: "", beneficiary_account_no: "", beneficiary_bank: "", amount: "", bank_reference: "", purpose: "" };

export function PaymentsView() {
  const data = useFinanceOpsData({ bank: true });
  const params = useSearchParams();
  const [entity, setEntity] = useState("");
  const [status, setStatus] = useState(params.get("status") ?? "");
  const [attentionOnly, setAttentionOnly] = useState(params.get("attention") === "1");
  const [createdToday, setCreatedToday] = useState(params.get("created") === "today");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [showNew, setShowNew] = useState(false);
  const { payments, me } = data;

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return payments.filter((p) =>
      (!entity || p.entity_id === entity) && (!status || p.status === status) && (!attentionOnly || p.needs_attention) && (!createdToday || String(p.created_at).slice(0, 10) === todayIso()) &&
      (!q || [p.beneficiary_name, p.purpose, p.bank_reference, p.beneficiary_account_no, p.amount].some((v) => String(v ?? "").toLowerCase().includes(q))));
  }, [payments, entity, status, attentionOnly, createdToday, search]);
  const selected = payments.find((p) => p.id === selectedId) ?? null;
  const canCreate = ["owner", "finance_manager", "finance_staff", "data_entry"].includes(me.role ?? "");

  async function create(e: FormEvent) {
    e.preventDefault();
    data.setError(""); data.setMessage("");
    const amount = Number(form.amount);
    if (!form.entity_id) return data.setError("Choose the entity.");
    if (!(amount > 0)) return data.setError("Enter an amount greater than zero.");
    if (!me.id) return data.setError("Your session has expired.");
    const res = await data.db.from("finance_payment_register").insert({
      entity_id: form.entity_id, source_type: "manual", payment_type: form.payment_type, payment_instruction_date: form.payment_instruction_date, payment_instruction_time: form.payment_instruction_time || null,
      payment_method: form.payment_method, pay_from_account_ref: form.pay_from_account_ref.trim() || null, beneficiary_name: form.beneficiary_name.trim() || null, beneficiary_account_no: form.beneficiary_account_no.trim() || null,
      beneficiary_bank: form.beneficiary_bank.trim() || null, amount, currency: "MYR", bank_reference: form.bank_reference.trim() || null, purpose: form.purpose.trim() || null,
      required_documents: requirementsFor(form.payment_type), status: "documents_pending", created_by: me.id,
    });
    if (res.error) return data.setError(res.error.message);
    data.setMessage("Payment recorded. Attach its documents (payment evidence and what its type requires) from the payment's details.");
    setForm({ ...emptyForm, entity_id: form.entity_id });
    setShowNew(false);
    await data.reload();
  }

  return (
    <FinanceOpsShell title="Payment Register" subtitle="An operational record of each payment. It does not mean bank-cleared, posted or reconciled." active="/finance-ops/payments" message={data.message} error={data.error}>
      {data.loading ? <div className="empty">Loading...</div> : (
        <>
          <section className="panel">
            <div className="panel-head">
              <h2>{rows.length} payment{rows.length === 1 ? "" : "s"}</h2>
              {canCreate && <button type="button" className="primary" onClick={() => setShowNew(!showNew)}>{showNew ? "Close" : "Record a payment"}</button>}
            </div>
            <div className="mini" role="group" aria-label="Filters">
              <label>Entity<select value={entity} onChange={(e) => setEntity(e.target.value)}><option value="">All</option>{data.entities.map((x) => <option key={x.id} value={x.id}>{x.short_code}</option>)}</select></label>
              <label>Status<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{PAYMENT_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}</select></label>
              <label>Search<input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="payee, reference, amount" /></label>
              <label><input type="checkbox" checked={attentionOnly} onChange={(e) => setAttentionOnly(e.target.checked)} /> Needs attention only</label>
              <label><input type="checkbox" checked={createdToday} onChange={(e) => setCreatedToday(e.target.checked)} /> Captured today</label>
            </div>
            {showNew && canCreate && (
              <form className="mini" onSubmit={create} aria-label="Record a payment">
                <label>Entity<select value={form.entity_id} onChange={(e) => setForm({ ...form, entity_id: e.target.value })} required><option value="">Choose</option>{data.entities.map((x) => <option key={x.id} value={x.id}>{x.short_code}</option>)}</select></label>
                <label>Type<select value={form.payment_type} onChange={(e) => setForm({ ...form, payment_type: e.target.value as PaymentType })}>{PAYMENT_TYPES.map((t) => <option key={t} value={t}>{PAYMENT_TYPE_LABELS[t]}</option>)}</select></label>
                <label>Payment date<input type="date" value={form.payment_instruction_date} onChange={(e) => setForm({ ...form, payment_instruction_date: e.target.value })} required /></label>
                <label>Time (optional)<input type="time" step="1" value={form.payment_instruction_time} onChange={(e) => setForm({ ...form, payment_instruction_time: e.target.value })} /></label>
                <label>Method<select value={form.payment_method} onChange={(e) => setForm({ ...form, payment_method: e.target.value })}>{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m.replace(/_/g, " ")}</option>)}</select></label>
                <label>Pay-from account<input value={form.pay_from_account_ref} onChange={(e) => setForm({ ...form, pay_from_account_ref: e.target.value })} placeholder="e.g. 8001344252" /></label>
                <label>Beneficiary<input value={form.beneficiary_name} onChange={(e) => setForm({ ...form, beneficiary_name: e.target.value })} /></label>
                <label>Beneficiary account<input value={form.beneficiary_account_no} onChange={(e) => setForm({ ...form, beneficiary_account_no: e.target.value })} /></label>
                <label>Beneficiary bank<input value={form.beneficiary_bank} onChange={(e) => setForm({ ...form, beneficiary_bank: e.target.value })} /></label>
                <label>Amount (MYR)<input type="number" step="0.01" min="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required /></label>
                <label>Bank / payment reference<input value={form.bank_reference} onChange={(e) => setForm({ ...form, bank_reference: e.target.value })} /></label>
                <label>Purpose<input value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} /></label>
                <div className="record-actions"><button type="submit" className="primary">Save payment</button></div>
              </form>
            )}
          </section>
          {!rows.length ? <div className="empty">No payments match.</div> : (
            <div style={{ overflowX: "auto" }}><table>
              <thead><tr><th>Date</th><th>Entity</th><th>Payee</th><th>Amount</th><th>Purpose</th><th>Type</th><th>Status</th><th>Documents</th><th /></tr></thead>
              <tbody>
                {rows.map((p) => {
                  const ds = data.documentState(p);
                  return (
                    <tr key={p.id}>
                      <td>{dateText(p.payment_instruction_date)}</td>
                      <td>{data.entityCode(p.entity_id)}</td>
                      <td>{p.beneficiary_name ?? <em>not stated</em>}</td>
                      <td>{money(p.amount, p.currency)}</td>
                      <td>{p.purpose ?? <em>not stated</em>}</td>
                      <td>{PAYMENT_TYPE_LABELS[p.payment_type as PaymentType]}</td>
                      <td><StatusTag status={p.status} />{p.needs_attention && <span className="tag" title={(p.attention_reasons ?? []).join(", ")}>Attention</span>}</td>
                      <td>{ds.missing.length === 0 ? "Complete" : p.document_exception_approved_at ? "Exception approved" : `Missing ${ds.missing.length}`}</td>
                      <td><button type="button" className="neutral" onClick={() => setSelectedId(p.id)}>Open</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          )}
          {selected && <PaymentDrawer key={selected.id} data={data} payment={selected} onClose={() => setSelectedId(null)} />}
        </>
      )}
    </FinanceOpsShell>
  );
}

// ====================================================================== payment detail

export function PaymentDrawer({ data, payment: p, onClose }: { data: FinanceOpsData; payment: Row; onClose: () => void }) {
  const { me, db } = data;
  const reviewer = isFinanceReviewer(me.role);
  const ds = data.documentState(p);
  const [sql, setSql] = useState({ reference: p.sql_reference ?? "", date: p.sql_posting_date ?? todayIso(), note: p.sql_note ?? "", reconciled: p.reconciled_date ?? todayIso() });
  const confirmedMatch = data.matches.find((m) => m.payment_register_id === p.id && m.status === "confirmed");
  const hasConfirmedMatch = Boolean(confirmedMatch) || (["bank_matched", "finance_review", "ready_for_sql", "posted_to_sql", "reconciled"].includes(p.status) && !p.bank_match_not_applicable);
  const ctx = { role: me.role, actorUserId: me.id, createdByUserId: p.created_by, sourceType: p.source_type, status: p.status as PaymentStatus };
  const moves = allowedMoves({ ...ctx, hasConfirmedMatch, bankMatchNotApplicable: p.bank_match_not_applicable, documentsSatisfied: ds.missing.length === 0 || Boolean(p.document_exception_approved_at), missingDocuments: ds.missing, hasSqlReference: sql.reference.trim().length > 0, hasSqlPostingDate: Boolean(sql.date), hasReconciledDate: Boolean(sql.reconciled) });
  const editable = canEditDetails(ctx);
  const [notes, setNotes] = useState(p.notes ?? "");
  const [followup, setFollowup] = useState(p.followup_note ?? "");
  const [role, setRole] = useState<DocRole>(ds.missing[0] ?? "payment_evidence");
  const [busy, setBusy] = useState(false);
  const [exception, setException] = useState(p.document_exception_note ?? "");
  const [naNote, setNaNote] = useState(p.bank_match_na_note ?? "");
  const [billId, setBillId] = useState(p.supplier_bill_id ?? "");
  const [edit, setEdit] = useState({ beneficiary_name: p.beneficiary_name ?? "", beneficiary_account_no: p.beneficiary_account_no ?? "", beneficiary_bank: p.beneficiary_bank ?? "", amount: String(p.amount), purpose: p.purpose ?? "", bank_reference: p.bank_reference ?? "", pay_from_account_ref: p.pay_from_account_ref ?? "", account_code: p.account_code ?? "", payment_type: p.payment_type as PaymentType });

  async function run(label: string, work: () => PromiseLike<{ error?: { message: string } | null } | string | null | void>) {
    setBusy(true); data.setError(""); data.setMessage("");
    try {
      const r = await work();
      const err = typeof r === "string" ? r : r && "error" in r && r.error ? r.error.message : null;
      if (err) data.setError(err); else data.setMessage(`${label} saved.`);
    } finally {
      setBusy(false);
      await data.reload();
    }
  }
  const update = (patch: Row) => db.from("finance_payment_register").update(patch).eq("id", p.id).select("id");

  async function onFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    await run("Document", async () => {
      const err = await attachFileToPayments(data, [p], role, file);
      if (!err) await syncEarlyStatus(data, p);
      return err;
    });
  }
  const bills = data.bills.filter((b) => b.entity_id === p.entity_id);

  return (
    <DetailDrawer open title={`${p.beneficiary_name ?? "Payment"} · ${money(p.amount, p.currency)}`} subtitle={`${data.entityCode(p.entity_id)} · ${dateText(p.payment_instruction_date)} · ${PAYMENT_TYPE_LABELS[p.payment_type as PaymentType]}`} onClose={onClose}>
      <p><StatusTag status={p.status} /> {p.needs_attention && <span className="tag">Needs attention: {(p.attention_reasons ?? []).join(", ").replace(/_/g, " ") || "flagged"}</span>}</p>
      <div className="detail-grid">
        <FieldValue label="Method">{p.payment_method.replace(/_/g, " ")}</FieldValue>
        <FieldValue label="Pay from">{p.pay_from_account_ref}</FieldValue>
        <FieldValue label="Beneficiary account">{p.beneficiary_account_no}</FieldValue>
        <FieldValue label="Beneficiary bank">{p.beneficiary_bank}</FieldValue>
        <FieldValue label="Bank / payment reference">{p.bank_reference}</FieldValue>
        <FieldValue label="Purpose">{p.purpose}</FieldValue>
        <FieldValue label="Source">{p.source_type === "financeops" ? "FinanceOps (Hermes)" : p.source_type === "excel_import" ? "Imported from the old register" : "Entered in the Hub"}</FieldValue>
        <FieldValue label="Age">{`${ageDays(p.payment_instruction_date)} days`}</FieldValue>
      </div>
      {p.legacy_state && <p className="help">Old register: {Object.entries(p.legacy_state as Row).filter(([k]) => ["payment_status", "bank_verification_status", "reconciliation_status", "invoice_status", "supporting_document"].includes(k)).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(" · ")}</p>}
      {p.payload?.notes && <p className="help">FinanceOps note: {String(p.payload.notes)}</p>}

      <section className="mini" aria-label="Documents">
        <b>Documents</b>
        <ul className="mini">
          {documentChecklist(p.payment_type, ds).map((i) => (
            <li key={i.role}><span className="tag">{i.state === "present" ? "✓" : i.state === "via_supplier_bill" ? "✓ via bill" : i.state === "not_applicable" ? "N/A" : "Missing"}</span> {i.label}</li>
          ))}
        </ul>
        <ul className="mini">
          {ds.live.map((d) => (
            <li key={d.id}>
              {DOC_ROLE_LABELS[d.doc_role as DocRole]}: {d.original_filename}{" "}
              <button type="button" className="neutral" onClick={async () => { const s = await db.storage.from("finance-payment-documents").createSignedUrl(d.storage_path, 300); if (s.data?.signedUrl) window.open(s.data.signedUrl, "_blank", "noopener"); else data.setError(s.error?.message ?? "Could not open the file."); }}>Open</button>
              {reviewer && <button type="button" className="neutral" onClick={() => { const reason = window.prompt("Why is this document being removed?"); if (reason && reason.trim().length >= 3) void run("Removal", async () => { const r = await db.from("finance_payment_documents").update({ removed_at: new Date().toISOString(), removal_reason: reason.trim() }).eq("id", d.id).select("id"); if (!r.error) await syncEarlyStatus(data, p); return r; }); }}>Remove</button>}
            </li>
          ))}
        </ul>
        {me.role !== "management" && (
          <div className="record-actions">
            <select value={role} onChange={(e) => setRole(e.target.value as DocRole)} aria-label="Document role">{DOC_ROLES.map((r) => <option key={r} value={r}>{DOC_ROLE_LABELS[r]}</option>)}</select>
            <input type="file" accept=".pdf,.jpg,.jpeg,.png,.csv,.xlsx" disabled={busy} onChange={(e) => void onFile(e.target.files)} aria-label="Attach a document" />
          </div>
        )}
        {p.document_exception_approved_at && <p className="help">Exception approved: {p.document_exception_note}</p>}
      </section>

      {reviewer && (
        <section className="mini" aria-label="Human decisions">
          <b>Decisions (Owner, Finance Manager, Finance Staff)</b>
          <label>Document exception<input value={exception} onChange={(e) => setException(e.target.value)} placeholder="Why can this proceed without the missing document?" /></label>
          <div className="record-actions">
            <button type="button" className="neutral" disabled={busy || exception.trim().length < 3} onClick={() => void run("Exception", () => update({ document_exception_note: exception.trim() }))}>Approve exception</button>
            {p.document_exception_note && <button type="button" className="neutral" disabled={busy} onClick={() => void run("Exception withdrawal", () => update({ document_exception_note: null }))}>Withdraw exception</button>}
          </div>
          <label>Mark documents not applicable
            <select multiple value={(p.not_applicable_documents ?? []) as string[]} onChange={(e) => { const next = Array.from(e.target.selectedOptions).map((o) => o.value); void run("Not-applicable documents", () => update({ not_applicable_documents: next, not_applicable_note: next.length ? "Marked not applicable by a reviewer" : null })); }}>
              {DOC_ROLES.map((r) => <option key={r} value={r}>{DOC_ROLE_LABELS[r]}</option>)}
            </select>
          </label>
          {EARLY_STATUSES.includes(p.status) || p.status === "bank_matched" ? (
            <>
              <label>Bank match not applicable (e.g. cash)<input value={naNote} onChange={(e) => setNaNote(e.target.value)} placeholder="Reason" /></label>
              <div className="record-actions">
                {!p.bank_match_not_applicable ? <button type="button" className="neutral" disabled={busy || naNote.trim().length < 3} onClick={() => void run("Bank-match-not-applicable", () => update({ bank_match_not_applicable: true, bank_match_na_note: naNote.trim() }))}>Mark bank match not applicable</button>
                  : <button type="button" className="neutral" disabled={busy} onClick={() => void run("Bank match applicable", () => update({ bank_match_not_applicable: false }))}>Bank match is applicable after all</button>}
              </div>
            </>
          ) : null}
          {editable && (
            <label>Supplier bill (link)
              <select value={billId} onChange={(e) => { setBillId(e.target.value); void run("Supplier bill link", () => update({ supplier_bill_id: e.target.value || null })); }}>
                <option value="">None</option>{bills.map((b) => <option key={b.id} value={b.id}>{b.bill_number ?? "no number"} · {b.description} · {money(b.total_amount)}</option>)}
              </select>
            </label>
          )}
        </section>
      )}

      {editable && (
        <form className="mini" aria-label="Edit details" onSubmit={(e: FormEvent) => { e.preventDefault(); const amount = Number(edit.amount); if (!(amount > 0)) return data.setError("Enter a valid amount."); void run("Details", () => update({ beneficiary_name: edit.beneficiary_name.trim() || null, beneficiary_account_no: edit.beneficiary_account_no.trim() || null, beneficiary_bank: edit.beneficiary_bank.trim() || null, amount, purpose: edit.purpose.trim() || null, bank_reference: edit.bank_reference.trim() || null, pay_from_account_ref: edit.pay_from_account_ref.trim() || null, payment_type: edit.payment_type, ...(reviewer ? { account_code: edit.account_code.trim() || null } : {}), required_documents: requirementsFor(edit.payment_type) })); }}>
          <b>Correct details</b>
          <label>Type<select value={edit.payment_type} onChange={(e) => setEdit({ ...edit, payment_type: e.target.value as PaymentType })}>{PAYMENT_TYPES.map((t) => <option key={t} value={t}>{PAYMENT_TYPE_LABELS[t]}</option>)}</select></label>
          <label>Beneficiary<input value={edit.beneficiary_name} onChange={(e) => setEdit({ ...edit, beneficiary_name: e.target.value })} /></label>
          <label>Beneficiary account<input value={edit.beneficiary_account_no} onChange={(e) => setEdit({ ...edit, beneficiary_account_no: e.target.value })} /></label>
          <label>Beneficiary bank<input value={edit.beneficiary_bank} onChange={(e) => setEdit({ ...edit, beneficiary_bank: e.target.value })} /></label>
          <label>Amount<input type="number" step="0.01" value={edit.amount} onChange={(e) => setEdit({ ...edit, amount: e.target.value })} /></label>
          <label>Bank / payment reference<input value={edit.bank_reference} onChange={(e) => setEdit({ ...edit, bank_reference: e.target.value })} /></label>
          <label>Pay-from account<input value={edit.pay_from_account_ref} onChange={(e) => setEdit({ ...edit, pay_from_account_ref: e.target.value })} /></label>
          <label>Purpose<input value={edit.purpose} onChange={(e) => setEdit({ ...edit, purpose: e.target.value })} /></label>
          {reviewer && <label>SQL account code (if known)<input value={edit.account_code} onChange={(e) => setEdit({ ...edit, account_code: e.target.value })} /></label>}
          <div className="record-actions"><button type="submit" className="neutral" disabled={busy}>Save corrections</button></div>
        </form>
      )}

      {me.role !== "management" && (
        <section className="mini" aria-label="Notes">
          <label>Notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
          <label>Follow-up (who is chasing what)<textarea value={followup} onChange={(e) => setFollowup(e.target.value)} /></label>
          <div className="record-actions"><button type="button" className="neutral" disabled={busy} onClick={() => void run("Notes", () => update({ notes: notes.trim() || null, followup_note: followup.trim() || null }))}>Save notes</button></div>
        </section>
      )}

      {(p.status === "ready_for_sql" || p.status === "posted_to_sql") && reviewer && (
        <section className="mini" aria-label="SQL Account tracking">
          <b>SQL Account</b>
          {p.status === "ready_for_sql" && (
            <>
              <label>SQL reference / journal number<input value={sql.reference} onChange={(e) => setSql({ ...sql, reference: e.target.value })} /></label>
              <label>SQL posting date<input type="date" value={sql.date} onChange={(e) => setSql({ ...sql, date: e.target.value })} /></label>
              <label>Note<input value={sql.note} onChange={(e) => setSql({ ...sql, note: e.target.value })} /></label>
            </>
          )}
          {p.status === "posted_to_sql" && <label>Reconciliation date (in SQL Account)<input type="date" value={sql.reconciled} onChange={(e) => setSql({ ...sql, reconciled: e.target.value })} /></label>}
          <p className="help">This only records what was done in SQL Account. The Hub does not post to, or read from, SQL Account.</p>
        </section>
      )}

      <section className="record-actions" aria-label="Move this payment">
        {moves.length === 0 && <p className="help">No actions are available to you for this payment at this stage.</p>}
        {moves.map((m) => (
          <button key={m.to + m.label} type="button" className={m.allowed ? "primary" : "neutral"} disabled={!m.allowed || busy} title={m.blocker} onClick={() => {
            if (m.to === "posted_to_sql") return void run("Posted to SQL", () => update({ status: "posted_to_sql", sql_reference: sql.reference.trim(), sql_posting_date: sql.date, sql_note: sql.note.trim() || null }));
            if (m.to === "reconciled") return void run("Reconciled", () => update({ status: "reconciled", reconciled_date: sql.reconciled }));
            if (m.to === "ready_for_sql" && !window.confirm("Mark this payment Ready for SQL? Check the bank match, documents and details first.")) return;
            void run(m.label, () => update({ status: m.to }));
          }}>{m.label}{m.blocker ? " (blocked)" : ""}</button>
        ))}
      </section>
      {moves.filter((m) => m.blocker).map((m) => <p key={m.to} className="help">{m.label}: {m.blocker}</p>)}
    </DetailDrawer>
  );
}

