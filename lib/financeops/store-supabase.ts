import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExistingBill, ExistingDocumentLink } from "./duplicates";
import {
  classifyDbError,
  type EntityRef,
  type FinanceOpsIdentity,
  type IntakePatch,
  type IntakeRow,
  type IntakeStore,
  type NewBill,
  type NewDocument,
  type NewDocumentLink,
  type NewIntake,
  type RawDbError,
  type Res,
} from "./store";
import type { SafeCategory, SafeSupplier } from "./supplier-match";

/**
 * IntakeStore backed by a supabase-js client that is signed in AS THE FINANCEOPS IDENTITY (a data_entry user).
 * It must never be given a service-role client: every statement here relies on RLS and the 0023 / Stage 1B
 * triggers to be the authority. Reads of other tables use only columns/views a data_entry user is allowed to see.
 */

const fail = <T,>(err: RawDbError): Res<T> => ({ ok: false, error: classifyDbError(err) });
const ok = <T,>(value: T): Res<T> => ({ ok: true, value });
const thrown = <T,>(e: unknown): Res<T> => ({ ok: false, error: { kind: "unavailable", message: e instanceof Error ? e.message : "request failed" } });

const INTAKE_COLUMNS =
  "id, intake_id, payload_hash, entity_code_declared, entity_id, supplier_bill_id, document_id, document_sha256, document_mime_type, document_filename, document_size_bytes, flags, duplicate_matches, process_state, review_status, entity_resolved_at, supersedes_intake_id, created_by, created_at, updated_at";

const PAGE = 5000;

