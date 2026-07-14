import { NextResponse } from "next/server";
import { BankMapping, mapBankRows, statementMonthStart } from "@/lib/import/bank-statement";
import { requireBankAccess } from "@/app/api/bank-imports/_shared";

type IncomingRow = {
  id?: string;
  rowNumber?: number;
  original?: Record<string, string>;
  excluded?: boolean;
  duplicateWarnings?: unknown[];
  duplicateDecision?: string;
};

export async function POST(request: Request) {
  const body = await request.json();
  const rows = (body.rows ?? []) as IncomingRow[];
  const mapping = (body.mapping ?? {}) as BankMapping;
  const bankAccountId = String(body.bankAccountId ?? "");
  const entityId = body.entityId ? String(body.entityId) : undefined;
  const statementMonth = statementMonthStart(String(body.statementMonth ?? ""));

  const { supabase, error } = await requireBankAccess(entityId, "import");
  if (error) return error;
  if (!bankAccountId) return NextResponse.json({ error: "Bank account is required before applying mapping." }, { status: 400 });
  if (!rows.length) return NextResponse.json({ rows: [] });

  let fingerprintQuery = supabase
    .from("bank_transactions_staff_safe")
    .select("duplicate_fingerprint")
    .eq("bank_account_id", bankAccountId);
  if (statementMonth) fingerprintQuery = fingerprintQuery.eq("statement_month", statementMonth);
  const existing = await fingerprintQuery;
  if (existing.error) return NextResponse.json({ error: existing.error.message }, { status: 400 });
  const existingFingerprints = new Set((existing.data ?? []).map((row) => String(row.duplicate_fingerprint ?? "")).filter(Boolean));

  const reprocessed = mapBankRows(
    rows.map((row) => row.original ?? {}),
    mapping,
    existingFingerprints,
    bankAccountId,
  ).map((row, index) => {
    const previous = rows[index] ?? {};
    const duplicateWarnings = row.duplicateWarnings.length ? row.duplicateWarnings : previous.duplicateWarnings ?? [];
    return {
      ...row,
      id: previous.id,
      rowNumber: previous.rowNumber ?? row.rowNumber,
      excluded: previous.excluded ?? row.excluded,
      duplicateWarnings,
      duplicateDecision: previous.duplicateDecision ?? (duplicateWarnings.length ? "pending" : "import_as_new"),
    };
  });

  return NextResponse.json({ rows: reprocessed });
}
