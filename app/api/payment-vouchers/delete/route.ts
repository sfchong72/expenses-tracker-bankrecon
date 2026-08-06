import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const db = await createClient();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Please log in first." }, { status: 401 });

  const { voucherId } = await request.json();
  if (!voucherId) return NextResponse.json({ error: "Choose a voucher to delete." }, { status: 400 });

  const voucher = await db.from("payment_vouchers").select("id, status, voucher_number").eq("id", voucherId).maybeSingle();
  if (voucher.error) return NextResponse.json({ error: voucher.error.message }, { status: 400 });
  if (!voucher.data) return NextResponse.json({ error: "Voucher not found." }, { status: 404 });
  if (voucher.data.status !== "draft") {
    return NextResponse.json({ error: "Only draft vouchers can be deleted. Void issued test or sample vouchers instead." }, { status: 400 });
  }

  const deleted = await db.from("payment_vouchers").delete().eq("id", voucherId).eq("status", "draft");
  if (deleted.error) return NextResponse.json({ error: deleted.error.message }, { status: 400 });

  await db.from("audit_logs").insert({
    actor_user_id: userData.user.id,
    action: "payment_voucher_draft_deleted",
    entity_type: "payment_voucher",
    entity_id: voucherId,
    payload: { voucher_number: voucher.data.voucher_number || "Draft" },
    data_origin: "manual",
  });

  return NextResponse.json({ deleted: true });
}
