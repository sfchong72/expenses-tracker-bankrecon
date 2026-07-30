import type { Metadata } from "next";
import { Phase2Shortcuts } from "@/app/phase2-shortcuts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Inter-Excel Operations Hub",
  description: "Finance Operations and Student Operations for internal administration, payment preparation and supporting-document control",
};

export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased"><Phase2Shortcuts />{children}</body>
    </html>
  );
}
