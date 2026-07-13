"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { AuthBar } from "@/app/auth-bar";
import { createClient } from "@/lib/supabase/client";

type Row = Record<string, any>;
const today = new Date().toISOString().slice(0, 10);
const week = new Date(Date.now() + 604800000).toISOString().slice(0, 10);
const money = (n: any) => Number(n || 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const age = (a: string, b: string) => Math.abs((+new Date(a) - +new Date(b)) / 86400000);
const esc = (v: any) => `"${String(v ?? "").replaceAll('"', '""')}"`;

export default function Home() {
  const db = useMemo(() => createClient(), []);
  const [tab, setTab] = useState("reconcile");
  const [note, setNote] = useState("Loading workspace...");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [invoices, setInvoices] = useState<Row[]>([]);
  const [receipts, setReceipts] = useState<Row[]>([]);
  const [bank, setBank] = useState<Row[]>([]);
  const [matches, setMatches] = useState<Row[]>([]);
  const [editI, setEditI] = useState("");
  const [editR, setEditR] = useState("");
  const [pickBank, setPickBank] = useState("");
  const [pickTarget, setPickTarget] = useState("");
  const [preview, setPreview] = useState<Row[]>([]);
  const [invoice, setInvoice] = useState({ vendor: "", amount: "", invoice_date: today, due_date: week, status: "unpaid", reference_number: "", description: "" });
  const [receipt, setReceipt] = useState({ merchant: "", amount: "", expense_date: today, category: "General", description: "" });
  const [tx, setTx] = useState({ description: "", amount: "", direction: "debit", transaction_date: today, bank_reference: "", statement_month: today.slice(0, 7) });

  useEffect(() => { void load(); }, []);
  useEffect(() => { void fetch("/api/recurring/generate", { method: "POST" }).catch(() => undefined); }, []);
  async function load() {
    setBusy(true); setErr("");
    const [i, r, b, m] = await Promise.all([
      db.from("invoices").select("*").order("due_date"),
      db.from("receipts").select("*").order("expense_date", { ascending: false }),
      db.from("bank_transactions").select("*").order("transaction_date", { ascending: false }),
      db.from("reconciliation_matches").select("*").eq("status", "accepted").order("created_at", { ascending: false }),
    ]);
    const e = i.error || r.error || b.error || m.error;
    if (e) { setErr(e.message); setNote("Supabase data unavailable. Check env and migrations."); }
    else { setInvoices(i.data ?? []); setReceipts(r.data ?? []); setBank(b.data ?? []); setMatches(m.data ?? []); setNote("Ready"); }
    setBusy(false);
  }
  async function done(e: any, ok: string) {
    if (e) {
      setErr(e.message);
      setNote("Save failed; retry when ready.");
      setBusy(false);
      return false;
    }
    setNote(ok);
    await load();
    setBusy(false);
    return true;
  }

  const usedB = new Set(matches.map(m => m.bank_transaction_id));
  const usedI = new Set(matches.map(m => m.invoice_id).filter(Boolean));
  const usedR = new Set(matches.map(m => m.receipt_id).filter(Boolean));
  const openB = bank.filter(b => !usedB.has(b.id));
  const openI = invoices.filter(i => !usedI.has(i.id));
  const openR = receipts.filter(r => !usedR.has(r.id));
  const joined = matches.map(m => ({ m, b: bank.find(x => x.id === m.bank_transaction_id), i: invoices.find(x => x.id === m.invoice_id), r: receipts.find(x => x.id === m.receipt_id) })).filter(x => x.b && (x.i || x.r));
  const total = joined.reduce((s, x) => s + Number(x.b?.amount || 0), 0);

  async function saveInvoice(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    const p = { ...invoice, amount: Number(invoice.amount), currency: "MYR", description: invoice.description || null, reference_number: invoice.reference_number || null };
    const res = editI ? await db.from("invoices").update(p).eq("id", editI) : await db.from("invoices").insert(p);
    if (await done(res.error, "Invoice saved")) {
      setEditI("");
      setInvoice({ vendor: "", amount: "", invoice_date: today, due_date: week, status: "unpaid", reference_number: "", description: "" });
    }
  }
  async function saveReceipt(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    const p = { ...receipt, amount: Number(receipt.amount), currency: "MYR", description: receipt.description || null };
    const res = editR ? await db.from("receipts").update(p).eq("id", editR) : await db.from("receipts").insert(p);
    if (await done(res.error, "Receipt saved")) {
      setEditR("");
      setReceipt({ merchant: "", amount: "", expense_date: today, category: "General", description: "" });
    }
  }
  async function saveBank(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    const p = { ...tx, amount: Number(tx.amount), bank_reference: tx.bank_reference || null, statement_month: tx.statement_month || tx.transaction_date.slice(0, 7) };
    const res = await db.from("bank_transactions").insert(p);
    if (await done(res.error, "Bank row saved")) {
      setTx({ description: "", amount: "", direction: "debit", transaction_date: today, bank_reference: "", statement_month: today.slice(0, 7) });
    }
  }
  async function del(table: string, id: string, name: string) {
    if (!confirm(`Delete ${name}? Matched rows will be unlinked.`)) return;
    setBusy(true); await done((await db.from(table).delete().eq("id", id)).error, "Deleted");
  }
  function readCsv(text: string) {
    const [head, ...lines] = text.trim().split(/\r?\n/), h = head.split(",").map(x => x.trim().toLowerCase());
    if (!["description", "amount", "date", "direction"].every(x => h.includes(x))) { setErr("CSV format not recognised - expected: description, amount, date, direction"); return; }
    setPreview(lines.map(line => { const c = line.split(",").map(x => x.trim()), r = Object.fromEntries(h.map((k, i) => [k, c[i] ?? ""])), d = String(r.date); return { description: r.description, amount: Number(r.amount), direction: String(r.direction).toLowerCase() === "credit" ? "credit" : "debit", transaction_date: d, bank_reference: r.reference || r.bank_reference || null, statement_month: r.statement_month || d.slice(0, 7) }; }));
  }
  async function importCsv() {
    if (!preview.length || !confirm(`Import ${preview.length} rows?`)) return;
    setBusy(true); const res = await db.from("bank_transactions").insert(preview);
    if (!res.error) await db.from("audit_logs").insert({ action: "bank_rows_imported", entity_type: "bank_transaction", payload: { row_count: preview.length } });
    if (await done(res.error, "CSV imported")) setPreview([]);
  }
  const payload = (b: string, kind: string, id: string, amount: number, type: string, by: string) => ({ bank_transaction_id: b, invoice_id: kind === "invoice" ? id : null, receipt_id: kind === "receipt" ? id : null, match_type: type, match_value: amount, match_value_source: by, match_value_confidence: type === "exact" ? 1 : null, match_value_review_status: "accepted", matched_by: by, status: "accepted" });
  async function autoMatch() {
    if (!bank.length) { setErr("Import bank transactions first"); return; }
    setBusy(true); const ins: Row[] = [], paid: string[] = [];
    for (const b of openB.filter(x => x.direction === "debit")) {
      const i = openI.find(x => !paid.includes(x.id) && Number(x.amount) === Number(b.amount) && (age(x.invoice_date, b.transaction_date) <= 3 || age(x.due_date, b.transaction_date) <= 3));
      if (i) { ins.push(payload(b.id, "invoice", i.id, b.amount, "exact", "system")); paid.push(i.id); continue; }
      const r = openR.find(x => !ins.some(y => y.receipt_id === x.id) && Number(x.amount) === Number(b.amount) && age(x.expense_date, b.transaction_date) <= 3);
      if (r) ins.push(payload(b.id, "receipt", r.id, b.amount, "exact", "system"));
    }
    if (!ins.length) { setBusy(false); setNote("No exact matches found"); return; }
    const res = await db.from("reconciliation_matches").insert(ins);
    if (!res.error && paid.length) await db.from("invoices").update({ status: "paid" }).in("id", paid);
    if (!res.error) await db.from("audit_logs").insert({ action: "run_auto_match", entity_type: "match", payload: { created_count: ins.length } });
    await done(res.error, `${ins.length} auto-matches created`);
  }
  async function manualMatch() {
    const [kind, id] = pickTarget.split(":"); if (!pickBank || !id) { setErr("Choose one unmatched bank row and one invoice or receipt"); return; }
    setBusy(true); const amount = bank.find(x => x.id === pickBank)?.amount ?? 0, res = await db.from("reconciliation_matches").insert(payload(pickBank, kind, id, amount, "manual", "user"));
    if (!res.error && kind === "invoice") await db.from("invoices").update({ status: "paid" }).eq("id", id);
    if (!res.error) await db.from("audit_logs").insert({ action: "match_created", entity_type: "match", entity_id: pickBank, payload: { kind, id } });
    setPickBank(""); setPickTarget(""); await done(res.error, "Manual match created");
  }
  async function exportCsv() {
    const body = [["bank_date","bank_description","direction","amount","record_type","vendor_or_merchant","reference","match_type","matched_by"], ...joined.map(x => [x.b?.transaction_date, x.b?.description, x.b?.direction, x.b?.amount, x.i ? "invoice" : "receipt", x.i?.vendor ?? x.r?.merchant, x.i?.reference_number ?? x.r?.category, x.m.match_type, x.m.matched_by])].map(r => r.map(esc).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([body], { type: "text/csv" })), a = document.createElement("a"); a.href = url; a.download = `reconciliation-${today}.csv`; a.click(); URL.revokeObjectURL(url);
    await db.from("audit_logs").insert({ action: "export_csv", entity_type: "match", payload: { row_count: joined.length } }); setNote(`Exported ${joined.length} rows`);
  }

  return <main>
    <header><div><span>Supplier Bills, Student Payments, Bank Reconciliation & Audit Readiness</span><h1>Internal Finance Operations Dashboard</h1></div><div className="metrics"><b>{joined.length} matched</b><b>MYR {money(total)}</b><b>{bank.length ? Math.round(joined.length / bank.length * 100) : 0}%</b></div><AuthBar /></header>
    <nav className="page-tabs">{["reconcile","invoices","receipts","bank","report"].map(t => <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t}</button>)}</nav>
    <p className={err ? "notice error" : "notice"}>{err || note}<button onClick={() => void load()}>Refresh</button></p>{busy && <div className="skeleton" />}
    {tab === "reconcile" && <section className="grid"><Panel title="Matched Pairs" action={<button onClick={() => void autoMatch()}>Run Auto-Match</button>}><Matches rows={joined} /></Panel><Panel title="Manual Match"><select value={pickBank} onChange={e => setPickBank(e.target.value)}><option value="">Unmatched bank row</option>{openB.map(b => <option key={b.id} value={b.id}>{b.description} - {money(b.amount)}</option>)}</select><select value={pickTarget} onChange={e => setPickTarget(e.target.value)}><option value="">Unmatched invoice or receipt</option>{openI.map(i => <option key={i.id} value={`invoice:${i.id}`}>Invoice - {i.vendor} - {money(i.amount)}</option>)}{openR.map(r => <option key={r.id} value={`receipt:${r.id}`}>Receipt - {r.merchant} - {money(r.amount)}</option>)}</select><button onClick={() => void manualMatch()}>Create Manual Match</button><Mini title="Unmatched Bank Rows" rows={openB.map(b => `${b.description} - ${money(b.amount)}`)} /><Mini title="Unmatched Invoices" rows={openI.map(i => `${i.vendor} - ${money(i.amount)}`)} /><Mini title="Unmatched Receipts" rows={openR.map(r => `${r.merchant} - ${money(r.amount)}`)} /></Panel></section>}
    {tab === "invoices" && <section className="grid"><Panel title="Invoice Form"><Form data={invoice} set={setInvoice} save={saveInvoice} selects={{ status: ["unpaid","paid","overdue"] }} /></Panel><Panel title="Invoices"><Grid rows={invoices} cols={["vendor","amount","due_date","status"]} edit={r => { setEditI(r.id); setInvoice({ vendor: r.vendor, amount: String(r.amount), invoice_date: r.invoice_date, due_date: r.due_date, status: r.status, reference_number: r.reference_number ?? "", description: r.description ?? "" }); }} del={r => void del("invoices", r.id, r.vendor)} /></Panel></section>}
    {tab === "receipts" && <section className="grid"><Panel title="Receipt Form"><Form data={receipt} set={setReceipt} save={saveReceipt} selects={{ category: ["Transport","Meals & Entertainment","Office","General"] }} /></Panel><Panel title="Receipts"><Grid rows={receipts} cols={["merchant","amount","expense_date","category"]} edit={r => { setEditR(r.id); setReceipt({ merchant: r.merchant, amount: String(r.amount), expense_date: r.expense_date, category: r.category, description: r.description ?? "" }); }} del={r => void del("receipts", r.id, r.merchant)} /></Panel></section>}
    {tab === "bank" && <section className="grid"><Panel title="Bank Entry"><Form data={tx} set={setTx} save={saveBank} selects={{ direction: ["debit","credit"] }} /><input type="file" accept=".csv" onChange={async e => { const f = e.target.files?.[0]; if (f) readCsv(await f.text()); }} /><button onClick={() => void importCsv()}>Confirm Import</button><Mini title="CSV Preview" rows={preview.map(r => `${r.transaction_date} - ${r.description} - ${money(r.amount)}`)} /></Panel><Panel title="Bank Transactions"><Grid rows={bank} cols={["transaction_date","description","direction","amount"]} /></Panel></section>}
    {tab === "report" && <Panel title="Reconciliation Report" action={<button onClick={() => void exportCsv()}>Export CSV</button>}><Matches rows={joined} /></Panel>}
  </main>;
}

