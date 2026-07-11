"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const supabase = useMemo(() => createClient(), []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("Sign in with your Supabase email and password.");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reason = params.get("error");
    if (reason === "no_profile") setError("Access denied: no application profile exists for this login.");
    if (reason === "inactive") setError("Access denied: this user account is inactive.");
  }, []);

  async function signIn(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      setError("Invalid email or password.");
      setBusy(false);
      return;
    }

    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) {
      setError("Sign in failed. Please try again.");
      setBusy(false);
      return;
    }

    const { data: profile, error: profileError } = await supabase
      .from("app_profiles")
      .select("role, active_status")
      .eq("id", userData.user.id)
      .maybeSingle();

    if (profileError || !profile) {
      await supabase.auth.signOut();
      setError("Access denied: no application profile exists for this login.");
    } else if (!profile.active_status) {
      await supabase.auth.signOut();
      setError("Access denied: this user account is inactive.");
    } else {
      const params = new URLSearchParams(window.location.search);
      window.location.href = params.get("next") || "/";
    }
    setBusy(false);
  }

  return (
    <main>
      <header>
        <div>
          <span>Phase 1 access</span>
          <h1>Login</h1>
        </div>
      </header>

      <section className={error ? "notice error" : "notice"}>
        <p>{error || message}</p>
      </section>

      <section className="grid">
        <div className="panel">
          <h2>Account</h2>
          <form onSubmit={signIn}>
            <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
            <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
            <button disabled={busy}>Sign in</button>
          </form>
        </div>

        <div className="panel">
          <h2>Phase 1 Notes</h2>
          <div className="mini">
            <p>Only users with an active application profile can open the dashboard.</p>
            <p>Owner access is required for company settings and bank balance records.</p>
          </div>
        </div>
      </section>
    </main>
  );
}