export function createSupabaseIntakeStore(client: SupabaseClient): IntakeStore {
  return {
    async identity(): Promise<Res<FinanceOpsIdentity>> {
      try {
        const session = await client.auth.getSession();
        const userId = session.data.session?.user.id;
        if (!userId) return { ok: false, error: { kind: "unavailable", message: "no FinanceOps session" } };
        const profile = await client.from("app_profiles").select("role, active_status").eq("id", userId).maybeSingle();
        if (profile.error) return fail(profile.error);
        const registry = await client.from("finance_integration_identities").select("active_status, allowed_entity_ids, integration").eq("user_id", userId).maybeSingle();
        if (registry.error) return fail(registry.error);
        return ok({
          userId,
          role: profile.data?.role ?? null,
          profileActive: profile.data?.active_status === true,
          registryActive: registry.data?.active_status === true && registry.data?.integration === "financeops",
          allowedEntityIds: Array.isArray(registry.data?.allowed_entity_ids) ? (registry.data?.allowed_entity_ids as string[]) : [],
        });
      } catch (e) {
        return thrown(e);
      }
    },

    async entityByCode(code: string): Promise<Res<EntityRef | null>> {
      try {
        const r = await client.from("entities").select("id, short_code").eq("short_code", code).maybeSingle();
        if (r.error) return fail(r.error);
        return ok(r.data ? { id: r.data.id as string, code: r.data.short_code as string } : null);
      } catch (e) {
        return thrown(e);
      }
    },

    async entityById(id: string): Promise<Res<EntityRef | null>> {
      try {
        const r = await client.from("entities").select("id, short_code").eq("id", id).maybeSingle();
        if (r.error) return fail(r.error);
        return ok(r.data ? { id: r.data.id as string, code: r.data.short_code as string } : null);
      } catch (e) {
        return thrown(e);
      }
    },

    async insertIntake(row: NewIntake): Promise<Res<IntakeRow>> {
      try {
        const r = await client.from("finance_intake_submissions").insert(row).select(INTAKE_COLUMNS).single();
        if (r.error) return fail(r.error);
        return ok(r.data as unknown as IntakeRow);
      } catch (e) {
        return thrown(e);
      }
    },

    async getIntake(intakeId: string): Promise<Res<IntakeRow | null>> {
      try {
        const r = await client.from("finance_intake_submissions").select(INTAKE_COLUMNS).eq("intake_id", intakeId).maybeSingle();
        if (r.error) return fail(r.error);
        return ok((r.data as unknown as IntakeRow | null) ?? null);
      } catch (e) {
        return thrown(e);
      }
    },

    async updateIntake(rowId: string, patch: IntakePatch): Promise<Res<IntakeRow>> {
      try {
        const r = await client.from("finance_intake_submissions").update(patch).eq("id", rowId).select(INTAKE_COLUMNS).single();
        if (r.error) return fail(r.error);
        return ok(r.data as unknown as IntakeRow);
      } catch (e) {
        return thrown(e);
      }
    },

    async loadSuppliers(entityId: string): Promise<Res<SafeSupplier[]>> {
      try {
        // suppliers_app_safe is the projection without bank details; supplier_entities narrows it to this entity.
        const [links, suppliers] = await Promise.all([
          client.from("supplier_entities").select("supplier_id").eq("entity_id", entityId).range(0, PAGE - 1),
          client.from("suppliers_app_safe").select("id, supplier_name, registration_number, active_status, archived_at").range(0, PAGE - 1),
        ]);
        if (links.error) return fail(links.error);
        if (suppliers.error) return fail(suppliers.error);
        const inEntity = new Set((links.data ?? []).map((l) => l.supplier_id as string));
        return ok(
          (suppliers.data ?? [])
            .filter((s) => inEntity.has(s.id as string))
            .map((s) => ({
              id: s.id as string,
              supplierName: s.supplier_name as string,
              registrationNumber: (s.registration_number as string | null) ?? null,
              activeStatus: s.active_status === true,
              archivedAt: (s.archived_at as string | null) ?? null,
            })),
        );
      } catch (e) {
        return thrown(e);
      }
    },

    async loadCategories(entityId: string): Promise<Res<SafeCategory[]>> {
      try {
        const r = await client
          .from("categories")
          .select("id, name")
          .eq("category_type", "expense")
          .eq("active_status", true)
          .or(`entity_id.is.null,entity_id.eq.${entityId}`)
          .range(0, PAGE - 1);
        if (r.error) return fail(r.error);
        return ok((r.data ?? []).map((c) => ({ id: c.id as string, name: c.name as string })));
      } catch (e) {
        return thrown(e);
      }
    },

    async loadDuplicateContext(query): Promise<Res<{ bills: ExistingBill[]; documents: ExistingDocumentLink[] }>> {
      try {
        const docs = await client.from("documents").select("id, file_hash, deleted_at").eq("file_hash", query.fileSha256).limit(200);
        if (docs.error) return fail(docs.error);
        const docRows = docs.data ?? [];
        const docIds = docRows.map((d) => d.id as string);
        const links = docIds.length
          ? await client.from("document_links").select("document_id, linked_record_id, linked_record_type").in("document_id", docIds).eq("linked_record_type", "supplier_bill").limit(500)
          : { data: [] as { document_id: string; linked_record_id: string }[], error: null };
        if (links.error) return fail(links.error);
        const linkRows = links.data ?? [];
        const billIds = Array.from(new Set(linkRows.map((l) => l.linked_record_id as string)));

        const billSelect = "id, entity_id, supplier_id, bill_number, total_amount, bill_date, payment_status";
        const byFile = billIds.length ? await client.from("supplier_bills").select(billSelect).in("id", billIds) : { data: [] as Record<string, unknown>[], error: null };
        if (byFile.error) return fail(byFile.error);
        const bySupplier = query.supplierId
          ? await client.from("supplier_bills").select(billSelect).eq("entity_id", query.entityId).eq("supplier_id", query.supplierId).neq("payment_status", "cancelled").limit(1000)
          : { data: [] as Record<string, unknown>[], error: null };
        if (bySupplier.error) return fail(bySupplier.error);

        const seen = new Set<string>();
        const bills: ExistingBill[] = [];
        for (const b of [...(byFile.data ?? []), ...(bySupplier.data ?? [])]) {
          const id = b.id as string;
          if (seen.has(id)) continue;
          seen.add(id);
          bills.push({
            id,
            entityId: b.entity_id as string,
            supplierId: (b.supplier_id as string | null) ?? null,
            billNumber: (b.bill_number as string | null) ?? null,
            totalAmount: Number(b.total_amount),
            billDate: (b.bill_date as string | null) ?? null,
            paymentStatus: b.payment_status as string,
          });
        }
        const docById = new Map(docRows.map((d) => [d.id as string, d]));
        const documents: ExistingDocumentLink[] = linkRows.map((l) => {
          const d = docById.get(l.document_id as string);
          return { fileSha256: (d?.file_hash as string | null) ?? null, billId: l.linked_record_id as string, deleted: Boolean(d?.deleted_at) };
        });
        return ok({ bills, documents });
      } catch (e) {
        return thrown(e);
      }
    },

    async getBill(id: string) {
      try {
        const r = await client.from("supplier_bills").select("id, entity_id, created_by, payment_status").eq("id", id).maybeSingle();
        if (r.error) return fail(r.error);
        return ok(r.data ? { id: r.data.id as string, entity_id: r.data.entity_id as string, created_by: (r.data.created_by as string | null) ?? null, payment_status: r.data.payment_status as string } : null);
      } catch (e) {
        return thrown(e);
      }
    },

    async insertBill(row: NewBill) {
      try {
        const r = await client.from("supplier_bills").insert(row).select("id, entity_id, created_by, payment_status").single();
        if (r.error) return fail(r.error);
        return ok({ id: r.data.id as string, entity_id: r.data.entity_id as string, created_by: (r.data.created_by as string | null) ?? null, payment_status: r.data.payment_status as string });
      } catch (e) {
        return thrown(e);
      }
    },

    async uploadObject(path: string, bytes: Uint8Array, contentType: string) {
      try {
        const r = await client.storage.from("bill-documents").upload(path, bytes, { contentType, upsert: false });
        if (!r.error) return ok({ alreadyExisted: false });
        const status = String((r.error as { statusCode?: string | number }).statusCode ?? "");
        if (status === "409" || /already exists/i.test(r.error.message)) return ok({ alreadyExisted: true });
        return { ok: false as const, error: { kind: "unavailable" as const, message: r.error.message } };
      } catch (e) {
        return thrown(e);
      }
    },

    async insertDocument(row: NewDocument) {
      try {
        // No .select(): an unlinked document is invisible to its uploader, so RETURNING would trip the SELECT policy.
        const r = await client.from("documents").insert(row);
        if (r.error) return fail(r.error);
        return ok(null);
      } catch (e) {
        return thrown(e);
      }
    },

    async linkDocument(row: NewDocumentLink) {
      try {
        const r = await client.from("document_links").insert(row);
        if (r.error) return fail(r.error);
        return ok(null);
      } catch (e) {
        return thrown(e);
      }
    },
  };
}
