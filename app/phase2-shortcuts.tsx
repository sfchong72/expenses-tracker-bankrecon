"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

const navGroups = [
  {
    label: "Dashboard",
    items: [{ label: "Dashboard", href: "/" }],
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
      { label: "Dashboard", href: "/student-operations" },
      { label: "Students", href: "/students" },
      { label: "Import Students", href: "/students/import" },
      { label: "Programmes", href: "/programmes" },
      { label: "Intakes", href: "/intakes" },
      { label: "Enrolments", href: "/enrolments" },
    ],
  },
  {
    label: "Admin",
    items: [
      { label: "UAT Feedback", href: "/uat" },
      { label: "Users", href: "/settings/users" },
      { label: "Settings", href: "/settings/foundation" },
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
        <strong>Inter-Excel Operations Hub</strong>
        <span>Finance and Student Operations</span>
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
