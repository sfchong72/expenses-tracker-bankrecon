"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

const navGroups = [
  {
    label: "Dashboard",
    items: [{ label: "Hub", href: "/" }],
  },
  {
    label: "Finance Operations",
    items: [
      { label: "Suppliers", href: "/suppliers" },
      { label: "Import", href: "/suppliers/import" },
      { label: "Bills", href: "/bills" },
      { label: "Recurring", href: "/recurring" },
      { label: "Payment Vouchers", href: "/payment-vouchers" },
      { label: "Claims", href: "/claims" },
      { label: "Documents", href: "/documents" },
      { label: "Missing Documents", href: "/missing-documents" },
    ],
  },
  {
    label: "Student Operations",
    items: [
      { label: "Student Dashboard", href: "/student-operations" },
      { label: "Students", href: "/students" },
      { label: "Programmes", href: "/programmes" },
      { label: "Intakes", href: "/intakes" },
      { label: "Enrolments", href: "/enrolments" },
    ],
  },
  {
    label: "Settings",
    items: [
      { label: "UAT Feedback", href: "/uat" },
      { label: "Staff Access", href: "/settings/users" },
      { label: "Foundation", href: "/settings/foundation" },
    ],
  },
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
      <nav className="shortcutbar grouped" aria-label="Main navigation">
        {navGroups.map((group) => (
          <div className="nav-group" key={group.label}>
            <span>{group.label}</span>
            <div>
              {group.items.map((item) => {
                const active = item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`) || (item.href.startsWith("/settings") && pathname.startsWith("/settings"));
                return <a key={item.href} className={active ? "active" : ""} href={item.href}>{item.label}</a>;
              })}
            </div>
          </div>
        ))}
      </nav>
    </div>
  );
}
