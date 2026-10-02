import { Suspense } from "react";
import { Disabled } from "@/app/finance-ops-shared";
import { BankImportView } from "@/app/finance-ops-bank";
import { paymentRegisterEnabled } from "@/lib/financeops/payments/types";

// Finance Operations is OFF unless FINANCEOPS_PAYMENT_REGISTER_ENABLED=true (read on the server, per request).
export const dynamic = "force-dynamic";

export default function Page() {
  if (!paymentRegisterEnabled(process.env)) return <Disabled title="Bank statement import" />;
  return <Suspense fallback={null}><BankImportView /></Suspense>;
}
