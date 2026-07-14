import type { Metadata } from "next";
import { Phase2Shortcuts } from "@/app/phase2-shortcuts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Internal Finance Operations Dashboard",
  description: "Expense administration, payment preparation and supporting-document control",
};

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
