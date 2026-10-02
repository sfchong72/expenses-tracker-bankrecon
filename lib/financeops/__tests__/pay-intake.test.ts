import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { sha256Hex, signRequest } from "../auth";
import { readFinanceOpsConfig, type FinanceOpsConfig } from "../config";
import { handlePaymentIntake, handlePaymentStatus, sniffPaymentMime, type PaymentHandlerDeps } from "../payments/handler";
import { parsePaymentIntake } from "../payments/intake-schema";
import { paymentDocumentIdFor, paymentIdFor } from "../payments/store";
import { ENTITY_IDS, FO_USER } from "./fake-store";
import { FakePaymentStore } from "./fake-payment-store";
import { CONFIG, ENV, NOW, SECRET } from "./harness";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const realConsoleError = console.error;
before(() => { console.error = () => {}; });
after(() => { console.error = realConsoleError; });

const PATH = "/api/integrations/financeops/v1/payment-intakes";
const SLIP = new TextEncoder().encode("%PDF-1.7\npublic bank payment slip 1");
const WAGES = new TextEncoder().encode("%PDF-1.7\nSeptember 2026 internship wages");
const INVOICE = new TextEncoder().encode("%PDF-1.7\nsupplier invoice IV-008508");
const XLSX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00, 0x00, 0x00, 0x21, 0x00]);
const CSV = new TextEncoder().encode("name,amount\nIngyin May,1250\nSania Arshad,320.83\n");

type Doc = { part: string; role: string; bytes: Uint8Array; mime?: string; filename?: string };
const docMeta = (d: Doc) => ({ part: d.part, role: d.role, sha256: sha256Hex(d.bytes), mime_type: d.mime ?? "application/pdf", filename: d.filename ?? `${d.part}.pdf` });

function meta(over: Record<string, unknown> = {}, docs: Doc[] = []) {
  return {
    intake_id: "fo_pay_0001abc",
    source: { channel: "telegram", chat_id: "1", message_id: "2", received_at: "2026-10-02T14:54:10Z" },
    entity_code: "IETA",
    payment_type: "intern_wage",
    payment: {
      instruction_date: "2026-10-02", instruction_time: "22:44:43", method: "Domestic Transfers", pay_from_account_ref: "8001344252", pay_from_name: "INTER EXCEL TOURISM ACADEMY SDN. BHD. (MYR)",
      beneficiary_name: "Ingyin May", beneficiary_account_no: "152023754172", beneficiary_bank: "MALAYAN BANKING BHD", amount: 1250, currency: "MYR", bank_reference: "202610020349882888", purpose: "Intern allowance Sept 2026",
    },
    suggested_links: { payroll_ref: "Sept 2026 wage sheet" },
    documents: docs.map(docMeta),
    extraction: { agent: "hermes", version: "1", overall_confidence: 0.92 },
    ...over,
  };
}

