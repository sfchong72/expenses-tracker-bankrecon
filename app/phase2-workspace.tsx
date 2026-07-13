"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getBrowserSupabase } from "@/lib/supabase/client";

type Mode = "suppliers" | "bills" | "recurring" | "vouchers" | "documents" | "missing";
type Row = Record<string, any>;

type Props = {
  mode: Mode;
  userRole: string;
  userEmail: string;
};

const pageTitles: Record<Mode, string> = {
  suppliers: "Suppliers",
  bills: "Supplier Bills",
  recurring: "Recurring Obligations",
  vouchers: "Payment Vouchers",
  documents: "Documents",
  missing: "Missing Documents",
};

const nav: { href: string; label: string; mode: Mode }[] = [
  { href: "/suppliers", label: "Suppliers", mode: "suppliers" },
  { href: "/bills", label: "Bills", mode: "bills" },
  { href: "/recurring", label: "Recurring", mode: "recurring" },
  { href: "/payment-vouchers", label: "Payment Vouchers", mode: "vouchers" },
  { href: "/documents", label: "Documents", mode: "documents" },
  { href: "/missing-documents", label: "Missing Documents", mode: "missing" },
];

const documentTypes = ["supplier_invoice", "receipt", "payment_slip", "payment_voucher", "quotation", "contract", "payroll_support", "other"];
const linkedTypes = ["supplier_bill", "payment_voucher", "bill_payment", "bank_transaction", "recurring_obligation"];
const voucherStatuses = ["draft", "issued", "paid", "cancelled"];

function money(value: unknown) {
  const amount = Number(value || 0);
  return amount.toLocaleString("en-MY", { style: "currency", currency: "MYR" });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function monthInput() {
  return new Date().toISOString().slice(0, 7);
}

function safeMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Unexpected error");
}

