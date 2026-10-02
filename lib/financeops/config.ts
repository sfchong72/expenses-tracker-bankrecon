import { DEFAULT_MAX_SKEW_SECONDS, loadKeys, type FinanceOpsKey } from "./auth";
import { ENTITY_CODES, type EntityCode } from "./schema";

/**
 * Integration configuration, read from environment VARIABLE VALUES passed in by the
 * caller (pure; never touches process.env itself). Secure defaults: disabled, no keys,
 * no entities. Production stays disabled until Claire explicitly enables it.
 *
 * Entity allow-list: FINANCEOPS_ALLOWED_ENTITY_CODES is the ceiling for the whole
 * integration. A key may be narrowed further with FINANCEOPS_ALLOWED_ENTITY_CODES_CURRENT /
 * _NEXT (always intersected with the ceiling, never widened). An unset per-key list means the
 * key gets the ceiling.
 */
export type FinanceOpsConfig = {
  enabled: boolean;
  keys: FinanceOpsKey[];
  /** Ceiling for the whole integration. */
  allowedEntities: EntityCode[];
  /** Effective allow-list per key id (subset of allowedEntities). */
  keyEntities: Record<string, EntityCode[]>;
  maxSkewSeconds: number;
  rateLimitPerMinute: number;
};

function parseEntityList(value: string | undefined): EntityCode[] {
  const parsed = (value ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is EntityCode => (ENTITY_CODES as readonly string[]).includes(s));
  return Array.from(new Set(parsed));
}

export const DEFAULT_RATE_LIMIT_PER_MINUTE = 30;

export function readFinanceOpsConfig(env: Record<string, string | undefined>): FinanceOpsConfig {
  const ceiling = parseEntityList(env.FINANCEOPS_ALLOWED_ENTITY_CODES);
  const keys = loadKeys(env);

  const keyEntities: Record<string, EntityCode[]> = {};
  for (const key of keys) {
    const perKey = env[`FINANCEOPS_ALLOWED_ENTITY_CODES_${key.slot.toUpperCase()}`];
    keyEntities[key.keyId] = perKey === undefined || perKey.trim() === "" ? ceiling : parseEntityList(perKey).filter((e) => ceiling.includes(e));
  }

  const skew = Number.parseInt(env.FINANCEOPS_MAX_SKEW_SECONDS ?? "", 10);
  const rate = Number.parseInt(env.FINANCEOPS_RATE_LIMIT_PER_MINUTE ?? "", 10);
  return {
    enabled: env.FINANCEOPS_INTAKE_ENABLED === "true",
    keys,
    allowedEntities: ceiling,
    keyEntities,
    maxSkewSeconds: Number.isFinite(skew) && skew >= 30 && skew <= 900 ? skew : DEFAULT_MAX_SKEW_SECONDS,
    rateLimitPerMinute: Number.isFinite(rate) && rate >= 1 && rate <= 600 ? rate : DEFAULT_RATE_LIMIT_PER_MINUTE,
  };
}
