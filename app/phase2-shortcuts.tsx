"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const navGroups = [
  {
    label: "Dashboard",
    items: [{ label: "Operations Hub", href: "/", icon: "⌂" }],
  },
  {
    label: "Finance",
    items: [
      { label: "Payment Vouchers", href: "/payment-vouchers", icon: "PV" },
      { label: "Bills", href: "/bills", icon: "B" },
      { label: "Suppliers", href: "/suppliers", icon: "S" },
      { label: "Import Suppliers", href: "/suppliers/import", icon: "↑" },
      { label: "Recurring", href: "/recurring", icon: "R" },
      { label: "Claims", href: "/claims", icon: "C" },
      { label: "Documents", href: "/documents", icon: "D" },
      { label: "Missing Documents", href: "/missing-documents", icon: "!" },
    ],
  },
  {
    label: "Student Operations",
    items: [
      { label: "Dashboard", href: "/student-operations", icon: "⌂" },
      { label: "Students", href: "/students", icon: "ST" },
      { label: "Import Students", href: "/students/import", icon: "↑" },
      { label: "Programmes", href: "/programmes", icon: "P" },
      { label: "Intakes", href: "/intakes", icon: "I" },
      { label: "Enrolments", href: "/enrolments", icon: "E" },
    ],
  },
  {
    label: "Admin",
    items: [
      { label: "Users", href: "/settings/users", icon: "U" },
      { label: "Settings", href: "/settings/foundation", icon: "⚙" },
      { label: "UAT Feedback", href: "/uat", icon: "?" },
    ],
  },
];

export function Phase2Shortcuts() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (pathname !== "/login") {
      void fetch("/api/recurring/generate", { method: "POST" }).catch(() => undefined);
    }
  }, [pathname]);

  useEffect(() => { setOpen(false); }, [pathname]);

  if (pathname === "/login") return null;

  return (
    <aside className={`app-shell-nav ${open ? "nav-open" : ""}`}>
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">IE</div>
        <div><strong>Inter-Excel Hub</strong><span>Finance & Student Operations</span></div>
        <button type="button" className="nav-toggle neutral" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label="Toggle navigation">☰</button>
      </div>
      <nav className="shortcutbar grouped" aria-label="Main navigation">
        {navGroups.map((group) => (
          <div className="nav-group" key={group.label}>
            <span>{group.label}</span>
            <div>
              {group.items.map((item) => {
                const active = item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`);
                return <Link key={item.href} className={active ? "active" : ""} href={item.href}><span className="nav-icon" aria-hidden="true">{item.icon}</span><span>{item.label}</span></Link>;
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="nav-footer"><span>UI Version 2.0</span><small>Functional layout upgrade</small></div>
    </aside>
  );
}
