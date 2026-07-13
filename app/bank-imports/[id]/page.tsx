"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AuthBar } from "@/app/auth-bar";
import { createClient } from "@/lib/supabase/client";

type Row = Record<string, any>;

export default function BankImportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const supabase = useMemo(() => createClient(), []);
  const [id, setId] = useState("");
  const [batch, setBatch] = useState<Row | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [message, setMessage] = useState("Loading bank import batch...");

  useEffect(() => { params.then((value) => setId(value.id)); }, [params]);
  useEffect(() => { if (id) void load(); }, [id]);

  async function load() {
    const [batchRes, rowRes] = await Promise.all([
      supabase.from("bank_import_batches_staff_safe").select("*").eq("id", id).maybeSingle(),
      supabase.from("bank_import_rows_staff_safe").select("*").eq("bank_import_batch_id", id).order("row_number"),
    ]);
    if (batchRes.error || !batchRes.data) setMessage(batchRes.error?.message || "Batch not found");
    else {
      setBatch(batchRes.data);
      setRows(rowRes.data || []);
      setMessage("Batch loaded. Staff-safe rows do not expose running balances.");
    }
  }

  return (
    <main className="page-shell">
      <div className="page-header">
        <div>
          <p className="eyebrow">PHASE 3A</p>
          <h1>Bank Import Batch</h1>
          <p className="subtitle">Preview rows, result status and audit-friendly batch history.</p>
        </div>
        <AuthBar />
      </div>
      <div className="statusbar"><span>{message}</span><Link href="/bank-imports">Back to imports</Link></div>
      {batch && <section className="panel">
        <h2>{batch.filename}</h2>
        <div className="metric-grid">
          <div><span>Status</span><strong>{batch.status}</strong></div>
          <div><span>Statement month</span><strong>{new Date(batch.statement_month).toLocaleDateString("en-MY", { month: "long", year: "numeric" })}</strong></div>
          <div><span>Successful</span><strong>{batch.successful_rows}</strong></div>
          <div><span>Failed</span><strong>{batch.failed_rows}</strong></div>
        </div>
        <a className="button-link" href={`/api/bank-imports/export?batchId=${batch.id}`}>Export Result</a>
      </section>}
      <section className="panel">
        <h2>Rows</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Row</th><th>Status</th><th>Mapped Data</th><th>Warnings</th><th>Transaction</th></tr></thead>
            <tbody>{rows.map((row) => (
              <tr key={row.id}>
                <td>{row.row_number}</td>
                <td>{row.result_status}<br />{row.result_message}</td>
                <td><code>{JSON.stringify(row.mapped_data)}</code></td>
                <td><code>{JSON.stringify(row.duplicate_warnings)}</code></td>
                <td>{row.bank_transaction_id ? <Link href="/bank-transactions">Created</Link> : "-"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
