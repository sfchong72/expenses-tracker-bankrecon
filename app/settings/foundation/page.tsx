"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Entity = {
  id: string;
  short_code: string;
  display_name: string;
  legal_name: string;
  active_status: boolean;
};

type SafeBankAccount = {
  id: string;
  entity_code: string;
  bank_name: string;
  account_name: string;
  masked_account_number: string | null;
  currency: string;
  active_status: boolean;
};

export default function FoundationSettingsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [accounts, setAccounts] = useState<SafeBankAccount[]>([]);
  const [message, setMessage] = useState("Loading foundation settings...");
  const [error, setError] = useState("");

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setError("");
    const [entityResult, accountResult] = await Promise.all([
      supabase.from("entities").select("id, short_code, display_name, legal_name, active_status").order("short_code"),
      supabase.from("bank_accounts_staff_safe").select("id, entity_code, bank_name, account_name, masked_account_number, currency, active_status").order("entity_code"),
    ]);

    const firstError = entityResult.error || accountResult.error;
    if (firstError) {
      setError(firstError.message);
      setMessage("Phase 1 migration is required before this screen can load.");
      return;
    }

    setEntities(entityResult.data ?? []);
    setAccounts(accountResult.data ?? []);
    setMessage("Foundation settings loaded.");
  }

  return (
    <main>
      <header>
        <div>
          <span>Phase 1 foundation</span>
          <h1>Company Settings</h1>
        </div>
        <div className="metrics">
          <b>{entities.length} entities</b>
          <b>{accounts.length} accounts</b>
        </div>
      </header>

      <nav>
        <button onClick={() => { window.location.href = "/"; }}>Dashboard</button>
        <button onClick={() => { window.location.href = "/login"; }}>Login</button>
      </nav>

      <section className={error ? "notice error" : "notice"}>
        <p>{error || message}</p>
      </section>

      <section className="grid">
        <div className="panel">
          <h2>Entities</h2>
          <table>
            <thead><tr><th>Code</th><th>Name</th><th>Status</th></tr></thead>
            <tbody>
              {entities.map((entity) => (
                <tr key={entity.id}>
                  <td>{entity.short_code}</td>
                  <td>{entity.legal_name}</td>
                  <td>{entity.active_status ? "Active" : "Inactive"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!entities.length && <div className="empty">No entities available.</div>}
        </div>

        <div className="panel">
          <h2>Bank Accounts</h2>
          <table>
            <thead><tr><th>Entity</th><th>Bank</th><th>Account</th></tr></thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <td>{account.entity_code}</td>
                  <td>{account.bank_name}</td>
                  <td>{account.account_name}<br />{account.masked_account_number || "Account number pending"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!accounts.length && <div className="empty">No accessible bank accounts.</div>}
        </div>
      </section>
    </main>
  );
}
