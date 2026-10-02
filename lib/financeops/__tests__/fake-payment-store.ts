import type { EntityRef, FinanceOpsIdentity, Res, StoreError } from "../store";
import type { DuplicateProbe, NewPayment, NewPaymentDocument, PaymentDocRef, PaymentPatch, PaymentRow, PaymentStore } from "../payments/store";
import { ENTITY_IDS, FO_USER } from "./fake-store";

/**
 * In-memory PaymentStore modelling the parts of 0024 the capture flow depends on: unique intake_id, the FinanceOps
 * insert and update limits (early statuses only, mechanical columns only), unique live document hash per payment.
 * A TEST DOUBLE: the real rules are proven by the 0024 pgTAP suite and the opt-in local integration test.
 */

export class FakePaymentStore implements PaymentStore {
  identityValue: FinanceOpsIdentity = { userId: FO_USER, role: "data_entry", profileActive: true, registryActive: true, allowedEntityIds: Object.values(ENTITY_IDS) };
  payments: (PaymentRow & Record<string, unknown>)[] = [];
  hidden: (Partial<PaymentRow> & { intake_id: string })[] = [];
  documents: (NewPaymentDocument & { removed_at: string | null })[] = [];
  objects = new Map<string, Uint8Array>();
  patches: PaymentPatch[] = [];
  calls: string[] = [];
  /** probe results to simulate pre-existing payments */
  duplicateReference = false;
  samePayment = false;
  private fails: { method: string; nth?: number; times: number; error: StoreError }[] = [];
  private counts: Record<string, number> = {};
  private seq = 0;

  failOn(method: keyof PaymentStore, over: { nth?: number; error?: StoreError } = {}): this {
    this.fails.push({ method, nth: over.nth, times: 1, error: over.error ?? { kind: "unavailable", message: `injected failure in ${method}` } });
    return this;
  }

  private gate(method: string): StoreError | null {
    this.calls.push(method);
    this.counts[method] = (this.counts[method] ?? 0) + 1;
    for (const f of this.fails) {
      if (f.method !== method || f.times <= 0) continue;
      if (f.nth !== undefined && f.nth !== this.counts[method]) continue;
      f.times -= 1;
      return f.error;
    }
    return null;
  }
  private err<T>(e: StoreError): Res<T> { return { ok: false, error: e }; }

  async identity(): Promise<Res<FinanceOpsIdentity>> { const f = this.gate("identity"); return f ? this.err(f) : { ok: true, value: this.identityValue }; }
  async entityByCode(code: string): Promise<Res<EntityRef | null>> { const f = this.gate("entityByCode"); return f ? this.err(f) : { ok: true, value: ENTITY_IDS[code] ? { id: ENTITY_IDS[code], code } : null }; }
  async entityById(id: string): Promise<Res<EntityRef | null>> {
    const f = this.gate("entityById");
    if (f) return this.err(f);
    const code = Object.keys(ENTITY_IDS).find((c) => ENTITY_IDS[c] === id);
    return { ok: true, value: code ? { id, code } : null };
  }

  async insertPayment(row: NewPayment): Promise<Res<PaymentRow>> {
    const f = this.gate("insertPayment");
    if (f) return this.err(f);
    if (row.created_by !== this.identityValue.userId) return this.err({ kind: "denied", message: "new row violates row-level security policy" });
    if (!["captured", "documents_pending", "ready_for_bank_match"].includes(row.status)) return this.err({ kind: "rejected", message: "FinanceOps may only capture a payment as captured, documents_pending or ready_for_bank_match" });
    if (this.payments.some((p) => p.intake_id === row.intake_id) || this.hidden.some((p) => p.intake_id === row.intake_id)) {
      return this.err({ kind: "conflict", constraint: "fpr_intake_id_uidx", message: 'duplicate key value violates unique constraint "fpr_intake_id_uidx"' });
    }
    this.seq += 1;
    const stored = { ...row, created_at: new Date(Date.UTC(2026, 9, 3, 1, 0, this.seq)).toISOString(), updated_at: new Date(Date.UTC(2026, 9, 3, 1, 0, this.seq)).toISOString() } as unknown as PaymentRow & Record<string, unknown>;
    this.payments.push(stored);
    return { ok: true, value: { ...stored } };
  }

  async getPaymentByIntake(intakeId: string): Promise<Res<PaymentRow | null>> {
    const f = this.gate("getPaymentByIntake");
    if (f) return this.err(f);
    const p = this.payments.find((x) => x.intake_id === intakeId);
    return { ok: true, value: p ? { ...p } : null };
  }

  async updatePayment(id: string, patch: PaymentPatch): Promise<Res<PaymentRow>> {
    const f = this.gate("updatePayment");
    if (f) return this.err(f);
    this.patches.push(patch);
    const p = this.payments.find((x) => x.id === id);
    if (!p) return this.err({ kind: "denied", message: "no row" });
    const early = ["captured", "documents_pending", "ready_for_bank_match", "bank_match_suggested"];
    if (patch.status && patch.status !== p.status && (!["captured", "documents_pending", "ready_for_bank_match"].includes(patch.status) || !early.includes(p.status))) {
      return this.err({ kind: "rejected", message: "The FinanceOps identity can only move its own payment between captured, documents_pending and ready_for_bank_match" });
    }
    Object.assign(p, patch, { updated_at: new Date(Date.UTC(2026, 9, 3, 2, 0, ++this.seq)).toISOString() });
    return { ok: true, value: { ...p } };
  }

  async listPaymentDocuments(paymentId: string): Promise<Res<PaymentDocRef[]>> {
    const f = this.gate("listPaymentDocuments");
    if (f) return this.err(f);
    return { ok: true, value: this.documents.filter((d) => d.payment_register_id === paymentId).map((d) => ({ id: d.id, doc_role: d.doc_role, file_hash: d.file_hash, removed_at: d.removed_at })) };
  }

  async uploadPaymentObject(path: string, bytes: Uint8Array): Promise<Res<{ alreadyExisted: boolean }>> {
    const f = this.gate("uploadPaymentObject");
    if (f) return this.err(f);
    const existed = this.objects.has(path);
    this.objects.set(path, bytes);
    return { ok: true, value: { alreadyExisted: existed } };
  }

  async insertPaymentDocument(row: NewPaymentDocument): Promise<Res<null>> {
    const f = this.gate("insertPaymentDocument");
    if (f) return this.err(f);
    if (this.documents.some((d) => d.id === row.id)) return this.err({ kind: "conflict", constraint: "finance_payment_documents_pkey", message: "duplicate key" });
    if (this.documents.some((d) => d.payment_register_id === row.payment_register_id && d.file_hash === row.file_hash && d.removed_at === null)) return this.err({ kind: "conflict", constraint: "fpd_live_hash_uidx", message: "duplicate key" });
    this.documents.push({ ...row, removed_at: null });
    return { ok: true, value: null };
  }

  async findPossibleDuplicates(_probe: DuplicateProbe): Promise<Res<{ bankReference: boolean; samePayment: boolean }>> {
    const f = this.gate("findPossibleDuplicates");
    return f ? this.err(f) : { ok: true, value: { bankReference: this.duplicateReference, samePayment: this.samePayment } };
  }
}
