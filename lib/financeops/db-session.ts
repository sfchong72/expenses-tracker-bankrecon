import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseIntakeStore } from "./store-supabase";
import type { IntakeStore } from "./store";

/**
 * Server-side database session for the FinanceOps integration.
 *
 * The HMAC check proves the CALLER is Hermes/FinanceOps. Database access then runs as the FinanceOps *Supabase
 * user* (a data_entry identity listed in finance_integration_identities), signed in with the project's public
 * anon key and that user's own credentials. There is NO service-role key here, and neither Hermes nor the browser
 * ever sees these credentials: they live only in the server environment (Vercel env vars).
 *
 *   FINANCEOPS_DB_USER_EMAIL / FINANCEOPS_DB_USER_PASSWORD     the FinanceOps data_entry user
 *   NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY    the existing public project settings
 *
 * Unset => persistence is "not configured" and the endpoint answers 503. Nothing is provisioned by this code.
 */

export type FinanceOpsDbConfig = { url: string; anonKey: string; email: string; password: string };

export function readFinanceOpsDbConfig(env: Record<string, string | undefined>): FinanceOpsDbConfig | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  const email = env.FINANCEOPS_DB_USER_EMAIL?.trim();
  const password = env.FINANCEOPS_DB_USER_PASSWORD;
  if (!url || !anonKey || !email || !password) return null;
  return { url, anonKey, email, password };
}

type Cached = { key: string; client: SupabaseClient; expiresAtMs: number };
let cached: Cached | null = null;
let inflight: Promise<Cached> | null = null;

const REFRESH_MARGIN_MS = 120_000;

async function signIn(cfg: FinanceOpsDbConfig, key: string): Promise<Cached> {
  const client = createClient(cfg.url, cfg.anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await client.auth.signInWithPassword({ email: cfg.email, password: cfg.password });
  if (error || !data.session) throw new Error("FinanceOps identity sign-in failed");
  const expiresAtMs = (data.session.expires_at ?? Math.floor(Date.now() / 1000) + 3000) * 1000;
  return { key, client, expiresAtMs };
}

/** Returns a signed-in client for the FinanceOps identity, reusing the session until shortly before it expires. */
export async function getFinanceOpsClient(cfg: FinanceOpsDbConfig): Promise<SupabaseClient> {
  const key = `${cfg.url}|${cfg.email}`;
  if (cached && cached.key === key && Date.now() < cached.expiresAtMs - REFRESH_MARGIN_MS) return cached.client;
  if (!inflight) {
    inflight = signIn(cfg, key)
      .then((c) => {
        cached = c;
        return c;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return (await inflight).client;
}

export function resetFinanceOpsClientCache(): void {
  cached = null;
  inflight = null;
}

/** Store provider handed to the handlers. Resolves null when persistence is not configured. */
export function createStoreProvider(env: Record<string, string | undefined>): () => Promise<IntakeStore | null> {
  return async () => {
    const cfg = readFinanceOpsDbConfig(env);
    if (!cfg) return null;
    return createSupabaseIntakeStore(await getFinanceOpsClient(cfg));
  };
}
