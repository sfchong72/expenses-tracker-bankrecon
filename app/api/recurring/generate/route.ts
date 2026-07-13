import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

function dueDate(year: number, month: number, dueDay: number) {
  const last = new Date(year, month, 0).getDate();
  return new Date(year, month - 1, Math.min(dueDay, last)).toISOString().slice(0, 10);
}

export async function POST() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const today = new Date();
  const generatedMonth = today.toISOString().slice(0, 7);
  const obligations = await supabase.from("recurring_obligations").select("*").eq("active_status", true).lte("next_generation_date", today.toISOString().slice(0, 10));
  if (obligations.error) return NextResponse.json({ error: obligations.error.message }, { status: 400 });
  let created = 0;
  for (const item of obligations.data ?? []) {
    const bill = await supabase.from("supplier_bills").insert({ entity_id: item.entity_id, supplier_id: item.supplier_id, description: item.description, bill_type: "recurring_obligation", bill_date: today.toISOString().slice(0, 10), due_date: dueDate(today.getFullYear(), today.getMonth() + 1, item.due_day), subtotal: item.expected_amount, tax_amount: 0, total_amount: item.expected_amount, outstanding_amount: item.expected_amount, payment_status: "unpaid", is_recurring_generated: true, recurring_obligation_id: item.id, generated_month: generatedMonth, created_by: userData.user.id, supporting_document_status: item.required_document_type === "not_applicable" ? "not_applicable" : "no_document", not_applicable_reason: item.required_document_type === "not_applicable" ? "Recurring obligation does not require supplier document" : null, is_demo: item.is_demo ?? false, data_origin: item.data_origin ?? "manual" }).select("*").single();
    if (!bill.error && bill.data) {
      created += 1;
      if (item.auto_generate_pv) {
        const voucher = await supabase.from("payment_vouchers").insert({ entity_id: item.entity_id, supplier_id: item.supplier_id, payee: item.description, purpose: item.description, voucher_source: "recurring_obligation", recurring_obligation_id: item.id, total_amount: item.expected_amount, status: "draft", prepared_by: userData.user.id, is_demo: item.is_demo ?? false, data_origin: item.data_origin ?? "manual" }).select("*").single();
        if (!voucher.error) await supabase.from("payment_voucher_items").insert({ payment_voucher_id: voucher.data.id, supplier_bill_id: bill.data.id, recurring_obligation_id: item.id, description: item.description, amount: item.expected_amount, is_demo: item.is_demo ?? false, data_origin: item.data_origin ?? "manual" });
      }
    }
    const next = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    await supabase.from("recurring_obligations").update({ last_generated_date: today.toISOString().slice(0, 10), next_generation_date: next.toISOString().slice(0, 10), next_due_date: dueDate(next.getFullYear(), next.getMonth() + 1, item.due_day) }).eq("id", item.id);
  }
  return NextResponse.json({ created });
}
