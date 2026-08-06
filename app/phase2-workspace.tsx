"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { ActionGroup, DetailDrawer, FieldValue, MoreActions, PageTabs, StatusBadge } from "@/app/ui-v2";

type Row = Record<string, any>;
type Mode = "suppliers" | "bills" | "recurring" | "vouchers" | "documents" | "missing";

const today = new Date().toISOString().slice(0, 10);
const money = (n: any) => `MYR ${Number(n || 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const docTypes = ["supplier_invoice", "receipt", "payment_slip", "payment_voucher", "quotation", "contract", "payroll_support", "claim_receipt", "tax_invoice", "ticket", "booking_confirmation", "mileage_route_screenshot", "redacted_card_statement", "claim_payment_proof", "other"];
const linkTypes = ["supplier_bill", "payment_voucher", "bill_payment", "recurring_obligation", "claim", "claim_line"];
const emptySupplier = { id: "", supplier_name: "", registration_number: "", contact_person: "", email: "", phone: "", bank_details_text: "", default_expense_category: "", default_description: "", account_code: "", remarks: "", active_status: true, entity_ids: [] as string[] };
const emptyBill = { entity_id: "", supplier_id: "", description: "", bill_number: "", bill_type: "supplier_invoice", bill_date: today, due_date: today, subtotal: "", tax_amount: "0", total_amount: "", payment_status: "unpaid", expense_category_id: "", remarks: "" };
const emptyVoucher = { id: "", entity_id: "", supplier_id: "", voucher_date: today, payee: "", payee_bank_details_text: "", purpose: "", voucher_source: "manual", recurring_obligation_id: "", paying_bank_account_id: "", payment_method: "bank_transfer", bank_reference: "", remarks: "" };
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
  const [claims, setClaims] = useState<Row[]>([]);
  const [profiles, setProfiles] = useState<Row[]>([]);
  const [claimLines, setClaimLines] = useState<Row[]>([]);
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
    const [e, se, s, c, ba, b, r, v, vi, p, d, l, cl, cli, pr] = await Promise.all([
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
      db.from("claims").select("*").eq("is_demo", showDemo).order("created_at", { ascending: false }),
      db.from("claim_lines").select("*").order("sort_order"),
      db.from("app_profiles").select("id, display_name, email").eq("active_status", true),
    ]);
    const firstError = e.error || se.error || s.error || c.error || ba.error || b.error || r.error || v.error || vi.error || p.error || d.error || l.error;
    if (firstError) { setError(firstError.message); setMessage("Phase 2 migration 0005 may need to be applied."); return; }
    setEntities(e.data ?? []); setSupplierEntities(se.data ?? []); setSuppliers(s.data ?? []); setCategories(c.data ?? []); setBanks(ba.data ?? []); setBills(b.data ?? []); setRecurring(r.data ?? []); setVouchers(v.data ?? []); setItems(vi.data ?? []); setPayments(p.data ?? []); setDocs(d.data ?? []); setLinks(l.data ?? []); setClaims(cl.error ? [] : (cl.data ?? [])); setClaimLines(cli.error ? [] : (cli.data ?? [])); setProfiles(pr.error ? [] : (pr.data ?? []));
    const entity = e.data?.[0]?.id ?? "";
    setBill((x) => ({ ...x, entity_id: x.entity_id || entity })); setObligation((x) => ({ ...x, entity_id: x.entity_id || entity })); setVoucher((x) => ({ ...x, entity_id: x.entity_id || entity })); setUpload((x) => ({ ...x, entity_id: x.entity_id || entity }));
    setMessage(showDemo ? "Showing DEMO records only." : "Ready. DEMO records are hidden by default.");
  }

  const title = { suppliers: "Suppliers", bills: "Supplier Bills", recurring: "Recurring Obligations", vouchers: "Payment Vouchers", documents: "Documents", missing: "Missing Documents" }[mode];
  const description = { suppliers: "Maintain payees, contact details and payment defaults.", bills: "Capture supplier bills and supporting evidence before payment preparation.", recurring: "Maintain regular obligations and generate monthly draft records.", vouchers: "Prepare, issue, print and audit payment vouchers without replacing SQL Accounting.", documents: "Upload and review private supporting documents linked to operational records.", missing: "Find evidence gaps that need finance follow-up before audit review." }[mode];
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
    if (type === "claim") return claims.filter((claim) => claim.entity_id === entityId).map((claim) => ({ id: claim.id, name: `${claim.claim_number || "Draft"} - ${claim.claimant_name}` }));
    if (type === "claim_line") return claimLines.filter((line) => line.entity_id === entityId).map((line) => ({ id: line.id, name: line.description }));
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
    const payload = { entity_id: voucher.entity_id, supplier_id: voucher.supplier_id || null, voucher_date: voucher.voucher_date, payee: voucher.payee, payee_bank_details: voucher.payee_bank_details_text ? { notes: voucher.payee_bank_details_text } : {}, purpose: voucher.purpose, voucher_source: voucher.voucher_source, recurring_obligation_id: voucher.recurring_obligation_id || null, paying_bank_account_id: voucher.paying_bank_account_id || null, payment_method: voucher.payment_method || null, bank_reference: voucher.bank_reference || null, remarks: voucher.remarks || null, total_amount: total };
    const res = voucher.id
      ? await db.from("payment_vouchers").update(payload).eq("id", voucher.id).eq("status", "draft").select("id").single()
      : await db.from("payment_vouchers").insert({ ...payload, status: "draft", is_demo: false, data_origin: "manual" }).select("id").single();
    if (res.error) { setError(res.error.message); return; }
    if (voucher.id) await db.from("payment_voucher_items").delete().eq("payment_voucher_id", voucher.id);
    const itemRes = await db.from("payment_voucher_items").insert(validItems.map((i, index) => ({ payment_voucher_id: res.data.id, supplier_bill_id: i.supplier_bill_id || null, recurring_obligation_id: i.recurring_obligation_id || null, expense_category_id: i.expense_category_id || null, description: i.description, amount: Number(i.amount), sort_order: index + 1, is_demo: false, data_origin: "manual" })));
    if (itemRes.error) { setError(itemRes.error.message); return; }
    setVoucher({ ...emptyVoucher, entity_id: voucher.entity_id }); setVoucherItems([{ ...emptyItem }]); setMessage(voucher.id ? "Voucher draft updated. Issue only when final." : "Voucher draft saved. Issue only when final."); await load();
  }

  function editVoucher(row: Row) {
    if (row.status !== "draft") return;
    setVoucher({ ...emptyVoucher, ...row, payee_bank_details_text: row.payee_bank_details?.notes ?? "", supplier_id: row.supplier_id || "", recurring_obligation_id: row.recurring_obligation_id || "", paying_bank_account_id: row.paying_bank_account_id || "" });
    const rows = items.filter((item) => item.payment_voucher_id === row.id);
    setVoucherItems(rows.length ? rows.map((item) => ({ ...item, amount: String(item.amount ?? "") })) : [{ ...emptyItem }]);
    setMessage(`Editing draft ${row.voucher_number || "voucher"}.`);
    window.scrollTo({ top: 0, behavior: "smooth" });
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

  async function deleteVoucher(row: Row) {
    if (row.status !== "draft") { setError("Only draft vouchers can be deleted."); return; }
    if (!window.confirm(`Delete draft voucher for ${row.payee}? This cannot be undone.`)) return;
    setError("");
    const res = await fetch("/api/payment-vouchers/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voucherId: row.id }) });
    const json = await res.json();
    if (!res.ok) setError(json.error || "Voucher could not be deleted."); else { setMessage("Draft voucher deleted. Issued voucher numbering was not affected."); await load(); }
  }

  async function voidVoucher(row: Row) {
    if (!["issued", "paid"].includes(row.status)) { setError("Only an issued voucher can be voided or cancelled."); return; }
    const reason = window.prompt("Reason for voiding or cancelling this issued voucher:");
    if (!reason?.trim()) { setError("A cancellation reason is required."); return; }
    setError("");
    const res = await fetch("/api/payment-vouchers/void", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voucherId: row.id, reason }) });
    const json = await res.json();
    if (!res.ok) setError(json.error || "Voucher could not be voided or cancelled."); else { setMessage(`${row.voucher_number || "Voucher"} is now Void / Cancelled and remains in the audit trail.`); await load(); }
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
  const missingClaimEvidence = claimLines.filter((line) => line.requires_receipt && line.document_status === "missing");

  return <main className="page-shell"><div className="shortcut-bar"><Link href="/suppliers">Suppliers</Link><Link href="/bills">Bills</Link><Link href="/recurring">Recurring</Link><Link href="/payment-vouchers">Payment Vouchers</Link><Link href="/documents">Documents</Link><Link href="/missing-documents">Missing Documents</Link></div><section className="page-hero"><div><span className="eyebrow">Finance Operations</span><h1>{title}</h1><p className="subtitle">{description}</p></div><div className="hero-stats"><strong>{bills.length} bills</strong><strong>{bills.filter((b) => b.due_date <= today && b.payment_status !== "paid").length} due soon</strong><strong>{docs.length} docs</strong></div></section><div className="status-bar"><span>{error || message}</span><span className="actions"><label className="inline"><input type="checkbox" checked={showDemo} onChange={(e) => setShowDemo(e.target.checked)} /> DEMO view</label><button className="neutral" onClick={() => void load()}>Refresh</button></span></div>
    {mode === "suppliers" && <section className="grid"><Panel title="Supplier / Payee"><SupplierForm supplier={supplier} setSupplier={setSupplier} save={saveSupplier} entities={entities} categories={categories} /></Panel><Panel title="Supplier List" action={<span className="actions"><button onClick={() => void demoAction("load")}>Load Phase 2 Demo Data</button><button onClick={() => void demoAction("remove")}>Remove Phase 2 Demo Data</button></span>}><SupplierTable rows={suppliers} entities={entities} supplierEntities={supplierEntities} setSupplier={setSupplier} toggleSupplier={toggleSupplier} /></Panel></section>}
    {mode === "bills" && <BillsWorkspaceV21 billId={billId} bills={bills} bill={bill} setBill={setBill} entities={entities} suppliers={suppliers} selectedSuppliers={selectedSuppliers} categories={categories} billFiles={billFiles} setBillFiles={setBillFiles} uploading={uploading} onSaveBill={saveBill} voucher={voucher} setVoucher={setVoucher} voucherItems={voucherItems} setVoucherItems={setVoucherItems} recurring={recurring} banks={banks} onSaveVoucher={saveVoucherDraft} onFromBill={createFromBill} payment={payment} setPayment={setPayment} onSavePayment={savePayment} vouchers={vouchers} docs={docs} links={links} />}
    {mode === "recurring" && <section className="grid"><Panel title="Recurring Obligation"><RecurringForm obligation={obligation} setObligation={setObligation} save={saveRecurring} entities={entities} suppliers={activeSuppliers(obligation.entity_id)} /></Panel><Panel title="Monthly Drafts" action={<button onClick={generateDrafts}>Generate Monthly Drafts</button>}>{!recurring.length ? <div className="empty">Nothing to show.</div> : recurring.map((r) => <div key={r.id} className="list-row"><b>{r.description}</b><span>{supplierName(r.supplier_id)} - day {r.due_day} - {money(r.expected_amount)}</span></div>)}</Panel></section>}
    {mode === "vouchers" && <VoucherWorkspaceV2 vouchers={vouchers} voucher={voucher} setVoucher={setVoucher} voucherItems={voucherItems} setVoucherItems={setVoucherItems} items={items} entities={entities} suppliers={suppliers} activeSuppliers={activeSuppliers} categories={categories} bills={bills} recurring={recurring} banks={banks} docs={docs} links={links} profiles={profiles} onSave={saveVoucherDraft} onIssue={issueVoucher} onEdit={editVoucher} onDelete={deleteVoucher} onVoid={voidVoucher} onFromBill={createFromBill} />}
    {mode === "documents" && <section className="grid"><Panel title="Upload Documents"><form onSubmit={uploadLibrary}><p className="wide help">The normal invoice workflow starts from Supplier Bills. This library is for secondary uploads and document review.</p><Select label="Entity" value={upload.entity_id} onChange={(v: string) => setUpload({ ...upload, entity_id: v, linked_record_id: "" })} rows={entities} /><label>Document type<select value={upload.document_type} onChange={(e) => setUpload({ ...upload, document_type: e.target.value })}>{docTypes.map((x) => <option key={x}>{x}</option>)}</select></label><label>Linked type<select value={upload.linked_record_type} onChange={(e) => setUpload({ ...upload, linked_record_type: e.target.value, linked_record_id: "" })}>{linkTypes.map((x) => <option key={x}>{x}</option>)}</select></label><Select label="Record" value={upload.linked_record_id} onChange={(v: string) => setUpload({ ...upload, linked_record_id: v })} rows={recordRows} required={false} empty="Choose" />{!recordRows.length && <p className="wide help">No {upload.linked_record_type.replaceAll("_", " ")} records available. Create the required record first.</p>}<Link href={upload.linked_record_type === "payment_voucher" ? "/payment-vouchers" : upload.linked_record_type === "recurring_obligation" ? "/recurring" : "/bills"}>Create required record</Link><label className="wide">Desktop files<input type="file" multiple accept="application/pdf,image/jpeg,image/png,image/*" onChange={(e) => setLibraryFiles(Array.from(e.target.files ?? []))} /></label><label className="wide">Phone camera - supported mobile devices only<input type="file" accept="image/*" capture="environment" onChange={(e) => setLibraryFiles([...(libraryFiles ?? []), ...Array.from(e.target.files ?? [])])} /></label><FilePreview files={libraryFiles} /><button disabled={uploading || !libraryFiles.length || !upload.linked_record_id}>{uploading ? "Uploading..." : "Upload Documents"}</button></form></Panel><Panel title="Documents">{docs.map((d) => <div key={d.id} className="list-row"><b><Demo row={d} />{d.original_filename}</b><span>{d.document_type} - {Math.round(Number(d.file_size || 0) / 1024)} KB</span><button onClick={() => void downloadDoc(d.id)}>Preview / Download</button></div>)}</Panel></section>}
    {mode === "missing" && <section className="grid"><Panel title="Missing-document tracking"><div className="checkgrid"><Metric label="Bills with no invoice" value={bills.filter((b) => !docsFor("supplier_bill", b.id).includes(".")).length} /><Metric label="Recurring without voucher" value={recurring.filter((r) => !vouchers.some((v) => v.recurring_obligation_id === r.id)).length} /><Metric label="Paid bills without slip" value={bills.filter((b) => b.payment_status === "paid" && !docsFor("supplier_bill", b.id).includes("payment")).length} /><Metric label="Claim evidence gaps" value={missingClaimEvidence.length} /><Metric label="Partial evidence" value={bills.filter((b) => b.supporting_document_status === "partial_evidence").length} /><Metric label="Not applicable" value={bills.filter((b) => b.supporting_document_status === "not_applicable").length} /><Metric label="Incomplete for audit" value={missing.length + missingClaimEvidence.length} /></div></Panel><Panel title="Claims missing evidence">{missingClaimEvidence.length ? <table><thead><tr><th>Claim</th><th>Line</th><th>Evidence needed</th><th /></tr></thead><tbody>{missingClaimEvidence.map((line) => { const claim = claims.find((item) => item.id === line.claim_id); return <tr key={line.id}><td>{claim?.claim_number || "Draft"}<br />{claim?.claimant_name}</td><td>{line.description}</td><td>{line.line_type === "mileage" ? "Route screenshot" : line.line_type === "accommodation" ? "Hotel invoice / receipt" : line.line_type === "credit_card_transaction" ? "Receipt or redacted statement" : "Receipt"}</td><td><Link href={`/claims/${line.claim_id}`}>Open claim</Link></td></tr>; })}</tbody></table> : <div className="empty">No claim evidence gaps.</div>}</Panel></section>}
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

type BillTab = "list" | "create" | "voucher";

function BillsWorkspaceV21(props: Row) {
  const { billId, bills, bill, setBill, entities, suppliers, selectedSuppliers, categories, billFiles, setBillFiles, uploading, onSaveBill, voucher, setVoucher, voucherItems, setVoucherItems, recurring, banks, onSaveVoucher, onFromBill, payment, setPayment, onSavePayment, vouchers, docs, links } = props;
  const [tab, setTab] = useState<BillTab>("list");
  const [selected, setSelected] = useState<Row | null>(null);
  const awaiting = bills.filter((row: Row) => !["paid", "cancelled"].includes(row.payment_status));

  useEffect(() => {
    if (!billId || !bills.length) return;
    const match = bills.find((row: Row) => row.id === billId);
    if (match) setSelected(match);
  }, [billId, bills]);

  function beginVoucher(row: Row) {
    onFromBill(row);
    setTab("voucher");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return <section>
    <div className="section-heading">
      <div><h2>Bills workspace</h2><p className="help">Use the list first. Open bill entry or payment preparation only when needed.</p></div>
      <button type="button" className="primary primary-action" onClick={() => setTab("create")}>+ New Bill</button>
    </div>
    <PageTabs tabs={[{ id: "list", label: "Bill List", count: bills.length }, { id: "create", label: "Create Bill" }, { id: "voucher", label: "Create PV Draft", count: awaiting.length }]} active={tab} onChange={(id) => setTab(id as BillTab)} label="Bill workspace views" />

    {tab === "list" && <BillListV21 rows={bills} suppliers={suppliers} entities={entities} onView={setSelected} onVoucher={beginVoucher} />}
    {tab === "create" && <Panel title="Create Supplier Bill"><BillForm bill={bill} setBill={setBill} save={onSaveBill} entities={entities} suppliers={selectedSuppliers} categories={categories} files={billFiles} setFiles={setBillFiles} uploading={uploading} /></Panel>}
    {tab === "voucher" && <>
      <Panel title="Bills Awaiting Payment">
        {!awaiting.length ? <div className="empty">No unpaid bills are awaiting payment.</div> : <BillListV21 rows={awaiting} suppliers={suppliers} entities={entities} onView={setSelected} onVoucher={beginVoucher} />}
      </Panel>
      <Panel title="Payment Voucher Draft">
        <p className="form-note">Choose a bill above to prefill the draft, or enter a manual voucher. The voucher remains a draft until issued from Payment Vouchers.</p>
        <VoucherForm voucher={voucher} setVoucher={setVoucher} items={voucherItems} setItems={setVoucherItems} save={onSaveVoucher} entities={entities} suppliers={suppliers.filter((row: Row) => row.active_status)} categories={categories} bills={bills} recurring={recurring} bankAccounts={banks} onCancel={() => { setVoucher({ ...emptyVoucher, entity_id: voucher.entity_id }); setVoucherItems([{ ...emptyItem }]); setTab("list"); }} />
        <details className="advanced-section"><summary>Record an existing bill payment</summary><div className="advanced-section-body"><PaymentForm payment={payment} setPayment={setPayment} save={onSavePayment} bills={bills} vouchers={vouchers} /></div></details>
      </Panel>
    </>}

    <DetailDrawer open={Boolean(selected)} title={selected?.description || "Bill details"} subtitle={selected?.bill_number || "No bill number"} onClose={() => setSelected(null)} footer={selected && <ActionGroup><button type="button" className="primary" onClick={() => { beginVoucher(selected); setSelected(null); }}>Create PV Draft</button><button type="button" className="neutral" onClick={() => setSelected(null)}>Close</button></ActionGroup>}>
      {selected && <><div className="detail-grid"><FieldValue label="Entity">{entities.find((row: Row) => row.id === selected.entity_id)?.short_code}</FieldValue><FieldValue label="Supplier">{suppliers.find((row: Row) => row.id === selected.supplier_id)?.supplier_name}</FieldValue><FieldValue label="Bill date">{selected.bill_date}</FieldValue><FieldValue label="Due date">{selected.due_date}</FieldValue><FieldValue label="Total">{money(selected.total_amount)}</FieldValue><FieldValue label="Outstanding">{money(selected.outstanding_amount)}</FieldValue><FieldValue label="Status"><StatusBadge status={selected.payment_status} /></FieldValue><FieldValue label="Evidence">{selected.supporting_document_status}</FieldValue></div><section className="detail-section"><h3>Remarks</h3><p>{selected.remarks || "No remarks."}</p></section><section className="detail-section"><h3>Linked documents</h3><p>{links.filter((link: Row) => link.linked_record_type === "supplier_bill" && link.linked_record_id === selected.id).map((link: Row) => docs.find((doc: Row) => doc.id === link.document_id)?.original_filename).filter(Boolean).join(", ") || "No linked documents."}</p></section></>}
    </DetailDrawer>
  </section>;
}

function BillListV21({ rows, suppliers, entities, onView, onVoucher }: Row) {
  if (!rows.length) return <div className="empty">No supplier bills match this view.</div>;
  return <div className="record-list bill-record-list">
    <div className="record-list-head"><span>Bill</span><span>Supplier / Entity</span><span>Amount / Due</span><span>Status</span><span>Actions</span></div>
    {rows.map((row: Row) => <div className="record-row" key={row.id}><div className="record-row-main bill-list-row">
      <div className="record-primary"><strong>{row.description}</strong><span>{row.bill_number || "No bill number"}</span></div>
      <div className="record-primary"><strong>{suppliers.find((supplier: Row) => supplier.id === row.supplier_id)?.supplier_name || "No supplier"}</strong><span>{entities.find((entity: Row) => entity.id === row.entity_id)?.short_code || "No entity"}</span></div>
      <div className="record-primary"><strong className="record-money">{money(row.total_amount)}</strong><span>Due {row.due_date || "not set"}</span></div>
      <StatusBadge status={row.payment_status} />
      <ActionGroup><button type="button" className="neutral" onClick={() => onView(row)}>View</button>{!["paid", "cancelled"].includes(row.payment_status) && <button type="button" className="primary" onClick={() => onVoucher(row)}>Create PV Draft</button>}</ActionGroup>
    </div></div>)}
  </div>;
}

type VoucherTab = "list" | "create" | "bills" | "cancelled";

function VoucherWorkspaceV2(props: Row) {
  const { vouchers, voucher, setVoucher, voucherItems, setVoucherItems, items, entities, suppliers, activeSuppliers, categories, bills, recurring, banks, docs, links, profiles, onSave, onIssue, onEdit, onDelete, onVoid, onFromBill } = props;
  const [tab, setTab] = useState<VoucherTab>("list");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<Row | null>(null);
  const cancelled = vouchers.filter((row: Row) => row.status === "cancelled");
  const active = vouchers.filter((row: Row) => row.status !== "cancelled");
  const awaitingBills = bills.filter((row: Row) => !["paid", "cancelled"].includes(row.payment_status));
  const sourceRows = tab === "cancelled" ? cancelled : active;
  const visibleRows = sourceRows.filter((row: Row) => {
    const text = `${row.voucher_number || "draft"} ${row.payee || ""} ${row.purpose || ""}`.toLowerCase();
    return (!query.trim() || text.includes(query.trim().toLowerCase())) && (!status || row.status === status);
  });
  const tabs = [
    { id: "list", label: "Voucher List", count: active.length },
    { id: "create", label: voucher.id ? "Edit Voucher" : "Create Voucher" },
    { id: "bills", label: "Bills Awaiting Payment", count: awaitingBills.length },
    { id: "cancelled", label: "Cancelled / Archived", count: cancelled.length },
  ];
  const selectedItems = selected ? items.filter((item: Row) => item.payment_voucher_id === selected.id) : [];

  function edit(row: Row) { onEdit(row); setTab("create"); window.scrollTo({ top: 0, behavior: "smooth" }); }
  function fromBill(row: Row) { onFromBill(row); setTab("create"); window.scrollTo({ top: 0, behavior: "smooth" }); }
  function cancelForm() { setVoucher({ ...emptyVoucher, entity_id: voucher.entity_id }); setVoucherItems([{ ...emptyItem }]); setTab("list"); }

  return <section>
    <div className="section-heading">
      <div><h2>Voucher workspace</h2><p className="help">Start from the list, then open only the task you need.</p></div>
      <button type="button" className="primary primary-action" onClick={() => { cancelForm(); setTab("create"); }}>+ New Voucher</button>
    </div>
    <div className="compact-kpis">
      <span className="kpi-chip">Draft <strong>{vouchers.filter((row: Row) => row.status === "draft").length}</strong></span>
      <span className="kpi-chip">Issued <strong>{vouchers.filter((row: Row) => row.status === "issued").length}</strong></span>
      <span className="kpi-chip">Void / Cancelled <strong>{cancelled.length}</strong></span>
      <span className="kpi-chip">Awaiting bills <strong>{awaitingBills.length}</strong></span>
    </div>
    <PageTabs tabs={tabs} active={tab} onChange={(id) => setTab(id as VoucherTab)} label="Payment voucher views" />

    {(tab === "list" || tab === "cancelled") && <>
      <div className="sticky-toolbar">
        <div className="toolbar-fields">
          <label>Search vouchers<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Voucher no, payee or purpose" /></label>
          <label className="compact">Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option>{["draft", "pending", "approved", "issued", "paid", "cancelled", "archived"].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label>
        </div>
        <button type="button" className="neutral" onClick={() => { setQuery(""); setStatus(""); }}>Reset</button>
      </div>
      <VoucherListV2 rows={visibleRows} items={items} entities={entities} categories={categories} docs={docs} links={links} profiles={profiles} onIssue={onIssue} onEdit={edit} onDelete={onDelete} onVoid={onVoid} onView={setSelected} />
    </>}

    {tab === "create" && <Panel title={voucher.id ? `Edit Draft ${voucher.voucher_number || "Voucher"}` : "Create Voucher"}>
      <VoucherForm voucher={voucher} setVoucher={setVoucher} items={voucherItems} setItems={setVoucherItems} save={onSave} entities={entities} suppliers={activeSuppliers(voucher.entity_id)} categories={categories} bills={bills} recurring={recurring} bankAccounts={banks} onCancel={cancelForm} />
    </Panel>}

    {tab === "bills" && <Panel title="Bills Awaiting Payment">
      {!awaitingBills.length ? <div className="empty">No unpaid bills are awaiting payment.</div> : <div className="record-list">
        {awaitingBills.map((bill: Row) => <div className="record-row" key={bill.id}><div className="record-row-main bills-record-row">
          <div className="record-primary"><strong>{bill.description}</strong><span>{bill.bill_number || "No bill number"}</span></div>
          <div>{suppliers.find((row: Row) => row.id === bill.supplier_id)?.supplier_name || "No supplier"}</div>
          <div className="record-secondary">Due {bill.due_date}</div>
          <div className="record-money">{money(bill.outstanding_amount || bill.total_amount)}</div>
          <ActionGroup><button type="button" className="primary" onClick={() => fromBill(bill)}>Create PV Draft</button><Link className="action-button neutral" href={`/bills/${bill.id}`}>View Bill</Link></ActionGroup>
        </div></div>)}
      </div>}
    </Panel>}

    <DetailDrawer open={Boolean(selected)} title={selected?.voucher_number || "Draft Voucher"} subtitle={selected ? `${selected.payee} · ${money(selected.total_amount)}` : undefined} onClose={() => setSelected(null)} footer={selected && <ActionGroup>{selected.status === "draft" && <button type="button" className="primary" onClick={() => { edit(selected); setSelected(null); }}>Edit Draft</button>}<button type="button" className="neutral" onClick={() => printVoucher(selected, selectedItems, entities, categories, docs, links, profiles)}>Print</button>{selected.status === "issued" && <button type="button" className="danger" onClick={() => void onVoid(selected)}>Void / Cancel Voucher</button>}</ActionGroup>}>
      {selected && <VoucherDetails voucher={selected} items={selectedItems} entities={entities} categories={categories} />}
    </DetailDrawer>
  </section>;
}

function VoucherForm({ voucher, setVoucher, items, setItems, save, entities, suppliers, categories, bills, recurring, bankAccounts, onCancel }: Row) {
  const total = items.reduce((sum: number, item: Row) => sum + Number(item.amount || 0), 0);
  return <form onSubmit={save}>
    <fieldset className="form-section"><legend>General</legend>
      <Select label="Entity" value={voucher.entity_id} onChange={(value: string) => setVoucher({ ...voucher, entity_id: value, supplier_id: "" })} rows={entities} />
      <label>Voucher date<input type="date" value={voucher.voucher_date} onChange={(event) => setVoucher({ ...voucher, voucher_date: event.target.value })} /></label>
      <label>Purpose<input value={voucher.purpose} onChange={(event) => setVoucher({ ...voucher, purpose: event.target.value })} required /></label>
      <label>Voucher source<select value={voucher.voucher_source} onChange={(event) => setVoucher({ ...voucher, voucher_source: event.target.value })}><option>manual</option><option>supplier_bill</option><option>recurring_obligation</option></select></label>
      <Select label="Recurring obligation" value={voucher.recurring_obligation_id} onChange={(value: string) => setVoucher({ ...voucher, recurring_obligation_id: value })} rows={recurring} required={false} />
    </fieldset>

    <fieldset className="form-section"><legend>Payee</legend>
      <Select label="Supplier / payee" value={voucher.supplier_id} onChange={(value: string) => { const supplier = suppliers.find((row: Row) => row.id === value); setVoucher({ ...voucher, supplier_id: value, payee: supplier?.supplier_name ?? voucher.payee, payee_bank_details_text: supplier?.bank_details?.notes ?? voucher.payee_bank_details_text }); }} rows={suppliers} required={false} />
      <label>Payee<input value={voucher.payee} onChange={(event) => setVoucher({ ...voucher, payee: event.target.value })} required /></label>
      <label className="wide">Payee bank details<textarea value={voucher.payee_bank_details_text} onChange={(event) => setVoucher({ ...voucher, payee_bank_details_text: event.target.value })} /></label>
    </fieldset>

    <fieldset className="form-section"><legend>Payment</legend>
      <Select label="Paying bank account" value={voucher.paying_bank_account_id} onChange={(value: string) => setVoucher({ ...voucher, paying_bank_account_id: value })} rows={bankAccounts} required={false} />
      <label>Payment method<input value={voucher.payment_method} onChange={(event) => setVoucher({ ...voucher, payment_method: event.target.value })} /></label>
      <label>Payment reference<input value={voucher.bank_reference} onChange={(event) => setVoucher({ ...voucher, bank_reference: event.target.value })} /></label>
      <div className="wide mini"><div className="section-heading"><b>Itemised payment rows</b><strong className="record-money">Total {money(total)}</strong></div>
        {items.map((item: Row, index: number) => <div className="itemrow" key={index}>
          <input aria-label={`Item ${index + 1} description`} placeholder="Description" value={item.description} onChange={(event) => setItems(items.map((row: Row, itemIndex: number) => itemIndex === index ? { ...row, description: event.target.value } : row))} />
          <select aria-label={`Item ${index + 1} category`} value={item.expense_category_id} onChange={(event) => setItems(items.map((row: Row, itemIndex: number) => itemIndex === index ? { ...row, expense_category_id: event.target.value } : row))}><option value="">Category</option>{categories.map((category: Row) => <option key={category.id} value={category.id}>{category.name}</option>)}</select>
          <select aria-label={`Item ${index + 1} related bill`} value={item.supplier_bill_id} onChange={(event) => setItems(items.map((row: Row, itemIndex: number) => itemIndex === index ? { ...row, supplier_bill_id: event.target.value } : row))}><option value="">Related bill</option>{bills.map((bill: Row) => <option key={bill.id} value={bill.id}>{bill.description}</option>)}</select>
          <input aria-label={`Item ${index + 1} amount`} type="number" step="0.01" placeholder="Amount" value={item.amount} onChange={(event) => setItems(items.map((row: Row, itemIndex: number) => itemIndex === index ? { ...row, amount: event.target.value } : row))} />
          <button type="button" className="danger" onClick={() => setItems(items.filter((_: Row, itemIndex: number) => itemIndex !== index))}>Remove</button>
        </div>)}
        <button type="button" className="secondary" onClick={() => setItems([...items, { ...emptyItem }])}>+ Add Item</button>
      </div>
    </fieldset>

    <details className="advanced-section"><summary>Approval, Attachments & Advanced</summary><div className="advanced-section-body">
      <p className="form-note">Approval: save the voucher as a draft first. The Issue action remains available from the voucher list once the draft is final.</p>
      <p className="form-note">Attachments: after saving, use <Link href="/documents">Documents</Link> to link invoices, payment slips, or other supporting evidence to this voucher.</p>
      <label className="wide">Remarks<textarea value={voucher.remarks} onChange={(event) => setVoucher({ ...voucher, remarks: event.target.value })} /></label>
      <p className="form-note">Audit fields such as prepared by, created time, updated time, and issued time are maintained automatically and shown in the record detail or print view.</p>
    </div></details>

    <div className="form-footer"><button type="button" className="neutral" onClick={onCancel}>Cancel</button><button type="submit" className="primary">{voucher.id ? "Update Voucher Draft" : "Save Voucher Draft"}</button></div>
  </form>;
}
function BillTable({ rows, entities, suppliers, onVoucher, docs, links }: Row) { return !rows.length ? <div className="empty">No bills yet.</div> : <table><thead><tr><th>Entity</th><th>Description</th><th>Supplier</th><th>Due</th><th>Status</th><th>Evidence</th><th>Total</th><th /></tr></thead><tbody>{rows.map((b: Row) => <tr key={b.id}><td>{entities.find((e: Row) => e.id === b.entity_id)?.short_code}</td><td><Demo row={b} /> {b.description}<br />{b.bill_number}</td><td>{suppliers.find((s: Row) => s.id === b.supplier_id)?.supplier_name}</td><td>{b.due_date}</td><td>{b.payment_status}</td><td>{b.supporting_document_status}<br />{links.filter((l: Row) => l.linked_record_type === "supplier_bill" && l.linked_record_id === b.id).map((l: Row) => docs.find((d: Row) => d.id === l.document_id)?.original_filename).filter(Boolean).join(", ")}</td><td>{money(b.total_amount)}</td><td><button onClick={() => void onVoucher(b)}>Create PV Draft</button></td></tr>)}</tbody></table>; }
function VoucherListV2({ rows, items, entities, categories, docs, links, profiles, onIssue, onEdit, onDelete, onVoid, onView }: Row) {
  if (!rows.length) return <div className="empty">No payment vouchers match this view.</div>;
  return <div className="record-list voucher-record-list">
    <div className="record-list-head"><span>Voucher No</span><span>Payee / Description</span><span>Amount</span><span>Date</span><span>Status</span><span>Actions</span></div>
    {rows.map((voucher: Row) => {
      const voucherItems = items.filter((item: Row) => item.payment_voucher_id === voucher.id);
      return <div className="record-row" key={voucher.id}><div className="record-row-main">
        <div className="record-primary"><strong><Demo row={voucher} />{voucher.voucher_number || "Draft"}</strong><span>{entities.find((entity: Row) => entity.id === voucher.entity_id)?.short_code || ""}</span></div>
        <div className="record-primary"><strong>{voucher.payee}</strong><span>{voucher.purpose || "No purpose recorded"}</span></div>
        <div className="record-money">{money(voucher.total_amount)}</div>
        <div className="record-secondary">{voucher.voucher_date}</div>
        <StatusBadge status={voucher.status} />
        <ActionGroup>
          <button type="button" className="neutral" onClick={() => onView(voucher)}>View</button>
          {voucher.status === "draft" && <>
            <button type="button" className="primary" onClick={() => onEdit(voucher)}>Edit</button>
            <MoreActions><button type="button" className="neutral" onClick={() => printVoucher(voucher, voucherItems, entities, categories, docs, links, profiles)}>Print Preview</button><button type="button" className="primary" onClick={() => void onIssue(voucher.id)}>Issue Voucher</button><button type="button" className="danger" onClick={() => void onDelete(voucher)}>Delete Draft</button></MoreActions>
          </>}
          {["issued", "paid"].includes(voucher.status) && <>
            <button type="button" className="neutral" onClick={() => printVoucher(voucher, voucherItems, entities, categories, docs, links, profiles)}>Print</button>
            <MoreActions><button type="button" className="danger" onClick={() => void onVoid(voucher)}>Void / Cancel Voucher</button></MoreActions>
          </>}
          {voucher.status === "cancelled" && <>
            <button type="button" className="neutral" onClick={() => printVoucher(voucher, voucherItems, entities, categories, docs, links, profiles)}>Print</button>
          </>}
        </ActionGroup>
      </div></div>;
    })}
  </div>;
}

function VoucherDetails({ voucher, items, entities, categories }: Row) {
  return <>
    {voucher.status === "cancelled" && <div className="notice error"><p><strong>VOID / CANCELLED</strong><br />{voucher.cancellation_reason || "Cancellation reason not available."}</p></div>}
    <div className="detail-grid">
      <FieldValue label="Status"><StatusBadge status={voucher.status} /></FieldValue>
      <FieldValue label="Entity">{entities.find((entity: Row) => entity.id === voucher.entity_id)?.short_code}</FieldValue>
      <FieldValue label="Voucher date">{voucher.voucher_date}</FieldValue>
      <FieldValue label="Total">{money(voucher.total_amount)}</FieldValue>
      <FieldValue label="Payee">{voucher.payee}</FieldValue>
      <FieldValue label="Payment method">{voucher.payment_method}</FieldValue>
      <FieldValue label="Reference">{voucher.bank_reference}</FieldValue>
      <FieldValue label="Source">{voucher.voucher_source}</FieldValue>
    </div>
    <section className="detail-section"><h3>Purpose</h3><p>{voucher.purpose || "—"}</p></section>
    <section className="detail-section"><h3>Payee bank details</h3><p>{voucher.payee_bank_details?.notes || "Not provided"}</p></section>
    <section className="detail-section"><h3>Items</h3>{items.length ? items.map((item: Row) => <div className="list-row" key={item.id}><b>{item.description}</b><span>{categories.find((category: Row) => category.id === item.expense_category_id)?.name || "Uncategorised"} · {money(item.amount)}</span></div>) : <p className="empty-state">No item rows recorded.</p>}</section>
    <section className="detail-section"><h3>Remarks</h3><p>{voucher.remarks || "No remarks."}</p></section>
  </>;
}
function printVoucher(v: Row, voucherItems: Row[], entities: Row[], categories: Row[], docs: Row[], links: Row[], profiles: Row[]) {
  const entity = entities.find((row) => row.id === v.entity_id);
  const docList = links.filter((row) => row.linked_record_type === "payment_voucher" && row.linked_record_id === v.id).map((row) => docs.find((document) => document.id === row.document_id)?.original_filename).filter(Boolean).join(", ") || "None";
  const itemRows = voucherItems.map((item) => `<tr><td>${item.description}</td><td>${categories.find((category) => category.id === item.expense_category_id)?.name ?? "-"}</td><td style="text-align:right">${money(item.amount)}</td></tr>`).join("");
  const preparedBy = profiles.find((profile: Row) => profile.id === v.prepared_by)?.display_name || profiles.find((profile: Row) => profile.id === v.prepared_by)?.email || v.prepared_by || "";
  const cancelled = v.status === "cancelled";
  const cancellationBlock = cancelled ? `<div class="void-banner">VOID / CANCELLED</div><p><b>Cancellation reason:</b> ${v.cancellation_reason || "Not recorded"}</p>` : "";
  const popup = window.open("", "_blank");
  if (!popup) return;
  popup.document.write(`<html><head><title>${v.voucher_number || "Draft Voucher"}</title><style>body{font-family:Arial;padding:24px;color:#171717}table{width:100%;border-collapse:collapse}td,th{border:1px solid #999;padding:8px}.void-banner{margin:0 0 18px;padding:14px;border:4px solid #b42323;color:#b42323;font-size:28px;font-weight:900;text-align:center;letter-spacing:.08em}@media print{button{display:none}}</style></head><body>${cancellationBlock}<h1>Payment Voucher</h1><p><b>Company:</b> ${entity?.legal_name || entity?.short_code || ""}</p><p><b>Voucher:</b> ${v.voucher_number || "Draft"}</p><p><b>Status:</b> ${cancelled ? "Void / Cancelled" : v.status}</p><p><b>Date:</b> ${v.voucher_date}</p><p><b>Payee:</b> ${v.payee}</p><p><b>Payee bank details:</b><br />${(v.payee_bank_details?.notes || "Not provided").replaceAll("\n", "<br />")}</p><p><b>Purpose:</b> ${v.purpose}</p><table><thead><tr><th>Description</th><th>Category</th><th>Amount</th></tr></thead><tbody>${itemRows}</tbody></table><p><b>Total:</b> ${money(v.total_amount)}</p><p><b>Payment method:</b> ${v.payment_method || ""}</p><p><b>Bank reference:</b> ${v.bank_reference || ""}</p><p><b>Prepared by:</b> ${preparedBy}</p><p><b>Remarks:</b> ${v.remarks || ""}</p><p><b>Supporting documents:</b> ${docList}</p><button onclick="window.print()">Print / Save PDF</button></body></html>`);
  popup.document.close();
}
