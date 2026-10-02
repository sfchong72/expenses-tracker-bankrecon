import { getFinanceOpsClient, readFinanceOpsDbConfig } from "../db-session";
import { createSupabasePaymentStore } from "./store-supabase";
import type { PaymentStore } from "./store";

/** Payment store provider for the HMAC endpoints: the FinanceOps identity's own session, or null when not configured. */
export function createPaymentStoreProvider(env: Record<string, string | undefined>): () => Promise<PaymentStore | null> {
  return async () => {
    const cfg = readFinanceOpsDbConfig(env);
    if (!cfg) return null;
    return createSupabasePaymentStore(await getFinanceOpsClient(cfg));
  };
}
