"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AuthBar } from "@/app/auth-bar";
import { createClient } from "@/lib/supabase/client";

type Row = Record<string, any>;

export default function ReconcilePage() {
  const supabase = useMemo(() => createClient(), []);
  const [entities, setEntities] = useState<Row[]>([]);
  const [accounts, setAccounts] = useState<Row[]>([]);
  const [transactions, setTransactions] = useState<Row[]>([]);
  const [entityId, setEntityId] = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [statementMonth, setStatementMonth] = useState(new Date().toISOString().slice(0, 7));
  const [message, setMessage] = useState("Choose a statement month to review unmatched outgoing transactions.");

  useEffect(() => { void loadLookups(); }, []);
  useEffect(() => { if (!entityId && entities[0]) setEntityId(entities[0].id); }, [entities, entityId]);
  useEffect(() => {
    const first = accounts.find((account) => account.entity_id === entityId);
    if (first && !accounts.some((account) => account.id === bankAccountId && account.entity_id === entityId)) setBankAccountId(first.id);
  }, [accounts, bankAccountId, entityId]);
  useEffect(() => { if (entityId && bankAccountId) void loadTransactions(); }, [entityId, bankAccountId, statementMonth]);

  async function loadLookups() {
    const [entityRes, accountRes] = await Promise.all([
      supabase.from("entities").select("id, short_code").eq("active_status", true).order("short_code"),
      supabase.from("bank_accounts_staff_safe").select("*").order("bank_name"),
    ]);
    setEntities(entityRes.data || []);
    setAccounts(accountRes.data || []);
  }

  async function loadTransactions() {
    const { data, error } = await supabase
      .from("bank_transactions_staff_safe")
      .select("*")
      .eq("entity_id", entityId)
      .eq("bank_account_id", bankAccountId)
      .eq("statement_month", `${statementMonth}-01`)
      .eq("direction", "debit")
      .in("reconciliation_status", ["unmatched", "partially_matched", "exception"])
      .order("transaction_date", { ascending: true });
    if (error) setMessage(error.message);
    else {
      setTransactions(data || []);
      setMessage(`${data?.length ?? 0} outgoing transactions need review.`);
    }
  }

  const entityAccounts = accounts.filter((account) => account.entity_id === entityId);

  return (
    <main className="page-shell">
      <div className="page-header">
        <div>
          <p className="eyebrow">PHASE 3A</p>
          <h1>Outgoing Payment Reconciliation</h1>
          <p className="subtitle">Suggested matches are not accounting links until manually confirmed.</p>
        </div>
        <AuthBar />
      </div>
      <div className="statusbar"><span>{message}</span><Link href={`/reconcile/${statementMonth}?entityId=${entityId}&bankAccountId=${bankAccountId}`}>Open Month View</Link></div>
      <section className="panel">
        <div className="form-grid">
          <label>Entity<select value={entityId} onChange={(event) => setEntityId(event.target.value)}>{entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.short_code}</option>)}</select></label>
          <label>Bank account<select value={bankAccountId} onChange={(event) => setBankAccountId(event.target.value)}>{entityAccounts.map((account) => <option key={account.id} value={account.id}>{account.bank_name} - {account.account_name}</option>)}</select></label>
          <label>Statement month<input type="month" value={statementMonth} onChange={(event) => setStatementMonth(event.target.value)} /></label>
        </div>
      </section>
      <section className="panel">
        <h2>Unmatched Outgoing Transactions</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Description</th><th>Reference</th><th>Amount</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>{transactions.map((tx) => (
              <tr key={tx.id}>
                <td>{tx.transaction_date}</td>
                <td>{tx.description}</td>
                <td>{tx.reference_number || tx.bank_reference}</td>
                <td>{Number(tx.amount || 0).toLocaleString("en-MY", { minimumFractionDigits: 2 })}</td>
                <td>{tx.reconciliation_status}</td>
                <td><Link href={`/reconcile/${statementMonth}?entityId=${entityId}&bankAccountId=${bankAccountId}&tx=${tx.id}`}>Review</Link></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
