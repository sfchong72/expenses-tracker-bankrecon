"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const supabase = useMemo(() => createClient(), []);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoveryReady, setRecoveryReady] = useState(false);

  useEffect(() => {
    let active = true;
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active && session) {
        setRecoveryReady(true);
        setError("");
      }
    });
    void supabase.auth.getSession().then(({ data }) => {
      if (active && data.session) setRecoveryReady(true);
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [supabase]);

  async function updatePassword(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!recoveryReady) { setError("Open the newest password-reset email link before choosing a new password."); return; }
    if (password.length < 8) { setError("New password must be at least 8 characters."); return; }
    if (password !== confirmPassword) { setError("The password confirmation does not match."); return; }
    setBusy(true);
    const result = await supabase.auth.updateUser({ password });
    if (result.error) {
      setError(result.error.message || "Password could not be updated.");
      setBusy(false);
      return;
    }
    await supabase.auth.signOut();
    window.location.href = "/login?reset=success";
  }

  return <main className="auth-page">
    <header><div><span>Secure recovery</span><h1>Choose a New Password</h1><p className="subtitle">The recovery link creates a temporary authenticated session for this update only.</p></div></header>
    {error && <section className="notice error"><p>{error}</p></section>}
    <section className="panel auth-panel">
      <form onSubmit={updatePassword}>
        <label>New password <span className="required-mark">*</span><input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        <label>Confirm new password <span className="required-mark">*</span><input type="password" autoComplete="new-password" minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></label>
        {!recoveryReady && <p className="help">Waiting for a valid password-recovery session from the email link.</p>}
        <button className="primary" disabled={busy || !recoveryReady}>{busy ? "Updating..." : "Update Password"}</button>
      </form>
    </section>
  </main>;
}
