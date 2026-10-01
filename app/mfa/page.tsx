"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type SetupState = "loading" | "enroll" | "challenge";

function safeNext(value: string | null) {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export default function MfaPage() {
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<SetupState>("loading");
  const [factorId, setFactorId] = useState("");
  const [qrCode, setQrCode] = useState("");
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;

    async function prepareMfa() {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) {
        window.location.href = "/login";
        return;
      }

      const assurance = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (assurance.data?.currentLevel === "aal2") {
        const next = safeNext(new URLSearchParams(window.location.search).get("next"));
        window.location.href = next;
        return;
      }

      const factors = await supabase.auth.mfa.listFactors();
      if (factors.error || !factors.data) {
        if (active) setError("Could not inspect the MFA configuration. Access remains closed.");
        return;
      }

      const verified = factors.data.totp[0];
      if (verified) {
        if (active) {
          setFactorId(verified.id);
          setState("challenge");
        }
        return;
      }

      for (const factor of factors.data.all) {
        if (factor.factor_type === "totp" && factor.status !== "verified") {
          await supabase.auth.mfa.unenroll({ factorId: factor.id });
        }
      }

      const enrollment = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: "Inter-Excel Operations Hub",
      });
      if (enrollment.error || !enrollment.data) {
        if (active) setError("Could not start MFA enrollment. Access remains closed.");
        return;
      }

      if (active) {
        setFactorId(enrollment.data.id);
        setQrCode(enrollment.data.totp.qr_code);
        setSecret(enrollment.data.totp.secret);
        setState("enroll");
      }
    }

    void prepareMfa();
    return () => { active = false; };
  }, [supabase]);

  async function verify(e: FormEvent) {
    e.preventDefault();
    const cleanCode = code.replace(/\s/g, "");
    if (!/^\d{6}$/.test(cleanCode) || !factorId) {
      setError("Enter the current six-digit code from the authenticator app.");
      return;
    }

    setBusy(true);
    setError("");
    const verified = await supabase.auth.mfa.challengeAndVerify({ factorId, code: cleanCode });
    if (verified.error) {
      setError("The verification code was not accepted. Check the authenticator time and try again.");
      setBusy(false);
      return;
    }

    const next = safeNext(new URLSearchParams(window.location.search).get("next"));
    window.location.href = next;
  }

  async function signOut() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  return (
    <main>
      <header>
        <div>
          <span>Protected account</span>
          <h1>Multi-factor authentication</h1>
        </div>
      </header>

      <section className={error ? "notice error" : "notice"}>
        <p>{error || "Verify a second factor to continue with this high-risk action."}</p>
      </section>

      <section className="grid">
        <div className="panel">
          {state === "loading" ? <p>Preparing secure verification…</p> : null}
          {state === "enroll" ? (
            <>
              <h2>Set up an authenticator</h2>
              <p>Scan this QR code with a trusted authenticator app, then enter its six-digit code.</p>
              {/* The QR value is a Supabase-generated local data URL, not a remote image. */}
              <img src={qrCode} alt="Authenticator enrollment QR code" width={220} height={220} />
              <p>If scanning is unavailable, enter this one-time setup secret manually:</p>
              <p><code>{secret}</code></p>
            </>
          ) : null}
          {state === "challenge" ? (
            <>
              <h2>Verify your authenticator</h2>
              <p>Enter the current six-digit code from the enrolled authenticator.</p>
            </>
          ) : null}

          {state !== "loading" ? (
            <form onSubmit={verify}>
              <label>
                Verification code
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                />
              </label>
              <button disabled={busy}>{busy ? "Verifying…" : "Verify and continue"}</button>
            </form>
          ) : null}
        </div>

        <div className="panel">
          <h2>Account safety</h2>
          <p>Do not share the owner account or its authenticator. Every user must use a separate personal login.</p>
          <p>If the enrolled factor is unavailable, stop and ask the account administrator to use the approved recovery process. Do not bypass the MFA requirement.</p>
          <button type="button" onClick={signOut}>Cancel and sign out</button>
        </div>
      </section>
    </main>
  );
}
