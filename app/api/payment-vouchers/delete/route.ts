import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const db = await createClient();
  const { data: userData } = await db.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Please log in first." }, { status: 401 });

  const { voucherId, reason } = await request.json();
  const deletionReason = String(reason || "").trim();
  if (!voucherId) return NextResponse.json({ error: "Choose a voucher to delete." }, { status: 400 });
  if (!deletionReason) return NextResponse.json({ error: "Enter a deletion reason for the audit trail." }, { status: 400 });

  const voucher = await db.from("payment_vouchers").select("id, status, voucher_number").eq("id", voucherId).maybeSingle();
  if (voucher.error) return NextResponse.json({ error: voucher.error.message }, { status: 400 });
  if (!voucher.data) return NextResponse.json({ error: "Voucher not found." }, { status: 404 });
  if (voucher.data.status !== "draft") {
    return NextResponse.json({ error: "Only draft vouchers can be deleted. Void issued test or sample vouchers instead." }, { status: 400 });
  }

  const deleted = await db.rpc("delete_payment_voucher_draft", { p_voucher_id: voucherId, p_reason: deletionReason });
  if (deleted.error) return NextResponse.json({ error: deleted.error.message }, { status: 400 });

  return NextResponse.json({ deleted: true });
}
