"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AuthBar } from "@/app/auth-bar";
import { IntakeReviewPanel, type DuplicateMatchView, type IntakeReviewItem, type SupplierCandidateView } from "@/app/intake-review";
import { PageTabs, StatusBadge } from "@/app/ui-v2";
import { createClient } from "@/lib/supabase/client";
import {
  allowedReviewTargets,
  APPROVED_ENTITY_CODES,
  canResolveEntity,
  canViewIntakeQueue,
  extractedFromPayload,
  groupOf,
  REVIEW_TARGET_LABELS,
  validateResolution,
  type QueueGroup,
  type ReviewTarget,
} from "@/lib/financeops/review";
import { matchSupplier, type SafeSupplier } from "@/lib/financeops/supplier-match";

type Row = Record<string, any>;

const money = (n: unknown) => `MYR ${Number(n || 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso: string) => new Date(iso).toLocaleString("en-MY", { dateStyle: "medium", timeStyle: "short" });

/**
 * FinanceOps intake queue (migration 0023). Every action is a direct update through the signed-in user's own session,
 * so RLS and the 0023 triggers decide; this screen only offers what the rules allow (see lib/financeops/review.ts).
 *   - "Resolve entity": Owner / Finance Manager / Finance Staff only (the database refuses everyone else).
 *   - "Data Verified": the intake-level human check. It is not payment approval; the bill still needs
 *     "Verify & Mark Ready for Payment" on the Bills screen.
 */
export function FinanceIntakeWorkspace() {
  const db = useMemo(() => createClient(), []);
  const [me, setMe] = useState<{ id: string | null; role: string | null }>({ id: null, role: null });
  const [loaded, setLoaded] = useState(false);
  const [entities, setEntities] = useState<Row[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [bills, setBills] = useState<Record<string, Row>>({});
  const [documents, setDocuments] = useState<Record<string, Row>>({});
  const [suppliers, setSuppliers] = useState<SafeSupplier[]>([]);
  const [supplierLinks, setSupplierLinks] = useState<Row[]>([]);
  const [tab, setTab] = useState<QueueGroup>("in_review");
  const [openId, setOpenId] = useState<string | null>(null);
  const [documentUrl, setDocumentUrl] = useState<string | null>(null);
  const [message, setMessage] = useState("Loading...");
  const [error, setError] = useState("");

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setError("");
    const user = await db.auth.getUser();
    const id = user.data.user?.id ?? null;
    const profile = id ? await db.from("app_profiles").select("role, active_status").eq("id", id).maybeSingle() : null;
    const role = profile?.data?.active_status ? (profile.data.role as string) : null;
    setMe({ id, role });
    if (!canViewIntakeQueue(role)) {
      setLoaded(true);
      setMessage("");
      return;
    }
    const [ent, queue] = await Promise.all([
      db.from("entities").select("id, short_code").order("short_code"),
      db.from("finance_intake_queue").select("*").order("created_at", { ascending: false }).limit(200),
    ]);
    if (ent.error || queue.error) {
      setError((ent.error || queue.error)!.message);
      setLoaded(true);
      return;
    }
    const queueRows = (queue.data ?? []) as Row[];
    setEntities(ent.data ?? []);
    setRows(queueRows);

    const billIds = queueRows.map((r) => r.supplier_bill_id).filter(Boolean);
    const docIds = queueRows.map((r) => r.document_id).filter(Boolean);
    const [b, d, s, se] = await Promise.all([
      billIds.length ? db.from("supplier_bills").select("id, entity_id, supplier_id, bill_number, bill_date, due_date, total_amount, tax_amount, description, payment_status").in("id", billIds) : Promise.resolve({ data: [], error: null }),
      docIds.length ? db.from("documents").select("id, storage_path, mime_type").in("id", docIds) : Promise.resolve({ data: [], error: null }),
      db.from("suppliers_app_safe").select("id, supplier_name, registration_number, active_status, archived_at").limit(5000),
      db.from("supplier_entities").select("supplier_id, entity_id").limit(5000),
    ]);
    setBills(Object.fromEntries((b.data ?? []).map((x: Row) => [x.id, x])));
    setDocuments(Object.fromEntries((d.data ?? []).map((x: Row) => [x.id, x])));
    setSuppliers((s.data ?? []).map((x: Row) => ({ id: x.id, supplierName: x.supplier_name, registrationNumber: x.registration_number ?? null, activeStatus: x.active_status === true, archivedAt: x.archived_at ?? null })));
    setSupplierLinks(se.data ?? []);
    setMessage("");
    setLoaded(true);
  }

  async function openIntake(row: Row) {
    setOpenId(row.id);
    setDocumentUrl(null);
    const doc = row.document_id ? documents[row.document_id] : null;
    if (doc?.storage_path) {
      const signed = await db.storage.from("bill-documents").createSignedUrl(doc.storage_path, 300);
      setDocumentUrl(signed.data?.signedUrl ?? null);
    }
  }

  async function resolveEntity(row: Row, entityCode: string, note: string) {
    setError("");
    setMessage("");
    const check = validateResolution({ entityCode, note });
    if (!check.ok) return setError(check.message);
    const entity = entities.find((e) => e.short_code === check.entityCode);
    if (!entity) return setError("That entity is not available to your account.");
    // A standalone change: entity + note only. The database sets the process state and the audit entry.
    const res = await db.from("finance_intake_submissions").update({ entity_id: entity.id, entity_resolution_note: check.note }).eq("id", row.id).is("entity_id", null).select("id");
    if (res.error) return setError(res.error.message);
    if (!res.data?.length) return setError("The intake was not changed. It may already be resolved, superseded or rejected.");
    setMessage(`Entity resolved to ${check.entityCode}. FinanceOps must re-send the same intake (same intake_id) to attach the document and create the draft bill.`);
    await load();
  }

  async function setReview(row: Row, target: ReviewTarget, note: string) {
    setError("");
    setMessage("");
    if (target === "rejected" && note.trim().length < 3) return setError("Enter a note explaining why the intake is rejected.");
    if (target === "data_verified" && !window.confirm("Mark this intake Data Verified? This confirms the data matches the original document. It does not approve payment.")) return;
    const res = await db.from("finance_intake_submissions").update({ review_status: target, review_note: note.trim() || null }).eq("id", row.id).select("id");
    if (res.error) return setError(res.error.message);
    if (!res.data?.length) return setError("The intake was not changed. You may not be allowed to review it.");
    setMessage(`${REVIEW_TARGET_LABELS[target]} recorded.`);
    setOpenId(null);
    await load();
  }

  async function saveCorrections(bill: Row, values: { supplier_id: string; bill_number: string; bill_date: string; due_date: string; total_amount: string }) {
    setError("");
    setMessage("");
    const total = Number(values.total_amount);
    if (!Number.isFinite(total) || total < 0) return setError("Enter a valid amount.");
    const tax = Number(bill.tax_amount || 0);
    const res = await db
      .from("supplier_bills")
      .update({
        supplier_id: values.supplier_id || null,
        bill_number: values.bill_number.trim() || null,
        bill_date: values.bill_date,
        due_date: values.due_date,
        total_amount: total,
        outstanding_amount: total,
        subtotal: Math.max(total - tax, 0),
      })
      .eq("id", bill.id)
      .eq("payment_status", "draft")
      .select("id");
    if (res.error) return setError(res.error.message);
    if (!res.data?.length) return setError("The draft bill was not changed. It may no longer be a draft.");
    setMessage("Draft bill updated. Confirm the highlighted items, then mark the intake Data Verified.");
    await load();
  }

  if (!loaded) return <main className="page-shell"><Header /><section className="notice"><p>{message}</p></section></main>;
  if (!canViewIntakeQueue(me.role)) {
    return <main className="page-shell"><Header /><section className="notice error"><p>The FinanceOps intake queue is available to Finance, data entry and management users.</p></section></main>;
  }

  const resolver = canResolveEntity(me.role);
  const grouped: Record<QueueGroup, Row[]> = { needs_entity: [], in_review: [], done: [], superseded: [] };
  for (const row of rows) grouped[groupOf(row as { entity_id: string | null; review_status: any; is_superseded?: boolean })].push(row);
  const tabs = [
    ...(resolver ? [{ id: "needs_entity", label: "Needs entity", count: grouped.needs_entity.length }] : []),
    { id: "in_review", label: "In review", count: grouped.in_review.length },
    { id: "done", label: "Done", count: grouped.done.length },
  ];
  const activeTab = tabs.some((t) => t.id === tab) ? tab : (tabs[0].id as QueueGroup);
  const list = grouped[activeTab];

  return (
    <main className="page-shell">
      <Header />
      <section className="notice">
        <p>{message || "Invoices received from FinanceOps. Data Verified is a data check only; releasing the bill for payment is a separate step on the Bills screen."}</p>
        <button type="button" onClick={() => void load()}>Refresh</button>
      </section>
      {error && <section className="notice error"><p>{error}</p></section>}
      <PageTabs tabs={tabs} active={activeTab} onChange={(id) => { setTab(id as QueueGroup); setOpenId(null); }} label="FinanceOps intake views" />

      {!list.length && <div className="empty">{activeTab === "needs_entity" ? "No intakes are waiting for an entity." : activeTab === "in_review" ? "No intakes are waiting for review." : "Nothing here yet."}</div>}

      {list.map((row) =>
        activeTab === "needs_entity" ? (
          <ResolveEntityCard key={row.id} row={row} entities={entities} onResolve={resolveEntity} onReject={(note) => setReview(row, "rejected", note)} />
        ) : activeTab === "done" ? (
          <DoneRow key={row.id} row={row} bill={bills[row.supplier_bill_id]} />
        ) : (
          <InReview
            key={row.id}
            row={row}
            me={me}
            bill={bills[row.supplier_bill_id]}
            document={documents[row.document_id]}
            documentUrl={openId === row.id ? documentUrl : null}
            open={openId === row.id}
            onToggle={() => (openId === row.id ? setOpenId(null) : void openIntake(row))}
            suppliers={suppliers}
            supplierLinks={supplierLinks}
            entities={entities}
            onReview={setReview}
            onSaveCorrections={saveCorrections}
          />
        ),
      )}
    </main>
  );
}

function Header() {
  return (
    <div className="page-header">
      <div>
        <p className="eyebrow">Finance</p>
        <h1>FinanceOps Intake</h1>
        <p className="subtitle">Invoices received from Telegram/FinanceOps. A person checks the data against the original document; payment release stays a separate Finance Staff step.</p>
      </div>
      <AuthBar />
    </div>
  );
}

// ------------------------------------------------------------------ needs entity

function ResolveEntityCard({ row, entities, onResolve, onReject }: { row: Row; entities: Row[]; onResolve: (row: Row, code: string, note: string) => Promise<void>; onReject: (note: string) => Promise<void> }) {
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  const fields = extractedFromPayload(row.payload, row.flags ?? []);
  const approved = entities.filter((e) => (APPROVED_ENTITY_CODES as readonly string[]).includes(e.short_code));
  return (
    <section className="panel" aria-label={`Unresolved intake ${row.intake_id}`}>
      <h2>Resolve entity <StatusBadge status="needs_attention" label="Entity unknown" /></h2>
      <p className="help">Received {when(row.created_at)}. FinanceOps could not tell which entity this invoice belongs to, so no bill or file was created. Choose the entity from the invoice details.</p>
      <div className="detail-grid">
        {fields.filter((f) => f.value).map((f) => <div key={f.label} className="field-value"><span>{f.label}</span><strong>{f.value}</strong></div>)}
      </div>
      <form className="mini" onSubmit={(e: FormEvent) => { e.preventDefault(); void onResolve(row, code, note); }}>
        <label>Entity
          <select value={code} onChange={(e) => setCode(e.target.value)} required>
            <option value="">Choose exactly one entity</option>
            {approved.map((e) => <option key={e.id} value={e.short_code}>{e.short_code}</option>)}
          </select>
        </label>
        <label>Resolution note (required)
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="How was the entity determined? e.g. billed to Inter-Excel Advisory Sdn Bhd" required minLength={3} />
        </label>
        <div className="record-actions" aria-label="Entity resolution actions">
          <button type="submit" className="primary">Resolve entity</button>
          <button type="button" className="neutral" onClick={() => void onReject(note)}>Reject (not a real invoice)</button>
        </div>
      </form>
      <p className="help">After you resolve the entity, FinanceOps re-sends the same intake to attach the document and create the draft bill. FinanceOps cannot resolve entities itself.</p>
    </section>
  );
}

// ------------------------------------------------------------------ done

function DoneRow({ row, bill }: { row: Row; bill?: Row }) {
  return (
    <section className="panel" aria-label={`Intake ${row.intake_id}`}>
      <h2>{row.intake_id} <StatusBadge status={row.review_status} label={row.review_status === "data_verified" ? "Data Verified" : "Rejected"} /></h2>
      <p className="help">Received {when(row.created_at)}{row.review_note ? ` - Note: ${row.review_note}` : ""}</p>
      {row.review_status === "data_verified" && bill && (
        <p className="help">The draft bill is {bill.payment_status}. A Finance Staff member or above uses <b>Verify &amp; Mark Ready for Payment</b> on the <Link href={`/bills/${bill.id}`}>bill</Link> to release it.</p>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ in review

type InReviewProps = {
  row: Row;
  me: { id: string | null; role: string | null };
  bill?: Row;
  document?: Row;
  documentUrl: string | null;
  open: boolean;
  onToggle: () => void;
  suppliers: SafeSupplier[];
  supplierLinks: Row[];
  entities: Row[];
  onReview: (row: Row, target: ReviewTarget, note: string) => Promise<void>;
  onSaveCorrections: (bill: Row, values: { supplier_id: string; bill_number: string; bill_date: string; due_date: string; total_amount: string }) => Promise<void>;
};

function InReview({ row, me, bill, document, documentUrl, open, onToggle, suppliers, supplierLinks, entities, onReview, onSaveCorrections }: InReviewProps) {
  const [note, setNote] = useState("");
  const entityCode = row.entity_code_declared ?? entities.find((e) => e.id === row.entity_id)?.short_code ?? null;
  const targets = allowedReviewTargets({ role: me.role, actorUserId: me.id, createdByUserId: row.created_by, entityResolved: row.entity_id !== null, processState: row.process_state, reviewStatus: row.review_status });
  const waiting = row.process_state !== "complete";

  return (
    <section className="panel" aria-label={`Intake ${row.intake_id}`}>
      <h2>
        {row.intake_id} <StatusBadge status={row.review_status} label={row.review_status.replace(/_/g, " ")} />{" "}
        <span className="tag">{entityCode ?? "?"}</span> <span className="tag">{row.process_state.replace(/_/g, " ")}</span>
      </h2>
      <p className="help">
        Received {when(row.created_at)}
        {waiting && row.entity_resolved_at ? " - Entity resolved. Waiting for FinanceOps to re-send this intake so the draft bill and document are created." : ""}
        {waiting && !row.entity_resolved_at ? " - FinanceOps has not finished creating the bill and attaching the document." : ""}
      </p>
      <button type="button" className="neutral" onClick={onToggle}>{open ? "Close" : "Review"}</button>
      {open && <ReviewBody row={row} me={me} bill={bill} document={document} documentUrl={documentUrl} suppliers={suppliers} supplierLinks={supplierLinks} entityCode={entityCode} targets={targets} note={note} setNote={setNote} onReview={onReview} onSaveCorrections={onSaveCorrections} />}
    </section>
  );
}

function ReviewBody({ row, me, bill, document, documentUrl, suppliers, supplierLinks, entityCode, targets, note, setNote, onReview, onSaveCorrections }: Omit<InReviewProps, "open" | "onToggle" | "entities"> & { entityCode: string | null; targets: ReviewTarget[]; note: string; setNote: (v: string) => void }) {
  const entitySuppliers = useMemo(() => {
    const ids = new Set(supplierLinks.filter((l) => l.entity_id === row.entity_id).map((l) => l.supplier_id));
    return suppliers.filter((s) => ids.has(s.id));
  }, [supplierLinks, suppliers, row.entity_id]);
  const payload = (row.payload ?? {}) as Row;
  const match = useMemo(() => matchSupplier({ name: payload.supplier?.name ?? null, registrationNumber: payload.supplier?.registration_number ?? null }, entitySuppliers), [payload, entitySuppliers]);
  const candidates: SupplierCandidateView[] = match.candidates.map((c) => ({ supplierId: c.supplierId, name: c.name, score: c.score, reason: c.reason }));
  const [form, setForm] = useState({
    supplier_id: bill?.supplier_id ?? "",
    bill_number: bill?.bill_number ?? "",
    bill_date: bill?.bill_date ?? "",
    due_date: bill?.due_date ?? "",
    total_amount: bill ? String(bill.total_amount) : "",
  });
  const flags: string[] = row.flags ?? [];
  const duplicates: DuplicateMatchView[] = ((row.duplicate_matches ?? []) as Row[]).map((m) => ({ type: m.type, billId: m.billId, entityCode: entityCode ?? "", strength: m.strength }));
  const editable = Boolean(bill) && bill?.payment_status === "draft" && targets.length > 0;

  const item: IntakeReviewItem = {
    intakeId: row.intake_id,
    createdByUserId: row.created_by ?? "",
    receivedAt: when(row.created_at),
    entityCode,
    billId: bill?.id ?? null,
    flags,
    extracted: extractedFromPayload(row.payload, flags),
    current: { supplierId: bill?.supplier_id ?? null, totalAmount: Number(bill?.total_amount ?? 0), entityId: row.entity_id, hasDocument: Boolean(row.document_id) },
    dueDateIsPlaceholder: flags.includes("due_date_missing"),
    supplierCandidates: candidates,
    duplicates,
    documentUrl,
    documentMime: document?.mime_type ?? null,
  };

  const extra = targets
    .filter((t) => t !== "data_verified" && t !== "rejected")
    .map((t) => <button key={t} type="button" className="neutral" onClick={() => void onReview(row, t, note)}>{REVIEW_TARGET_LABELS[t]}</button>);

  return (
    <IntakeReviewPanel
      item={item}
      actorUserId={me.id}
      allowedTargets={targets}
      onVerify={() => void onReview(row, "data_verified", note)}
      onReject={() => void onReview(row, "rejected", note)}
      onSelectSupplier={editable ? (supplierId) => setForm({ ...form, supplier_id: supplierId }) : undefined}
      extraActions={extra}
    >
      {bill && (
        <form className="mini" onSubmit={(e: FormEvent) => { e.preventDefault(); void onSaveCorrections(bill, form); }}>
          <b>Draft bill - correct anything that does not match the document</b>
          <label>Supplier
            <select value={form.supplier_id} disabled={!editable} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}>
              <option value="">No supplier chosen</option>
              {entitySuppliers.map((s) => <option key={s.id} value={s.id}>{s.supplierName}</option>)}
            </select>
          </label>
          <label>Invoice number<input value={form.bill_number} disabled={!editable} onChange={(e) => setForm({ ...form, bill_number: e.target.value })} /></label>
          <label>Invoice date<input type="date" value={form.bill_date} disabled={!editable} onChange={(e) => setForm({ ...form, bill_date: e.target.value })} required /></label>
          <label>Due date{flags.includes("due_date_missing") && <span className="tag"> placeholder</span>}<input type="date" value={form.due_date} disabled={!editable} onChange={(e) => setForm({ ...form, due_date: e.target.value })} required /></label>
          <label>Total amount ({bill.currency ?? "MYR"})<input type="number" step="0.01" min="0" value={form.total_amount} disabled={!editable} onChange={(e) => setForm({ ...form, total_amount: e.target.value })} required /></label>
          <p className="help">Stored amount: {money(bill.total_amount)}.</p>
          <div className="record-actions" aria-label="Draft bill corrections"><button type="submit" className="neutral" disabled={!editable}>Save corrections</button></div>
        </form>
      )}
      <label className="mini">Review note{" "}
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional for Data Verified; required to reject" />
      </label>
      {bill && <p className="help">Open the <Link href={`/bills/${bill.id}`}>draft bill</Link> to see its documents.</p>}
    </IntakeReviewPanel>
  );
}
