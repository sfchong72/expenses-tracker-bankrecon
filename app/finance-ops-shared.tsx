"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AuthBar } from "@/app/auth-bar";
import { StatusBadge } from "@/app/ui-v2";
import { createClient } from "@/lib/supabase/client";
import { missingDocuments, requirementsFor } from "@/lib/financeops/payments/requirements";
import { canViewRegister, isFinanceReviewer, STATUS_LABELS, type DocRole, type PaymentStatus } from "@/lib/financeops/payments/types";

export type Row = Record<string, any>;

export const money = (n: unknown, currency = "MYR") => `${currency} ${Number(n || 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const dateText = (iso: string | null | undefined) => (iso ? new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" }) : "—");
export const todayIso = () => new Date().toISOString().slice(0, 10);
export const ageDays = (iso: string | null | undefined) => (iso ? Math.max(0, Math.floor((Date.now() - new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).getTime()) / 86400000)) : 0);

export const NAV = [
  { href: "/finance-ops", label: "Dashboard" },
  { href: "/finance-ops/payments", label: "Payment Register" },
  { href: "/finance-ops/bank-import", label: "Bank import" },
  { href: "/finance-ops/matching", label: "Matching queue" },
  { href: "/finance-ops/missing-documents", label: "Missing documents" },
  { href: "/finance-ops/sql-queue", label: "SQL queue" },
  { href: "/finance-ops/register-import", label: "Import old register" },
];

export function StatusTag({ status }: { status: PaymentStatus | string }) {
  return <StatusBadge status={status} label={STATUS_LABELS[status as PaymentStatus] ?? String(status).replace(/_/g, " ")} />;
}

export function FinanceOpsShell({ title, subtitle, active, message, error, children }: { title: string; subtitle: string; active: string; message?: string; error?: string; children: ReactNode }) {
  return (
    <main className="page-shell">
      <div className="page-header">
        <div>
          <p className="eyebrow">Finance Operations</p>
          <h1>{title}</h1>
          <p className="subtitle">{subtitle}</p>
        </div>
        <AuthBar />
      </div>
      <nav className="segmented-tabs" aria-label="Finance Operations">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} aria-current={n.href === active ? "page" : undefined} className={n.href === active ? "active" : undefined}>{n.label}</Link>
        ))}
      </nav>
      {message && <section className="notice"><p>{message}</p></section>}
      {error && <section className="notice error"><p>{error}</p></section>}
      {children}
    </main>
  );
}

export function Disabled({ title }: { title: string }) {
  return (
    <main className="page-shell">
      <div className="page-header"><div><p className="eyebrow">Finance Operations</p><h1>{title}</h1></div><AuthBar /></div>
      <section className="notice"><p>The Payment Register module is not enabled yet. The administrator switches it on separately, after its database migration has been applied.</p></section>
    </main>
  );
}

export type FinanceOpsData = ReturnType<typeof useFinanceOpsData>;

/**
 * Loads what the Finance Operations screens need through the signed-in user's own session (RLS decides what each role
 * sees). Bank rows and matches are only requested for reviewers who are at AAL2, because the database only allows those.
 */
export function useFinanceOpsData(options: { bank?: boolean } = {}) {
  const db = useMemo(() => createClient(), []);
  const [me, setMe] = useState<{ id: string | null; role: string | null; aal2: boolean }>({ id: null, role: null, aal2: false });
  const [entities, setEntities] = useState<Row[]>([]);
  const [payments, setPayments] = useState<Row[]>([]);
  const [docs, setDocs] = useState<Row[]>([]);
  const [bills, setBills] = useState<Row[]>([]);
  const [matches, setMatches] = useState<Row[]>([]);
  const [bankRows, setBankRows] = useState<Row[]>([]);
  const [batches, setBatches] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const wantBank = Boolean(options.bank);

  const reload = useCallback(async () => {
    setError("");
    const user = await db.auth.getUser();
    const id = user.data.user?.id ?? null;
    const profile = id ? await db.from("app_profiles").select("role, active_status").eq("id", id).maybeSingle() : null;
    const role = profile?.data?.active_status ? (profile.data.role as string) : null;
    let aal2 = false;
    try {
      const level = await db.auth.mfa.getAuthenticatorAssuranceLevel();
      aal2 = level.data?.currentLevel === "aal2";
    } catch {
      aal2 = false;
    }
    setMe({ id, role, aal2 });
    if (!canViewRegister(role)) { setLoading(false); return; }

    const [ent, pay, doc] = await Promise.all([
      db.from("entities").select("id, short_code").order("short_code"),
      db.from("finance_payment_register").select("*").order("payment_instruction_date", { ascending: false }).order("created_at", { ascending: false }).limit(1500),
      db.from("finance_payment_documents").select("id, payment_register_id, entity_id, doc_role, storage_path, original_filename, mime_type, file_hash, uploaded_at, removed_at").is("removed_at", null).limit(6000),
    ]);
    if (ent.error || pay.error) { setError((ent.error || pay.error)!.message); setLoading(false); return; }
    setEntities(ent.data ?? []);
    const paymentRows = (pay.data ?? []) as Row[];
    setPayments(paymentRows);
    setDocs((doc.data ?? []) as Row[]);

    const billIds = Array.from(new Set(paymentRows.map((p) => p.supplier_bill_id).filter(Boolean)));
    const billRows: Row[] = [];
    for (let i = 0; i < billIds.length; i += 80) {
      const r = await db.from("supplier_bills").select("id, bill_number, description, total_amount, supporting_document_status, payment_status, entity_id").in("id", billIds.slice(i, i + 80));
      billRows.push(...((r.data ?? []) as Row[]));
    }
    setBills(billRows);

    if (wantBank && isFinanceReviewer(role) && aal2) {
      const m = await db.from("finance_payment_bank_matches").select("*").in("status", ["suggested", "confirmed"]).order("score", { ascending: false }).limit(3000);
      const matchRows = (m.data ?? []) as Row[];
      setMatches(matchRows);
      const txIds = Array.from(new Set(matchRows.map((x) => x.bank_transaction_id)));
      const txRows: Row[] = [];
      for (let i = 0; i < txIds.length; i += 80) {
        const r = await db.from("finance_bank_statement_transactions").select("*").in("id", txIds.slice(i, i + 80));
        txRows.push(...((r.data ?? []) as Row[]));
      }
      const open = await db.from("finance_bank_statement_transactions").select("*").eq("direction", "debit").order("transaction_date", { ascending: false }).limit(1500);
      const merged = new Map<string, Row>();
      for (const r of [...txRows, ...((open.data ?? []) as Row[])]) merged.set(r.id, r);
      setBankRows(Array.from(merged.values()));
      const b = await db.from("finance_bank_import_batches").select("*").order("imported_at", { ascending: false }).limit(25);
      setBatches((b.data ?? []) as Row[]);
    }
    setLoading(false);
  }, [db, wantBank]);

  useEffect(() => { void reload(); }, [reload]);

  const entityCode = useCallback((id: string) => entities.find((e) => e.id === id)?.short_code ?? "?", [entities]);

  /** documents each payment has / is missing, from the rules (the database applies the same rule at the review gates) */
  const documentState = useCallback((p: Row) => {
    const live = docs.filter((d) => d.payment_register_id === p.id);
    const available = live.map((d) => d.doc_role as DocRole);
    const bill = p.supplier_bill_id ? bills.find((b) => b.id === p.supplier_bill_id) : undefined;
    const required = ((p.required_documents as DocRole[] | null)?.length ? p.required_documents : requirementsFor(p.payment_type)) as DocRole[];
    const state = { required, notApplicable: (p.not_applicable_documents ?? []) as DocRole[], available, billHasInvoice: Boolean(bill && ["invoice_uploaded", "complete"].includes(bill.supporting_document_status)), exceptionApproved: Boolean(p.document_exception_approved_at) };
    return { ...state, missing: missingDocuments(state), live };
  }, [docs, bills]);

  return { db, me, entities, payments, docs, bills, matches, bankRows, batches, loading, message, error, setMessage, setError, reload, entityCode, documentState };
}