async function build(metadata: unknown, docs: Doc[], extraParts: Record<string, Uint8Array> = {}) {
  const fd = new FormData();
  fd.set("metadata", typeof metadata === "string" ? metadata : JSON.stringify(metadata));
  for (const d of docs) fd.set(d.part, new File([d.bytes as BlobPart], d.filename ?? `${d.part}.bin`, { type: d.mime ?? "application/pdf" }));
  for (const [k, v] of Object.entries(extraParts)) fd.set(k, new File([v as BlobPart], `${k}.bin`, { type: "application/pdf" }));
  const res = new Response(fd);
  return { raw: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") as string };
}

function signed(method: string, path: string, body: Uint8Array, contentType?: string, secret = SECRET): Headers {
  const ts = String(NOW);
  const h = new Headers();
  if (contentType) h.set("content-type", contentType);
  h.set("x-financeops-key-id", "kid-current");
  h.set("x-financeops-timestamp", ts);
  h.set("x-financeops-signature", signRequest(secret, { timestamp: ts, method, path, query: "", bodySha256: sha256Hex(body) }));
  return h;
}

const deps = (store: FakePaymentStore | null | (() => Promise<FakePaymentStore | null>), over: Partial<PaymentHandlerDeps> = {}): PaymentHandlerDeps => ({
  nowSeconds: NOW, paymentRegisterEnabled: true, paymentStoreProvider: typeof store === "function" ? store : async () => store, ...over,
});

async function post(store: FakePaymentStore | null, metadata: unknown = meta({}, [{ part: "file_0", role: "payment_evidence", bytes: SLIP }, { part: "file_1", role: "wage_schedule", bytes: WAGES }]), docs: Doc[] = [{ part: "file_0", role: "payment_evidence", bytes: SLIP }, { part: "file_1", role: "wage_schedule", bytes: WAGES }], opts: { config?: FinanceOpsConfig; deps?: Partial<PaymentHandlerDeps>; sign?: boolean; extra?: Record<string, Uint8Array> } = {}) {
  const parts = await build(metadata, docs, opts.extra);
  const headers = opts.sign === false ? new Headers({ "content-type": parts.contentType }) : signed("POST", PATH, parts.raw, parts.contentType);
  return handlePaymentIntake({ method: "POST", path: PATH, query: "", headers, rawBody: parts.raw }, opts.config ?? CONFIG, deps(store, opts.deps));
}

async function status(store: FakePaymentStore | null, id: string, opts: { sign?: boolean; method?: string; deps?: Partial<PaymentHandlerDeps> } = {}) {
  const path = `${PATH}/${id}`;
  const empty = new Uint8Array(0);
  const method = opts.method ?? "GET";
  return handlePaymentStatus({ method, path, query: "", headers: opts.sign === false ? new Headers() : signed(method, path, empty), rawBody: empty }, id, CONFIG, deps(store, opts.deps));
}

describe("payment capture: Hermes -> operational Payment Register record", () => {
  it("a real intern allowance with its payment slip and the wage schedule: captured, documents complete, ready for bank match", async () => {
    const s = new FakePaymentStore();
    const r = await post(s);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, "ready_for_bank_match");
    assert.equal(r.body.documents_complete, true);
    assert.deepEqual(r.body.documents_missing, []);
    assert.equal(r.body.entity_code, "IETA");
    assert.equal(r.body.idempotent_replay, false);
    const p = s.payments[0];
    assert.equal(p.id, paymentIdFor("fo_pay_0001abc"));
    assert.equal(p.source_type, "financeops");
    assert.equal(p.created_by, FO_USER);
    assert.equal(p.entity_id, ENTITY_IDS.IETA);
    assert.equal(p.payment_method, "ibg"); // "Domestic Transfers"
    assert.equal(p.amount, 1250);
    assert.equal(p.bank_reference, "202610020349882888");
    assert.equal(p.payroll_ref, "Sept 2026 wage sheet");
    assert.deepEqual(p.required_documents, ["wage_schedule", "payment_evidence"]);
    assert.equal(s.documents.length, 2);
    assert.deepEqual(s.documents.map((d) => d.doc_role).sort(), ["payment_evidence", "wage_schedule"]);
    assert.equal(s.documents[0].file_hash, sha256Hex(SLIP));
    for (const d of s.documents) {
      assert.match(d.storage_path, new RegExp(`^${ENTITY_IDS.IETA}/2026/10/payments/${p.id}/`));
      assert.equal(d.uploaded_by, FO_USER);
    }
    assert.equal(s.documents[0].id, paymentDocumentIdFor("fo_pay_0001abc", "file_0"));
  });

  it("an intern wage needs no invoice: with evidence and the schedule nothing is missing; without the schedule it stays documents_pending", async () => {
    const s = new FakePaymentStore();
    const r = await post(s, meta({}, [{ part: "file_0", role: "payment_evidence", bytes: SLIP }]), [{ part: "file_0", role: "payment_evidence", bytes: SLIP }]);
    assert.equal(r.status, 201);
    assert.equal(r.body.status, "documents_pending");
    assert.deepEqual(r.body.documents_missing, ["wage_schedule"]);
    assert.equal((r.body.documents_required as string[]).includes("invoice"), false);
  });

  it("a supplier expense without its invoice is documents_pending (not rejected); with both it is ready for bank match", async () => {
    const a = new FakePaymentStore();
    const ra = await post(a, meta({ payment_type: "supplier_expense", suggested_links: { supplier_name: "ABC Trading", invoice_number: "IV-008508" } }, [{ part: "file_0", role: "payment_evidence", bytes: SLIP }]), [{ part: "file_0", role: "payment_evidence", bytes: SLIP }]);
    assert.equal(ra.status, 201);
    assert.equal(ra.body.status, "documents_pending");
    assert.deepEqual(ra.body.documents_missing, ["invoice"]);
    assert.deepEqual(a.payments[0].suggested_links, { supplier_name: "ABC Trading", invoice_number: "IV-008508", claim_ref: null, payroll_ref: null, note: null });
    assert.equal(a.payments[0].supplier_bill_id, undefined); // FinanceOps only SUGGESTS the link
    const b = new FakePaymentStore();
    const docs: Doc[] = [{ part: "file_0", role: "payment_evidence", bytes: SLIP }, { part: "file_1", role: "invoice", bytes: INVOICE }];
    const rb = await post(b, meta({ payment_type: "supplier_expense", intake_id: "fo_pay_0002abc" }, docs), docs);
    assert.equal(rb.body.status, "ready_for_bank_match");
  });

  it("a capture with NO documents at all is still accepted: documents_pending, everything listed as missing", async () => {
    const s = new FakePaymentStore();
    const r = await post(s, meta({}, []), []);
    assert.equal(r.status, 201);
    assert.equal(r.body.status, "documents_pending");
    assert.deepEqual(r.body.documents_missing, ["wage_schedule", "payment_evidence"]);
  });

  it("wage schedules may be spreadsheets (xlsx / csv); content is sniffed, not trusted", async () => {
    const docs: Doc[] = [
      { part: "file_0", role: "payment_evidence", bytes: SLIP },
      { part: "file_1", role: "wage_schedule", bytes: XLSX, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: "wages.xlsx" },
    ];
    const s = new FakePaymentStore();
    assert.equal((await post(s, meta({}, docs), docs)).status, 201);
    const csvDocs: Doc[] = [{ part: "file_0", role: "payment_evidence", bytes: SLIP }, { part: "file_1", role: "wage_schedule", bytes: CSV, mime: "text/csv", filename: "wages.csv" }];
    assert.equal((await post(new FakePaymentStore(), meta({}, csvDocs), csvDocs)).status, 201);
    assert.equal(sniffPaymentMime(CSV), "text/csv");
    assert.equal(sniffPaymentMime(XLSX), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.equal(sniffPaymentMime(new Uint8Array([1, 2, 3, 0, 5])), null);
  });
});

describe("idempotency and retry", () => {
  it("same intake + same payload is an idempotent replay: no second payment, document or upload", async () => {
    const s = new FakePaymentStore();
    await post(s);
    const again = await post(s);
    assert.equal(again.status, 200);
    assert.equal(again.body.idempotent_replay, true);
    assert.equal(s.payments.length, 1);
    assert.equal(s.documents.length, 2);
    assert.equal(s.objects.size, 2);
  });

  it("same intake + different payload (or different file) is 409 and changes nothing", async () => {
    const s = new FakePaymentStore();
    await post(s);
    const before = JSON.stringify(s.payments);
    const m = meta({}, [{ part: "file_0", role: "payment_evidence", bytes: SLIP }, { part: "file_1", role: "wage_schedule", bytes: WAGES }]);
    (m.payment as { amount: number }).amount = 1251;
    const r = await post(s, m);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "intake_conflict");
    assert.equal(JSON.stringify(s.payments), before);
    assert.equal(s.documents.length, 2);
  });

  it("a payment that exists but is invisible to this identity, or created by another user, is a conflict: never adopted", async () => {
    const hidden = new FakePaymentStore();
    hidden.hidden.push({ intake_id: "fo_pay_0001abc" });
    assert.equal((await post(hidden)).status, 409);
    const other = new FakePaymentStore();
    await post(other);
    other.payments[0].created_by = "99999999-9999-4999-8999-999999999999";
    assert.equal((await post(other)).status, 409);
  });

  it("a storage failure leaves the payment 'captured' and reports it (never complete); the retry finishes it without duplicates", async () => {
    const s = new FakePaymentStore().failOn("uploadPaymentObject", { nth: 2 });
    const first = await post(s);
    assert.equal(first.status, 503);
    assert.equal(first.body.retryable, true);
    assert.equal(s.payments[0].status, "captured");
    assert.equal(s.documents.length, 1);
    const retry = await post(s);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.status, "ready_for_bank_match");
    assert.equal(s.payments.length, 1);
    assert.equal(s.documents.length, 2);
    assert.equal(s.objects.size, 2);
  });

  it("failure of the final status update: the retry adopts everything and finalises", async () => {
    const s = new FakePaymentStore().failOn("updatePayment");
    assert.equal((await post(s)).status, 503);
    assert.equal(s.payments[0].status, "captured");
    assert.equal((await post(s)).status, 200);
    assert.equal(s.payments[0].status, "ready_for_bank_match");
    assert.equal(s.documents.length, 2);
  });

  it("a payment a human has already moved on is reported as it is and never touched again", async () => {
    const s = new FakePaymentStore();
    await post(s);
    s.payments[0].status = "bank_matched";
    const before = s.patches.length;
    const r = await post(s);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "bank_matched");
    assert.equal(s.patches.length, before);
  });

  it("never reports success unless the payment really reached its final early status", async () => {
    for (const method of ["entityByCode", "insertPayment", "listPaymentDocuments", "uploadPaymentObject", "insertPaymentDocument", "findPossibleDuplicates", "updatePayment"] as const) {
      const s = new FakePaymentStore().failOn(method);
      const r = await post(s);
      if (r.status === 201) assert.ok(["documents_pending", "ready_for_bank_match"].includes(s.payments[0].status), method);
      else assert.notEqual(r.body.status, "ready_for_bank_match", method);
    }
  });
});

