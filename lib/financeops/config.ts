import { DEFAULT_MAX_SKEW_SECONDS, loadKeys, type FinanceOpsKey } from "./auth.ts";
import { ENTITY_CODES, type EntityCode } from "./schema.ts";

/**
 * Integration configuration, read from environment VARIABLE VALUES passed in by the
 * caller (pure; never touches process.env itself). Secure defaults: disabled, no keys,
 * no entities. Production stays disabled until Claire explicitly enables it.
 */
export type FinanceOpsConfig = {
  enabled: boolean;
  keys: FinanceOpsKey[];
  allowedEntities: EntityCode[];
  maxSkewSeconds: number;
};

export function readFinanceOpsConfig(env: Record<string, string | undefined>): FinanceOpsConfig {
  const allowedEntities = (env.FINANCEOPS_ALLOWED_ENTITY_CODES ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is EntityCode => (ENTITY_CODES as readonly string[]).includes(s));

  const skew = Number.parseInt(env.FINANCEOPS_MAX_SKEW_SECONDS ?? "", 10);
  return {
    enabled: env.FINANCEOPS_INTAKE_ENABLED === "true",
    keys: loadKeys(env),
    allowedEntities: Array.from(new Set(allowedEntities)),
    maxSkewSeconds: Number.isFinite(skew) && skew >= 30 && skew <= 900 ? skew : DEFAULT_MAX_SKEW_SECONDS,
  };
}
