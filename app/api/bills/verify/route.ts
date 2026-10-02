import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { canVerifyBills, VERIFY_FROM_STATUS, VERIFY_TO_STATUS } from "@/lib/bill-verification";
import { evaluateFinanceOpsVerifyGate } from "@/lib/financeops/gate";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Human verification of a Supplier Bill: draft -> unpaid, and nothing else.
// Runs with the caller's own Supabase session, so RLS and the supplier_bills state trigger stay authoritative.
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const billId = typeof body?.bill_id === "string" ? body.bill_id : "";
  if (!uuidPattern.test(billId)) return NextResponse.json({ error: "A valid bill_id is required" }, { status: 400 });

  const profile = await supabase.from("app_profiles").select("role, active_status").eq("id", user.id).maybeSingle();
  if (profile.error || !profile.data?.active_status || !canVerifyBills(profile.data.role)) {
    return NextResponse.json({ error: "Only Owner, Finance Manager or Finance Staff may verify a draft bill" }, { status: 403 });
  }

  const bill = await supabase.from("supplier_bills").select("id, entity_id, payment_status").eq("id", billId).maybeSingle();
  if (bill.error) return NextResponse.json({ error: bill.error.message }, { status: 400 });
  if (!bill.data) return NextResponse.json({ error: "Bill not found" }, { status: 404 });
  if (bill.data.payment_status !== VERIFY_FROM_STATUS) {
    return NextResponse.json({ error: "Only draft bills can be verified" }, { status: 409 });
  }

  // Q5 (application gate): a bill created from a FinanceOps intake needs a human "Data Verified" on that intake first.
  // Ordinary bills have no intake row and are unaffected. The lookup uses the caller's own session; failure fails closed.
  const intake = await supabase.from("finance_intake_submissions").select("review_status").eq("supplier_bill_id", billId);
  const gate = evaluateFinanceOpsVerifyGate({ error: intake.error?.message, rows: intake.data });
  if (!gate.allow) return NextResponse.json({ error: gate.message, code: gate.error }, { status: gate.status });

  // Guarded update: only a row that is still draft is changed, and only to unpaid.
  const updated = await supabase.from("supplier_bills").update({ payment_status: VERIFY_TO_STATUS }).eq("id", billId).eq("payment_status", VERIFY_FROM_STATUS).select("id");
  if (updated.error) return NextResponse.json({ error: updated.error.message }, { status: 403 });
  if (!updated.data?.length) {
    const current = await supabase.from("supplier_bills").select("payment_status").eq("id", billId).maybeSingle();
    if (current.data && current.data.payment_status !== VERIFY_FROM_STATUS) {
      return NextResponse.json({ error: "Bill is no longer a draft" }, { status: 409 });
    }
    return NextResponse.json({ error: "You are not permitted to verify this bill" }, { status: 403 });
  }

  // The database does not audit draft -> unpaid, so record it here. The actor is the authenticated user, never request input.
  const audit = await supabase.from("audit_logs").insert({
    actor_user_id: user.id,
    action: "supplier_bill_verified",
    entity_type: "supplier_bill",
    entity_id: bill.data.entity_id,
    payload: { bill_id: billId, previous_status: VERIFY_FROM_STATUS, new_status: VERIFY_TO_STATUS },
    before_data: { payment_status: VERIFY_FROM_STATUS },
    after_data: { payment_status: VERIFY_TO_STATUS },
    is_demo: false,
    data_origin: "manual",
  });
  if (audit.error) {
    console.error("supplier_bill_verified audit write failed", { billId, message: audit.error.message });
    // Fail closed: do not leave an unaudited verification in place.
    const reverted = await supabase.from("supplier_bills").update({ payment_status: VERIFY_FROM_STATUS }).eq("id", billId).eq("payment_status", VERIFY_TO_STATUS).select("id");
    if (reverted.error || !reverted.data?.length) {
      console.error("supplier_bill_verified revert failed; bill is unpaid without an audit entry", { billId });
      return NextResponse.json({ error: "Verification could not be audited and could not be reverted. Contact the Owner.", status_changed: true }, { status: 500 });
    }
    return NextResponse.json({ error: "Verification could not be audited and was reverted. Please try again." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, bill_id: billId, previous_status: VERIFY_FROM_STATUS, status: VERIFY_TO_STATUS });
}
