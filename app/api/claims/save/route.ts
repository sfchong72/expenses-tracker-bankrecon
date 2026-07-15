import { createClient } from "@/lib/supabase/server";
import { fingerprintClaimLine, lastFourDigits, parseAmount, parseDate } from "@/lib/import/claim-credit-card";
import { NextResponse } from "next/server";

type ClaimLineInput = Record<string, unknown> & { client_key?: string };
type AdvanceInput = Record<string, unknown>;

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const claim = body.claim as Record<string, unknown>;
  const lines = (body.lines ?? []) as ClaimLineInput[];
  const advances = (body.advances ?? []) as AdvanceInput[];

  if (!claim?.entity_id || !claim.claimant_name || !claim.claim_mode || !claim.claim_type) {
    return NextResponse.json({ error: "Entity, claimant, mode and claim type are required" }, { status: 400 });
  }
  if (!lines.length) return NextResponse.json({ error: "Add at least one claim line" }, { status: 400 });

  const claimPayload = {
    entity_id: String(claim.entity_id),
    claim_mode: String(claim.claim_mode),
    claim_type: String(claim.claim_type),
    claimant_user_id: cleanUuid(claim.claimant_user_id),
    claimant_name: cleanText(claim.claimant_name),
    designation: cleanText(claim.designation),
    department: cleanText(claim.department),
    claim_period_start: parseDate(claim.claim_period_start),
    claim_period_end: parseDate(claim.claim_period_end),
    statement_date: parseDate(claim.statement_date),
    statement_month: monthStart(claim.statement_month || claim.statement_date),
    trip_or_business_purpose: cleanText(claim.trip_or_business_purpose),
    currency: cleanText(claim.currency) || "MYR",
    remarks: cleanText(claim.remarks),
    created_by: userData.user.id,
    updated_by: userData.user.id,
    data_origin: "manual",
    is_demo: false,
  };

  const saved = claim.id
    ? await supabase.from("claims").update({ ...claimPayload, created_by: undefined }).eq("id", claim.id).select("id").single()
    : await supabase.from("claims").insert(claimPayload).select("id").single();
  if (saved.error) return NextResponse.json({ error: saved.error.message }, { status: 400 });

  const claimId = saved.data.id;

  if (claim.id) {
    const existingLines = await supabase.from("claim_lines").select("id").eq("claim_id", claimId);
    if (existingLines.error) return NextResponse.json({ error: existingLines.error.message }, { status: 400 });
    const lineIds = (existingLines.data ?? []).map((row) => row.id);
    if (lineIds.length) {
      const linked = await supabase.from("document_links").select("linked_record_id").eq("linked_record_type", "claim_line").in("linked_record_id", lineIds).limit(1);
      if (linked.data?.length) return NextResponse.json({ error: "This claim has line documents. Open a new revision instead of replacing existing lines." }, { status: 409 });
    }
    await supabase.from("claim_lines").delete().eq("claim_id", claimId);
    await supabase.from("claim_advances").delete().eq("claim_id", claimId);
  }

  const lineRows = lines.map((line, index) => buildLine(claimId, String(claim.entity_id), line, index));
  const lineResult = await supabase.from("claim_lines").insert(lineRows).select("id, client_key");
  if (lineResult.error) return NextResponse.json({ error: lineResult.error.message }, { status: 400 });

  const advanceRows = advances
    .filter((advance) => Number(parseAmount(advance.advance_amount) ?? 0) > 0)
    .map((advance) => ({
      claim_id: claimId,
      entity_id: String(claim.entity_id),
      advance_amount: Number(parseAmount(advance.advance_amount) ?? 0),
      advance_date: parseDate(advance.advance_date),
      advance_reference: cleanText(advance.advance_reference),
      amount_utilised: Number(parseAmount(advance.amount_utilised) ?? parseAmount(advance.advance_amount) ?? 0),
      remarks: cleanText(advance.remarks),
      created_by: userData.user.id,
    }));
  if (advanceRows.length) {
    const advanceResult = await supabase.from("claim_advances").insert(advanceRows);
    if (advanceResult.error) return NextResponse.json({ error: advanceResult.error.message }, { status: 400 });
  }

  await supabase.rpc("recalculate_claim_totals", { p_claim_id: claimId });
  await supabase.from("audit_logs").insert({
    actor_user_id: userData.user.id,
    action: claim.id ? "claim_updated" : "claim_created",
    entity_type: "claim",
    entity_id: String(claim.entity_id),
    payload: { claim_id: claimId, line_count: lines.length },
    data_origin: "manual",
  });

  const refreshed = await supabase.from("claims").select("*").eq("id", claimId).single();
  return NextResponse.json({ claim: refreshed.data, lines: lineResult.data ?? [] });
}

