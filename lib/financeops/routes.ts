/**
 * Edge-safe (no imports) matcher for the single path prefix that bypasses the
 * cookie-session gate in middleware. Requests under this prefix are authenticated
 * inside the route by HMAC (see auth.ts); nothing else is exempted.
 */
export const FINANCEOPS_API_PREFIX = "/api/integrations/financeops/v1/";

export function isFinanceOpsIntegrationPath(pathname: string): boolean {
  if (!pathname.startsWith(FINANCEOPS_API_PREFIX)) return false;
  if (pathname.length === FINANCEOPS_API_PREFIX.length) return false;
  // Defence in depth: URL parsing normally removes dot segments, but never let a traversal-looking,
  // percent-encoded (including encoded slash/backslash/dot and double-encoding), backslash or
  // path-parameter (;) path ride on the exemption. Legitimate routes need none of these.
  if (pathname.includes("..") || pathname.includes("//") || pathname.includes("\\") || pathname.includes("%") || pathname.includes(";")) {
    return false;
  }
  return true;
}
