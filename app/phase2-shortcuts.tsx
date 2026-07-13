"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

const navItems = [
  { label: "Dashboard", href: "/" },
  { label: "Suppliers", href: "/suppliers" },
  { label: "Import", href: "/suppliers/import" },
  { label: "Bills", href: "/bills" },
  { label: "Recurring", href: "/recurring" },
  { label: "Payment Vouchers", href: "/payment-vouchers" },
  { label: "Documents", href: "/documents" },
  { label: "Missing Documents", href: "/missing-documents" },
  { label: "Bank Imports", href: "/bank-imports" },
  { label: "Bank Transactions", href: "/bank-transactions" },
  { label: "Reconcile", href: "/reconcile" },
  { label: "Bank Report", href: "/reports/bank-reconciliation" },
  { label: "Settings", href: "/settings/foundation" },
];

export function Phase2Shortcuts() {
  const pathname = usePathname();

  useEffect(() => {
    if (pathname !== "/login") {
      void fetch("/api/recurring/generate", { method: "POST" }).catch(() => undefined);
    }
  }, [pathname]);

  if (pathname === "/login") return null;

  return (
    <div className="app-shell-nav">
      <div className="brand-lockup">
        <strong>Finance Operations</strong>
        <span>Audit-ready admin workspace</span>
      </div>
      <nav className="shortcutbar" aria-label="Main navigation">
        {navItems.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`) || (item.href.startsWith("/settings") && pathname.startsWith("/settings"));
          return <a key={item.href} className={active ? "active" : ""} href={item.href}>{item.label}</a>;
        })}
      </nav>
    </div>
  );
}
