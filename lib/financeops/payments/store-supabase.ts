import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyDbError, type RawDbError, type Res } from "../store";
import { createSupabaseIntakeStore } from "../store-supabase";
import type { NewPayment, NewPaymentDocument, PaymentDocRef, PaymentPatch, PaymentRow, PaymentStore } from "./store";

/**
 * PaymentStore backed by a supabase-js client signed in AS THE FINANCEOPS IDENTITY (data_entry). Never give it a
 * service-role client. It touches exactly: finance_payment_register, finance_payment_documents (+ the private
 * finance-payment-documents bucket) and, through the shared identity helpers, app_profiles / the registry / entities.
 */

const fail = <T,>(err: RawDbError): Res<T> => ({ ok: false, error: classifyDbError(err) });
const ok = <T,>(value: T): Res<T> => ({ ok: true, value });
const thrown = <T,>(e: unknown): Res<T> => ({ ok: false, error: { kind: "unavailable", message: e instanceof Error ? e.message : "request failed" } });

const PAYMENT_COLUMNS = "id, entity_id, intake_id, payload_hash, payment_type, status, needs_attention, attention_reasons, required_documents, created_by, source_type, created_at, updated_at";

export function createSupabasePaymentStore(client: SupabaseClient): PaymentStore {
  const shared = createSupabaseIntakeStore(client);
  return {
    identity: () => shared.identity(),
    entityByCode: (code) => shared.entityByCode(code),
    entityById: (id) => shared.entityById(id),

    async insertPayment(row: NewPayment): Promise<Res<PaymentRow>> {
      try {
        const r = await client.from("finance_payment_register").insert(row).select(PAYMENT_COLUMNS).single();
        if (r.error) return fail(r.error);
        return ok(r.data as unknown as PaymentRow);
      } catch (e) {
        return thrown(e);
      }
    },

    async getPaymentByIntake(intakeId: string): Promise<Res<PaymentRow | null>> {
      try {
        const r = await client.from("finance_payment_register").select(PAYMENT_COLUMNS).eq("intake_id", intakeId).maybeSingle();
        if (r.error) return fail(r.error);
        return ok((r.data as unknown as PaymentRow | null) ?? null);
      } catch (e) {
        return thrown(e);
      }
    },

    async updatePayment(id: string, patch: PaymentPatch): Promise<Res<PaymentRow>> {
      try {
        const r = await client.from("finance_payment_register").update(patch).eq("id", id).select(PAYMENT_COLUMNS).single();
        if (r.error) return fail(r.error);
        return ok(r.data as unknown as PaymentRow);
      } catch (e) {
        return thrown(e);
      }
    },

    async listPaymentDocuments(paymentId: string): Promise<Res<PaymentDocRef[]>> {
      try {
        const r = await client.from("finance_payment_documents").select("id, doc_role, file_hash, removed_at").eq("payment_register_id", paymentId).limit(200);
        if (r.error) return fail(r.error);
        return ok((r.data ?? []) as unknown as PaymentDocRef[]);
      } catch (e) {
        return thrown(e);
      }
    },

    async uploadPaymentObject(path: string, bytes: Uint8Array, contentType: string) {
      try {
        const r = await client.storage.from("finance-payment-documents").upload(path, bytes, { contentType, upsert: false });
        if (!r.error) return ok({ alreadyExisted: false });
        const status = String((r.error as { statusCode?: string | number }).statusCode ?? "");
        if (status === "409" || /already exists/i.test(r.error.message)) return ok({ alreadyExisted: true });
        return { ok: false as const, error: { kind: "unavailable" as const, message: r.error.message } };
      } catch (e) {
        return thrown(e);
      }
    },

    async insertPaymentDocument(row: NewPaymentDocument): Promise<Res<null>> {
      try {
        const r = await client.from("finance_payment_documents").insert(row);
        if (r.error) return fail(r.error);
        return ok(null);
      } catch (e) {
        return thrown(e);
      }
    },

    async findPossibleDuplicates(p) {
      try {
        let byRef = false;
        if (p.bankReference) {
          const r = await client.from("finance_payment_register").select("id").eq("entity_id", p.entityId).eq("bank_reference", p.bankReference).neq("id", p.excludeId).limit(1);
          if (r.error) return fail(r.error);
          byRef = (r.data ?? []).length > 0;
        }
        let same = false;
        if (p.beneficiaryAccountNo) {
          const r = await client.from("finance_payment_register").select("id").eq("entity_id", p.entityId).eq("beneficiary_account_no", p.beneficiaryAccountNo).eq("amount", p.amount).eq("payment_instruction_date", p.instructionDate).neq("id", p.excludeId).limit(1);
          if (r.error) return fail(r.error);
          same = (r.data ?? []).length > 0;
        }
        return ok({ bankReference: byRef, samePayment: same });
      } catch (e) {
        return thrown(e);
      }
    },
  };
}
