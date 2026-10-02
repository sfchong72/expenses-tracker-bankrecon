import type { ExistingBill, ExistingDocumentLink } from "../duplicates";
import type {
  BillRef,
  EntityRef,
  FinanceOpsIdentity,
  IntakePatch,
  IntakeRow,
  IntakeStore,
  NewBill,
  NewDocument,
  NewDocumentLink,
  NewIntake,
  Res,
  StoreError,
} from "../store";
import type { SafeCategory, SafeSupplier } from "../supplier-match";

/**
 * In-memory IntakeStore that models the parts of 0023 / Stage 1B the application relies on (unique intake_id,
 * unique successor, insert rules, set-once links, forward-only states, same-entity draft bill, document hash,
 * integration identity limited to mechanical columns). It is a TEST DOUBLE: the real rules are proven by the
 * 240-assertion pgTAP suite and by the opt-in local integration test.
 */

export const FO_USER = "f0f0f0f0-0000-4000-8000-000000000001";
export const ENTITY_IDS: Record<string, string> = {
  IEA: "e1000000-0000-4000-8000-000000000001",
  IETA: "e1000000-0000-4000-8000-000000000002",
  PLC: "e1000000-0000-4000-8000-000000000003",
  KALER: "e1000000-0000-4000-8000-000000000004",
};

export type FailSpec = { method: keyof IntakeStore; nth?: number; error?: StoreError; times?: number };

export class FakeStore implements IntakeStore {
  identityValue: FinanceOpsIdentity = { userId: FO_USER, role: "data_entry", profileActive: true, registryActive: true, allowedEntityIds: Object.values(ENTITY_IDS) };
  intakes: IntakeRow[] = [];
  /** other users' intakes, invisible to this identity (RLS: creator reads own) */
  hiddenIntakes: IntakeRow[] = [];
  bills: (NewBill & { created_by: string })[] = [];
  documents: NewDocument[] = [];
  links: NewDocumentLink[] = [];
  objects = new Map<string, Uint8Array>();
  suppliers: { entityId: string; supplier: SafeSupplier }[] = [];
  categories: SafeCategory[] = [];
  /** pre-existing world: bills (already visible) and their documents/links */
  existingBills: ExistingBill[] = [];
  existingDocuments: ExistingDocumentLink[] = [];
  patches: IntakePatch[] = [];
  calls: string[] = [];
  private counts: Record<string, number> = {};
  private fails: FailSpec[] = [];
  private seq = 0;

  failOn(spec: FailSpec): this {
    this.fails.push({ times: 1, ...spec });
    return this;
  }

  private gate(method: keyof IntakeStore): StoreError | null {
    this.calls.push(method);
    this.counts[method] = (this.counts[method] ?? 0) + 1;
    for (const f of this.fails) {
      if (f.method !== method || (f.times ?? 1) <= 0) continue;
      if (f.nth !== undefined && f.nth !== this.counts[method]) continue;
      f.times = (f.times ?? 1) - 1;
      return f.error ?? { kind: "unavailable", message: `injected failure in ${method}` };
    }
    return null;
  }

  private err<T>(e: StoreError): Res<T> {
    return { ok: false, error: e };
  }

  async identity(): Promise<Res<FinanceOpsIdentity>> {
    const f = this.gate("identity");
    return f ? this.err(f) : { ok: true, value: this.identityValue };
  }

  async entityByCode(code: string): Promise<Res<EntityRef | null>> {
    const f = this.gate("entityByCode");
    if (f) return this.err(f);
    return { ok: true, value: ENTITY_IDS[code] ? { id: ENTITY_IDS[code], code } : null };
  }

  async entityById(id: string): Promise<Res<EntityRef | null>> {
    const f = this.gate("entityById");
    if (f) return this.err(f);
    const code = Object.keys(ENTITY_IDS).find((c) => ENTITY_IDS[c] === id);
    return { ok: true, value: code ? { id, code } : null };
  }

