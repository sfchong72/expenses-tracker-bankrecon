"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { AuthBar } from "@/app/auth-bar";
import { createClient } from "@/lib/supabase/client";

type Row = Record<string, any>;

const checklist = [
  { area: "Dashboard", action: "Open the dashboard and follow the main cards.", expected: "Tester understands where to start without random clicking." },
  { area: "Suppliers", action: "Create or edit one supplier/payee and assign entities.", expected: "Supplier appears only for applicable entities." },
  { area: "Supplier Bills", action: "Create one bill and attach invoice PDF/image/photo.", expected: "Bill saves, document uploads, document appears on the bill." },
  { area: "Recurring", action: "Create one recurring obligation and generate monthly drafts.", expected: "Draft bill/voucher is created only when scheduling details are ready." },
  { area: "Payment Vouchers", action: "Create a manual voucher, then issue and print it.", expected: "Voucher number is assigned only on issue and print layout is clear." },
  { area: "Claims", action: "Create a staff cash/travel or credit-card claim with lines and receipts.", expected: "Totals calculate automatically and missing evidence is visible." },
  { area: "Documents", action: "Upload a secondary supporting document to an existing record.", expected: "Upload button, progress/result and download all work." },
  { area: "Missing Documents", action: "Review missing evidence list.", expected: "Bills, payments and claim lines needing documents are easy to find." },
  { area: "Permissions", action: "Log in as staff tester.", expected: "Staff sees assigned work only and no bank balances." },
  { area: "Feedback", action: "Submit one issue or remark here.", expected: "Owner can review tester remarks." },
];

export default function UatPage() {
  const db = useMemo(() => createClient(), []);
  const [feedback, setFeedback] = useState<Row[]>([]);
  const [form, setForm] = useState({ page_path: "/", feedback_type: "remark", priority: "normal", summary: "", details: "", screenshot_reference: "" });
  const [message, setMessage] = useState("Use this page while family/staff test the app. Bank reconciliation stays in SQL Accounting.");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { void load(); }, []);

  async function load() {
    const res = await db.from("uat_feedback").select("*").order("submitted_at", { ascending: false }).limit(50);
    if (res.error) {
      setError("Apply migration 0012_staff_trial_feedback.sql to enable feedback storage.");
      return;
    }
    setFeedback(res.data ?? []);
    setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const user = await db.auth.getUser();
    const clean = {
      page_path: plain(form.page_path).slice(0, 200),
      feedback_type: form.feedback_type,
      priority: form.priority,
      summary: plain(form.summary).slice(0, 300),
      details: plain(form.details).slice(0, 4000),
      screenshot_reference: plain(form.screenshot_reference).slice(0, 500),
      submitted_by: user.data.user?.id ?? null,
    };
    const res = await db.from("uat_feedback").insert(clean);
    setBusy(false);
    if (res.error) {
      setError(res.error.message);
      return;
    }
    setMessage("Feedback submitted. Thank you.");
    setForm({ page_path: "/", feedback_type: "remark", priority: "normal", summary: "", details: "", screenshot_reference: "" });
    await load();
  }

  return (
    <main>
      <header>
        <div>
          <span>Staff Trial</span>
          <h1>UAT Checklist & Feedback</h1>
          <p className="subtitle">A simple path for testers to try the app and leave remarks without changing the project scope.</p>
        </div>
        <AuthBar />
      </header>

      <section className={error ? "notice error" : "notice"}>
        <p>{error || message}</p>
        <button onClick={() => void load()}>Refresh</button>
      </section>

      <section className="notice">
        <p>Privacy note: do not submit passwords, full card numbers, bank balances, bank login details or confidential account numbers in feedback.</p>
      </section>

      <section className="panel">
        <h2>Recommended Test Path</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Area</th><th>Exact action</th><th>Expected result</th><th>Pass / Fail</th></tr></thead>
            <tbody>{checklist.map((item) => <tr key={item.area}><td>{item.area}</td><td>{item.action}</td><td>{item.expected}</td><td>_____</td></tr>)}</tbody>
          </table>
        </div>
      </section>

      <section className="grid">
        <section className="panel">
          <h2>Submit Feedback</h2>
          <form onSubmit={submit}>
            <label>Page / area<input value={form.page_path} onChange={(e) => setForm({ ...form, page_path: e.target.value })} placeholder="/claims or Supplier Bills" /></label>
            <label>Type<select value={form.feedback_type} onChange={(e) => setForm({ ...form, feedback_type: e.target.value })}><option value="remark">Remark</option><option value="issue">Issue</option><option value="question">Question</option><option value="idea">Idea</option></select></label>
            <label>Priority<select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="blocker">Blocker</option></select></label>
            <label>Short summary<input value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} required /></label>
            <label className="wide">Screenshot / reference<input value={form.screenshot_reference} onChange={(e) => setForm({ ...form, screenshot_reference: e.target.value })} placeholder="Optional screenshot filename, page link or short reference" /></label>
            <label className="wide">Details<textarea value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })} /></label>
            <button disabled={busy}>{busy ? "Submitting..." : "Submit Feedback"}</button>
          </form>
        </section>

        <section className="panel">
          <h2>Recent Feedback</h2>
          {!feedback.length ? <div className="empty">No feedback submitted yet.</div> : <div className="table-wrap"><table><thead><tr><th>Priority</th><th>Type</th><th>Page</th><th>Summary</th><th>Reference</th><th>Status</th></tr></thead><tbody>{feedback.map((row) => <tr key={row.id}><td>{row.priority}</td><td>{row.feedback_type}</td><td>{row.page_path || "-"}</td><td>{row.summary}<br /><span className="help">{row.details}</span></td><td>{row.screenshot_reference || "-"}</td><td>{row.status}</td></tr>)}</tbody></table></div>}
        </section>
      </section>
    </main>
  );
}

function plain(value: string) {
  return value.replace(/[<>]/g, "").trim();
}
