import Link from "next/link";
import { AuthBar } from "@/app/auth-bar";

export function BankFeatureInactive() {
  return (
    <main className="page-shell">
      <div className="page-header">
        <div>
          <p className="eyebrow">Feature inactive</p>
          <h1>Bank reconciliation is handled in SQL Accounting</h1>
          <p className="subtitle">
            This application now supports expense administration, payment preparation and supporting-document control.
            Existing bank import and reconciliation records are retained for audit history, but the workflow is dormant.
          </p>
        </div>
        <AuthBar />
      </div>

      <section className="panel">
        <h2>Active Scope</h2>
        <p className="help">
          Use this dashboard for suppliers, expense categories, recurring obligations, supplier bills,
          payment vouchers, supporting documents and missing-document tracking.
        </p>
        <div className="actions">
          <Link className="button" href="/">Go to Dashboard</Link>
          <Link className="button secondary" href="/payment-vouchers">Payment Vouchers</Link>
          <Link className="button neutral" href="/missing-documents">Missing Documents</Link>
        </div>
      </section>
    </main>
  );
}