  async insertIntake(row: NewIntake): Promise<Res<IntakeRow>> {
    const f = this.gate("insertIntake");
    if (f) return this.err(f);
    if (row.created_by !== this.identityValue.userId) return this.err({ kind: "denied", message: "new row violates row-level security policy" });
    if (this.intakes.some((r) => r.intake_id === row.intake_id) || this.hiddenIntakes.some((r) => r.intake_id === row.intake_id)) {
      return this.err({ kind: "conflict", constraint: "fis_intake_id_key", message: 'duplicate key value violates unique constraint "fis_intake_id_key"' });
    }
    if (row.supersedes_intake_id) {
      if (row.entity_id === null) return this.err({ kind: "constraint", constraint: "fis_supersede_has_entity", message: 'violates check constraint "fis_supersede_has_entity"' });
      if (row.supersedes_intake_id === row.intake_id) return this.err({ kind: "constraint", constraint: "fis_no_self_supersede", message: 'violates check constraint "fis_no_self_supersede"' });
      const original = this.intakes.find((r) => r.intake_id === row.supersedes_intake_id);
      if (!original) return this.err({ kind: "rejected", message: "The intake to supersede was not found" });
      if (original.entity_id !== null) return this.err({ kind: "rejected", message: "intake_already_resolved: the original intake already has an entity" });
      if (original.review_status === "rejected") return this.err({ kind: "rejected", message: "A rejected intake cannot be superseded" });
      if (this.intakes.some((r) => r.supersedes_intake_id === row.supersedes_intake_id)) {
        return this.err({ kind: "conflict", constraint: "fis_supersedes_uidx", message: 'duplicate key value violates unique constraint "fis_supersedes_uidx"' });
      }
    }
    this.seq += 1;
    const now = new Date(Date.UTC(2026, 9, 2, 3, 0, this.seq)).toISOString();
    const stored: IntakeRow = {
      id: `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`,
      intake_id: row.intake_id,
      payload_hash: row.payload_hash,
      entity_code_declared: row.entity_code_declared,
      entity_id: row.entity_id,
      supplier_bill_id: null,
      document_id: null,
      document_sha256: row.document_sha256,
      document_mime_type: row.document_mime_type,
      document_filename: row.document_filename,
      document_size_bytes: row.document_size_bytes,
      flags: row.flags,
      duplicate_matches: row.duplicate_matches,
      process_state: row.entity_id === null ? "awaiting_entity" : "received",
      review_status: row.review_status,
      entity_resolved_at: null,
      supersedes_intake_id: row.supersedes_intake_id,
      created_by: row.created_by,
      created_at: now,
      updated_at: now,
    };
    this.intakes.push(stored);
    return { ok: true, value: { ...stored } };
  }

  async getIntake(intakeId: string): Promise<Res<IntakeRow | null>> {
    const f = this.gate("getIntake");
    if (f) return this.err(f);
    const r = this.intakes.find((x) => x.intake_id === intakeId);
    return { ok: true, value: r ? { ...r } : null };
  }

  async updateIntake(rowId: string, patch: IntakePatch): Promise<Res<IntakeRow>> {
    const f = this.gate("updateIntake");
    if (f) return this.err(f);
    this.patches.push(patch);
    const row = this.intakes.find((r) => r.id === rowId);
    if (!row) return this.err({ kind: "denied", message: "no row" });
    if (row.review_status === "data_verified" || row.review_status === "rejected") return this.err({ kind: "rejected", message: `A finance intake that is ${row.review_status} cannot be changed` });
    if (patch.review_status !== undefined && patch.review_status !== row.review_status && !(row.review_status === "pending_review" && (patch.review_status === "duplicate_suspected" || patch.review_status === "needs_attention"))) {
      return this.err({ kind: "rejected", message: "The FinanceOps integration identity can only flag an intake as duplicate_suspected or needs_attention" });
    }
    const next = { ...row, ...patch };
    if (patch.supplier_bill_id !== undefined && patch.supplier_bill_id !== row.supplier_bill_id) {
      if (row.supplier_bill_id !== null) return this.err({ kind: "rejected", message: "The supplier bill link can only be set once" });
      const bill = this.bills.find((b) => b.id === patch.supplier_bill_id);
      if (!bill || bill.entity_id !== row.entity_id) return this.err({ kind: "rejected", message: "The supplier bill belongs to a different entity than the intake" });
      if (bill.payment_status !== "draft") return this.err({ kind: "rejected", message: "An intake can only be linked to a draft supplier bill" });
    }
    if (patch.document_id !== undefined && patch.document_id !== row.document_id) {
      if (row.document_id !== null) return this.err({ kind: "rejected", message: "The document link can only be set once" });
      const doc = this.documents.find((d) => d.id === patch.document_id);
      const linked = this.links.some((l) => l.document_id === patch.document_id);
      if (!doc || !linked) return this.err({ kind: "rejected", message: "The linked document must be the original file of the same entity" });
      if (doc.entity_id !== row.entity_id || doc.file_hash !== row.document_sha256) return this.err({ kind: "rejected", message: "The linked document must be the original file of the same entity" });
    }
    if (patch.process_state !== undefined && patch.process_state !== row.process_state) {
      const order = ["awaiting_entity", "received", "bill_created", "document_attached", "complete"];
      if (order.indexOf(patch.process_state) <= order.indexOf(row.process_state)) return this.err({ kind: "rejected", message: "process_state can only move forward" });
      if (["bill_created", "document_attached", "complete"].includes(patch.process_state) && !next.supplier_bill_id) return this.err({ kind: "rejected", message: "process_state requires a linked supplier bill" });
      if (["document_attached", "complete"].includes(patch.process_state) && !next.document_id) return this.err({ kind: "rejected", message: "process_state requires a linked document" });
    }
    Object.assign(row, patch, { updated_at: new Date(Date.UTC(2026, 9, 2, 4, 0, ++this.seq)).toISOString() });
    return { ok: true, value: { ...row } };
  }

