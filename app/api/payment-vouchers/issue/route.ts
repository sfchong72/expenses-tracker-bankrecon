import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { voucherId } = await request.json();
  if (!voucherId) return NextResponse.json({ error: "Voucher is required" }, { status: 400 });
  const voucher = await supabase.from("payment_vouchers").select("*").eq("id", voucherId).maybeSingle();
  if (voucher.error || !voucher.data) return NextResponse.json({ error: "Voucher not found" }, { status: 404 });
  if (voucher.data.status !== "draft") return NextResponse.json({ error: "Only draft vouchers can be issued" }, { status: 409 });
  if (voucher.data.voucher_number) return NextResponse.json({ error: "Voucher already has a number" }, { status: 409 });
  const items = await supabase.from("payment_voucher_items").select("id, amount").eq("payment_voucher_id", voucherId);
  if (items.error) return NextResponse.json({ error: items.error.message }, { status: 400 });
  if (!items.data?.length) return NextResponse.json({ error: "Add at least one voucher item before issuing" }, { status: 400 });
  const number = await supabase.rpc("generate_payment_voucher_number", { p_entity_id: voucher.data.entity_id });
  if (number.error) return NextResponse.json({ error: number.error.message }, { status: 403 });
  const issued = await supabase.from("payment_vouchers").update({ voucher_number: number.data, status: "issued", issued_at: new Date().toISOString(), prepared_by: voucher.data.prepared_by || userData.user.id }).eq("id", voucherId).eq("status", "draft").select("id, voucher_number").single();
  if (issued.error) return NextResponse.json({ error: issued.error.message }, { status: 400 });
  await supabase.from("audit_logs").insert({ actor_user_id: userData.user.id, action: "payment_voucher_issued", entity_type: "payment_voucher", entity_id: voucher.data.entity_id, payload: { voucher_id: voucherId, voucher_number: number.data } });
  return NextResponse.json({ id: issued.data.id, voucher_number: issued.data.voucher_number });
}
