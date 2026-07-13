import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { billId } = await request.json();
  const bill = await supabase.from("supplier_bills").select("*").eq("id", billId).maybeSingle();
  if (bill.error || !bill.data) return NextResponse.json({ error: "Bill not found" }, { status: 404 });
  const existing = await supabase.from("payment_voucher_items").select("payment_voucher_id, payment_vouchers(status, voucher_number)").eq("supplier_bill_id", billId).limit(1);
  if (existing.data?.length) return NextResponse.json({ error: "A voucher already exists for this bill" }, { status: 409 });
  const supplier = bill.data.supplier_id ? await supabase.from("suppliers").select("supplier_name").eq("id", bill.data.supplier_id).maybeSingle() : { data: null };
  const voucher = await supabase.from("payment_vouchers").insert({ entity_id: bill.data.entity_id, supplier_id: bill.data.supplier_id, payee: supplier.data?.supplier_name ?? "Manual payee", purpose: bill.data.description, voucher_source: "supplier_bill", total_amount: bill.data.outstanding_amount || bill.data.total_amount, status: "draft", prepared_by: userData.user.id, remarks: bill.data.remarks, is_demo: bill.data.is_demo ?? false, data_origin: bill.data.data_origin ?? "manual" }).select("*").single();
  if (voucher.error) return NextResponse.json({ error: voucher.error.message }, { status: 400 });
  const item = await supabase.from("payment_voucher_items").insert({ payment_voucher_id: voucher.data.id, supplier_bill_id: bill.data.id, expense_category_id: bill.data.expense_category_id, recurring_obligation_id: bill.data.recurring_obligation_id, description: bill.data.bill_number ? `${bill.data.description} (${bill.data.bill_number})` : bill.data.description, amount: bill.data.outstanding_amount || bill.data.total_amount, is_demo: bill.data.is_demo ?? false, data_origin: bill.data.data_origin ?? "manual" });
  if (item.error) return NextResponse.json({ error: item.error.message }, { status: 400 });
  await supabase.from("audit_logs").insert({ actor_user_id: userData.user.id, action: "payment_voucher_draft_created", entity_type: "payment_voucher", entity_id: bill.data.entity_id, payload: { voucher_id: voucher.data.id, bill_id: bill.data.id } });
  return NextResponse.json({ id: voucher.data.id, status: "draft" });
}
