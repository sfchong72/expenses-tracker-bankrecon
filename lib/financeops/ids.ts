import { sha256Hex } from "./auth";

/**
 * Deterministic UUIDs derived from the intake id. The bill and the document of an intake always get the
 * same primary key, so a retry after a partial failure ADOPTS what an earlier attempt created (a primary-key
 * conflict) instead of creating a second bill or document. Namespaced so the two never collide.
 */
export function deterministicUuid(namespace: string, key: string): string {
  const hex = sha256Hex(`${namespace}:${key}`).slice(0, 32).split("");
  hex[12] = "5"; // version-5 style layout
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16], 16) & 3]; // RFC 4122 variant
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export const billIdFor = (intakeId: string): string => deterministicUuid("financeops-supplier-bill", intakeId);
export const documentIdFor = (intakeId: string): string => deterministicUuid("financeops-document", intakeId);
