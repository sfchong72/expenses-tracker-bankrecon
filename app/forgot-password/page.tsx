"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const neutralMessage = "If this email belongs to an active account, password reset instructions have been sent.";

export default function ForgotPasswordPage() {
  const supabase = useMemo(() => createClient(), []);
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("Enter your login email to request official Supabase password-reset instructions.");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEmail(new URLSearchParams(window.location.search).get("email") || "");
  }, []);

  async function requestReset(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
        redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
      });
    } finally {
      setMessage(neutralMessage);
      setBusy(false);
    }
  }

  return <main className="auth-page">
    <header><div><span>Account recovery</span><h1>Reset Password</h1><p className="subtitle">No existing password is displayed or retrieved.</p></div></header>
    <section className="notice"><p>{message}</p></section>
    <section className="panel auth-panel">
      <form onSubmit={requestReset}>
        <label>Email <span className="required-mark">*</span><input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
        <div className="actions"><Link className="action-button neutral" href="/login">Back to Sign In</Link><button className="primary" disabled={busy}>{busy ? "Sending..." : "Send Password Reset"}</button></div>
      </form>
    </section>
  </main>;
}
