"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { AuthBar } from "@/app/auth-bar";
import { createClient } from "@/lib/supabase/client";

type Row = Record<string, any>;

export default function CategoriesSettingsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [categories, setCategories] = useState<Row[]>([]);
  const [entities, setEntities] = useState<Row[]>([]);
  const [form, setForm] = useState({ id: "", entity_id: "", name: "", account_code: "" });
  const [showArchived, setShowArchived] = useState(false);
  const [message, setMessage] = useState("Loading expense categories...");
  const [error, setError] = useState("");

  useEffect(() => { void load(); }, [showArchived]);

  async function load() {
    setError("");
    const [categoryResult, entityResult] = await Promise.all([
      supabase.from("categories").select("*").eq("category_type", "expense").eq("active_status", !showArchived).order("name"),
      supabase.from("entities").select("id, short_code, display_name").eq("active_status", true).order("short_code"),
    ]);
    const firstError = categoryResult.error || entityResult.error;
    if (firstError) { setError(firstError.message); setMessage("Could not load categories."); return; }
    setCategories(categoryResult.data ?? []);
    setEntities(entityResult.data ?? []);
    setMessage(showArchived ? "Showing archived expense categories." : "Showing active expense categories.");
  }

  async function saveCategory(event: FormEvent) {
    event.preventDefault();
    setError("");
    const payload = {
      entity_id: form.entity_id || null,
      category_type: "expense",
      name: form.name.trim(),
      account_code: form.account_code.trim() || null,
      active_status: true,
      data_origin: "manual",
    };
    if (!payload.name) { setError("Category name is required."); return; }
    const result = form.id
      ? await supabase.from("categories").update(payload).eq("id", form.id)
      : await supabase.from("categories").insert(payload);
    if (result.error) { setError(result.error.message); return; }
    setForm({ id: "", entity_id: "", name: "", account_code: "" });
    setShowArchived(false);
    setMessage(form.id ? "Expense category updated." : "Expense category created.");
    await load();
  }

  async function setActive(row: Row, active: boolean) {
    const result = await supabase.from("categories").update({ active_status: active }).eq("id", row.id);
    if (result.error) setError(result.error.message);
    else { setMessage(active ? "Expense category reactivated." : "Expense category archived."); await load(); }
  }

  function entityName(id: string | null) {
    if (!id) return "All entities";
    return entities.find((entity) => entity.id === id)?.short_code ?? "-";
  }

  return (
    <main>
      <header>
        <div>
          <span>Settings</span>
          <h1>Expense Categories</h1>
        </div>
        <div className="metrics"><b>{categories.length} shown</b><b>{showArchived ? "Archived" : "Active"}</b></div>
        <AuthBar />
      </header>

      <nav className="page-tabs">
        <button onClick={() => { window.location.href = "/settings/foundation"; }}>Foundation</button>
        <button className="active">Expense Categories</button>
      </nav>

      <section className={error ? "notice error" : "notice"}>
        <p>{error || message}</p>
        <label className="inline"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived</label>
      </section>

      <section className="grid">
        <section className="panel">
          <h2>{form.id ? "Edit Category" : "Create Category"}</h2>
          <form onSubmit={saveCategory}>
            <label className="wide">Category name<input placeholder="e.g. Vehicle Loan" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></label>
            <label>Entity scope<select value={form.entity_id} onChange={(event) => setForm({ ...form, entity_id: event.target.value })}><option value="">All entities</option>{entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.short_code}</option>)}</select></label>
            <label>Account code / SQL reference<input placeholder="Optional" value={form.account_code} onChange={(event) => setForm({ ...form, account_code: event.target.value })} /></label>
            <div className="actions wide"><button>{form.id ? "Update Category" : "Create Category"}</button>{form.id && <button className="neutral" type="button" onClick={() => setForm({ id: "", entity_id: "", name: "", account_code: "" })}>Cancel</button>}</div>
          </form>
        </section>

        <section className="panel">
          <h2>Category List</h2>
          {!categories.length ? <div className="empty">{showArchived ? "No archived categories." : "No active categories yet."}</div> : <table><thead><tr><th>Name</th><th>Entity</th><th>Account code</th><th>Status</th><th /></tr></thead><tbody>{categories.map((category) => <tr key={category.id}><td>{category.name}</td><td>{entityName(category.entity_id)}</td><td>{category.account_code || "-"}</td><td><span className={`status-pill ${category.active_status ? "status-issued" : "status-cancelled"}`}>{category.active_status ? "Active" : "Archived"}</span></td><td className="actions"><button className="secondary" onClick={() => setForm({ id: category.id, entity_id: category.entity_id || "", name: category.name, account_code: category.account_code || "" })}>Edit</button>{category.active_status ? <button className="danger" onClick={() => void setActive(category, false)}>Archive</button> : <button onClick={() => void setActive(category, true)}>Reactivate</button>}</td></tr>)}</tbody></table>}
        </section>
      </section>
    </main>
  );
}
