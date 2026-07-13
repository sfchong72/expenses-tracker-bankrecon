import { NextResponse } from "next/server";
import { requireBankAccess } from "@/app/api/bank-imports/_shared";

export async function POST(request: Request) {
  const body = await request.json();
  const transactionId = String(body.bankTransactionId ?? "");
  if (!transactionId) return NextResponse.json({ error: "Bank transaction is required" }, { status: 400 });

  const access = await requireBankAccess(undefined, "read");
  if (access.error) return access.error;

  const tx = await access.supabase.from("bank_transactions_staff_safe").select("*").eq("id", transactionId).maybeSingle();
  if (tx.error || !tx.data) return NextResponse.json({ error: "Bank transaction not found" }, { status: 404 });

  const entityId = tx.data.entity_id;
  const amount = Number(tx.data.amount || 0);
  const description = `${tx.data.description ?? ""} ${tx.data.additional_description ?? ""} ${tx.data.reference_number ?? ""}`.toLowerCase();
  const [bills, vouchers, payments] = await Promise.all([
    access.supabase.from("supplier_bills").select("id, supplier_id, bill_number, description, outstanding_amount, due_date, suppliers(supplier_name)").eq("entity_id", entityId).neq("payment_status", "paid").limit(50),
    access.supabase.from("payment_vouchers").select("id, voucher_number, payee_name, purpose, total_amount, voucher_date, status").eq("entity_id", entityId).in("status", ["issued", "paid"]).limit(50),
    access.supabase.from("bill_payments").select("id, supplier_bill_id, amount, payment_date, payment_reference").eq("entity_id", entityId).limit(50),
  ]);
  const firstError = bills.error || vouchers.error || payments.error;
  if (firstError) return NextResponse.json({ error: firstError.message }, { status: 400 });

  const suggestions = [
    ...(bills.data ?? []).map((bill: any) => scoreSuggestion("supplier_bill", bill.id, Number(bill.outstanding_amount || 0), amount, description, [bill.bill_number, bill.description, bill.suppliers?.supplier_name], bill)),
    ...(vouchers.data ?? []).map((voucher: any) => scoreSuggestion("payment_voucher", voucher.id, Number(voucher.total_amount || 0), amount, description, [voucher.voucher_number, voucher.payee_name, voucher.purpose], voucher)),
    ...(payments.data ?? []).map((payment: any) => scoreSuggestion("bill_payment", payment.id, Number(payment.amount || 0), amount, description, [payment.payment_reference], payment)),
  ]
    .filter((item) => item.confidenceScore >= 40)
    .sort((a, b) => b.confidenceScore - a.confidenceScore)
    .slice(0, 10);

  return NextResponse.json({ suggestions });
}

function scoreSuggestion(type: string, id: string, targetAmount: number, txAmount: number, txText: string, hints: unknown[], source: unknown) {
  let score = 0;
  const reasons: string[] = [];
  if (targetAmount === txAmount) {
    score += 55;
    reasons.push("exact amount");
  } else if (targetAmount > 0 && Math.abs(targetAmount - txAmount) <= 5) {
    score += 25;
    reasons.push("amount close");
  }
  for (const hint of hints) {
    const text = String(hint ?? "").trim().toLowerCase();
    if (text && txText.includes(text)) {
      score += 25;
      reasons.push(`${type === "payment_voucher" ? "voucher/payee" : "supplier/reference"} matched`);
      break;
    }
  }
  return {
    linkedRecordType: type,
    linkedRecordId: id,
    allocatedAmount: Math.min(txAmount, targetAmount || txAmount),
    confidenceScore: Math.min(100, score),
    matchReason: reasons.join(", ") || "possible manual match",
    source,
  };
}
