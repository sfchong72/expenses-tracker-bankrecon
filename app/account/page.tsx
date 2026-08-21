"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";
import { AuthBar } from "@/app/auth-bar";
import { createClient } from "@/lib/supabase/client";

export default function AccountPage() {
  const supabase = useMemo(() => createClient(), []);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("Change the password for your own signed-in account.");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (password.length < 8) { setError("New password must be at least 8 characters."); return; }
    if (password !== confirmPassword) { setError("The password confirmation does not match."); return; }
    setBusy(true);
    const result = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (result.error) { setError(result.error.message || "Password could not be changed."); return; }
    setPassword("");
    setConfirmPassword("");
    setMessage("Password changed successfully. Your role and entity access were not changed.");
  }

  return <main>
    <header><div><span>Account</span><h1>My Account</h1><p className="subtitle">Self-service password management only. Roles and entity permissions remain owner-managed.</p></div><AuthBar /></header>
    <section className={error ? "notice error" : "notice"}><p>{error || message}</p><Link className="action-button neutral" href="/">Back to Dashboard</Link></section>
    <section className="panel auth-panel">
      <h2>Change Password</h2>
      <form onSubmit={changePassword}>
        <label>New password <span className="required-mark">*</span><input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        <label>Confirm new password <span className="required-mark">*</span><input type="password" autoComplete="new-password" minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></label>
        <button className="primary" disabled={busy}>{busy ? "Saving..." : "Change Password"}</button>
      </form>
    </section>
  </main>;
}
