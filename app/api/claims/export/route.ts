import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

type Row = Record<string, any>;

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const claimId = url.searchParams.get("claimId");
  let claimQuery = supabase.from("claims").select("*").order("created_at", { ascending: false });
  if (claimId) claimQuery = claimQuery.eq("id", claimId);
  const [claimsRes, linesRes, entitiesRes, categoriesRes, vouchersRes] = await Promise.all([
    claimQuery,
    supabase.from("claim_lines").select("*").order("sort_order"),
    supabase.from("entities").select("id, short_code"),
    supabase.from("categories").select("id, name, account_code"),
    supabase.from("payment_vouchers").select("id, voucher_number, bank_reference"),
  ]);
  const firstError = claimsRes.error || linesRes.error || entitiesRes.error || categoriesRes.error || vouchersRes.error;
  if (firstError) return NextResponse.json({ error: firstError.message }, { status: 400 });

  const claims = claimsRes.data ?? [];
  const lines = linesRes.data ?? [];
  const entities = entitiesRes.data ?? [];
  const categories = categoriesRes.data ?? [];
  const vouchers = vouchersRes.data ?? [];

  const header = [
    "entity_code",
    "claim_number",
    "claim_type",
    "claimant",
    "line_date",
    "account_category_code",
    "category",
    "merchant",
    "description",
    "amount",
    "tax",
    "claimant_name",
    "voucher_number",
    "payment_reference",
    "sql_accounting_reference",
  ];

  const rows = lines
    .filter((line) => claims.some((claim) => claim.id === line.claim_id))
    .map((line) => {
      const claim = claims.find((item) => item.id === line.claim_id) as Row;
      const entity = entities.find((item) => item.id === claim.entity_id);
      const category = categories.find((item) => item.id === line.expense_category_id);
      const voucher = vouchers.find((item) => item.id === claim.payment_voucher_id);
      return [
        entity?.short_code ?? "",
        claim.claim_number ?? "",
        claim.claim_type ?? "",
        claim.claimant_name ?? "",
        line.expense_date || line.transaction_date || claim.statement_month || "",
        category?.account_code ?? "",
        category?.name ?? "",
        line.merchant_or_supplier ?? "",
        line.description ?? "",
        String(line.myr_converted_amount ?? line.amount ?? 0),
        String(line.tax_amount ?? 0),
        claim.claimant_name ?? "",
        voucher?.voucher_number ?? "",
        claim.payment_reference || voucher?.bank_reference || "",
        claim.sql_accounting_reference ?? "",
      ];
    });

  const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
  return new NextResponse(`${csv}\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="claims-sql-accounting-export${claimId ? `-${claimId}` : ""}.csv"`,
    },
  });
}

function csvCell(value: string) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}