describe("what a human should look at (flags, never refusals)", () => {
  it("a possible duplicate bank reference or payment is flagged but still captured", async () => {
    const s = new FakePaymentStore();
    s.duplicateReference = true;
    s.samePayment = true;
    const r = await post(s);
    assert.equal(r.status, 201);
    assert.equal(r.body.needs_attention, true);
    assert.deepEqual(r.body.attention_reasons, ["possible_duplicate_bank_reference", "possible_duplicate_payment"]);
  });

  it("unclear type, missing purpose or beneficiary, cash, low confidence, foreign currency and a pay-from name that suggests another entity are flagged", async () => {
    const m = meta({ payment_type: "other", entity_code: "IEA", extraction: { agent: "h", version: "1", overall_confidence: 0.5 } }, []);
    const p = m.payment as Record<string, unknown>;
    Object.assign(p, { purpose: null, beneficiary_name: null, beneficiary_account_no: null, method: "Cash", currency: "SGD" });
    const s = new FakePaymentStore();
    const r = await post(s, m, []);
    assert.equal(r.status, 201);
    for (const reason of ["payment_type_unclear", "purpose_missing", "beneficiary_missing", "cash_no_bank_match_expected", "low_extraction_confidence", "non_myr_currency", "pay_from_name_suggests_other_entity"]) {
      assert.ok((r.body.attention_reasons as string[]).includes(reason), reason);
    }
  });

  it("a clean capture raises no flags", async () => {
    const r = await post(new FakePaymentStore());
    assert.equal(r.body.needs_attention, false);
    assert.deepEqual(r.body.attention_reasons, []);
  });
});

