"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { AuthBar } from "@/app/auth-bar";
import { createClient } from "@/lib/supabase/client";

type Row = Record<string, any>;

export default function BankTransactionsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [entities, setEntities] = useState<Row[]>([]);
  const [accounts, setAccounts] = useState<Row[]>([]);
  const [transactions, setTransactions] = useState<Row[]>([]);
  const [entityId, setEntityId] = useState("");
  const [bankAccountId, setBankAccountId] = useState("");
  const [statementMonth, setStatementMonth] = useState(new Date().toISOString().slice(0, 7));
  const [message, setMessage] = useState("Manual entry is for exceptions only. Monthly imports should use Bank Imports.");
  const [manual, setManual] = useState({ transaction_date: new Date().toISOString().slice(0, 10), description: "", amount: "", direction: "debit", reference_number: "", remarks: "" });

  useEffect(() => { void loadLookups(); }, []);
  useEffect(() => { if (entityId && bankAccountId) void loadTransactions(); }, [entityId, bankAccountId, statementMonth]);
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

  async function loadTransactions() {
    const month = `${statementMonth}-01`;
    const { data, error } = await supabase
      .from("bank_transactions_staff_safe")
      .select("*")
      .eq("entity_id", entityId)
      .eq("bank_account_id", bankAccountId)
      .eq("statement_month", month)
      .order("transaction_date", { ascending: false });
    if (error) setMessage(error.message);
    else setTransactions(data || []);
  }

  async function saveManual(event: FormEvent) {
    event.preventDefault();
    const amount = Math.abs(Number(manual.amount || 0));
    if (!amount) return setMessage("Manual entry amount must be greater than zero.");
    const payload = {
      entity_id: entityId,
      bank_account_id: bankAccountId,
      transaction_date: manual.transaction_date,
      description: manual.description,
      reference_number: manual.reference_number || null,
      bank_reference: manual.reference_number || null,
      direction: manual.direction,
      debit_amount: manual.direction === "debit" ? amount : null,
      credit_amount: manual.direction === "credit" ? amount : null,
      amount,
      statement_month: `${statementMonth}-01`,
      manual_entry_reason: manual.remarks,
      data_origin: "manual",
      is_demo: false,
    };
    const { error } = await supabase.from("bank_transactions").insert(payload);
    if (error) setMessage(error.message);
    else {
      setMessage("Manual exception transaction saved.");
      setManual({ transaction_date: new Date().toISOString().slice(0, 10), description: "", amount: "", direction: "debit", reference_number: "", remarks: "" });
      void loadTransactions();
    }
  }

  const entityAccounts = accounts.filter((account) => account.entity_id === entityId);

  return (
    <main className="page-shell">
      <div className="page-header">
        <div>
          <p className="eyebrow">PHASE 3A</p>
          <h1>Bank Transactions</h1>
          <p className="subtitle">Staff-safe list excludes running balances and sensitive bank balance fields.</p>
        </div>
        <AuthBar />
      </div>
      <div className="statusbar"><span>{message}</span><button onClick={() => void loadTransactions()}>Refresh</button></div>
      <section className="panel">
        <div className="form-grid">
          <label>Entity<select value={entityId} onChange={(event) => setEntityId(event.target.value)}>{entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.short_code}</option>)}</select></label>
          <label>Bank account<select value={bankAccountId} onChange={(event) => setBankAccountId(event.target.value)}>{entityAccounts.map((account) => <option key={account.id} value={account.id}>{account.bank_name} - {account.account_name}</option>)}</select></label>
          <label>Statement month<input type="month" value={statementMonth} onChange={(event) => setStatementMonth(event.target.value)} /></label>
        </div>
      </section>
      <section className="split-grid">
        <form className="panel" onSubmit={(event) => void saveManual(event)}>
          <h2>Manual Exception Entry</h2>
          <div className="form-grid">
            <label>Date<input type="date" value={manual.transaction_date} onChange={(event) => setManual({ ...manual, transaction_date: event.target.value })} /></label>
            <label>Direction<select value={manual.direction} onChange={(event) => setManual({ ...manual, direction: event.target.value })}><option value="debit">Debit</option><option value="credit">Credit</option></select></label>
            <label>Amount<input value={manual.amount} onChange={(event) => setManual({ ...manual, amount: event.target.value })} /></label>
            <label>Reference<input value={manual.reference_number} onChange={(event) => setManual({ ...manual, reference_number: event.target.value })} /></label>
          </div>
          <label>Description<input value={manual.description} onChange={(event) => setManual({ ...manual, description: event.target.value })} /></label>
          <label>Reason / remarks<textarea value={manual.remarks} onChange={(event) => setManual({ ...manual, remarks: event.target.value })} /></label>
          <button className="primary">Save Manual Transaction</button>
        </form>
        <section className="panel">
          <h2>Transactions</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Description</th><th>Reference</th><th>Direction</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>{transactions.map((tx) => (
                <tr key={tx.id}>
                  <td>{tx.transaction_date}</td>
                  <td>{tx.description}</td>
                  <td>{tx.reference_number || tx.bank_reference}</td>
                  <td>{tx.direction}</td>
                  <td>{Number(tx.amount || 0).toLocaleString("en-MY", { minimumFractionDigits: 2 })}</td>
                  <td>{tx.reconciliation_status}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      </section>
    </main>
  );
}
