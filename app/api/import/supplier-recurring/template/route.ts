import { templateColumns } from "@/lib/import/supplier-recurring";

export async function GET() {
  const rows = [
    templateColumns,
    ["IETA", "KOSWIP", "", "", "", "", "", "", "KL office rental", "Rent", "fixed", "RM7,212.80", "monthly", "7", new Date().toISOString().slice(0, 10), "", "3", "payment_voucher", "yes", "yes", "KL office", "", "Template example only", "active", "IETA"],
    ["IETA", "U Mobile", "", "", "", "", "", "", "IETA mobile lines", "Telecommunications", "variable", "", "monthly", "15", new Date().toISOString().slice(0, 10), "", "3", "payment_voucher", "yes", "yes", "Account number here", "", "Variable bill example", "active", "IETA"],
  ];
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="supplier-recurring-import-template.csv"' } });
}