describe("FinanceOps can capture and attach evidence, nothing more", () => {
  const forbiddenNames = ["status", "payment_status", "bank_matched", "matched_by", "ready_for_sql", "posted_to_sql", "reconciled", "sql_reference", "sql_posting_date", "needs_attention", "required_documents", "document_exception_note", "bank_match_not_applicable", "reviewed_by", "created_by", "entity_id", "supplier_bill_id", "bank_transaction_id", "payment_register_id", "source_type", "legacy_state"];

  it("every status, match, posting, review and authority field is rejected as forbidden_field (top level and inside payment)", () => {
    for (const k of forbiddenNames) {
      const top = parsePaymentIntake({ ...meta(), [k]: "x" });
      assert.equal(top.ok, false, k);
      if (!top.ok) assert.ok(top.issues.some((i) => i.path === k && i.code === "forbidden_field"), k);
      const m = meta();
      (m.payment as Record<string, unknown>)[k] = "x";
      const nested = parsePaymentIntake(m);
      assert.equal(nested.ok, false, `payment.${k}`);
      if (!nested.ok) assert.ok(nested.issues.some((i) => i.path === `payment.${k}` && i.code === "forbidden_field"), `payment.${k}`);
    }
  });

  it("unknown fields fail closed; an entity is mandatory and must be approved; the type must be known", () => {
    assert.ok(!parsePaymentIntake({ ...meta(), surprise: 1 }).ok);
    assert.ok(!parsePaymentIntake(meta({ entity_code: null })).ok);
    assert.ok(!parsePaymentIntake(meta({ entity_code: "PREMIER" })).ok);
    assert.ok(!parsePaymentIntake(meta({ payment_type: "mystery" })).ok);
    assert.ok(parsePaymentIntake(meta({ entity_code: "PLC" })).ok);
  });

  it("amounts and dates are validated, never defaulted", () => {
    for (const [field, value] of [["amount", 0], ["amount", -5], ["amount", 12.345], ["amount", "100"], ["amount", null], ["instruction_date", "2026-02-31"], ["instruction_date", "02/10/2026"], ["instruction_time", "25:00"], ["currency", "ringgit"]] as const) {
      const m = meta();
      (m.payment as Record<string, unknown>)[field] = value;
      assert.equal(parsePaymentIntake(m).ok, false, `${field}=${String(value)}`);
    }
  });

  it("the store only ever receives mechanical patches: status within the early set, attention flags", async () => {
    const s = new FakePaymentStore();
    s.duplicateReference = true;
    await post(s);
    for (const patch of s.patches) {
      for (const k of Object.keys(patch)) assert.ok(["status", "needs_attention", "attention_reasons"].includes(k), k);
      if (patch.status) assert.ok(["captured", "documents_pending", "ready_for_bank_match"].includes(patch.status));
    }
    // and the model of the 0024 trigger refuses everything else
    const id = s.payments[0].id;
    for (const status of ["bank_match_suggested", "bank_matched", "finance_review", "ready_for_sql", "posted_to_sql", "reconciled"] as const) {
      const bad = await s.updatePayment(id, { status: status as never });
      assert.equal(bad.ok, false, status);
    }
  });

  it("FinanceOps cannot create a payment at a human-only status", async () => {
    const s = new FakePaymentStore();
    const r = await s.insertPayment({ id: "x", entity_id: ENTITY_IDS.IETA, source_type: "financeops", intake_id: "fo_pay_hack001", payload_hash: "a".repeat(64), integration_key_id: "k", request_id: "r", source: {}, payload: {}, suggested_links: {}, payment_type: "other", claim_ref: null, payroll_ref: null, payment_instruction_date: "2026-10-02", payment_instruction_time: null, payment_method: "ibg", pay_from_account_ref: null, beneficiary_name: null, beneficiary_account_no: null, beneficiary_bank: null, amount: 1, currency: "MYR", bank_reference: null, purpose: null, required_documents: [], status: "ready_for_sql" as never, needs_attention: false, attention_reasons: [], created_by: FO_USER });
    assert.equal(r.ok, false);
  });
});

