"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Profile = {
  email: string | null;
  display_name: string | null;
  role: string;
};

export default function LoginPage() {
  const supabase = useMemo(() => createClient(), []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [message, setMessage] = useState("Checking session...");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadProfile();
  }, []);

  async function loadProfile() {
    setError("");
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
      setProfile(null);
      setMessage("Sign in to use the protected Phase 1 foundation screens.");
      return;
    }

    const { data, error: profileError } = await supabase
      .from("app_profiles")
      .select("email, display_name, role")
      .eq("id", userData.user.id)
      .maybeSingle();

    if (profileError) {
      setProfile(null);
      setMessage("Signed in, but the Phase 1 database migration is not applied yet.");
      setError(profileError.message);
      return;
    }

    setProfile(data ?? { email: userData.user.email ?? null, display_name: null, role: "read_only" });
    setMessage("Signed in.");
  }

  async function signIn(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      setError(signInError.message);
      setMessage("Sign in failed.");
    } else {
      setMessage("Signed in.");
      await loadProfile();
    }
    setBusy(false);
  }

  async function signUp() {
    setBusy(true);
    setError("");
    const { error: signUpError } = await supabase.auth.signUp({ email, password });
    if (signUpError) {
      setError(signUpError.message);
      setMessage("Sign up failed.");
    } else {
      setMessage("Account created. Check email confirmation settings in Supabase, then sign in.");
    }
    setBusy(false);
  }

  async function signOut() {
    setBusy(true);
    await supabase.auth.signOut();
    setProfile(null);
    setMessage("Signed out.");
    setBusy(false);
  }

  return (
    <main>
      <header>
        <div>
          <span>Phase 1 access</span>
          <h1>Login</h1>
        </div>
        <button onClick={() => { window.location.href = "/"; }}>Dashboard</button>
      </header>

      <section className={error ? "notice error" : "notice"}>
        <p>{error || message}</p>
      </section>

      <section className="grid">
        <div className="panel">
          <h2>Account</h2>
          {profile ? (
            <div className="mini">
              <p><strong>Email:</strong> {profile.email || "Unknown"}</p>
              <p><strong>Name:</strong> {profile.display_name || "Not set"}</p>
              <p><strong>Role:</strong> {profile.role}</p>
              <button disabled={busy} onClick={signOut}>Sign out</button>
            </div>
          ) : (
            <form onSubmit={signIn}>
              <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
              <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} /></label>
              <button disabled={busy}>Sign in</button>
              <button type="button" disabled={busy || !email || !password} onClick={signUp}>Create account</button>
            </form>
          )}
        </div>

        <div className="panel">
          <h2>Phase 1 Notes</h2>
          <div className="mini">
            <p>New accounts start as read-only until the owner changes their role in Supabase.</p>
            <p>Bank balances are only exposed through the owner-only bank account table, not the staff-safe view.</p>
            <p><button onClick={() => { window.location.href = "/settings/foundation"; }}>Open foundation settings</button></p>
          </div>
        </div>
      </section>
    </main>
  );
}
