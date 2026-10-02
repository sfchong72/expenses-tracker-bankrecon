import { sha256Hex, signRequest } from "../auth";
import { readFinanceOpsConfig, type FinanceOpsConfig } from "../config";
import { handleBillIntake, handleBillIntakeStatus, type HandlerDeps } from "../handler";
import type { IntakeStore } from "../store";
import { FakeStore } from "./fake-store";

export const SECRET = "test-secret-current-0123456789abcdef0123";
export const PATH = "/api/integrations/financeops/v1/bill-intakes";
export const NOW = 1_800_000_000;
export const PDF = new TextEncoder().encode("%PDF-1.7\nfake invoice one");
export const PDF2 = new TextEncoder().encode("%PDF-1.7\nfake invoice two");

export const ENV = {
  FINANCEOPS_INTAKE_ENABLED: "true",
  FINANCEOPS_ALLOWED_ENTITY_CODES: "IEA,IETA,PLC,KALER",
  FINANCEOPS_HMAC_KEY_ID_CURRENT: "kid-current",
  FINANCEOPS_HMAC_SECRET_CURRENT: SECRET,
};
export const CONFIG: FinanceOpsConfig = readFinanceOpsConfig(ENV);

export function metadata(over: Record<string, unknown> = {}, bytes: Uint8Array = PDF) {
  return {
    intake_id: "fo_bill_01JABCDEF",
    source: { channel: "telegram", chat_id: "1", message_id: "2", received_at: "2026-10-02T03:04:05Z" },
    entity_code: "IEA",
    supplier: { name: "Mega Supplies", registration_number: null },
    invoice: { number: "INV-1", date: "2026-09-30", due_date: "2026-10-30", currency: "MYR", subtotal: null, tax_amount: null, total_amount: 106, description: "Office supplies", bill_type: "supplier_invoice" },
    extraction: { agent: "a", version: "1", overall_confidence: 0.95, fields: {} },
    document: { sha256: sha256Hex(bytes), mime_type: "application/pdf", filename: "a.pdf" },
    ...over,
  };
}

export type Parts = { raw: Uint8Array; contentType: string };

export async function multipart(meta: unknown, bytes: Uint8Array = PDF): Promise<Parts> {
  const fd = new FormData();
  fd.set("metadata", JSON.stringify(meta));
  fd.set("file", new File([bytes as BlobPart], "a.pdf", { type: "application/pdf" }));
  const res = new Response(fd);
  return { raw: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") as string };
}

function signedHeaders(method: string, path: string, body: Uint8Array, contentType?: string, secret = SECRET): Headers {
  const timestamp = String(NOW);
  const headers = new Headers();
  if (contentType) headers.set("content-type", contentType);
  headers.set("x-financeops-key-id", "kid-current");
  headers.set("x-financeops-timestamp", timestamp);
  headers.set("x-financeops-signature", signRequest(secret, { timestamp, method, path, query: "", bodySha256: sha256Hex(body) }));
  return headers;
}

export function depsFor(store: IntakeStore | null | (() => Promise<IntakeStore | null>)): HandlerDeps {
  return { nowSeconds: NOW, storeProvider: typeof store === "function" ? store : async () => store };
}

/** POST a signed intake through the REAL handler against the given store. */
export async function post(store: IntakeStore, meta: unknown = metadata(), bytes: Uint8Array = PDF, config: FinanceOpsConfig = CONFIG) {
  const parts = await multipart(meta, bytes);
  return handleBillIntake({ method: "POST", path: PATH, query: "", headers: signedHeaders("POST", PATH, parts.raw, parts.contentType), rawBody: parts.raw }, config, depsFor(store));
}

export async function getStatus(store: IntakeStore | null, intakeId: string, over: { sign?: boolean; method?: string; config?: FinanceOpsConfig } = {}) {
  const path = `${PATH}/${intakeId}`;
  const empty = new Uint8Array(0);
  const method = over.method ?? "GET";
  const headers = over.sign === false ? new Headers() : signedHeaders(method, path, empty);
  return handleBillIntakeStatus({ method, path, query: "", headers, rawBody: empty }, intakeId, over.config ?? CONFIG, depsFor(store));
}

export function freshStore(): FakeStore {
  const store = new FakeStore();
  return store;
}
