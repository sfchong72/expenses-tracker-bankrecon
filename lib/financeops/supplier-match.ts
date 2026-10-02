/**
 * Supplier and category matching from SAFE projections.
 *
 * Callers must pass rows from `suppliers_app_safe` (or an equivalent projection)
 * limited to suppliers linked to the intake's entity. The input type deliberately has
 * no bank-detail field; raw supplier bank information is never needed or accepted.
 *
 * Only an unambiguous exact match yields a supplier id. Everything else is a ranked
 * candidate list for a human to choose from. Suppliers are never created here.
 */

export type SafeSupplier = {
  id: string;
  supplierName: string;
  registrationNumber: string | null;
  activeStatus: boolean;
  archivedAt?: string | null;
};

export type SupplierProposal = { name: string | null; registrationNumber: string | null };

export type SupplierCandidate = { supplierId: string; name: string; score: number; reason: string };

export type SupplierMatch =
  | { status: "exact"; supplierId: string; candidates: SupplierCandidate[] }
  | { status: "candidates"; supplierId: null; candidates: SupplierCandidate[] }
  | { status: "none"; supplierId: null; candidates: [] };

const LEGAL_SUFFIXES = new Set(["sdn", "bhd", "berhad", "pte", "ltd", "limited", "llp", "plt", "inc", "corp", "co", "m"]);

export function normalizeName(value: string | null | undefined): string {
  if (!value) return "";
  const base = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const tokens = base.split(/\s+/).filter((t) => t && !LEGAL_SUFFIXES.has(t));
  return tokens.join(" ");
}

export function normalizeRegistration(value: string | null | undefined): string {
  return value ? value.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
}

function registrationMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  // Tolerate old/new Malaysian formats stored together, e.g. "202001012345 (1234567-X)".
  return short.length >= 8 && long.includes(short);
}

function bigrams(text: string): Map<string, number> {
  const s = text.replace(/\s+/g, " ");
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Sørensen–Dice coefficient on character bigrams, 0..1. */
export function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let overlap = 0;
  let total = 0;
  for (const n of ga.values()) total += n;
  for (const n of gb.values()) total += n;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0);
  return total === 0 ? 0 : (2 * overlap) / total;
}

export const CANDIDATE_THRESHOLD = 0.6;
export const MAX_CANDIDATES = 5;

export function matchSupplier(proposal: SupplierProposal, suppliers: readonly SafeSupplier[]): SupplierMatch {
  const active = suppliers.filter((s) => s.activeStatus && !s.archivedAt);
  const name = normalizeName(proposal.name);
  const reg = normalizeRegistration(proposal.registrationNumber);
  if (!name && !reg) return { status: "none", supplierId: null, candidates: [] };

  const scored: SupplierCandidate[] = [];
  const exactRegistration: SafeSupplier[] = [];
  const exactName: SafeSupplier[] = [];

  for (const s of active) {
    const sName = normalizeName(s.supplierName);
    const similarity = name ? nameSimilarity(name, sName) : 0;
    const regHit = reg !== "" && registrationMatches(reg, normalizeRegistration(s.registrationNumber));
    if (regHit) exactRegistration.push(s);
    if (name && sName === name) exactName.push(s);

    if (regHit) {
      scored.push({ supplierId: s.id, name: s.supplierName, score: name ? Math.max(0.9, similarity) : 0.9, reason: "registration_number" });
    } else if (name && similarity >= CANDIDATE_THRESHOLD) {
      scored.push({ supplierId: s.id, name: s.supplierName, score: round(similarity), reason: sName === name ? "name_exact" : "name_similar" });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const candidates = scored.slice(0, MAX_CANDIDATES);

  // Registration number is the strongest identity, but a registration hit whose name is
  // clearly different is demoted to a candidate for a human to resolve.
  if (exactRegistration.length === 1) {
    const only = exactRegistration[0];
    const sName = normalizeName(only.supplierName);
    if (!name || nameSimilarity(name, sName) >= 0.3) return { status: "exact", supplierId: only.id, candidates };
    return { status: "candidates", supplierId: null, candidates: candidates.map((c) => (c.supplierId === only.id ? { ...c, reason: "registration_matches_name_differs" } : c)) };
  }
  if (exactRegistration.length === 0 && exactName.length === 1) {
    return { status: "exact", supplierId: exactName[0].id, candidates };
  }
  if (candidates.length === 0) return { status: "none", supplierId: null, candidates: [] };
  return { status: "candidates", supplierId: null, candidates };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ------------------------------------------------------------------ categories

export type SafeCategory = { id: string; name: string };
export type CategoryMatch =
  | { status: "exact"; categoryId: string }
  | { status: "candidates"; categoryId: null; candidates: { categoryId: string; name: string; score: number }[] }
  | { status: "none"; categoryId: null };

export function matchCategory(hint: string | null | undefined, categories: readonly SafeCategory[]): CategoryMatch {
  const wanted = normalizeName(hint);
  if (!wanted) return { status: "none", categoryId: null };
  const exact = categories.filter((c) => normalizeName(c.name) === wanted);
  if (exact.length === 1) return { status: "exact", categoryId: exact[0].id };
  const candidates = categories
    .map((c) => ({ categoryId: c.id, name: c.name, score: round(nameSimilarity(wanted, normalizeName(c.name))) }))
    .filter((c) => c.score >= CANDIDATE_THRESHOLD)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, MAX_CANDIDATES);
  return candidates.length ? { status: "candidates", categoryId: null, candidates } : { status: "none", categoryId: null };
}
