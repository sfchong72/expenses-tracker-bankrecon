"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

export function Phase2Shortcuts() {
  const pathname = usePathname();

  useEffect(() => {
    if (pathname !== "/login") {
      void fetch("/api/recurring/generate", { method: "POST" }).catch(() => undefined);
    }
  }, [pathname]);

  if (pathname === "/login") return null;

  return (
    <div className="shortcutbar">
      <a href="/suppliers">Suppliers</a>
      <a href="/suppliers/import">Import</a>
      <a href="/bills">Bills</a>
      <a href="/recurring">Recurring</a>
      <a href="/payment-vouchers">Payment Vouchers</a>
      <a href="/documents">Documents</a>
      <a href="/missing-documents">Missing Documents</a>
    </div>
  );
}
