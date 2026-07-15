"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AuthBar } from "@/app/auth-bar";
import { createClient } from "@/lib/supabase/client";

type Row = Record<string, any>;

const money = (value: unknown) => Number(value || 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function Home() {
  const supabase = useMemo(() => createClient(), []);
  const [message, setMessage] = useState("Loading finance workspace...");
  const [bills, setBills] = useState<Row[]>([]);
  const [recurring, setRecurring] = useState<Row[]>([]);
  const [vouchers, setVouchers] = useState<Row[]>([]);
  const [documents, setDocuments] = useState<Row[]>([]);
  const [suppliers, setSuppliers] = useState<Row[]>([]);
  const [categories, setCategories] = useState<Row[]>([]);

  useEffect(() => {
    void load();
    void fetch("/api/recurring/generate", { method: "POST" }).catch(() => undefined);
  }, []);

  async function load() {
    const [billRes, recurringRes, voucherRes, documentRes, supplierRes, categoryRes] = await Promise.all([
      supabase.from("supplier_bills").select("id, description, due_date, total_amount, outstanding_amount, payment_status, supporting_document_status").eq("is_demo", false).order("due_date"),
      supabase.from("recurring_obligations").select("id, description, next_generation_date, due_day, active_status").eq("is_demo", false).order("next_generation_date"),
      supabase.from("payment_vouchers").select("id, voucher_number, payee, voucher_date, total_amount, status").eq("is_demo", false).order("created_at", { ascending: false }),
      supabase.from("documents").select("id, document_type, status, uploaded_at").eq("is_demo", false).order("uploaded_at", { ascending: false }),
      supabase.from("suppliers").select("id, supplier_name, active_status").eq("is_demo", false).order("supplier_name"),
      supabase.from("expense_categories").select("id, name, active_status").eq("active_status", true).order("name"),
    ]);
    const error = billRes.error || recurringRes.error || voucherRes.error || documentRes.error || supplierRes.error || categoryRes.error;
    if (error) {
      setMessage(error.message);
      return;
    }
    setBills(billRes.data ?? []);
    setRecurring(recurringRes.data ?? []);
    setVouchers(voucherRes.data ?? []);
    setDocuments(documentRes.data ?? []);
    setSuppliers(supplierRes.data ?? []);
    setCategories(categoryRes.data ?? []);
    setMessage("Bank reconciliation and official accounting records are maintained in SQL Accounting. This app supports expense administration, payment preparation and supporting-document control.");
  }

  const today = new Date().toISOString().slice(0, 10);
  const dueSoon = bills.filter((bill) => bill.due_date && bill.due_date <= new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10) && !["paid", "cancelled"].includes(bill.payment_status));
  const overdue = bills.filter((bill) => bill.due_date && bill.due_date < today && !["paid", "cancelled"].includes(bill.payment_status));
  const missingEvidence = bills.filter((bill) => ["no_document", "partial_evidence", "not_applicable"].includes(bill.supporting_document_status));
  const draftVouchers = vouchers.filter((voucher) => voucher.status === "draft");
  const openAmount = bills.reduce((sum, bill) => sum + Number(bill.outstanding_amount ?? bill.total_amount ?? 0), 0);

  return (
    <main className="page-shell">
      <div className="page-header">
        <div>
          <p className="eyebrow">Finance Operations</p>
          <h1>Internal Finance Operations Dashboard</h1>
          <p className="subtitle">Expense administration, payment preparation and supporting-document control.</p>
        </div>
        <AuthBar />
      </div>

      <section className="notice">
        <p>{message}</p>
        <button onClick={() => void load()}>Refresh</button>
      </section>

      <section className="metric-grid">
        <Metric label="Open bills" value={bills.filter((bill) => !["paid", "cancelled"].includes(bill.payment_status)).length} />
        <Metric label="Outstanding" value={`MYR ${money(openAmount)}`} />
        <Metric label="Draft vouchers" value={draftVouchers.length} />
        <Metric label="Missing evidence" value={missingEvidence.length} />
      </section>

      <section className="split-grid">
        <Panel title="Payment Preparation">
          <QuickLink href="/bills" title="Supplier Bills" detail={`${dueSoon.length} due within 3 days, ${overdue.length} overdue`} />
          <QuickLink href="/payment-vouchers" title="Payment Vouchers" detail={`${vouchers.length} vouchers, ${draftVouchers.length} drafts to review`} />
          <QuickLink href="/claims" title="Staff & Director Claims" detail="Cash, travel and credit-card reimbursement preparation" />
          <QuickLink href="/recurring" title="Recurring Obligations" detail={`${recurring.filter((row) => row.active_status).length} active monthly obligations`} />
        </Panel>

        <Panel title="Audit Evidence">
          <QuickLink href="/documents" title="Supporting Documents" detail={`${documents.length} private documents stored`} />
          <QuickLink href="/missing-documents" title="Missing Documents" detail={`${missingEvidence.length} records need evidence review`} />
          <QuickLink href="/settings/categories" title="Expense Categories" detail={`${categories.length} active categories`} />
        </Panel>
      </section>

      <section className="panel">
        <h2>Workspace Status</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Area</th><th>Status</th><th>Next action</th></tr></thead>
            <tbody>
              <tr><td>Suppliers / Payees</td><td>{suppliers.filter((row) => row.active_status).length} active</td><td><Link href="/suppliers">Maintain supplier records</Link></td></tr>
              <tr><td>Supplier Bills</td><td>{bills.length} current records</td><td><Link href="/bills">Create bills and attach invoices</Link></td></tr>
              <tr><td>Recurring Obligations</td><td>{recurring.length} configured</td><td><Link href="/recurring">Generate monthly drafts</Link></td></tr>
              <tr><td>Payment Vouchers</td><td>{vouchers.length} prepared</td><td><Link href="/payment-vouchers">Issue or print vouchers</Link></td></tr>
              <tr><td>Staff & Director Claims</td><td>Release 1 finance/admin entry</td><td><Link href="/claims">Create claims and reimbursement vouchers</Link></td></tr>
              <tr><td>SQL Accounting</td><td>Official accounting and bank reconciliation system</td><td>Record final accounting entries there</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="panel"><h2>{title}</h2>{children}</section>;
}

function QuickLink({ href, title, detail }: { href: string; title: string; detail: string }) {
  return <Link className="inline-card" href={href}><strong>{title}</strong><span>{detail}</span><span>Open</span></Link>;
}
