import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { claimId } = await request.json();
  if (!claimId) return NextResponse.json({ error: "Claim is required" }, { status: 400 });

  const prepared = await supabase.rpc("prepare_claim_payment_voucher", { p_claim_id: claimId });
  if (prepared.error) return NextResponse.json({ error: prepared.error.message }, { status: 403 });
  return NextResponse.json({ claimId: prepared.data.claim_id, paymentVoucherId: prepared.data.payment_voucher_id });
}
