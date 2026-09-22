import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { voucherId } = await request.json();
  if (!voucherId) return NextResponse.json({ error: "Voucher is required" }, { status: 400 });
  const issued = await supabase.rpc("issue_payment_voucher", { p_voucher_id: voucherId });
  if (issued.error) return NextResponse.json({ error: issued.error.message }, { status: 403 });
  return NextResponse.json(issued.data);
}