describe("fail-closed: flag, configuration, identity, entities, signature", () => {
  it("the whole module is OFF by default: even a perfectly signed request gets 503 payment_register_disabled and touches nothing", async () => {
    const s = new FakePaymentStore();
    const r = await post(s, undefined, undefined, { deps: { paymentRegisterEnabled: false } });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "payment_register_disabled");
    assert.equal(s.calls.length, 0);
    assert.equal((await post(s, undefined, undefined, { deps: { paymentRegisterEnabled: undefined } })).body.error, "payment_register_disabled");
    // the flag is checked before authentication, so it reveals nothing about the signature either
    assert.equal((await post(s, undefined, undefined, { sign: false, deps: { paymentRegisterEnabled: false } })).status, 503);
  });

  it("invoice intake being enabled does not enable payment capture; payment capture still needs the invoice integration's HMAC settings", async () => {
    const r = await post(new FakePaymentStore(), undefined, undefined, { config: readFinanceOpsConfig({ ...ENV, FINANCEOPS_INTAKE_ENABLED: "false" }) });
    assert.equal(r.body.error, "integration_disabled");
    assert.equal((await post(new FakePaymentStore(), undefined, undefined, { config: readFinanceOpsConfig({}) })).body.error, "integration_disabled");
  });

  it("no wired store -> not ready; no database credentials -> not configured; a failing session -> retryable 503", async () => {
    const parts = await build(meta(), []);
    const call = (provider: PaymentHandlerDeps["paymentStoreProvider"]) => handlePaymentIntake({ method: "POST", path: PATH, query: "", headers: signed("POST", PATH, parts.raw, parts.contentType), rawBody: parts.raw }, CONFIG, { nowSeconds: NOW, paymentRegisterEnabled: true, paymentStoreProvider: provider });
    assert.equal((await call(undefined)).body.error, "intake_persistence_not_ready");
    assert.equal((await call(async () => null)).body.error, "integration_db_not_configured");
    const boom = await call(async () => { throw new Error("FinanceOps identity sign-in failed"); });
    assert.equal(boom.status, 503);
    assert.equal(JSON.stringify(boom.body).includes("sign-in"), false);
  });

  it("unsigned or wrongly signed requests are 401 and never reach the store", async () => {
    const s = new FakePaymentStore();
    assert.equal((await post(s, undefined, undefined, { sign: false })).status, 401);
    const parts = await build(meta(), []);
    const r = await handlePaymentIntake({ method: "POST", path: PATH, query: "", headers: signed("POST", PATH, parts.raw, parts.contentType, "wrong-secret-wrong-secret-wrong-secret"), rawBody: parts.raw }, CONFIG, deps(s));
    assert.equal(r.status, 401);
    assert.equal(s.calls.length, 0);
  });

  it("an identity that is not an active data_entry registry identity writes nothing (kill switch, promotion, deactivation)", async () => {
    for (const patch of [{ role: "finance_staff" }, { role: "owner" }, { profileActive: false }, { registryActive: false }] as const) {
      const s = new FakePaymentStore();
      Object.assign(s.identityValue, patch);
      const r = await post(s);
      assert.equal(r.status, 503, JSON.stringify(patch));
      assert.equal(r.body.error, "integration_identity_inactive");
      assert.equal(s.payments.length, 0);
      assert.equal(s.documents.length, 0);
    }
  });

  it("entity limits: outside the registry list or the key's list is 403 before anything is stored", async () => {
    const reg = new FakePaymentStore();
    reg.identityValue.allowedEntityIds = [ENTITY_IDS.IEA];
    assert.equal((await post(reg)).status, 403);
    assert.equal(reg.payments.length, 0);
    const key = new FakePaymentStore();
    const narrow = readFinanceOpsConfig({ ...ENV, FINANCEOPS_ALLOWED_ENTITY_CODES_CURRENT: "IEA,PLC" });
    const r = await post(key, undefined, undefined, { config: narrow });
    assert.equal(r.status, 403);
    assert.equal(key.calls.length, 0);
  });

  it("files are re-hashed and sniffed; undeclared, missing, oversized and surplus files are refused", async () => {
    const good = (bytes: Uint8Array = SLIP): Doc[] => [{ part: "file_0", role: "payment_evidence", bytes }];
    const wrongHash = meta({}, good());
    (wrongHash.documents as { sha256: string }[])[0].sha256 = "0".repeat(64);
    assert.equal((await post(new FakePaymentStore(), wrongHash, good())).body.error, "document_hash_mismatch");
    const wrongType = meta({}, [{ part: "file_0", role: "payment_evidence", bytes: SLIP, mime: "image/png" }]);
    assert.equal((await post(new FakePaymentStore(), wrongType, good())).body.error, "content_type_mismatch");
    assert.equal((await post(new FakePaymentStore(), meta({}, good()), [], {})).status, 422); // declared, file missing
    const stray = await post(new FakePaymentStore(), meta({}, []), [], { extra: { file_3: SLIP } });
    assert.equal(stray.status, 422);
    const big = new Uint8Array(4 * 1024 * 1024 + 10);
    big.set(new TextEncoder().encode("%PDF-1.7\n"));
    assert.equal((await post(new FakePaymentStore(), meta({}, good(big)), good(big))).status, 413);
    const six = Array.from({ length: 6 }, (_, i) => ({ part: `file_${i}`, role: "other_support", bytes: new TextEncoder().encode(`%PDF-1.7\n${i}`) }));
    assert.equal((await post(new FakePaymentStore(), meta({}, six), six)).status, 422);
    const dupPart = meta({}, [...good(), { part: "file_0", role: "invoice", bytes: INVOICE }]);
    assert.equal((await post(new FakePaymentStore(), dupPart, good())).status, 422);
  });
});

