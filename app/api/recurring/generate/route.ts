import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

const UNIQUE_VIOLATION = "23505";
const INSUFFICIENT_PRIVILEGE = "42501";

type GenerationError = {
  obligation_id: string;
  description: string | null;
  stage: "bill" | "schedule";
  code: string | null;
  message: string;
};

function dueDate(year: number, month: number, dueDay: number) {
  const last = new Date(year, month, 0).getDate();
  return new Date(year, month - 1, Math.min(dueDay, last)).toISOString().slice(0, 10);
}

// Generates this month's recurring Supplier Bills as drafts (Stage 1B: bills are inserted as draft and must be
// verified by a human before they become payable). No Payment Voucher is created here; auto_generate_pv is left
// untouched on the obligation for a later, explicit post-verification step.
// next_generation_date only advances once the month's bill exists, so a failure never silently skips a month.
export async function POST() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = userData.user.id;

  const today = new Date();
  const generatedMonth = today.toISOString().slice(0, 7);
  const obligations = await supabase
    .from("recurring_obligations")
    .select("*")
    .eq("active_status", true)
    .lte("next_generation_date", today.toISOString().slice(0, 10));
  if (obligations.error) return NextResponse.json({ error: obligations.error.message }, { status: 400 });

  let billsCreated = 0;
  let billsExisting = 0;
  const errors: GenerationError[] = [];

  async function fail(item: { id: string; description: string | null; entity_id: string }, stage: GenerationError["stage"], code: string | null, message: string) {
    errors.push({ obligation_id: item.id, description: item.description, stage, code, message });
    console.error("recurring bill generation failed", { obligation_id: item.id, generatedMonth, stage, code, message });
    // A caller who simply lacks permission (e.g. a non-finance user loading a page) is expected; do not write an audit row for that.
    if (code === INSUFFICIENT_PRIVILEGE) return;
    const audit = await supabase.from("audit_logs").insert({
      actor_user_id: userId,
      action: "recurring_bill_generation_failed",
      entity_type: "recurring_obligation",
      entity_id: item.entity_id,
      payload: { obligation_id: item.id, generated_month: generatedMonth, stage, code, message },
      is_demo: false,
      data_origin: "manual",
    });
    if (audit.error) console.error("recurring_bill_generation_failed audit write failed", audit.error.message);
  }

  for (const item of obligations.data ?? []) {
    const bill = await supabase.from("supplier_bills").insert({
      entity_id: item.entity_id,
      supplier_id: item.supplier_id,
      description: item.description,
      bill_type: "recurring_obligation",
      bill_date: today.toISOString().slice(0, 10),
      due_date: dueDate(today.getFullYear(), today.getMonth() + 1, item.due_day),
      subtotal: item.expected_amount,
      tax_amount: 0,
      total_amount: item.expected_amount,
      outstanding_amount: item.expected_amount,
      expense_category_id: item.expense_category_id || null,
      payment_status: "draft",
      is_recurring_generated: true,
      recurring_obligation_id: item.id,
      generated_month: generatedMonth,
      created_by: userId,
      supporting_document_status: item.required_document_type === "not_applicable" ? "not_applicable" : "no_document",
      not_applicable_reason: item.required_document_type === "not_applicable" ? "Recurring obligation does not require supplier document" : null,
      is_demo: item.is_demo ?? false,
      data_origin: item.data_origin ?? "manual",
    }).select("id").single();

    if (!bill.error && bill.data) {
      billsCreated += 1;
    } else if (bill.error?.code === UNIQUE_VIOLATION) {
      // unique (recurring_obligation_id, generated_month): only treat as done if that month's bill is confirmed to exist.
      const existing = await supabase
        .from("supplier_bills")
        .select("id")
        .eq("recurring_obligation_id", item.id)
        .eq("generated_month", generatedMonth)
        .limit(1);
      if (existing.error || !existing.data?.length) {
        await fail(item, "bill", UNIQUE_VIOLATION, "Duplicate month reported but the existing bill could not be confirmed");
        continue;
      }
      billsExisting += 1;
    } else {
      await fail(item, "bill", bill.error?.code ?? null, bill.error?.message ?? "Bill insert returned no data");
      continue;
    }

    const next = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const schedule = await supabase.from("recurring_obligations").update({
      last_generated_date: today.toISOString().slice(0, 10),
      next_generation_date: next.toISOString().slice(0, 10),
      next_due_date: dueDate(next.getFullYear(), next.getMonth() + 1, item.due_day),
    }).eq("id", item.id).select("id");
    if (schedule.error || !schedule.data?.length) {
      await fail(item, "schedule", schedule.error?.code ?? INSUFFICIENT_PRIVILEGE, schedule.error?.message ?? "Schedule was not advanced (no permission to update recurring obligations)");
    }
  }

  return NextResponse.json({ bills_created: billsCreated, bills_existing: billsExisting, errors });
}
