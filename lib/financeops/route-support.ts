import { NextResponse } from "next/server";
import type { FinanceOpsConfig } from "./config";
import { createStoreProvider } from "./db-session";
import { createPaymentStoreProvider } from "./payments/db";
import type { PaymentHandlerDeps } from "./payments/handler";
import { paymentRegisterEnabled } from "./payments/types";
import type { HandlerDeps } from "./handler";
import { createRateLimiter, type RateLimiter } from "./rate-limit";
import type { HandlerResponse } from "./responses";

/** Glue shared by the FinanceOps route files (kept out of the route modules, which may only export HTTP verbs). */

export function toResponse(result: HandlerResponse) {
  return NextResponse.json(result.body, { status: result.status, headers: result.headers });
}

// Best-effort, per warm serverless instance (see rate-limit.ts). Not a security boundary.
let limiter: { perMinute: number; instance: RateLimiter } | null = null;

export function sharedRateLimiter(config: FinanceOpsConfig): RateLimiter {
  if (!limiter || limiter.perMinute !== config.rateLimitPerMinute) {
    limiter = { perMinute: config.rateLimitPerMinute, instance: createRateLimiter(config.rateLimitPerMinute) };
  }
  return limiter.instance;
}

export function handlerDeps(config: FinanceOpsConfig): HandlerDeps {
  return { rateLimiter: sharedRateLimiter(config), storeProvider: createStoreProvider(process.env) };
}

/** Deps for the payment-capture endpoints: its own feature flag (default OFF) plus the same rate limiter and identity session. */
export function paymentHandlerDeps(config: FinanceOpsConfig): PaymentHandlerDeps {
  return { rateLimiter: sharedRateLimiter(config), paymentStoreProvider: createPaymentStoreProvider(process.env), paymentRegisterEnabled: paymentRegisterEnabled(process.env) };
}