describe("payment status endpoint (own captures only, operational fields only)", () => {
  it("returns progress for its own capture, including what is still missing", async () => {
    const s = new FakePaymentStore();
    await post(s, meta({}, [{ part: "file_0", role: "payment_evidence", bytes: SLIP }]), [{ part: "file_0", role: "payment_evidence", bytes: SLIP }]);
    const r = await status(s, "fo_pay_0001abc");
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "documents_pending");
    assert.deepEqual(r.body.documents_missing, ["wage_schedule"]);
    assert.deepEqual(r.body.documents_available, ["payment_evidence"]);
    assert.equal(r.body.entity_code, "IETA");
    assert.equal("idempotent_replay" in r.body, false);
  });

  it("exposes no amounts, beneficiary, account, bank or internal ids", async () => {
    const s = new FakePaymentStore();
    await post(s);
    const text = JSON.stringify((await status(s, "fo_pay_0001abc")).body);
    for (const secret of ["1250", "Ingyin", "152023754172", "8001344252", "MALAYAN", FO_USER, ENTITY_IDS.IETA, paymentIdFor("fo_pay_0001abc"), "bank_reference", "sql_"]) assert.equal(text.includes(secret), false, secret);
  });

  it("another submitter's capture (even if RLS would show it), an unknown id and a malformed id are 404", async () => {
    const s = new FakePaymentStore();
    await post(s);
    s.payments[0].created_by = "99999999-9999-4999-8999-999999999999";
    assert.equal((await status(s, "fo_pay_0001abc")).status, 404);
    assert.equal((await status(s, "fo_pay_nosuch01")).status, 404);
    assert.equal((await status(s, "../etc")).status, 404);
  });

  it("is HMAC-protected, GET only, flag-gated and fails closed on an inactive identity", async () => {
    const s = new FakePaymentStore();
    await post(s);
    assert.equal((await status(s, "fo_pay_0001abc", { sign: false })).status, 401);
    assert.equal((await status(s, "fo_pay_0001abc", { method: "POST" })).status, 405);
    assert.equal((await status(s, "fo_pay_0001abc", { deps: { paymentRegisterEnabled: false } })).body.error, "payment_register_disabled");
    s.identityValue.registryActive = false;
    const r = await status(s, "fo_pay_0001abc");
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "integration_identity_inactive");
  });
});

