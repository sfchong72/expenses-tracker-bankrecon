import { deterministicUuid } from "../ids";
import type { EntityRef, FinanceOpsIdentity, Res } from "../store";
import type { DocRole, PaymentMethod, PaymentStatus, PaymentType } from "./types";

/**
 * Persistence port for the Hermes payment capture. As with invoice intake, the production implementation runs as the
 * FinanceOps identity's OWN Supabase session (data_entry): RLS and the 0024 triggers are the authority. It can read
 * and write only the payment register and its documents; there is no path to bank rows, matches or SQL fields.
 */

export const paymentIdFor = (intakeId: string): string => deterministicUuid("financeops-payment", intakeId);
export const paymentDocumentIdFor = (intakeId: string, part: string): string => deterministicUuid("financeops-payment-document", `${intakeId}:${part}`);

export type PaymentRow = {
  id: string;
  entity_id: string;
  intake_id: string | null;
  payload_hash: string | null;
  payment_type: PaymentType;
  status: PaymentStatus;
  needs_attention: boolean;
  attention_reasons: string[];
  required_documents: DocRole[];
  created_by: string | null;
  source_type: string;
  created_at: string;
  updated_at: string;
};

export type NewPayment = {
  id: string;
  entity_id: string;
  source_type: "financeops";
  intake_id: string;
  payload_hash: string;
  integration_key_id: string;
  request_id: string;
  source: Record<string, unknown>;
  payload: Record<string, unknown>;
  suggested_links: Record<string, unknown>;
  payment_type: PaymentType;
  claim_ref: string | null;
  payroll_ref: string | null;
  payment_instruction_date: string;
  payment_instruction_time: string | null;
  payment_method: PaymentMethod;
  pay_from_account_ref: string | null;
  beneficiary_name: string | null;
  beneficiary_account_no: string | null;
  beneficiary_bank: string | null;
  amount: number;
  currency: string;
  bank_reference: string | null;
  purpose: string | null;
  required_documents: DocRole[];
  status: "captured";
  needs_attention: boolean;
  attention_reasons: string[];
  created_by: string;
};

/** The only columns FinanceOps ever advances on its own payment (0024 enforces the same set). */
export type PaymentPatch = Partial<{ status: "captured" | "documents_pending" | "ready_for_bank_match"; needs_attention: boolean; attention_reasons: string[] }>;

export type PaymentDocRef = { id: string; doc_role: DocRole; file_hash: string; removed_at: string | null };

export type NewPaymentDocument = {
  id: string;
  payment_register_id: string;
  entity_id: string;
  doc_role: DocRole;
  storage_path: string;
  original_filename: string;
  mime_type: string;
  file_size: number;
  file_hash: string;
  uploaded_by: string;
};

export type DuplicateProbe = { entityId: string; excludeId: string; bankReference: string | null; beneficiaryAccountNo: string | null; amount: number; instructionDate: string };

export interface PaymentStore {
  identity(): Promise<Res<FinanceOpsIdentity>>;
  entityByCode(code: string): Promise<Res<EntityRef | null>>;
  entityById(id: string): Promise<Res<EntityRef | null>>;
  insertPayment(row: NewPayment): Promise<Res<PaymentRow>>;
  getPaymentByIntake(intakeId: string): Promise<Res<PaymentRow | null>>;
  updatePayment(id: string, patch: PaymentPatch): Promise<Res<PaymentRow>>;
  listPaymentDocuments(paymentId: string): Promise<Res<PaymentDocRef[]>>;
  uploadPaymentObject(path: string, bytes: Uint8Array, contentType: string): Promise<Res<{ alreadyExisted: boolean }>>;
  insertPaymentDocument(row: NewPaymentDocument): Promise<Res<null>>;
  findPossibleDuplicates(probe: DuplicateProbe): Promise<Res<{ bankReference: boolean; samePayment: boolean }>>;
}
