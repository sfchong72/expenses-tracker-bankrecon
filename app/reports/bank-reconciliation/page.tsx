"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { AuthBar } from "@/app/auth-bar";
import { createClient } from "@/lib/supabase/client";

type Row = Record<string, any>;

export default function BankReconciliationReportPage() {
  const supabase = useMemo(() => createClient(), []);
  const [entities, setEntities] = useState<Row[]>([]);
  const [accounts, setAccounts] = useState<Row[]>([]);
  const [entityId, setEntityId] = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [statementMonth, setStatementMonth] = useState(new Date().toISOString().slice(0, 7));
  const [summary, setSummary] = useState<Row | null>(null);
  const [message, setMessage] = useState("Monthly report excludes bank balances for staff.");

  useEffect(() => { void loadLookups(); }, []);
  useEffect(() => { if (!entityId && entities[0]) setEntityId(entities[0].id); }, [entities, entityId]);
  useEffect(() => {
    const first = accounts.find((account) => account.entity_id === entityId);
    if (first && !accounts.some((account) => account.id === bankAccountId && account.entity_id === entityId)) setBankAccountId(first.id);
  }, [accounts, bankAccountId, entityId]);

  async function loadLookups() {
    const [entityRes, accountRes] = await Promise.all([
      supabase.from("entities").select("id, short_code").eq("active_status", true).order("short_code"),
      supabase.from("bank_accounts_staff_safe").select("*").order("bank_name"),
    ]);
    setEntities(entityRes.data || []);
    setAccounts(accountRes.data || []);
  }

  async function loadReport(event?: FormEvent) {
    event?.preventDefault();
    const params = new URLSearchParams({ entityId, bankAccountId, statementMonth });
    const res = await fetch(`/api/bank-reports/monthly?${params.toString()}`);
    const json = await res.json();
    if (!res.ok) setMessage(json.error || "Could not load report.");
    else {
      setSummary(json);
      setMessage("Monthly reconciliation report loaded.");
    }
  }

  const entityAccounts = accounts.filter((account) => account.entity_id === entityId);
  const exportUrl = `/api/bank-reports/monthly?${new URLSearchParams({ entityId, bankAccountId, statementMonth, format: "csv" }).toString()}`;

  return (
    <main className="page-shell">
      <div className="page-header">
        <div>
          <p className="eyebrow">PHASE 3A</p>
          <h1>Monthly Bank Reconciliation Report</h1>
          <p className="subtitle">Totals by entity, bank account and statement month without exposing balances to staff.</p>
        </div>
        <AuthBar />
      </div>
      <div className="statusbar"><span>{message}</span>{summary && <a href={exportUrl}>Export CSV</a>}</div>
      <form className="panel" onSubmit={(event) => void loadReport(event)}>
        <div className="form-grid">
          <label>Entity<select value={entityId} onChange={(event) => setEntityId(event.target.value)}>{entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.short_code}</option>)}</select></label>
          <label>Bank account<select value={bankAccountId} onChange={(event) => setBankAccountId(event.target.value)}>{entityAccounts.map((account) => <option key={account.id} value={account.id}>{account.bank_name} - {account.account_name}</option>)}</select></label>
          <label>Statement month<input type="month" value={statementMonth} onChange={(event) => setStatementMonth(event.target.value)} /></label>
        </div>
        <button className="primary">Load Report</button>
      </form>
      {summary && <section className="panel">
        <h2>Summary</h2>
        <div className="metric-grid">
          {Object.entries(summary).map(([key, value]) => <div key={key}><span>{key.replaceAll("_", " ")}</span><strong>{String(value)}</strong></div>)}
        </div>
      </section>}
    </main>
  );
}
