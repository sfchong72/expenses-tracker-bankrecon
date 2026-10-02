/** Shared response shape for the framework-free FinanceOps handlers. */
export type HandlerResponse = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };

const NO_STORE = { "Cache-Control": "no-store" };

export function respond(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): HandlerResponse {
  return { status, body, headers: { ...NO_STORE, ...headers } };
}