  async loadSuppliers(entityId: string): Promise<Res<SafeSupplier[]>> {
    const f = this.gate("loadSuppliers");
    return f ? this.err(f) : { ok: true, value: this.suppliers.filter((s) => s.entityId === entityId).map((s) => s.supplier) };
  }

  async loadCategories(): Promise<Res<SafeCategory[]>> {
    const f = this.gate("loadCategories");
    return f ? this.err(f) : { ok: true, value: this.categories };
  }

  async loadDuplicateContext(): Promise<Res<{ bills: ExistingBill[]; documents: ExistingDocumentLink[] }>> {
    const f = this.gate("loadDuplicateContext");
    if (f) return this.err(f);
    // our own earlier work is visible too (bills and, once linked, documents)
    const mine: ExistingBill[] = this.bills.map((b) => ({ id: b.id, entityId: b.entity_id, supplierId: b.supplier_id, billNumber: b.bill_number, totalAmount: b.total_amount, billDate: b.bill_date, paymentStatus: b.payment_status }));
    const myDocs: ExistingDocumentLink[] = this.links.map((l) => ({ fileSha256: this.documents.find((d) => d.id === l.document_id)?.file_hash ?? null, billId: l.linked_record_id, deleted: false }));
    return { ok: true, value: { bills: [...this.existingBills, ...mine], documents: [...this.existingDocuments, ...myDocs] } };
  }

  async getBill(id: string): Promise<Res<BillRef | null>> {
    const f = this.gate("getBill");
    if (f) return this.err(f);
    const b = this.bills.find((x) => x.id === id);
    return { ok: true, value: b ? { id: b.id, entity_id: b.entity_id, created_by: b.created_by, payment_status: b.payment_status } : null };
  }

  async insertBill(row: NewBill): Promise<Res<BillRef>> {
    const f = this.gate("insertBill");
    if (f) return this.err(f);
    if (row.payment_status !== "draft" || row.created_by !== this.identityValue.userId) return this.err({ kind: "denied", message: "new row violates row-level security policy for table supplier_bills" });
    if (this.bills.some((b) => b.id === row.id)) return this.err({ kind: "conflict", constraint: "supplier_bills_pkey", message: 'duplicate key value violates unique constraint "supplier_bills_pkey"' });
    this.bills.push(row);
    return { ok: true, value: { id: row.id, entity_id: row.entity_id, created_by: row.created_by, payment_status: row.payment_status } };
  }

  async uploadObject(path: string, bytes: Uint8Array): Promise<Res<{ alreadyExisted: boolean }>> {
    const f = this.gate("uploadObject");
    if (f) return this.err(f);
    const existed = this.objects.has(path);
    this.objects.set(path, bytes);
    return { ok: true, value: { alreadyExisted: existed } };
  }

  async insertDocument(row: NewDocument): Promise<Res<null>> {
    const f = this.gate("insertDocument");
    if (f) return this.err(f);
    if (this.documents.some((d) => d.id === row.id)) return this.err({ kind: "conflict", constraint: "documents_pkey", message: 'duplicate key value violates unique constraint "documents_pkey"' });
    this.documents.push(row);
    return { ok: true, value: null };
  }

  async linkDocument(row: NewDocumentLink): Promise<Res<null>> {
    const f = this.gate("linkDocument");
    if (f) return this.err(f);
    if (this.links.some((l) => l.document_id === row.document_id && l.linked_record_id === row.linked_record_id)) {
      return this.err({ kind: "conflict", constraint: "document_links_document_id_linked_record_type_linked_record_id_key", message: "duplicate key value violates unique constraint" });
    }
    this.links.push(row);
    return { ok: true, value: null };
  }
}