function buildLine(claimId: string, entityId: string, line: ClaimLineInput, index: number) {
  const amount = Number(parseAmount(line.amount) ?? 0);
  const exchange = Number(parseAmount(line.exchange_rate) ?? 1) || 1;
  const converted = Number(parseAmount(line.myr_converted_amount) ?? amount * exchange);
  const lineType = cleanText(line.line_type) || "miscellaneous";
  const warnings = validationWarnings(line);
  const mappedForFingerprint = {
    card_last_four: line.card_last_four,
    transaction_date: line.transaction_date || line.expense_date,
    statement_date: line.statement_date,
    amount,
    merchant_or_supplier: line.merchant_or_supplier,
    transaction_description: line.transaction_description || line.description,
  };
  return {
    claim_id: claimId,
    entity_id: entityId,
    client_key: cleanText(line.client_key) || `line-${index}`,
    line_type: lineType,
    expense_date: parseDate(line.expense_date || line.transaction_date),
    statement_date: parseDate(line.statement_date),
    transaction_date: parseDate(line.transaction_date),
    from_location: cleanText(line.from_location),
    to_location: cleanText(line.to_location),
    transport_mode: cleanText(line.transport_mode),
    distance_km: Number(parseAmount(line.distance_km) ?? 0) || null,
    mileage_rate: Number(parseAmount(line.mileage_rate) ?? 0) || null,
    check_in_date: parseDate(line.check_in_date),
    check_out_date: parseDate(line.check_out_date),
    number_of_nights: line.number_of_nights ? Number(line.number_of_nights) : null,
    hotel_name: cleanText(line.hotel_name),
    merchant_or_supplier: cleanText(line.merchant_or_supplier),
    invoice_or_receipt_number: cleanText(line.invoice_or_receipt_number),
    payment_method: cleanText(line.payment_method),
    receipt_date: parseDate(line.receipt_date),
    cardholder_name: cleanText(line.cardholder_name),
    card_last_four: lastFourDigits(line.card_last_four) || null,
    card_type: cleanText(line.card_type) || null,
    transaction_description: cleanText(line.transaction_description),
    business_purpose: cleanText(line.business_purpose),
    description: cleanText(line.description || line.transaction_description || line.merchant_or_supplier) || "Claim line",
    expense_category_id: cleanUuid(line.expense_category_id),
    amount,
    tax_amount: Number(parseAmount(line.tax_amount) ?? 0),
    original_currency: cleanText(line.original_currency) || "MYR",
    exchange_rate: exchange,
    myr_converted_amount: converted,
    receipt_status: line.requires_receipt === false ? "not_required" : "missing",
    document_status: line.requires_receipt === false ? "not_required" : "missing",
    requires_receipt: line.requires_receipt !== false,
    validation_warnings: warnings,
    duplicate_fingerprint: lineType === "credit_card_transaction" ? fingerprintClaimLine(entityId, parseDate(line.statement_date) ?? new Date().toISOString().slice(0, 10), mappedForFingerprint) : null,
    sort_order: index + 1,
  };
}

function validationWarnings(line: ClaimLineInput) {
  const warnings: string[] = [];
  const expenseDate = parseDate(line.expense_date || line.transaction_date);
  const receiptDate = parseDate(line.receipt_date);
  const checkIn = parseDate(line.check_in_date);
  const checkOut = parseDate(line.check_out_date);
  if (receiptDate && expenseDate && receiptDate < expenseDate) warnings.push("Receipt date is before expense date");
  if (checkIn && checkOut && checkOut < checkIn) warnings.push("Check-out date is before check-in date");
  if (line.line_type === "credit_card_transaction" && !lastFourDigits(line.card_last_four)) warnings.push("Card last four digits missing");
  return warnings;
}

function cleanText(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function cleanUuid(value: unknown) {
  const text = String(value ?? "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text) ? text : null;
}

function monthStart(value: unknown) {
  const parsed = parseDate(value);
  if (!parsed) return null;
  return `${parsed.slice(0, 7)}-01`;
}
