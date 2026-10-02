import { Suspense } from "react";
import { Disabled } from "@/app/finance-ops-shared";
import { DashboardView } from "@/app/finance-ops-payments";
import { paymentRegisterEnabled } from "@/lib/financeops/payments/types";

// Finance Operations is OFF unless FINANCEOPS_PAYMENT_REGISTER_ENABLED=true (read on the server, per request).
export const dynamic = "force-dynamic";

export default function Page() {
  if (!paymentRegisterEnabled(process.env)) return <Disabled title="Finance Operations" />;
  return <Suspense fallback={null}><DashboardView /></Suspense>;
}
