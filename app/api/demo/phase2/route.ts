import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

const demoPdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");

async function requireOwner() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return { supabase, user: null, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const profile = await supabase.from("app_profiles").select("role, active_status").eq("id", userData.user.id).maybeSingle();
  if (profile.error || profile.data?.role !== "owner" || !profile.data?.active_status) return { supabase, user: userData.user, error: NextResponse.json({ error: "Owner access is required" }, { status: 403 }) };
  return { supabase, user: userData.user, error: null };
}

export async function POST() {
  const { supabase, user, error } = await requireOwner();
  if (error) return error;
  const entity = await supabase.from("entities").select("id, short_code").eq("short_code", "IETA").maybeSingle();
  if (entity.error || !entity.data) return NextResponse.json({ error: "IETA entity is required before demo data can be loaded" }, { status: 400 });
  const category = await supabase.from("categories").select("id").eq("category_type", "expense").limit(1).maybeSingle();
  const bank = await supabase.from("bank_accounts_staff_safe").select("id").eq("entity_code", "IETA").limit(1).maybeSingle();
  const existing = await supabase.from("suppliers").select("id").eq("is_demo", true).limit(1);
  if (existing.data?.length) return NextResponse.json({ message: "DEMO data is already loaded." });
  const supplier = await supabase.from("suppliers").insert({ supplier_name: "DEMO Supplier - Office Rental", registration_number: "DEMO-REG-001", contact_person: "DEMO Contact", email: "demo-supplier@example.com", phone: "+60 DEMO", bank_details: { notes: "DEMO bank: CIMB 8000-0000-0000" }, default_expense_category: category.data?.id ?? null, default_description: "DEMO monthly office rental", account_code: "DEMO-SUP", remarks: "DEMO supplier for UAT only", active_status: true, is_demo: true, data_origin: "demo" }).select("id").single();
  if (supplier.error) return NextResponse.json({ error: supplier.error.message }, { status: 400 });
  await supabase.from("supplier_entities").insert({ supplier_id: supplier.data.id, entity_id: entity.data.id, is_demo: true, data_origin: "demo" });
  const bill = await supabase.from("supplier_bills").insert({ entity_id: entity.data.id, supplier_id: supplier.data.id, bill_number: "DEMO-INV-001", description: "DEMO supplier invoice for office rental", bill_type: "supplier_invoice", bill_date: new Date().toISOString().slice(0, 10), due_date: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10), subtotal: 1200, tax_amount: 0, total_amount: 1200, outstanding_amount: 1200, expense_category_id: category.data?.id ?? null, payment_status: "unpaid", is_demo: true, data_origin: "demo", created_by: user?.id }).select("id").single();
  if (bill.error) return NextResponse.json({ error: bill.error.message }, { status: 400 });
  const recurring = await supabase.from("recurring_obligations").insert({ entity_id: entity.data.id, supplier_id: supplier.data.id, description: "DEMO monthly rental obligation", expected_amount: 1200, due_day: 7, next_due_date: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10), next_generation_date: new Date().toISOString().slice(0, 10), required_document_type: "payment_voucher", remarks: "DEMO recurring obligation for UAT only", is_demo: true, data_origin: "demo", created_by: user?.id }).select("id").single();
  if (recurring.error) return NextResponse.json({ error: recurring.error.message }, { status: 400 });
  const voucher = await supabase.from("payment_vouchers").insert({ entity_id: entity.data.id, supplier_id: supplier.data.id, voucher_date: new Date().toISOString().slice(0, 10), payee: "DEMO Supplier - Office Rental", payee_bank_details: { notes: "DEMO bank: CIMB 8000-0000-0000" }, purpose: "DEMO office rental payment voucher draft", voucher_source: "demo", recurring_obligation_id: recurring.data.id, paying_bank_account_id: bank.data?.id ?? null, total_amount: 1200, payment_method: "bank_transfer", status: "draft", prepared_by: user?.id, remarks: "DEMO voucher for UAT only", is_demo: true, data_origin: "demo" }).select("id").single();
  if (voucher.error) return NextResponse.json({ error: voucher.error.message }, { status: 400 });
  await supabase.from("payment_voucher_items").insert({ payment_voucher_id: voucher.data.id, supplier_bill_id: bill.data.id, recurring_obligation_id: recurring.data.id, expense_category_id: category.data?.id ?? null, description: "DEMO office rental item", amount: 1200, is_demo: true, data_origin: "demo" });
  const storagePath = `${entity.data.id}/demo/supplier_invoice/${bill.data.id}/${randomUUID()}.pdf`;
  const uploaded = await supabase.storage.from("bill-documents").upload(storagePath, demoPdf, { contentType: "application/pdf", upsert: false });
  if (uploaded.error) return NextResponse.json({ error: uploaded.error.message }, { status: 400 });
  const doc = await supabase.from("documents").insert({ entity_id: entity.data.id, document_type: "supplier_invoice", original_filename: "DEMO-invoice.pdf", storage_path: storagePath, mime_type: "application/pdf", file_size: demoPdf.length, uploaded_by: user?.id, is_demo: true, data_origin: "demo" }).select("id").single();
  if (!doc.error) await supabase.from("document_links").insert({ document_id: doc.data.id, entity_id: entity.data.id, linked_record_type: "supplier_bill", linked_record_id: bill.data.id, created_by: user?.id, is_demo: true, data_origin: "demo" });
  await supabase.from("audit_logs").insert({ actor_user_id: user?.id, action: "phase2_demo_data_loaded", entity_type: "phase2_demo_data", is_demo: false, data_origin: "manual", payload: { supplier_id: supplier.data.id, bill_id: bill.data.id, recurring_id: recurring.data.id, voucher_id: voucher.data.id } });
  return NextResponse.json({ message: "Phase 2 DEMO data loaded." });
}

export async function DELETE() {
  const { supabase, error } = await requireOwner();
  if (error) return error;
  const demoDocs = await supabase.from("documents").select("storage_path").eq("is_demo", true);
  const paths = (demoDocs.data ?? []).map((d) => d.storage_path).filter(Boolean);
  if (paths.length) await supabase.storage.from("bill-documents").remove(paths);
  const removed = await supabase.rpc("remove_phase2_demo_data");
  if (removed.error) return NextResponse.json({ error: removed.error.message }, { status: 400 });
  return NextResponse.json({ message: "Phase 2 DEMO data removed.", removed: removed.data });
}
