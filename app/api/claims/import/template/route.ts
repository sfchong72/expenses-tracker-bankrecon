import { NextResponse } from "next/server";

const columns = [
  "statement_date",
  "transaction_date",
  "cardholder_name",
  "card_last_four",
  "card_type",
  "merchant_or_supplier",
  "transaction_description",
  "business_purpose",
  "expense_category_id",
  "amount",
  "tax_amount",
  "original_currency",
  "exchange_rate",
  "payment_method",
  "invoice_or_receipt_number",
  "receipt_date",
  "remarks",
];

export async function GET() {
  const sample = [
    "2026-07-31",
    "2026-07-12",
    "Director Name",
    "1234",
    "personal",
    "Hotel ABC",
    "Client meeting accommodation",
    "Business travel to KL",
    "",
    "350.00",
    "0.00",
    "MYR",
    "1",
    "credit_card",
    "INV-001",
    "2026-07-12",
    "Receipt attached later",
  ];
  const csv = `${columns.join(",")}\n${sample.map(csvCell).join(",")}\n`;
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="credit-card-claim-template.csv"',
    },
  });
}

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}
