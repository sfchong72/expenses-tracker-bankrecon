"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Row = Record<string, any>;
type Mode = "suppliers" | "bills" | "recurring" | "vouchers" | "documents" | "missing";

const today = new Date().toISOString().slice(0, 10);
const money = (n: any) => `MYR ${Number(n || 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const docTypes = ["supplier_invoice", "receipt", "payment_slip", "payment_voucher", "quotation", "contract", "payroll_support", "other"];
const linkTypes = ["supplier_bill", "payment_voucher", "bill_payment", "recurring_obligation"];
const emptySupplier = { id: "", supplier_name: "", registration_number: "", contact_person: "", email: "", phone: "", bank_details_text: "", default_expense_category: "", default_description: "", account_code: "", remarks: "", active_status: true, entity_ids: [] as string[] };
const emptyBill = { entity_id: "", supplier_id: "", description: "", bill_number: "", bill_type: "supplier_invoice", bill_date: today, due_date: today, subtotal: "", tax_amount: "0", total_amount: "", payment_status: "unpaid", expense_category_id: "", remarks: "" };
const emptyVoucher = { entity_id: "", supplier_id: "", voucher_date: today, payee: "", payee_bank_details_text: "", purpose: "", voucher_source: "manual", recurring_obligation_id: "", paying_bank_account_id: "", payment_method: "bank_transfer", bank_reference: "", remarks: "" };
const emptyItem = { description: "", expense_category_id: "", supplier_bill_id: "", recurring_obligation_id: "", amount: "" };

export function Phase2Workspace({ mode, billId }: { mode: Mode; billId?: string }) {
  const db = useMemo(() => createClient(), []);
  const [entities, setEntities] = useState<Row[]>([]);
  const [suppliers, setSuppliers] = useState<Row[]>([]);
  const [supplierEntities, setSupplierEntities] = useState<Row[]>([]);
  const [categories, setCategories] = useState<Row[]>([]);
  const [banks, setBanks] = useState<Row[]>([]);
  const [bills, setBills] = useState<Row[]>([]);
  const [recurring, setRecurring] = useState<Row[]>([]);
  const [vouchers, setVouchers] = useState<Row[]>([]);
  const [items, setItems] = useState<Row[]>([]);
  const [payments, setPayments] = useState<Row[]>([]);
  const [docs, setDocs] = useState<Row[]>([]);
  const [links, setLinks] = useState<Row[]>([]);
  const [showDemo, setShowDemo] = useState(false);
  const [message, setMessage] = useState("Loading...");
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [supplier, setSupplier] = useState(emptySupplier);
  const [bill, setBill] = useState(emptyBill);
  const [billFiles, setBillFiles] = useState<File[]>([]);
  const [obligation, setObligation] = useState({ entity_id: "", supplier_id: "", description: "", expected_amount: "", due_day: "1", fixed_or_variable: "fixed", required_document_type: "supplier_invoice", start_date: today, reminder_days: "3", remarks: "" });
  const [payment, setPayment] = useState({ supplier_bill_id: "", payment_voucher_id: "", amount: "", payment_date: today, method: "bank_transfer", payment_reference: "", remarks: "" });
  const [upload, setUpload] = useState({ entity_id: "", linked_record_type: "supplier_bill", linked_record_id: billId ?? "", document_type: "supplier_invoice" });
  const [libraryFiles, setLibraryFiles] = useState<File[]>([]);
  const [voucher, setVoucher] = useState(emptyVoucher);
  const [voucherItems, setVoucherItems] = useState<Row[]>([{ ...emptyItem }]);

  useEffect(() => { void load(); }, [showDemo]);

  async function load() {
    setError("");
    const [e, se, s, c, ba, b, r, v, vi, p, d, l] = await Promise.all([
      db.from("entities").select("*").order("short_code"),
      db.from("supplier_entities").select("*").eq("is_demo", showDemo),
      db.from("suppliers").select("*").eq("is_demo", showDemo).order("supplier_name"),
      db.from("categories").select("*").eq("category_type", "expense").order("name"),
      db.from("bank_accounts_staff_safe").select("id, entity_code, bank_name, account_name, masked_account_number").order("entity_code"),
      db.from("supplier_bills").select("*").eq("is_demo", showDemo).order("due_date"),
      db.from("recurring_obligations").select("*").eq("is_demo", showDemo).order("next_generation_date"),
      db.from("payment_vouchers").select("*").eq("is_demo", showDemo).order("created_at", { ascending: false }),
      db.from("payment_voucher_items").select("*").eq("is_demo", showDemo).order("sort_order"),
      db.from("bill_payments").select("*").eq("is_demo", showDemo).order("payment_date", { ascending: false }),
      db.from("documents").select("*").eq("is_demo", showDemo).order("uploaded_at", { ascending: false }),
      db.from("document_links").select("*").eq("is_demo", showDemo).order("created_at", { ascending: false }),
    ]);
    const firstError = e.error || se.error || s.error || c.error || ba.error || b.error || r.error || v.error || vi.error || p.error || d.error || l.error;
    if (firstError) { setError(firstError.message); setMessage("Phase 2 migration 0005 may need to be applied."); return; }
    setEntities(e.data ?? []); setSupplierEntities(se.data ?? []); setSuppliers(s.data ?? []); setCategories(c.data ?? []); setBanks(ba.data ?? []); setBills(b.data ?? []); setRecurring(r.data ?? []); setVouchers(v.data ?? []); setItems(vi.data ?? []); setPayments(p.data ?? []); setDocs(d.data ?? []); setLinks(l.data ?? []);
    const entity = e.data?.[0]?.id ?? "";
    setBill((x) => ({ ...x, entity_id: x.entity_id || entity })); setObligation((x) => ({ ...x, entity_id: x.entity_id || entity })); setVoucher((x) => ({ ...x, entity_id: x.entity_id || entity })); setUpload((x) => ({ ...x, entity_id: x.entity_id || entity }));
    setMessage(showDemo ? "Showing DEMO records only." : "Ready. DEMO records are hidden by default.");
  }

  const title = { suppliers: "Suppliers", bills: "Supplier Bills", recurring: "Recurring Obligations", vouchers: "Payment Vouchers", documents: "Documents", missing: "Missing Documents" }[mode];
  const activeSuppliers = (entityId: string) => suppliers.filter((s) => s.active_status && supplierEntities.some((se) => se.supplier_id === s.id && se.entity_id === entityId));
  const selectedSuppliers = activeSuppliers(bill.entity_id);
  const entityName = (id: string) => entities.find((e) => e.id === id)?.short_code ?? "-";
  const supplierName = (id: string) => suppliers.find((s) => s.id === id)?.supplier_name ?? "-";
  const categoryName = (id: string) => categories.find((c) => c.id === id)?.name ?? "-";
  const recordRows = recordsFor(upload.linked_record_type, upload.entity_id);
  const docsFor = (type: string, id: string) => links.filter((l) => l.linked_record_type === type && l.linked_record_id === id).map((l) => docs.find((d) => d.id === l.document_id)?.original_filename).filter(Boolean).join(", ");

  function recordsFor(type: string, entityId: string) {
    if (type === "supplier_bill") return bills.filter((b) => b.entity_id === entityId).map((b) => ({ id: b.id, name: `${b.description} ${b.bill_number || ""}` }));
    if (type === "payment_voucher") return vouchers.filter((v) => v.entity_id === entityId).map((v) => ({ id: v.id, name: `${v.voucher_number || "Draft"} - ${v.payee}` }));
    if (type === "bill_payment") return payments.filter((p) => p.entity_id === entityId).map((p) => ({ id: p.id, name: `${p.payment_reference || "Payment"} ${money(p.amount)}` }));
    if (type === "recurring_obligation") return recurring.filter((r) => r.entity_id === entityId).map((r) => ({ id: r.id, name: r.description }));
    return [];
  }

  async function uploadDocs(files: File[], payload: Row) {
    if (!files.length) return true;
    setUploading(true);
    try {
      for (const file of files) {
        const body = new FormData();
        body.append("file", file); body.append("entity_id", payload.entity_id); body.append("linked_record_type", payload.linked_record_type); body.append("linked_record_id", payload.linked_record_id); body.append("document_type", payload.document_type);
        const res = await fetch("/api/documents/upload", { method: "POST", body });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Upload failed");
      }
      return true;
    } catch (err) { setError(err instanceof Error ? err.message : "Upload failed"); return false; }
    finally { setUploading(false); }
  }

  async function saveSupplier(e: FormEvent) {
    e.preventDefault(); setError("");
    const payload = { supplier_name: supplier.supplier_name, registration_number: supplier.registration_number || null, contact_person: supplier.contact_person || null, email: supplier.email || null, phone: supplier.phone || null, bank_details: supplier.bank_details_text ? { notes: supplier.bank_details_text } : {}, default_expense_category: supplier.default_expense_category || null, default_description: supplier.default_description || null, account_code: supplier.account_code || null, remarks: supplier.remarks || null, active_status: supplier.active_status, is_demo: false, data_origin: "manual" };
    const result = supplier.id ? await db.from("suppliers").update(payload).eq("id", supplier.id).select("id").single() : await db.from("suppliers").insert(payload).select("id").single();
    if (result.error) { setError(result.error.message); return; }
    await db.from("supplier_entities").delete().eq("supplier_id", result.data.id);
    if (supplier.entity_ids.length) {
      const inserted = await db.from("supplier_entities").insert(supplier.entity_ids.map((entity_id) => ({ supplier_id: result.data.id, entity_id, is_demo: false, data_origin: "manual" })));
      if (inserted.error) { setError(inserted.error.message); return; }
    }
    setSupplier(emptySupplier); setMessage("Supplier saved."); await load();
  }

  async function toggleSupplier(row: Row) {
    const res = await db.from("suppliers").update({ active_status: !row.active_status, archived_at: row.active_status ? new Date().toISOString() : null }).eq("id", row.id);
    if (res.error) setError(res.error.message); else { setMessage(row.active_status ? "Supplier archived." : "Supplier reactivated."); await load(); }
  }

  async function saveBill(e: FormEvent) {
    e.preventDefault(); setError("");
    const total = Number(bill.total_amount || bill.subtotal || 0);
    const payload = { entity_id: bill.entity_id, supplier_id: bill.supplier_id || null, description: bill.description, bill_number: bill.bill_number || null, bill_type: bill.bill_type, bill_date: bill.bill_date, due_date: bill.due_date, subtotal: Number(bill.subtotal || total), tax_amount: Number(bill.tax_amount || 0), total_amount: total, outstanding_amount: total, payment_status: bill.payment_status, expense_category_id: bill.expense_category_id || null, remarks: bill.remarks || null, supporting_document_status: billFiles.length ? "invoice_uploaded" : "no_document", is_demo: false, data_origin: "manual" };
    const res = await db.from("supplier_bills").insert(payload).select("id").single();
    if (res.error) { setError(res.error.message); return; }
    const ok = await uploadDocs(billFiles, { entity_id: bill.entity_id, linked_record_type: "supplier_bill", linked_record_id: res.data.id, document_type: "supplier_invoice" });
    setBill({ ...emptyBill, entity_id: bill.entity_id }); setBillFiles([]); setMessage(ok ? "Bill and documents saved." : "Bill saved, but document upload needs attention."); await load();
  }

  async function saveRecurring(e: FormEvent) {
    e.preventDefault(); setError("");
    const payload = { entity_id: obligation.entity_id, supplier_id: obligation.supplier_id || null, description: obligation.description, expected_amount: Number(obligation.expected_amount || 0), due_day: Number(obligation.due_day || 1), fixed_or_variable: obligation.fixed_or_variable, required_document_type: obligation.required_document_type, start_date: obligation.start_date, reminder_days: Number(obligation.reminder_days || 3), remarks: obligation.remarks || null, active_status: true, is_demo: false, data_origin: "manual" };
    const res = await db.from("recurring_obligations").insert(payload);
    if (res.error) setError(res.error.message); else { setMessage("Recurring obligation saved."); await load(); }
  }

  async function generateDrafts() {
    const res = await fetch("/api/recurring/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month: new Date().toISOString().slice(0, 7) }) });
    const json = await res.json();
    if (!res.ok) setError(json.error || "Draft generation failed"); else { setMessage(`Generated ${json.bills_created || 0} bill draft(s) and ${json.vouchers_created || 0} voucher draft(s).`); await load(); }
  }

  async function savePayment(e: FormEvent) {
    e.preventDefault(); setError("");
    const b = bills.find((x) => x.id === payment.supplier_bill_id);
    const res = await db.from("bill_payments").insert({ entity_id: b?.entity_id, supplier_bill_id: payment.supplier_bill_id, payment_voucher_id: payment.payment_voucher_id || null, payment_date: payment.payment_date, amount: Number(payment.amount || 0), method: payment.method, payment_reference: payment.payment_reference || null, remarks: payment.remarks || null, is_demo: false, data_origin: "manual" });
    if (res.error) setError(res.error.message); else { setPayment({ supplier_bill_id: "", payment_voucher_id: "", amount: "", payment_date: today, method: "bank_transfer", payment_reference: "", remarks: "" }); setMessage("Payment recorded."); await load(); }
  }

  async function saveVoucherDraft(e: FormEvent) {
    e.preventDefault(); setError("");
    const validItems = voucherItems.filter((i) => i.description && Number(i.amount) > 0);
    const total = validItems.reduce((sum, i) => sum + Number(i.amount || 0), 0);
    if (!voucher.entity_id || !voucher.payee || !voucher.purpose || total <= 0) { setError("Entity, payee, purpose and at least one item amount are required."); return; }
    const res = await db.from("payment_vouchers").insert({ entity_id: voucher.entity_id, supplier_id: voucher.supplier_id || null, voucher_date: voucher.voucher_date, payee: voucher.payee, payee_bank_details: voucher.payee_bank_details_text ? { notes: voucher.payee_bank_details_text } : {}, purpose: voucher.purpose, voucher_source: voucher.voucher_source, recurring_obligation_id: voucher.recurring_obligation_id || null, paying_bank_account_id: voucher.paying_bank_account_id || null, payment_method: voucher.payment_method || null, bank_reference: voucher.bank_reference || null, remarks: voucher.remarks || null, total_amount: total, status: "draft", is_demo: false, data_origin: "manual" }).select("id").single();
    if (res.error) { setError(res.error.message); return; }
    const itemRes = await db.from("payment_voucher_items").insert(validItems.map((i, index) => ({ payment_voucher_id: res.data.id, supplier_bill_id: i.supplier_bill_id || null, recurring_obligation_id: i.recurring_obligation_id || null, expense_category_id: i.expense_category_id || null, description: i.description, amount: Number(i.amount), sort_order: index + 1, is_demo: false, data_origin: "manual" })));
    if (itemRes.error) { setError(itemRes.error.message); return; }
    setVoucher({ ...emptyVoucher, entity_id: voucher.entity_id }); setVoucherItems([{ ...emptyItem }]); setMessage("Voucher draft saved. Issue only when final."); await load();
  }

  async function createFromBill(row: Row) {
    const s = suppliers.find((x) => x.id === row.supplier_id);
    setVoucher({ ...emptyVoucher, entity_id: row.entity_id, supplier_id: row.supplier_id || "", payee: s?.supplier_name ?? "", payee_bank_details_text: s?.bank_details?.notes ?? "", purpose: row.description, voucher_source: "supplier_bill", bank_reference: row.payment_reference || "" });
    setVoucherItems([{ description: `${row.bill_number || "Bill"} - ${row.description}`, expense_category_id: row.expense_category_id || "", supplier_bill_id: row.id, recurring_obligation_id: row.recurring_obligation_id || "", amount: String(row.outstanding_amount || row.total_amount || 0) }]);
    setMessage("Bill copied into the manual voucher form. Review, then save the draft.");
  }

  async function issueVoucher(id: string) {
    const res = await fetch("/api/payment-vouchers/issue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voucherId: id }) });
    const json = await res.json();
    if (!res.ok) setError(json.error || "Issue failed"); else { setMessage(`Voucher issued: ${json.voucher_number}`); await load(); }
  }

  async function uploadLibrary(e: FormEvent) {
    e.preventDefault(); setError("");
    if (!upload.linked_record_id) { setError("Choose a valid record first. Create the bill, voucher or payment if the list is empty."); return; }
    const ok = await uploadDocs(libraryFiles, upload);
    if (ok) { setLibraryFiles([]); setMessage("Document upload complete."); await load(); }
  }

  async function demoAction(kind: "load" | "remove") {
    if (kind === "remove" && window.prompt("Type REMOVE DEMO DATA to delete demo records only") !== "REMOVE DEMO DATA") return;
    const res = await fetch("/api/demo/phase2", { method: kind === "load" ? "POST" : "DELETE" });
    const json = await res.json();
    if (!res.ok) setError(json.error || "Demo action failed"); else { setShowDemo(kind === "load"); setMessage(json.message || "Demo action complete."); await load(); }
  }

  async function downloadDoc(id: string) {
    const res = await fetch(`/api/documents/${id}/download`); const json = await res.json();
    if (!res.ok) setError(json.error || "Download failed"); else window.open(json.signedUrl, "_blank", "noopener,noreferrer");
  }

  const missing = bills.filter((b) => ["no_document", "partial_evidence", "not_applicable"].includes(b.supporting_document_status));

  return <main className="page-shell"><div className="shortcut-bar"><Link href="/suppliers">Suppliers</Link><Link href="/bills">Bills</Link><Link href="/recurring">Recurring</Link><Link href="/payment-vouchers">Payment Vouchers</Link><Link href="/documents">Documents</Link><Link href="/missing-documents">Missing Documents</Link></div><section className="page-hero"><div><span className="eyebrow">PHASE 2</span><h1>{title}</h1></div><div className="hero-stats"><strong>{bills.length} bills</strong><strong>{bills.filter((b) => b.due_date <= today && b.payment_status !== "paid").length} due soon</strong><strong>{docs.length} docs</strong></div></section><div className="status-bar"><span>{error || message}</span><span className="actions"><label className="inline"><input type="checkbox" checked={showDemo} onChange={(e) => setShowDemo(e.target.checked)} /> DEMO view</label><button onClick={() => void load()}>Refresh</button></span></div>
    {mode === "suppliers" && <section className="grid"><Panel title="Supplier / Payee"><SupplierForm supplier={supplier} setSupplier={setSupplier} save={saveSupplier} entities={entities} categories={categories} /></Panel><Panel title="Supplier List" action={<span className="actions"><button onClick={() => void demoAction("load")}>Load Phase 2 Demo Data</button><button onClick={() => void demoAction("remove")}>Remove Phase 2 Demo Data</button></span>}><SupplierTable rows={suppliers} entities={entities} supplierEntities={supplierEntities} setSupplier={setSupplier} toggleSupplier={toggleSupplier} /></Panel></section>}
    {mode === "bills" && <section className="grid"><Panel title="Create Supplier Bill"><BillForm bill={bill} setBill={setBill} save={saveBill} entities={entities} suppliers={selectedSuppliers} categories={categories} files={billFiles} setFiles={setBillFiles} uploading={uploading} /></Panel><Panel title={billId ? "Bill Detail" : "Supplier Bills"}><BillTable rows={bills} entities={entities} suppliers={suppliers} onVoucher={createFromBill} docs={docs} links={links} /></Panel><Panel title="Record Payment"><PaymentForm payment={payment} setPayment={setPayment} save={savePayment} bills={bills} vouchers={vouchers} /></Panel></section>}
    {mode === "recurring" && <section className="grid"><Panel title="Recurring Obligation"><RecurringForm obligation={obligation} setObligation={setObligation} save={saveRecurring} entities={entities} suppliers={activeSuppliers(obligation.entity_id)} /></Panel><Panel title="Monthly Drafts" action={<button onClick={generateDrafts}>Generate Monthly Drafts</button>}>{!recurring.length ? <div className="empty">Nothing to show.</div> : recurring.map((r) => <div key={r.id} className="list-row"><b>{r.description}</b><span>{supplierName(r.supplier_id)} - day {r.due_day} - {money(r.expected_amount)}</span></div>)}</Panel></section>}
    {mode === "vouchers" && <section className="grid"><Panel title="Create Manual Voucher"><VoucherForm voucher={voucher} setVoucher={setVoucher} items={voucherItems} setItems={setVoucherItems} save={saveVoucherDraft} entities={entities} suppliers={activeSuppliers(voucher.entity_id)} categories={categories} bills={bills} recurring={recurring} bankAccounts={banks} /></Panel><Panel title="Create From Bill">{!bills.length && <div className="empty">No supplier bills are available. You may create a manual payment voucher.</div>}<BillTable rows={bills} entities={entities} suppliers={suppliers} onVoucher={createFromBill} docs={docs} links={links} /></Panel><Panel title="Payment Vouchers"><VoucherTable rows={vouchers} items={items} entities={entities} categories={categories} docs={docs} links={links} onIssue={issueVoucher} /></Panel></section>}
    {mode === "documents" && <section className="grid"><Panel title="Upload Documents"><form onSubmit={uploadLibrary}><p className="wide help">The normal invoice workflow starts from Supplier Bills. This library is for secondary uploads and document review.</p><Select label="Entity" value={upload.entity_id} onChange={(v) => setUpload({ ...upload, entity_id: v, linked_record_id: "" })} rows={entities} /><label>Document type<select value={upload.document_type} onChange={(e) => setUpload({ ...upload, document_type: e.target.value })}>{docTypes.map((x) => <option key={x}>{x}</option>)}</select></label><label>Linked type<select value={upload.linked_record_type} onChange={(e) => setUpload({ ...upload, linked_record_type: e.target.value, linked_record_id: "" })}>{linkTypes.map((x) => <option key={x}>{x}</option>)}</select></label><Select label="Record" value={upload.linked_record_id} onChange={(v) => setUpload({ ...upload, linked_record_id: v })} rows={recordRows} required={false} empty="Choose" />{!recordRows.length && <p className="wide help">No {upload.linked_record_type.replaceAll("_", " ")} records available. Create the required record first.</p>}<Link href={upload.linked_record_type === "payment_voucher" ? "/payment-vouchers" : upload.linked_record_type === "recurring_obligation" ? "/recurring" : "/bills"}>Create required record</Link><label className="wide">Desktop files<input type="file" multiple accept="application/pdf,image/jpeg,image/png,image/*" onChange={(e) => setLibraryFiles(Array.from(e.target.files ?? []))} /></label><label className="wide">Phone camera - supported mobile devices only<input type="file" accept="image/*" capture="environment" onChange={(e) => setLibraryFiles([...(libraryFiles ?? []), ...Array.from(e.target.files ?? [])])} /></label><FilePreview files={libraryFiles} /><button disabled={uploading || !libraryFiles.length || !upload.linked_record_id}>{uploading ? "Uploading..." : "Upload Documents"}</button></form></Panel><Panel title="Documents">{docs.map((d) => <div key={d.id} className="list-row"><b><Demo row={d} />{d.original_filename}</b><span>{d.document_type} - {Math.round(Number(d.file_size || 0) / 1024)} KB</span><button onClick={() => void downloadDoc(d.id)}>Preview / Download</button></div>)}</Panel></section>}
    {mode === "missing" && <section className="grid"><Panel title="Missing-document tracking"><div className="checkgrid"><Metric label="Bills with no invoice" value={bills.filter((b) => !docsFor("supplier_bill", b.id).includes(".")).length} /><Metric label="Recurring without voucher" value={recurring.filter((r) => !vouchers.some((v) => v.recurring_obligation_id === r.id)).length} /><Metric label="Paid bills without slip" value={bills.filter((b) => b.payment_status === "paid" && !docsFor("supplier_bill", b.id).includes("payment")).length} /><Metric label="Partial evidence" value={bills.filter((b) => b.supporting_document_status === "partial_evidence").length} /><Metric label="Not applicable" value={bills.filter((b) => b.supporting_document_status === "not_applicable").length} /><Metric label="Incomplete for audit" value={missing.length} /></div></Panel></section>}
  </main>;
}

function Panel({ title, action, children }: Row) { return <section className="panel"><div className="panel-head"><h2>{title}</h2>{action}</div>{children}</section>; }
function Demo({ row }: { row: Row }) { return row.is_demo ? <span className="tag">DEMO</span> : null; }
function Metric({ label, value }: { label: string; value: number }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function Select({ label, value, onChange, rows, required = true, empty = "Choose" }: Row) { return <label>{label}<select value={value || ""} required={required} onChange={(e) => onChange(e.target.value)}><option value="">{empty}</option>{rows.map((r: Row) => <option key={r.id} value={r.id}>{r.short_code || r.name || r.supplier_name || r.description || r.payee || r.account_name}</option>)}</select></label>; }
function FilePreview({ files }: { files: File[] }) { if (!files.length) return null; return <div className="wide mini"><b>Selected files</b>{files.map((f) => <span key={`${f.name}-${f.size}`}>{f.name} - {Math.round(f.size / 1024)} KB</span>)}</div>; }

function SupplierForm({ supplier, setSupplier, save, entities, categories }: Row) {
  const toggle = (id: string) => setSupplier({ ...supplier, entity_ids: supplier.entity_ids.includes(id) ? supplier.entity_ids.filter((x: string) => x !== id) : [...supplier.entity_ids, id] });
  return <form onSubmit={save}><label>Supplier / payee name<input value={supplier.supplier_name} onChange={(e) => setSupplier({ ...supplier, supplier_name: e.target.value })} required /></label><label>Registration number<input value={supplier.registration_number} onChange={(e) => setSupplier({ ...supplier, registration_number: e.target.value })} /></label><label>Contact person<input value={supplier.contact_person} onChange={(e) => setSupplier({ ...supplier, contact_person: e.target.value })} /></label><label>Email<input type="email" value={supplier.email} onChange={(e) => setSupplier({ ...supplier, email: e.target.value })} /></label><label>Phone<input value={supplier.phone} onChange={(e) => setSupplier({ ...supplier, phone: e.target.value })} /></label><Select label="Default expense category" value={supplier.default_expense_category} onChange={(v: string) => setSupplier({ ...supplier, default_expense_category: v })} rows={categories} required={false} /><label>Account code / SQL reference<input value={supplier.account_code} onChange={(e) => setSupplier({ ...supplier, account_code: e.target.value })} /></label><label>Default description<input value={supplier.default_description} onChange={(e) => setSupplier({ ...supplier, default_description: e.target.value })} /></label><label className="wide">Bank/payment details<textarea value={supplier.bank_details_text} onChange={(e) => setSupplier({ ...supplier, bank_details_text: e.target.value })} /></label><label className="wide">Entities supported<div className="checkgrid">{entities.map((e: Row) => <label key={e.id} className="inline"><input type="checkbox" checked={supplier.entity_ids.includes(e.id)} onChange={() => toggle(e.id)} /> {e.short_code}</label>)}</div></label><label className="wide">Remarks<textarea value={supplier.remarks} onChange={(e) => setSupplier({ ...supplier, remarks: e.target.value })} /></label><label className="inline"><input type="checkbox" checked={supplier.active_status} onChange={(e) => setSupplier({ ...supplier, active_status: e.target.checked })} /> Active</label><button>{supplier.id ? "Update supplier" : "Create supplier"}</button></form>;
}
function SupplierTable({ rows, entities, supplierEntities, setSupplier, toggleSupplier }: Row) { return !rows.length ? <div className="empty">No suppliers yet. Create a supplier or load owner-only DEMO data.</div> : <table><thead><tr><th>Supplier</th><th>Entities</th><th>Contact</th><th>Status</th><th /></tr></thead><tbody>{rows.map((s: Row) => <tr key={s.id}><td><Demo row={s} /> {s.supplier_name}</td><td>{supplierEntities.filter((se: Row) => se.supplier_id === s.id).map((se: Row) => entities.find((e: Row) => e.id === se.entity_id)?.short_code).join(", ")}</td><td>{s.email}<br />{s.phone}</td><td>{s.active_status ? "Active" : "Archived"}</td><td><button onClick={() => setSupplier({ ...s, bank_details_text: s.bank_details?.notes ?? "", entity_ids: supplierEntities.filter((se: Row) => se.supplier_id === s.id).map((se: Row) => se.entity_id) })}>Edit</button><button onClick={() => void toggleSupplier(s)}>{s.active_status ? "Archive" : "Reactivate"}</button></td></tr>)}</tbody></table>; }
function BillForm({ bill, setBill, save, entities, suppliers, categories, files, setFiles, uploading }: Row) { return <form onSubmit={save}><Select label="Entity" value={bill.entity_id} onChange={(v: string) => setBill({ ...bill, entity_id: v, supplier_id: "" })} rows={entities} /><Select label="Supplier" value={bill.supplier_id} onChange={(v: string) => setBill({ ...bill, supplier_id: v })} rows={suppliers} required={false} empty={bill.entity_id ? "Choose supplier" : "Choose entity first"} />{bill.entity_id && !suppliers.length && <p className="wide help">No active suppliers for this entity. Create one on the Suppliers page first.</p>}<label>Description<input value={bill.description} onChange={(e) => setBill({ ...bill, description: e.target.value })} required /></label><label>Bill no<input value={bill.bill_number} onChange={(e) => setBill({ ...bill, bill_number: e.target.value })} /></label><label>Bill type<select value={bill.bill_type} onChange={(e) => setBill({ ...bill, bill_type: e.target.value })}>{["supplier_invoice","recurring_obligation","statutory_payment","payroll_support","other"].map((x) => <option key={x}>{x}</option>)}</select></label><Select label="Expense category" value={bill.expense_category_id} onChange={(v: string) => setBill({ ...bill, expense_category_id: v })} rows={categories} required={false} /><label>Bill date<input type="date" value={bill.bill_date} onChange={(e) => setBill({ ...bill, bill_date: e.target.value })} /></label><label>Due date<input type="date" value={bill.due_date} onChange={(e) => setBill({ ...bill, due_date: e.target.value })} /></label><label>Subtotal<input type="number" step="0.01" value={bill.subtotal} onChange={(e) => setBill({ ...bill, subtotal: e.target.value })} /></label><label>Tax<input type="number" step="0.01" value={bill.tax_amount} onChange={(e) => setBill({ ...bill, tax_amount: e.target.value })} /></label><label>Total<input type="number" step="0.01" value={bill.total_amount} onChange={(e) => setBill({ ...bill, total_amount: e.target.value })} required /></label><label>Status<select value={bill.payment_status} onChange={(e) => setBill({ ...bill, payment_status: e.target.value })}>{["draft","unpaid","scheduled","partially_paid","paid","overdue","cancelled"].map((x) => <option key={x}>{x}</option>)}</select></label><label className="wide">Invoice documents - desktop file picker<input type="file" multiple accept="application/pdf,image/jpeg,image/png,image/*" disabled={uploading} onChange={(e) => setFiles(Array.from(e.target.files ?? []))} /></label><label className="wide">Phone camera - supported mobile devices only<input type="file" accept="image/*" capture="environment" disabled={uploading} onChange={(e) => setFiles([...(files ?? []), ...Array.from(e.target.files ?? [])])} /></label><FilePreview files={files ?? []} /><textarea placeholder="remarks" value={bill.remarks} onChange={(e) => setBill({ ...bill, remarks: e.target.value })} /><button disabled={uploading}>{uploading ? "Saving and uploading..." : "Save bill and documents"}</button></form>; }
function PaymentForm({ payment, setPayment, save, bills, vouchers }: Row) { return <form onSubmit={save}><Select label="Bill" value={payment.supplier_bill_id} onChange={(v: string) => setPayment({ ...payment, supplier_bill_id: v })} rows={bills} /><Select label="Voucher" value={payment.payment_voucher_id} onChange={(v: string) => setPayment({ ...payment, payment_voucher_id: v })} rows={vouchers} required={false} /><label>Amount<input type="number" step="0.01" value={payment.amount} onChange={(e) => setPayment({ ...payment, amount: e.target.value })} required /></label><label>Date<input type="date" value={payment.payment_date} onChange={(e) => setPayment({ ...payment, payment_date: e.target.value })} /></label><label>Method<input value={payment.method} onChange={(e) => setPayment({ ...payment, method: e.target.value })} /></label><label>Reference<input value={payment.payment_reference} onChange={(e) => setPayment({ ...payment, payment_reference: e.target.value })} /></label><textarea placeholder="remarks" value={payment.remarks} onChange={(e) => setPayment({ ...payment, remarks: e.target.value })} /><button>Record payment</button></form>; }
function RecurringForm({ obligation, setObligation, save, entities, suppliers }: Row) { return <form onSubmit={save}><Select label="Entity" value={obligation.entity_id} onChange={(v: string) => setObligation({ ...obligation, entity_id: v, supplier_id: "" })} rows={entities} /><Select label="Supplier" value={obligation.supplier_id} onChange={(v: string) => setObligation({ ...obligation, supplier_id: v })} rows={suppliers} required={false} />{obligation.entity_id && !suppliers.length && <p className="wide help">No active suppliers for this entity. Create one first.</p>}<label>Description<input value={obligation.description} onChange={(e) => setObligation({ ...obligation, description: e.target.value })} required /></label><label>Expected amount<input type="number" step="0.01" value={obligation.expected_amount} onChange={(e) => setObligation({ ...obligation, expected_amount: e.target.value })} /></label><label>Due day<input type="number" value={obligation.due_day} onChange={(e) => setObligation({ ...obligation, due_day: e.target.value })} /></label><label>Start date<input type="date" value={obligation.start_date} onChange={(e) => setObligation({ ...obligation, start_date: e.target.value })} /></label><label>Required doc<select value={obligation.required_document_type} onChange={(e) => setObligation({ ...obligation, required_document_type: e.target.value })}>{docTypes.map((x) => <option key={x}>{x}</option>)}</select></label><label>Reminder days<input type="number" value={obligation.reminder_days} onChange={(e) => setObligation({ ...obligation, reminder_days: e.target.value })} /></label><textarea placeholder="remarks" value={obligation.remarks} onChange={(e) => setObligation({ ...obligation, remarks: e.target.value })} /><button>Save recurring obligation</button></form>; }
function VoucherForm({ voucher, setVoucher, items, setItems, save, entities, suppliers, categories, bills, recurring, bankAccounts }: Row) { const total = items.reduce((s: number, i: Row) => s + Number(i.amount || 0), 0); return <form onSubmit={save}><Select label="Entity" value={voucher.entity_id} onChange={(v: string) => setVoucher({ ...voucher, entity_id: v, supplier_id: "" })} rows={entities} /><label>Voucher date<input type="date" value={voucher.voucher_date} onChange={(e) => setVoucher({ ...voucher, voucher_date: e.target.value })} /></label><Select label="Supplier / payee" value={voucher.supplier_id} onChange={(v: string) => { const s = suppliers.find((x: Row) => x.id === v); setVoucher({ ...voucher, supplier_id: v, payee: s?.supplier_name ?? voucher.payee, payee_bank_details_text: s?.bank_details?.notes ?? voucher.payee_bank_details_text }); }} rows={suppliers} required={false} /><label>Payee<input value={voucher.payee} onChange={(e) => setVoucher({ ...voucher, payee: e.target.value })} required /></label><label>Voucher source<select value={voucher.voucher_source} onChange={(e) => setVoucher({ ...voucher, voucher_source: e.target.value })}><option>manual</option><option>supplier_bill</option><option>recurring_obligation</option></select></label><Select label="Recurring obligation" value={voucher.recurring_obligation_id} onChange={(v: string) => setVoucher({ ...voucher, recurring_obligation_id: v })} rows={recurring} required={false} /><Select label="Paying bank account" value={voucher.paying_bank_account_id} onChange={(v: string) => setVoucher({ ...voucher, paying_bank_account_id: v })} rows={bankAccounts} required={false} /><label>Payment method<input value={voucher.payment_method} onChange={(e) => setVoucher({ ...voucher, payment_method: e.target.value })} /></label><label>Payment reference<input value={voucher.bank_reference} onChange={(e) => setVoucher({ ...voucher, bank_reference: e.target.value })} /></label><label>Purpose<input value={voucher.purpose} onChange={(e) => setVoucher({ ...voucher, purpose: e.target.value })} required /></label><label className="wide">Payee bank details<textarea value={voucher.payee_bank_details_text} onChange={(e) => setVoucher({ ...voucher, payee_bank_details_text: e.target.value })} /></label><div className="wide mini"><b>Itemised payment rows</b>{items.map((item: Row, index: number) => <div className="itemrow" key={index}><input placeholder="description" value={item.description} onChange={(e) => setItems(items.map((x: Row, i: number) => i === index ? { ...x, description: e.target.value } : x))} /><select value={item.expense_category_id} onChange={(e) => setItems(items.map((x: Row, i: number) => i === index ? { ...x, expense_category_id: e.target.value } : x))}><option value="">category</option>{categories.map((c: Row) => <option key={c.id} value={c.id}>{c.name}</option>)}</select><select value={item.supplier_bill_id} onChange={(e) => setItems(items.map((x: Row, i: number) => i === index ? { ...x, supplier_bill_id: e.target.value } : x))}><option value="">related bill</option>{bills.map((b: Row) => <option key={b.id} value={b.id}>{b.description}</option>)}</select><input type="number" step="0.01" placeholder="amount" value={item.amount} onChange={(e) => setItems(items.map((x: Row, i: number) => i === index ? { ...x, amount: e.target.value } : x))} /><button type="button" onClick={() => setItems(items.filter((_: Row, i: number) => i !== index))}>Remove</button></div>)}<button type="button" onClick={() => setItems([...items, { ...emptyItem }])}>Add item</button><p>Total: {money(total)}</p></div><textarea placeholder="remarks" value={voucher.remarks} onChange={(e) => setVoucher({ ...voucher, remarks: e.target.value })} /><button>Save voucher draft</button></form>; }
function BillTable({ rows, entities, suppliers, onVoucher, docs, links }: Row) { return !rows.length ? <div className="empty">No bills yet.</div> : <table><thead><tr><th>Entity</th><th>Description</th><th>Supplier</th><th>Due</th><th>Status</th><th>Evidence</th><th>Total</th><th /></tr></thead><tbody>{rows.map((b: Row) => <tr key={b.id}><td>{entities.find((e: Row) => e.id === b.entity_id)?.short_code}</td><td><Demo row={b} /> {b.description}<br />{b.bill_number}</td><td>{suppliers.find((s: Row) => s.id === b.supplier_id)?.supplier_name}</td><td>{b.due_date}</td><td>{b.payment_status}</td><td>{b.supporting_document_status}<br />{links.filter((l: Row) => l.linked_record_type === "supplier_bill" && l.linked_record_id === b.id).map((l: Row) => docs.find((d: Row) => d.id === l.document_id)?.original_filename).filter(Boolean).join(", ")}</td><td>{money(b.total_amount)}</td><td><button onClick={() => void onVoucher(b)}>Create PV Draft</button></td></tr>)}</tbody></table>; }
function VoucherTable({ rows, items, entities, categories, docs, links, onIssue }: Row) { return !rows.length ? <div className="empty">No payment vouchers yet.</div> : <table><thead><tr><th>No</th><th>Date</th><th>Payee</th><th>Purpose</th><th>Items</th><th>Total</th><th>Status</th><th /></tr></thead><tbody>{rows.map((v: Row) => <tr key={v.id}><td><Demo row={v} /> {v.voucher_number || "Draft"}</td><td>{v.voucher_date}</td><td>{v.payee}</td><td>{v.purpose}</td><td>{items.filter((i: Row) => i.payment_voucher_id === v.id).map((i: Row) => `${i.description} (${categoryName(i.expense_category_id)})`).join("; ")}</td><td>{money(v.total_amount)}</td><td>{v.status}</td><td>{v.status === "draft" && <button onClick={() => void onIssue(v.id)}>Issue Voucher</button>}<button onClick={() => printVoucher(v, items.filter((i: Row) => i.payment_voucher_id === v.id), entities, categories, docs, links)}>Print</button></td></tr>)}</tbody></table>; function categoryName(id: string) { return categories.find((c: Row) => c.id === id)?.name ?? "-"; } }
function printVoucher(v: Row, voucherItems: Row[], entities: Row[], categories: Row[], docs: Row[], links: Row[]) { const entity = entities.find((e) => e.id === v.entity_id); const docList = links.filter((l) => l.linked_record_type === "payment_voucher" && l.linked_record_id === v.id).map((l) => docs.find((d) => d.id === l.document_id)?.original_filename).filter(Boolean).join(", ") || "None"; const rows = voucherItems.map((i) => `<tr><td>${i.description}</td><td>${categories.find((c) => c.id === i.expense_category_id)?.name ?? "-"}</td><td style="text-align:right">${money(i.amount)}</td></tr>`).join(""); const w = window.open("", "_blank"); if (!w) return; w.document.write(`<html><head><title>${v.voucher_number || "Draft Voucher"}</title><style>body{font-family:Arial;padding:24px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #999;padding:8px}@media print{button{display:none}}</style></head><body><h1>Payment Voucher</h1><p><b>Company:</b> ${entity?.legal_name || entity?.short_code || ""}</p><p><b>Voucher:</b> ${v.voucher_number || "Draft"}</p><p><b>Date:</b> ${v.voucher_date}</p><p><b>Payee:</b> ${v.payee}</p><p><b>Purpose:</b> ${v.purpose}</p><table><thead><tr><th>Description</th><th>Category</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table><p><b>Total:</b> ${money(v.total_amount)}</p><p><b>Payment method:</b> ${v.payment_method || ""}</p><p><b>Bank reference:</b> ${v.bank_reference || ""}</p><p><b>Prepared by:</b> ${v.prepared_by || ""}</p><p><b>Remarks:</b> ${v.remarks || ""}</p><p><b>Supporting documents:</b> ${docList}</p><button onclick="window.print()">Print / Save PDF</button></body></html>`); w.document.close(); }
