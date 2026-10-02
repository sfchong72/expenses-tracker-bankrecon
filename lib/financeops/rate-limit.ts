/**
 * Small sliding-window rate limiter, applied per authenticated key id AFTER the signature has
 * verified (so an unauthenticated caller cannot spend a legitimate key's budget).
 *
 * BEST-EFFORT ONLY: state lives in the memory of one serverless instance, so the effective
 * limit is per warm instance, not global. It stops runaway loops and obvious abuse; a hard,
 * global limit needs the platform firewall or a shared store (future work, no new
 * infrastructure is added for Phase 1).
 */

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export type RateLimiter = { check(key: string, nowMs?: number): RateLimitResult };

export function createRateLimiter(limit: number, windowMs = 60_000): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    check(key, nowMs = Date.now()) {
      const cutoff = nowMs - windowMs;
      const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + windowMs - nowMs) / 1000)) };
      }
      recent.push(nowMs);
      hits.set(key, recent);
      // Opportunistic cleanup so the map cannot grow without bound.
      if (hits.size > 64) for (const [k, v] of hits) if (v.every((t) => t <= cutoff)) hits.delete(k);
      return { allowed: true };
    },
  };
}
