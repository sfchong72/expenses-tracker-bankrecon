import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Expenses Tracker & Bank Reconciliation",
  description: "Internal expenses and bank reconciliation workspace",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
