import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const db = await createClient();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Please log in first." }, { status: 401 });

  const { voucherId, reason } = await request.json();
  const cancelReason = String(reason || "").trim();
  if (!voucherId) return NextResponse.json({ error: "Choose a voucher to cancel." }, { status: 400 });
  if (!cancelReason) return NextResponse.json({ error: "Enter a reason before voiding or cancelling this voucher." }, { status: 400 });

  const voucher = await db.from("payment_vouchers").select("id, status, voucher_number, payee, total_amount").eq("id", voucherId).maybeSingle();
  if (voucher.error) return NextResponse.json({ error: voucher.error.message }, { status: 400 });
  if (!voucher.data) return NextResponse.json({ error: "Voucher not found." }, { status: 404 });
  if (voucher.data.status === "draft") return NextResponse.json({ error: "Draft vouchers should be deleted, not cancelled." }, { status: 400 });
  if (voucher.data.status === "cancelled") return NextResponse.json({ error: "This voucher is already void or cancelled." }, { status: 400 });

  const now = new Date().toISOString();
  const updated = await db.from("payment_vouchers").update({
    status: "cancelled",
    cancelled_by: userData.user.id,
    cancelled_at: now,
    cancellation_reason: cancelReason,
  }).eq("id", voucherId).neq("status", "draft");
  if (updated.error) return NextResponse.json({ error: updated.error.message }, { status: 400 });

  await db.from("audit_logs").insert({
    actor_user_id: userData.user.id,
    action: "payment_voucher_cancelled",
    entity_type: "payment_voucher",
    entity_id: voucherId,
    payload: { ...voucher.data, cancellation_reason: cancelReason },
    data_origin: "manual",
  });

  return NextResponse.json({ cancelled: true, status: "cancelled" });
}