export function Phase2Workspace({ mode, userRole, userEmail }: Props) {
  const supabase = getBrowserSupabase();
  const isOwner = userRole === "owner";
  const [entities, setEntities] = useState<Row[]>([]);
  const [suppliers, setSuppliers] = useState<Row[]>([]);
  const [supplierLinks, setSupplierLinks] = useState<Row[]>([]);
  const [categories, setCategories] = useState<Row[]>([]);
  const [banks, setBanks] = useState<Row[]>([]);
  const [bills, setBills] = useState<Row[]>([]);
  const [recurring, setRecurring] = useState<Row[]>([]);
  const [vouchers, setVouchers] = useState<Row[]>([]);
  const [voucherItems, setVoucherItems] = useState<Row[]>([]);
  const [documents, setDocuments] = useState<Row[]>([]);
  const [links, setLinks] = useState<Row[]>([]);
  const [status, setStatus] = useState("Loading...");
  const [showDemo, setShowDemo] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [previewFiles, setPreviewFiles] = useState<File[]>([]);
  const [supplierForm, setSupplierForm] = useState<Row>({ name: "", active_status: true, entity_ids: [] });
  const [billForm, setBillForm] = useState<Row>({ bill_type: "supplier_invoice", payment_status: "unpaid", support_status: "no_document", due_date: today() });
  const [recurringForm, setRecurringForm] = useState<Row>({ frequency: "monthly", fixed_or_variable: "fixed", due_day: 1, reminder_days: 3, required_document_type: "supplier_invoice", start_date: today(), active_status: true, auto_generate_pv: true });
  const [voucherForm, setVoucherForm] = useState<Row>({ voucher_source: "manual", voucher_date: today(), payment_method: "bank_transfer", status: "draft", items: [{ description: "", amount: "", expense_category_id: "" }] });
  const [documentForm, setDocumentForm] = useState<Row>({ document_type: "supplier_invoice", linked_record_type: "supplier_bill" });

  const defaultEntity = entities[0]?.id || "";

  async function load() {
    setStatus("Loading...");
    try {
      const [entityRes, supplierRes, linkRes, categoryRes, bankRes, billRes, recRes, voucherRes, itemRes, docRes, docLinkRes] = await Promise.all([
        supabase.from("entities").select("*").eq("active_status", true).order("code"),
        supabase.from("suppliers").select("*").eq("is_demo", showDemo).order("name"),
        supabase.from("supplier_entities").select("*").eq("is_demo", showDemo),
        supabase.from("expense_categories").select("*").order("name"),
        supabase.from("bank_accounts_staff_safe").select("*").order("account_name"),
        supabase.from("supplier_bills").select("*").eq("is_demo", showDemo).order("created_at", { ascending: false }),
        supabase.from("recurring_obligations").select("*").eq("is_demo", showDemo).order("created_at", { ascending: false }),
        supabase.from("payment_vouchers").select("*").eq("is_demo", showDemo).order("created_at", { ascending: false }),
        supabase.from("payment_voucher_items").select("*").eq("is_demo", showDemo).order("created_at", { ascending: true }),
        supabase.from("documents").select("*").eq("is_demo", showDemo).is("archived_at", null).order("created_at", { ascending: false }),
        supabase.from("document_links").select("*").eq("is_demo", showDemo),
      ]);
      for (const res of [entityRes, supplierRes, linkRes, categoryRes, bankRes, billRes, recRes, voucherRes, itemRes, docRes, docLinkRes]) if (res.error) throw res.error;
      setEntities(entityRes.data || []); setSuppliers(supplierRes.data || []); setSupplierLinks(linkRes.data || []); setCategories(categoryRes.data || []); setBanks(bankRes.data || []); setBills(billRes.data || []); setRecurring(recRes.data || []); setVouchers(voucherRes.data || []); setVoucherItems(itemRes.data || []); setDocuments(docRes.data || []); setLinks(docLinkRes.data || []);
      setSupplierForm((x) => ({ ...x, entity_ids: x.entity_ids?.length ? x.entity_ids : (entityRes.data || []).slice(0, 1).map((e) => e.id) }));
      setBillForm((x) => ({ ...x, entity_id: x.entity_id || entityRes.data?.[0]?.id || "" }));
      setRecurringForm((x) => ({ ...x, entity_id: x.entity_id || entityRes.data?.[0]?.id || "" }));
      setVoucherForm((x) => ({ ...x, entity_id: x.entity_id || entityRes.data?.[0]?.id || "" }));
      setDocumentForm((x) => ({ ...x, entity_id: x.entity_id || entityRes.data?.[0]?.id || "" }));
      setStatus("Ready");
    } catch (error) {
      setStatus(safeMessage(error));
    }
  }

  useEffect(() => { void load(); }, [showDemo]);

  const stats = useMemo(() => ({ bills: bills.length, due: bills.filter((b) => b.payment_status !== "paid" && b.due_date && b.due_date <= today()).length, docs: documents.length }), [bills, documents]);
  const entityCode = (id: string) => entities.find((e) => e.id === id)?.code || "";
  const supplierName = (id: string) => suppliers.find((s) => s.id === id)?.name || "Unassigned";
  const categoryName = (id: string) => categories.find((c) => c.id === id)?.name || "";
  const billLabel = (b: Row) => `${supplierName(b.supplier_id)} - ${b.bill_number || b.description || "Bill"} (${money(b.outstanding_amount ?? b.total_amount)})`;
  const validSuppliers = (entityId: string) => suppliers.filter((s) => s.active_status !== false && supplierLinks.some((l) => l.supplier_id === s.id && l.entity_id === entityId));
  const recordsForDocument = () => {
    if (documentForm.linked_record_type === "supplier_bill") return bills.filter((b) => b.entity_id === documentForm.entity_id).map((b) => ({ id: b.id, label: billLabel(b) }));
    if (documentForm.linked_record_type === "payment_voucher") return vouchers.filter((v) => v.entity_id === documentForm.entity_id).map((v) => ({ id: v.id, label: v.voucher_number || `${v.payee_name || "Voucher"} draft` }));
    if (documentForm.linked_record_type === "recurring_obligation") return recurring.filter((r) => r.entity_id === documentForm.entity_id).map((r) => ({ id: r.id, label: `${supplierName(r.supplier_id)} - ${r.description || "Recurring"}` }));
    return [];
  };
  const docListFor = (type: string, id: string) => links.filter((l) => l.linked_record_type === type && l.linked_record_id === id).map((l) => documents.find((d) => d.id === l.document_id)).filter(Boolean) as Row[];

  function chooseFiles(files: FileList | null) {
    setPreviewFiles(Array.from(files || []));
  }

  async function uploadDocuments(files: File[], form: Row) {
    if (!files.length) return [];
    setUploading(true);
    const uploaded: Row[] = [];
    try {
      for (const file of files) {
        const body = new FormData();
        body.append("file", file);
        body.append("entity_id", form.entity_id);
        body.append("document_type", form.document_type || "supplier_invoice");
        body.append("linked_record_type", form.linked_record_type);
        body.append("linked_record_id", form.linked_record_id);
        const res = await fetch("/api/documents/upload", { method: "POST", body });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Upload failed");
        uploaded.push(json.document);
      }
      setStatus(`${uploaded.length} document(s) uploaded.`);
      setPreviewFiles([]);
      await load();
      return uploaded;
    } finally {
      setUploading(false);
    }
  }

  async function saveSupplier(event: React.FormEvent) {
    event.preventDefault();
    try {
      const entityIds = supplierForm.entity_ids || [];
      if (!supplierForm.name || !entityIds.length) throw new Error("Supplier name and at least one entity are required.");
      const payload = { name: supplierForm.name, registration_number: supplierForm.registration_number || null, contact_person: supplierForm.contact_person || null, email: supplierForm.email || null, phone: supplierForm.phone || null, bank_details: supplierForm.bank_details || null, default_expense_category_id: supplierForm.default_expense_category_id || null, default_description: supplierForm.default_description || null, account_code: supplierForm.account_code || null, remarks: supplierForm.remarks || null, active_status: supplierForm.active_status !== false };
      const saved = supplierForm.id ? await supabase.from("suppliers").update(payload).eq("id", supplierForm.id).select("id").single() : await supabase.from("suppliers").insert(payload).select("id").single();
      if (saved.error) throw saved.error;
      await supabase.from("supplier_entities").delete().eq("supplier_id", saved.data.id);
      const rows = entityIds.map((entity_id: string) => ({ supplier_id: saved.data.id, entity_id }));
      const rel = await supabase.from("supplier_entities").insert(rows);
      if (rel.error) throw rel.error;
      setSupplierForm({ name: "", active_status: true, entity_ids: [defaultEntity] });
      setStatus("Supplier saved.");
      await load();
    } catch (error) { setStatus(safeMessage(error)); }
  }

  async function archiveSupplier(supplier: Row, active: boolean) {
    const { error } = await supabase.from("suppliers").update({ active_status: active, archived_at: active ? null : new Date().toISOString() }).eq("id", supplier.id);
    if (error) setStatus(error.message); else { setStatus(active ? "Supplier reactivated." : "Supplier archived."); await load(); }
  }

  async function saveBill(event: React.FormEvent) {
    event.preventDefault();
    try {
      if (!billForm.entity_id || !billForm.supplier_id || !billForm.description) throw new Error("Entity, supplier and description are required.");
      const total = Number(billForm.total_amount || 0);
      const { data, error } = await supabase.from("supplier_bills").insert({ entity_id: billForm.entity_id, supplier_id: billForm.supplier_id, description: billForm.description, bill_number: billForm.bill_number || null, bill_type: billForm.bill_type, subtotal: Number(billForm.subtotal || total), tax_amount: Number(billForm.tax_amount || 0), total_amount: total, outstanding_amount: total, expense_category_id: billForm.expense_category_id || null, bill_date: billForm.bill_date || today(), due_date: billForm.due_date || today(), payment_status: billForm.payment_status || "unpaid", support_status: previewFiles.length ? "invoice_uploaded" : "no_document", remarks: billForm.remarks || null }).select("id").single();
      if (error) throw error;
      if (previewFiles.length) await uploadDocuments(previewFiles, { entity_id: billForm.entity_id, document_type: "supplier_invoice", linked_record_type: "supplier_bill", linked_record_id: data.id });
      setBillForm({ bill_type: "supplier_invoice", payment_status: "unpaid", support_status: "no_document", due_date: today(), entity_id: billForm.entity_id });
      setStatus("Bill saved. Supporting documents are linked to the bill.");
      await load();
    } catch (error) { setStatus(safeMessage(error)); }
  }

  async function saveRecurring(event: React.FormEvent) {
    event.preventDefault();
    try {
      const { error } = await supabase.from("recurring_obligations").insert({ entity_id: recurringForm.entity_id, supplier_id: recurringForm.supplier_id, description: recurringForm.description, frequency: recurringForm.frequency, fixed_or_variable: recurringForm.fixed_or_variable, expected_amount: Number(recurringForm.expected_amount || 0), due_day: Number(recurringForm.due_day || 1), reminder_days: Number(recurringForm.reminder_days || 3), required_document_type: recurringForm.required_document_type, start_date: recurringForm.start_date, end_date: recurringForm.end_date || null, auto_generate_pv: recurringForm.auto_generate_pv !== false, active_status: true, remarks: recurringForm.remarks || null });
      if (error) throw error;
      setStatus("Recurring obligation saved."); await load();
    } catch (error) { setStatus(safeMessage(error)); }
  }

  async function generateDrafts() {
    try {
      const res = await fetch("/api/recurring/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month: monthInput() }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Draft generation failed");
      setStatus(`Generated ${json.bills_created || 0} bill draft(s) and ${json.vouchers_created || 0} voucher draft(s).`); await load();
    } catch (error) { setStatus(safeMessage(error)); }
  }

  function setVoucherItem(index: number, key: string, value: string) {
    setVoucherForm((form) => ({ ...form, items: form.items.map((item: Row, i: number) => i === index ? { ...item, [key]: value } : item) }));
  }

  async function saveVoucher(event: React.FormEvent) {
    event.preventDefault();
    try {
      if (!voucherForm.entity_id || !voucherForm.payee_name) throw new Error("Entity and payee are required.");
      const items = (voucherForm.items || []).filter((i: Row) => i.description && Number(i.amount) > 0);
      if (!items.length) throw new Error("Add at least one voucher item.");
      const total = items.reduce((sum: number, item: Row) => sum + Number(item.amount || 0), 0);
      const { data, error } = await supabase.from("payment_vouchers").insert({ entity_id: voucherForm.entity_id, supplier_id: voucherForm.supplier_id || null, voucher_source: voucherForm.voucher_source || "manual", recurring_obligation_id: voucherForm.recurring_obligation_id || null, voucher_date: voucherForm.voucher_date || today(), payee_name: voucherForm.payee_name, payee_bank_details: voucherForm.payee_bank_details || null, purpose: voucherForm.purpose || voucherForm.description || "Payment", payment_method: voucherForm.payment_method || null, paying_bank_account_id: voucherForm.paying_bank_account_id || null, payment_reference: voucherForm.payment_reference || null, remarks: voucherForm.remarks || null, status: "draft", total_amount: total }).select("id").single();
      if (error) throw error;
      const rows = items.map((item: Row) => ({ payment_voucher_id: data.id, supplier_bill_id: item.supplier_bill_id || null, recurring_obligation_id: item.recurring_obligation_id || null, expense_category_id: item.expense_category_id || null, description: item.description, amount: Number(item.amount) }));
      const itemRes = await supabase.from("payment_voucher_items").insert(rows);
      if (itemRes.error) throw itemRes.error;
      setStatus("Voucher draft saved. Issue it when details are final."); await load();
    } catch (error) { setStatus(safeMessage(error)); }
  }

  function fromBill(bill: Row) {
    setVoucherForm({ entity_id: bill.entity_id, supplier_id: bill.supplier_id, voucher_source: "supplier_bill", voucher_date: today(), payee_name: supplierName(bill.supplier_id), purpose: bill.description, payment_method: "bank_transfer", status: "draft", items: [{ supplier_bill_id: bill.id, expense_category_id: bill.expense_category_id || "", description: `${bill.bill_number || "Supplier bill"} - ${bill.description || "Payment"}`, amount: String(bill.outstanding_amount || bill.total_amount || 0) }] });
    setStatus("Bill details copied into a voucher draft. Review and save.");
  }

  async function issueVoucher(id: string) {
    try {
      const res = await fetch("/api/payment-vouchers/issue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payment_voucher_id: id }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not issue voucher");
      setStatus(`Voucher issued: ${json.voucher_number}`); await load();
    } catch (error) { setStatus(safeMessage(error)); }
  }

  async function loadDemo() {
    const res = await fetch("/api/demo/phase2", { method: "POST" });
    const json = await res.json();
    if (!res.ok) setStatus(json.error || "Demo load failed"); else { setShowDemo(true); setStatus("DEMO records loaded. Toggle DEMO view to inspect them."); await load(); }
  }

  async function removeDemo() {
    const reason = window.prompt("Owner action: type REMOVE DEMO DATA to delete Phase 2 demo records only.");
    if (reason !== "REMOVE DEMO DATA") return;
    const res = await fetch("/api/demo/phase2", { method: "DELETE" });
    const json = await res.json();
    if (!res.ok) setStatus(json.error || "Demo removal failed"); else { setShowDemo(false); setStatus("Phase 2 demo data removed."); await load(); }
  }

  async function downloadDocument(doc: Row) {
    const res = await fetch(`/api/documents/${doc.id}/download`);
    const json = await res.json();
    if (!res.ok) { setStatus(json.error || "Download failed"); return; }
    window.open(json.signedUrl, "_blank", "noopener,noreferrer");
  }

  const body = () => {
    if (mode === "suppliers") return <section className="grid two"><form onSubmit={saveSupplier} className="panel"><h2>Supplier Management</h2><label>Supplier name<input value={supplierForm.name || ""} onChange={(e) => setSupplierForm({ ...supplierForm, name: e.target.value })} /></label><label>Registration number<input value={supplierForm.registration_number || ""} onChange={(e) => setSupplierForm({ ...supplierForm, registration_number: e.target.value })} /></label><label>Contact person<input value={supplierForm.contact_person || ""} onChange={(e) => setSupplierForm({ ...supplierForm, contact_person: e.target.value })} /></label><label>Email<input value={supplierForm.email || ""} onChange={(e) => setSupplierForm({ ...supplierForm, email: e.target.value })} /></label><label>Phone<input value={supplierForm.phone || ""} onChange={(e) => setSupplierForm({ ...supplierForm, phone: e.target.value })} /></label><label>Bank/payment details<textarea value={supplierForm.bank_details || ""} onChange={(e) => setSupplierForm({ ...supplierForm, bank_details: e.target.value })} /></label><label>Default category<select value={supplierForm.default_expense_category_id || ""} onChange={(e) => setSupplierForm({ ...supplierForm, default_expense_category_id: e.target.value })}><option value="">None</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>Default description<input value={supplierForm.default_description || ""} onChange={(e) => setSupplierForm({ ...supplierForm, default_description: e.target.value })} /></label><label>Account code / SQL reference<input value={supplierForm.account_code || ""} onChange={(e) => setSupplierForm({ ...supplierForm, account_code: e.target.value })} /></label><label>Entities supported<select multiple value={supplierForm.entity_ids || []} onChange={(e) => setSupplierForm({ ...supplierForm, entity_ids: Array.from(e.target.selectedOptions).map((o) => o.value) })}>{entities.map((e) => <option key={e.id} value={e.id}>{e.code}</option>)}</select></label><label>Remarks<textarea value={supplierForm.remarks || ""} onChange={(e) => setSupplierForm({ ...supplierForm, remarks: e.target.value })} /></label><button>{supplierForm.id ? "Update Supplier" : "Create Supplier"}</button></form><section className="panel"><h2>Suppliers</h2>{isOwner && <div className="actions"><button onClick={loadDemo}>Load Phase 2 Demo Data</button><button onClick={removeDemo}>Remove Phase 2 Demo Data</button></div>}{suppliers.length === 0 ? <div className="empty">No suppliers yet.</div> : suppliers.map((s) => <article key={s.id} className="list-row"><strong>{s.is_demo ? "DEMO - " : ""}{s.name}</strong><span>{supplierLinks.filter((l) => l.supplier_id === s.id).map((l) => entityCode(l.entity_id)).join(", ")}</span><span>{s.email || "No email"}</span><div className="actions"><button onClick={() => setSupplierForm({ ...s, entity_ids: supplierLinks.filter((l) => l.supplier_id === s.id).map((l) => l.entity_id) })}>Edit</button><button onClick={() => archiveSupplier(s, !s.active_status)}>{s.active_status === false ? "Reactivate" : "Archive"}</button></div></article>)}</section></section>;

    if (mode === "bills") return <section className="grid two"><form onSubmit={saveBill} className="panel"><h2>Supplier Bill</h2><label>Entity<select value={billForm.entity_id || ""} onChange={(e) => setBillForm({ ...billForm, entity_id: e.target.value, supplier_id: "" })}>{entities.map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}</select></label><label>Supplier<select value={billForm.supplier_id || ""} onChange={(e) => setBillForm({ ...billForm, supplier_id: e.target.value })}><option value="">Choose</option>{validSuppliers(billForm.entity_id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>{validSuppliers(billForm.entity_id).length === 0 && <p className="help">No active suppliers for this entity. Create a supplier first.</p>}<label>Description<input value={billForm.description || ""} onChange={(e) => setBillForm({ ...billForm, description: e.target.value })} /></label><label>Bill number<input value={billForm.bill_number || ""} onChange={(e) => setBillForm({ ...billForm, bill_number: e.target.value })} /></label><label>Bill type<select value={billForm.bill_type} onChange={(e) => setBillForm({ ...billForm, bill_type: e.target.value })}>{["supplier_invoice", "recurring_obligation", "statutory_payment", "payroll_support", "other"].map((x) => <option key={x}>{x}</option>)}</select></label><label>Total amount<input type="number" step="0.01" value={billForm.total_amount || ""} onChange={(e) => setBillForm({ ...billForm, total_amount: e.target.value })} /></label><label>Due date<input type="date" value={billForm.due_date || today()} onChange={(e) => setBillForm({ ...billForm, due_date: e.target.value })} /></label><label>Expense category<select value={billForm.expense_category_id || ""} onChange={(e) => setBillForm({ ...billForm, expense_category_id: e.target.value })}><option value="">Choose</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>Attach invoice/supporting documents<input type="file" multiple accept="application/pdf,image/jpeg,image/png" onChange={(e) => chooseFiles(e.target.files)} /></label><label>Phone camera on supported mobile devices<input type="file" accept="image/*" capture="environment" onChange={(e) => chooseFiles(e.target.files)} /></label>{previewFiles.length > 0 && <div className="empty">Selected: {previewFiles.map((f) => f.name).join(", ")}</div>}<button disabled={uploading}>{uploading ? "Uploading..." : "Save Bill and Documents"}</button></form><section className="panel"><h2>Supplier Bills</h2>{bills.length === 0 ? <div className="empty">No bills yet.</div> : bills.map((b) => <article key={b.id} className="list-row"><strong>{b.is_demo ? "DEMO - " : ""}{billLabel(b)}</strong><span>{entityCode(b.entity_id)} - {b.payment_status}</span><span>{docListFor("supplier_bill", b.id).length} document(s)</span><button onClick={() => fromBill(b)}>Create PV Draft</button></article>)}</section></section>;

    if (mode === "recurring") return <section className="grid two"><form onSubmit={saveRecurring} className="panel"><h2>Recurring Obligation</h2><label>Entity<select value={recurringForm.entity_id || ""} onChange={(e) => setRecurringForm({ ...recurringForm, entity_id: e.target.value, supplier_id: "" })}>{entities.map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}</select></label><label>Supplier<select value={recurringForm.supplier_id || ""} onChange={(e) => setRecurringForm({ ...recurringForm, supplier_id: e.target.value })}><option value="">Choose</option>{validSuppliers(recurringForm.entity_id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>{validSuppliers(recurringForm.entity_id).length === 0 && <p className="help">No active suppliers for this entity. Create a supplier first.</p>}<label>Description<input value={recurringForm.description || ""} onChange={(e) => setRecurringForm({ ...recurringForm, description: e.target.value })} /></label><label>Expected amount<input type="number" step="0.01" value={recurringForm.expected_amount || ""} onChange={(e) => setRecurringForm({ ...recurringForm, expected_amount: e.target.value })} /></label><label>Due day<input type="number" value={recurringForm.due_day || 1} onChange={(e) => setRecurringForm({ ...recurringForm, due_day: e.target.value })} /></label><label>Start<input type="date" value={recurringForm.start_date || today()} onChange={(e) => setRecurringForm({ ...recurringForm, start_date: e.target.value })} /></label><label>Required doc<select value={recurringForm.required_document_type} onChange={(e) => setRecurringForm({ ...recurringForm, required_document_type: e.target.value })}>{documentTypes.map((x) => <option key={x}>{x}</option>)}</select></label><label>Reminder days<input type="number" value={recurringForm.reminder_days || 3} onChange={(e) => setRecurringForm({ ...recurringForm, reminder_days: e.target.value })} /></label><button>Save Recurring Obligation</button></form><section className="panel"><div className="actions"><h2>Monthly Drafts</h2><button onClick={generateDrafts}>Generate Monthly Drafts</button></div>{recurring.length === 0 ? <div className="empty">Nothing to show.</div> : recurring.map((r) => <article key={r.id} className="list-row"><strong>{r.is_demo ? "DEMO - " : ""}{supplierName(r.supplier_id)}</strong><span>{r.description} - due day {r.due_day}</span><span>{money(r.expected_amount)}</span></article>)}</section></section>;

    if (mode === "vouchers") return <section className="grid two"><form onSubmit={saveVoucher} className="panel"><h2>Create Manual Voucher</h2><label>Entity<select value={voucherForm.entity_id || ""} onChange={(e) => setVoucherForm({ ...voucherForm, entity_id: e.target.value })}>{entities.map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}</select></label><label>Voucher date<input type="date" value={voucherForm.voucher_date || today()} onChange={(e) => setVoucherForm({ ...voucherForm, voucher_date: e.target.value })} /></label><label>Payee<input value={voucherForm.payee_name || ""} onChange={(e) => setVoucherForm({ ...voucherForm, payee_name: e.target.value })} /></label><label>Payee bank details<textarea value={voucherForm.payee_bank_details || ""} onChange={(e) => setVoucherForm({ ...voucherForm, payee_bank_details: e.target.value })} /></label><label>Voucher source<select value={voucherForm.voucher_source || "manual"} onChange={(e) => setVoucherForm({ ...voucherForm, voucher_source: e.target.value })}><option>manual</option><option>supplier_bill</option><option>recurring_obligation</option></select></label><label>Recurring obligation<select value={voucherForm.recurring_obligation_id || ""} onChange={(e) => setVoucherForm({ ...voucherForm, recurring_obligation_id: e.target.value })}><option value="">Optional</option>{recurring.map((r) => <option key={r.id} value={r.id}>{supplierName(r.supplier_id)} - {r.description}</option>)}</select></label><label>Paying bank account<select value={voucherForm.paying_bank_account_id || ""} onChange={(e) => setVoucherForm({ ...voucherForm, paying_bank_account_id: e.target.value })}><option value="">Choose</option>{banks.filter((b) => b.entity_id === voucherForm.entity_id).map((b) => <option key={b.id} value={b.id}>{b.account_name}</option>)}</select></label><label>Payment method<input value={voucherForm.payment_method || ""} onChange={(e) => setVoucherForm({ ...voucherForm, payment_method: e.target.value })} /></label><label>Payment reference<input value={voucherForm.payment_reference || ""} onChange={(e) => setVoucherForm({ ...voucherForm, payment_reference: e.target.value })} /></label><label>Purpose<input value={voucherForm.purpose || ""} onChange={(e) => setVoucherForm({ ...voucherForm, purpose: e.target.value })} /></label>{voucherForm.items.map((item: Row, i: number) => <div className="itemrow" key={i}><input placeholder="Item description" value={item.description || ""} onChange={(e) => setVoucherItem(i, "description", e.target.value)} /><select value={item.expense_category_id || ""} onChange={(e) => setVoucherItem(i, "expense_category_id", e.target.value)}><option value="">Category</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select><input type="number" step="0.01" placeholder="Amount" value={item.amount || ""} onChange={(e) => setVoucherItem(i, "amount", e.target.value)} /></div>)}<button type="button" onClick={() => setVoucherForm({ ...voucherForm, items: [...voucherForm.items, { description: "", amount: "" }] })}>Add Item</button><strong>Total: {money(voucherForm.items.reduce((sum: number, item: Row) => sum + Number(item.amount || 0), 0))}</strong><label>Remarks<textarea value={voucherForm.remarks || ""} onChange={(e) => setVoucherForm({ ...voucherForm, remarks: e.target.value })} /></label><button>Save Draft Voucher</button></form><section className="panel"><h2>Create From Bill</h2>{bills.length === 0 ? <div className="empty">No supplier bills are available. You may create a manual payment voucher.</div> : bills.map((b) => <article key={b.id} className="list-row"><strong>{billLabel(b)}</strong><span>{entityCode(b.entity_id)} due {b.due_date || "not set"}</span><button onClick={() => fromBill(b)}>Review Draft</button></article>)}<h2>Payment Vouchers</h2>{vouchers.length === 0 ? <div className="empty">No payment vouchers yet.</div> : vouchers.map((v) => <article key={v.id} className="list-row"><strong>{v.is_demo ? "DEMO - " : ""}{v.voucher_number || "Draft voucher"}</strong><span>{v.payee_name} - {money(v.total_amount)} - {v.status}</span><span>{voucherItems.filter((i) => i.payment_voucher_id === v.id).map((i) => `${i.description} ${categoryName(i.expense_category_id)}`).join("; ")}</span><div className="actions">{v.status === "draft" && <button onClick={() => issueVoucher(v.id)}>Issue Voucher</button>}<button onClick={() => window.print()}>Print / Save PDF</button></div></article>)}</section></section>;

    if (mode === "documents") { const records = recordsForDocument(); return <section className="grid two"><form className="panel" onSubmit={(e) => { e.preventDefault(); void uploadDocuments(previewFiles, documentForm); }}><h2>Upload Documents</h2><p className="help">The normal invoice workflow starts from Supplier Bills. This library is for secondary uploads and document review.</p><label>Entity<select value={documentForm.entity_id || ""} onChange={(e) => setDocumentForm({ ...documentForm, entity_id: e.target.value, linked_record_id: "" })}>{entities.map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}</select></label><label>Document type<select value={documentForm.document_type} onChange={(e) => setDocumentForm({ ...documentForm, document_type: e.target.value })}>{documentTypes.map((x) => <option key={x}>{x}</option>)}</select></label><label>Linked type<select value={documentForm.linked_record_type} onChange={(e) => setDocumentForm({ ...documentForm, linked_record_type: e.target.value, linked_record_id: "" })}>{linkedTypes.map((x) => <option key={x}>{x}</option>)}</select></label><label>Record<select value={documentForm.linked_record_id || ""} onChange={(e) => setDocumentForm({ ...documentForm, linked_record_id: e.target.value })}><option value="">Choose</option>{records.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select></label>{records.length === 0 && <p className="help">No {documentForm.linked_record_type.replaceAll("_", " ")} records available. Create the required record first.</p>}<div className="actions"><Link className="button" href={documentForm.linked_record_type === "supplier_bill" ? "/bills" : documentForm.linked_record_type === "payment_voucher" ? "/payment-vouchers" : "/recurring"}>Create Required Record</Link></div><label>Desktop files<input type="file" multiple accept="application/pdf,image/jpeg,image/png" onChange={(e) => chooseFiles(e.target.files)} /></label><label>Phone camera on supported mobile devices<input type="file" accept="image/*" capture="environment" onChange={(e) => chooseFiles(e.target.files)} /></label>{previewFiles.length > 0 && <div className="empty">Selected: {previewFiles.map((f) => f.name).join(", ")}</div>}<button disabled={!documentForm.linked_record_id || !previewFiles.length || uploading}>{uploading ? "Uploading..." : "Upload Documents"}</button></form><section className="panel"><h2>Documents</h2>{documents.length === 0 ? <div className="empty">No documents yet.</div> : documents.map((d) => <article key={d.id} className="list-row"><strong>{d.is_demo ? "DEMO - " : ""}{d.original_filename}</strong><span>{d.document_type} - {Math.round(Number(d.file_size || 0) / 1024)} KB</span><button onClick={() => downloadDocument(d)}>Download / Preview</button></article>)}</section></section>; }

    return <section className="panel"><h2>Missing-document tracking</h2><div className="checkgrid"><div>Supplier bills with no invoice<strong>{bills.filter((b) => !docListFor("supplier_bill", b.id).some((d) => d.document_type === "supplier_invoice")).length}</strong></div><div>Recurring obligations with no payment voucher<strong>{recurring.filter((r) => !vouchers.some((v) => v.recurring_obligation_id === r.id)).length}</strong></div><div>Paid bills with no payment slip<strong>{bills.filter((b) => b.payment_status === "paid" && !docListFor("supplier_bill", b.id).some((d) => d.document_type === "payment_slip")).length}</strong></div><div>Partial evidence<strong>{bills.filter((b) => b.support_status === "partial_evidence").length}</strong></div><div>Not applicable<strong>{bills.filter((b) => b.support_status === "not_applicable").length}</strong></div><div>Incomplete for audit<strong>{bills.filter((b) => ["no_document", "partial_evidence"].includes(b.support_status)).length}</strong></div></div></section>;
  };

  return <main className="page-shell"><nav className="shortcut-bar">{nav.map((item) => <Link key={item.href} className={item.mode === mode ? "active" : ""} href={item.href}>{item.label}</Link>)}</nav><section className="page-hero"><div><span className="eyebrow">PHASE 2</span><h1>{pageTitles[mode]}</h1></div><div className="hero-stats"><strong>{stats.bills} bills</strong><strong>{stats.due} due soon</strong><strong>{stats.docs} docs</strong></div><div className="user-chip"><span>{userEmail}</span><strong>{userRole}</strong></div></section><div className="status-bar"><span>{status}</span><div className="actions"><label className="inline"><input type="checkbox" checked={showDemo} onChange={(e) => setShowDemo(e.target.checked)} /> DEMO view</label><button onClick={load}>Refresh</button></div></div>{body()}</main>;
}
