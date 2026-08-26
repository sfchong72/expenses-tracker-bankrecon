"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const supabase = useMemo(() => createClient(), []);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [sessionChecked, setSessionChecked] = useState(false);

  useEffect(() => {
    let active = true;
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active && session) {
        setRecoveryReady(true);
        setSessionChecked(true);
        setError("");
      }
    });
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setRecoveryReady(Boolean(data.session));
      setSessionChecked(true);
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
      {sessionChecked && !recoveryReady ? <div>
        <h2>Recovery link required</h2>
        <p>This page did not receive a valid password-recovery session. Request a fresh email and open only its newest link.</p>
        <div className="actions">
          <Link className="action-button primary" href="/forgot-password">Request Another Reset Link</Link>
          <Link className="action-button neutral" href="/login">Back to Sign In</Link>
        </div>
      </div> : <form onSubmit={updatePassword}>
          <label>New password <span className="required-mark">*</span><input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} disabled={!recoveryReady} required /></label>
          <label>Confirm new password <span className="required-mark">*</span><input type="password" autoComplete="new-password" minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} disabled={!recoveryReady} required /></label>
          {!sessionChecked && <p className="help">Checking the secure password-recovery session...</p>}
          <button className="primary" disabled={busy || !recoveryReady}>{busy ? "Updating..." : "Update Password"}</button>
        </form>}
    </section>
  </main>;
}