describe("scope: the FinanceOps-facing payment code cannot reach bank data, matches, SQL fields or payments", () => {
  const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const facing = ["persist.ts", "handler.ts", "store.ts", "store-supabase.ts", "intake-schema.ts", "db.ts"].map((f) => ({ name: f, code: read(`lib/financeops/payments/${f}`) }));
  const routes = ["app/api/integrations/financeops/v1/payment-intakes/route.ts", "app/api/integrations/financeops/v1/payment-intakes/[intake_id]/route.ts"].map((f) => ({ name: f, code: read(f) }));

  it("never names a bank table, the matches table, official payment tables, SQL posting fields or a service-role key", () => {
    const bad = /finance_bank_|finance_payment_bank_matches|bill_payments|payment_vouchers|bank_accounts|bank_transactions|reconciliation_matches|service[_-]?role|SERVICE_ROLE|sql_reference|sql_posting|posted_to_sql|reconciled_by|ready_for_sql/;
    // intake-schema.ts legitimately NAMES these fields: it is the deny-list that rejects them
    for (const f of [...facing, ...routes].filter((x) => x.name !== "intake-schema.ts")) assert.equal(bad.test(f.code), false, f.name);
    assert.equal(/service[_-]?role|SERVICE_ROLE/.test(facing.find((x) => x.name === "intake-schema.ts")!.code), false);
  });

  it("the store touches only the payment register and its documents (plus the shared identity reads) and never deletes or upserts", () => {
    const code = facing.find((f) => f.name === "store-supabase.ts")!.code;
    const tables = Array.from(new Set(Array.from(code.matchAll(/\.from\("([a-z_]+)"\)/g)).map((m) => m[1]))).sort();
    assert.deepEqual(tables, ["finance_payment_documents", "finance_payment_register"]);
    assert.deepEqual(Array.from(code.matchAll(/storage\.from\("([^"]+)"\)/g)).map((m) => m[1]), ["finance-payment-documents"]);
    assert.equal(/\.delete\(|\.upsert\(/.test(code), false);
    assert.deepEqual(Array.from(code.matchAll(/\.from\("([a-z_]+)"\)\s*\.update\(/g)).map((m) => m[1]), ["finance_payment_register"]);
    assert.deepEqual(Array.from(code.matchAll(/\.from\("([a-z_]+)"\)\s*\.insert\(/g)).map((m) => m[1]).sort(), ["finance_payment_documents", "finance_payment_register"]);
  });

  it("only the invoice-integration prefix is exempt from the cookie gate; payment capture adds no new exemption", () => {
    const text = readFileSync(join(ROOT, "lib/financeops/routes.ts"), "utf8");
    assert.equal(Array.from(text.matchAll(/FINANCEOPS_API_PREFIX\s*=\s*"([^"]+)"/g)).length, 1);
    assert.match(text, /\/api\/integrations\/financeops\/v1\//);
  });
});
