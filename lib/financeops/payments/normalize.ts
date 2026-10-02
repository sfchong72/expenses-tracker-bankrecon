/**
 * Normalisation helpers for matching and imports. Deliberately forgiving: bank and OCR text is messy (truncated
 * names, split words, spaces inside account numbers, a long payment reference vs the short statement reference).
 * Nothing here blocks anything; it only decides how confidently two values look like the same thing.
 */

/** "R OSLAN BIN AH MAD ( MYR )" / "[source text partly unclear]" -> a clean lower-case string. */
export function normalizeName(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\[[^\]]*\]/g, " ") // [source text partly unclear]
    .replace(/\(\s*(myr|rm)\s*\)/gi, " ")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Spaces removed as well: "SUVITRAA/P G ANASAN" and "SUVITRA A/P GANASAN" both become "suvitraapganasan". */
export function compactName(value: string | null | undefined): string {
  return normalizeName(value).replace(/\s+/g, "");
}

export type NameMatchKind = "exact" | "prefix" | "similar" | "none";
export type NameMatch = { kind: NameMatchKind; score: number };

function bigrams(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i += 1) {
    const g = text.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

export function dice(a: string, b: string): number {
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

/**
 * Compare two payee names. Statements truncate ("Eveyiana Mujan Anak" for "Eveyiana Mujan Anak Mackie"), so a
 * compact-form prefix of at least 8 characters counts as a match. Different words entirely are "none".
 */
export function matchNames(a: string | null | undefined, b: string | null | undefined): NameMatch {
  const ca = compactName(a);
  const cb = compactName(b);
  if (!ca || !cb) return { kind: "none", score: 0 };
  if (ca === cb) return { kind: "exact", score: 1 };
  const [short, long] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  if (short.length >= 8 && long.startsWith(short)) return { kind: "prefix", score: 0.93 };
  const sim = dice(ca, cb);
  if (sim >= 0.8) return { kind: "similar", score: sim };
  // token overlap (same people, different word order or missing "bin/binti")
  const ta = new Set(normalizeName(a).split(" ").filter((t) => t.length > 2 && !["bin", "binti", "anak", "sdn", "bhd"].includes(t)));
  const tb = new Set(normalizeName(b).split(" ").filter((t) => t.length > 2 && !["bin", "binti", "anak", "sdn", "bhd"].includes(t)));
  if (ta.size >= 2 && tb.size >= 2) {
    const shared = [...ta].filter((t) => tb.has(t)).length;
    if (shared >= Math.min(ta.size, tb.size)) return { kind: "similar", score: 0.82 };
  }
  return { kind: "none", score: sim };
}

export const digitsOnly = (value: string | null | undefined): string => (value ?? "").replace(/\D+/g, "");

export type AccountMatchKind = "exact" | "suffix" | "none";

/** Account numbers: spaces/dashes ignored; the last 6+ digits agreeing counts as a suffix match (masked statements). */
export function matchAccounts(a: string | null | undefined, b: string | null | undefined): AccountMatchKind {
  const da = digitsOnly(a);
  const db = digitsOnly(b);
  if (da.length < 6 || db.length < 6) return "none";
  if (da === db) return "exact";
  const [short, long] = da.length <= db.length ? [da, db] : [db, da];
  if (short.length >= 6 && long.endsWith(short)) return "suffix";
  return "none";
}

export type ReferenceMatchKind = "exact" | "suffix" | "none";

const refKey = (value: string | null | undefined): string => (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Payment-management references are long ("202610020349883140") while the statement shows the tail ("49883140").
 * Equality, or the shorter being a suffix of the longer (>= 6 characters), is a match.
 */
export function matchReferences(a: string | null | undefined, b: string | null | undefined): ReferenceMatchKind {
  const ra = refKey(a);
  const rb = refKey(b);
  if (ra.length < 4 || rb.length < 4) return "none";
  if (ra === rb) return "exact";
  const [short, long] = ra.length <= rb.length ? [ra, rb] : [rb, ra];
  if (short.length >= 6 && long.endsWith(short)) return "suffix";
  return "none";
}

/** "RM1,500.00", "MYR 1 500", "(320.83)", "320.8333333" -> 2-decimal number, or null when not a number. */
export function parseAmount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  if (typeof value !== "string") return null;
  let text = value.trim();
  if (!text) return null;
  const negative = /^\(.*\)$/.test(text) || /^-/.test(text);
  text = text.replace(/^[A-Za-z]{2,3}\s*/, "").replace(/[()\s,-]/g, "").replace(/^RM/i, "");
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n * 100) / 100;
  return negative ? -rounded : rounded;
}

export const cents = (n: number): number => Math.round(n * 100);

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function validDate(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function validTime(h: number, mi: number, s = 0): string | null {
  if (h < 0 || h > 23 || mi < 0 || mi > 59 || s < 0 || s > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Dates and times as they appear on Malaysian bank statements and in the register:
 *   "02-Oct-2026 23:16", "02/10/2026", "2026-10-02", "2-Oct-26 10:54:38", an Excel serial number.
 * Day-first for slash dates. Unparseable -> nulls (the row is flagged, not dropped).
 */
export function parseDateTime(value: unknown): { date: string | null; time: string | null } {
  if (typeof value === "number" && Number.isFinite(value) && value > 20000 && value < 80000) {
    const ms = Math.round((value - 25569) * 86400 * 1000);
    const d = new Date(ms);
    const date = validDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    const secs = Math.round((value % 1) * 86400);
    return { date, time: secs > 0 ? validTime(Math.floor(secs / 3600), Math.floor((secs % 3600) / 60), secs % 60) : null };
  }
  if (typeof value === "string" && /^\d{5}(\.\d+)?$/.test(value.trim())) return parseDateTime(Number(value));
  if (typeof value !== "string") return { date: null, time: null };
  const text = value.trim();
  if (!text) return { date: null, time: null };
  let date: string | null = null;
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (m) date = validDate(Number(m[1]), Number(m[2]), Number(m[3]));
  if (!date) {
    m = /(\d{1,2})[-/ ]([A-Za-z]{3,4})[a-z]*[-/ ,]*(\d{2,4})/.exec(text);
    if (m && MONTHS[m[2].toLowerCase()]) {
      const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
      date = validDate(y, MONTHS[m[2].toLowerCase()], Number(m[1]));
    }
  }
  if (!date) {
    m = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(text);
    if (m) {
      const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
      date = validDate(y, Number(m[2]), Number(m[1]));
    }
  }
  const t = /(?:^|[\sT])(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  return { date, time: t ? validTime(Number(t[1]), Number(t[2]), t[3] ? Number(t[3]) : 0) : null };
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10))) - Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10)))) / 86400000);
}

/**
 * Payment method as the bank portals and the old register word it ("In-House Transfers", "Domestic Transfers",
 * "DuitNow", "IBG", "CIMB Web Portal", "Cash transfer ...") -> the Hub's small set. Unknown wording is "other".
 */
export function normalizePaymentMethod(value: string | null | undefined): "bank_transfer" | "duitnow" | "ibg" | "cheque" | "cash" | "card" | "other" {
  const t = (value ?? "").toLowerCase();
  if (!t.trim()) return "bank_transfer";
  if (/^\s*cash\b/.test(t)) return "cash"; // "Cash transfer - ... receipt displays DuitNow QR" is a cash claim
  if (/duit\s*now/.test(t)) return "duitnow";
  if (/cheque|check\b/.test(t)) return "cheque";
  if (/\bibg\b|interbank giro|domestic/.test(t)) return "ibg";
  if (/in[\s-]*house|bank transfer|web portal|online|fpx|giro|\btt\b|telegraphic|d3bpimus/.test(t)) return "bank_transfer";
  if (/credit card|debit card|\bcard\b/.test(t)) return "card";
  if (/\bcash\b/.test(t)) return "cash";
  return "other";
}
