"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AuthBar } from "@/app/auth-bar";
import { createClient } from "@/lib/supabase/client";

type Row = Record<string, any>;

export default function ReconcileMonthPage({ params }: { params: Promise<{ "statement-month": string }> }) {
  const search = useSearchParams();
  const supabase = useMemo(() => createClient(), []);
  const [statementMonth, setStatementMonth] = useState("");
  const [transactions, setTransactions] = useState<Row[]>([]);
  const [selectedTx, setSelectedTx] = useState<Row | null>(null);
  const [suggestions, setSuggestions] = useState<Row[]>([]);
  const [message, setMessage] = useState("Loading reconciliation month...");
  const [manual, setManual] = useState({ linkedRecordType: "manual_exception", linkedRecordId: "", allocatedAmount: "", exceptionReason: "", exceptionCategory: "", remarks: "" });

  const entityId = search.get("entityId") ?? "";
  const bankAccountId = search.get("bankAccountId") ?? "";
  const selectedTxId = search.get("tx") ?? "";

  useEffect(() => { params.then((value) => setStatementMonth(value["statement-month"])); }, [params]);
  useEffect(() => { if (statementMonth && entityId && bankAccountId) void loadTransactions(); }, [statementMonth, entityId, bankAccountId]);
  useEffect(() => { if (selectedTxId && transactions.length) setSelectedTx(transactions.find((tx) => tx.id === selectedTxId) || transactions[0] || null); else setSelectedTx(transactions[0] || null); }, [selectedTxId, transactions]);
  useEffect(() => { if (selectedTx) void loadSuggestions(selectedTx.id); }, [selectedTx]);

  async function loadTransactions() {
    const { data, error } = await supabase
      .from("bank_transactions_staff_safe")
      .select("*")
      .eq("entity_id", entityId)
      .eq("bank_account_id", bankAccountId)
      .eq("statement_month", `${statementMonth}-01`)
      .eq("direction", "debit")
      .order("transaction_date", { ascending: true });
    if (error) setMessage(error.message);
    else {
      setTransactions(data || []);
      setMessage("Select an outgoing transaction, review suggestions, then confirm a match.");
    }
  }

  async function loadSuggestions(bankTransactionId: string) {
    const res = await fetch("/api/reconciliation/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bankTransactionId }),
    });
    const json = await res.json();
    setSuggestions(res.ok ? json.suggestions || [] : []);
  }

  async function confirmSuggestion(suggestion: Row) {
    if (!selectedTx) return;
    const res = await fetch("/api/reconciliation/confirm-match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bankTransactionId: selectedTx.id,
        linkedRecordType: suggestion.linkedRecordType,
        linkedRecordId: suggestion.linkedRecordId,
        allocatedAmount: suggestion.allocatedAmount,
        confidenceScore: suggestion.confidenceScore,
        matchReason: suggestion.matchReason,
        matchType: "suggested",
      }),
    });
    const json = await res.json();
    setMessage(res.ok ? "Match confirmed and audit history updated." : json.error || "Could not confirm match.");
    if (res.ok) void loadTransactions();
  }

  async function saveManualException() {
    if (!selectedTx) return;
    const res = await fetch("/api/reconciliation/confirm-match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bankTransactionId: selectedTx.id,
        linkedRecordType: manual.linkedRecordType,
        linkedRecordId: manual.linkedRecordId || null,
        allocatedAmount: Number(manual.allocatedAmount || selectedTx.amount),
        exceptionReason: manual.exceptionReason,
        exceptionCategory: manual.exceptionCategory,
        remarks: manual.remarks,
        matchType: manual.linkedRecordType === "manual_exception" ? "exception" : "manual",
      }),
    });
    const json = await res.json();
    setMessage(res.ok ? "Manual reconciliation entry saved." : json.error || "Manual match failed.");
    if (res.ok) void loadTransactions();
  }

  return (
    <main className="page-shell">
      <div className="page-header">
        <div>
          <p className="eyebrow">PHASE 3A</p>
          <h1>Statement Reconciliation</h1>
          <p className="subtitle">Month view for outgoing payment matching, exceptions and audit evidence.</p>
        </div>
        <AuthBar />
      </div>
      <div className="statusbar"><span>{message}</span><button onClick={() => void loadTransactions()}>Refresh</button></div>
      <section className="split-grid">
        <section className="panel">
          <h2>Transactions</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>{transactions.map((tx) => (
                <tr key={tx.id} className={selectedTx?.id === tx.id ? "selected-row" : ""} onClick={() => setSelectedTx(tx)}>
                  <td>{tx.transaction_date}</td>
                  <td>{tx.description}</td>
                  <td>{Number(tx.amount || 0).toLocaleString("en-MY", { minimumFractionDigits: 2 })}</td>
                  <td>{tx.reconciliation_status}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
        <section className="panel">
          <h2>Match Review</h2>
          {selectedTx ? <>
            <p><strong>{selectedTx.description}</strong></p>
            <p>{selectedTx.transaction_date} - RM {Number(selectedTx.amount || 0).toLocaleString("en-MY", { minimumFractionDigits: 2 })}</p>
            <h3>Suggested Matches</h3>
            {suggestions.length ? suggestions.map((suggestion) => (
              <div className="inline-card" key={`${suggestion.linkedRecordType}-${suggestion.linkedRecordId}`}>
                <strong>{suggestion.linkedRecordType}</strong>
                <span>{suggestion.matchReason} ({suggestion.confidenceScore}/100)</span>
                <button onClick={() => void confirmSuggestion(suggestion)}>Confirm</button>
              </div>
            )) : <p className="empty-state">No suggestions. Use manual exception only when the supporting business record does not exist yet.</p>}
            <h3>Manual / Exception</h3>
            <div className="form-grid">
              <label>Type<select value={manual.linkedRecordType} onChange={(event) => setManual({ ...manual, linkedRecordType: event.target.value })}><option value="manual_exception">Manual exception</option><option value="bank_charge">Bank charge</option><option value="internal_transfer">Internal transfer</option><option value="recurring_obligation">Recurring obligation exception</option><option value="refund">Refund</option></select></label>
              <label>Linked record ID<input value={manual.linkedRecordId} onChange={(event) => setManual({ ...manual, linkedRecordId: event.target.value })} placeholder="Optional UUID" /></label>
              <label>Allocated amount<input value={manual.allocatedAmount} onChange={(event) => setManual({ ...manual, allocatedAmount: event.target.value })} placeholder={String(selectedTx.amount)} /></label>
              <label>Category<input value={manual.exceptionCategory} onChange={(event) => setManual({ ...manual, exceptionCategory: event.target.value })} /></label>
            </div>
            <label>Reason<input value={manual.exceptionReason} onChange={(event) => setManual({ ...manual, exceptionReason: event.target.value })} /></label>
            <label>Remarks<textarea value={manual.remarks} onChange={(event) => setManual({ ...manual, remarks: event.target.value })} /></label>
            <button className="primary" onClick={() => void saveManualException()}>Save Manual Match</button>
          </> : <p className="empty-state">No bank transaction selected.</p>}
        </section>
      </section>
    </main>
  );
}