function Panel(p: { title: string; action?: React.ReactNode; children: React.ReactNode }) { return <section className="panel"><h2>{p.title}{p.action}</h2>{p.children}</section>; }
function Form({ data, set, save, selects = {} }: { data: Row; set: (r: any) => void; save: (e: FormEvent) => void; selects?: Row }) { return <form onSubmit={save}>{Object.keys(data).map(k => k === "description" ? <textarea key={k} placeholder={k} value={data[k]} onChange={e => set({ ...data, [k]: e.target.value })} /> : selects[k] ? <select key={k} value={data[k]} onChange={e => set({ ...data, [k]: e.target.value })}>{selects[k].map((x: string) => <option key={x}>{x}</option>)}</select> : <label key={k}>{k}<input required={k !== "reference_number" && k !== "bank_reference" && k !== "statement_month"} type={k.includes("date") ? "date" : k === "amount" ? "number" : "text"} step={k === "amount" ? "0.01" : undefined} value={data[k]} onChange={e => set({ ...data, [k]: e.target.value })} /></label>)}<button>Save</button></form>; }
function Grid({ rows, cols, edit, del }: { rows: Row[]; cols: string[]; edit?: (r: Row) => void; del?: (r: Row) => void }) { if (!rows.length) return <div className="empty">Add your first row</div>; return <table><thead><tr>{cols.map(c => <th key={c}>{c}</th>)}{(edit || del) && <th />}</tr></thead><tbody>{rows.map(r => <tr key={r.id}>{cols.map(c => <td key={c}>{c === "amount" ? money(r[c]) : r[c]}</td>)}{(edit || del) && <td>{edit && <button onClick={() => edit(r)}>Edit</button>}{del && <button onClick={() => del(r)}>Delete</button>}</td>}</tr>)}</tbody></table>; }
function Matches({ rows }: { rows: Row[] }) { if (!rows.length) return <div className="empty">Run auto-match or create a manual match</div>; return <table><thead><tr><th>Bank row</th><th>Matched record</th><th>Amount</th><th>Type</th></tr></thead><tbody>{rows.map(x => <tr key={x.m.id}><td>{x.b.transaction_date} - {x.b.description}</td><td>{x.i?.vendor ?? x.r?.merchant}</td><td>{money(x.b.amount)}</td><td>{x.m.match_type}</td></tr>)}</tbody></table>; }
function Mini({ title, rows }: { title: string; rows: string[] }) { return <div className="mini"><b>{title}</b>{rows.length ? rows.map(r => <p key={r}>{r}</p>) : <p>Nothing waiting.</p>}</div>; }
