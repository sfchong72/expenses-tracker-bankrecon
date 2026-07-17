import { createClient } from "@/lib/supabase/server";
import { fingerprintClaimLine, lastFourDigits, parseAmount, parseDate } from "@/lib/import/claim-credit-card";
import { NextResponse } from "next/server";

type ClaimLineInput = Record<string, unknown> & { client_key?: string };
type AdvanceInput = Record<string, unknown>;
type ValidationIssue = { key: string; field: string; message: string };

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const claim = body.claim as Record<string, unknown>;
  const lines = (body.lines ?? []) as ClaimLineInput[];
  const advances = (body.advances ?? []) as AdvanceInput[];
  const deletedLineIds = ((body.deletedLineIds ?? []) as unknown[]).map(cleanUuid).filter(Boolean) as string[];
  const deletedAdvanceIds = ((body.deletedAdvanceIds ?? []) as unknown[]).map(cleanUuid).filter(Boolean) as string[];

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

  const validation = validateLines(lines);
  if (validation.length) {
    return NextResponse.json({ error: "Please fix the highlighted claim line fields before saving.", fieldErrors: validation }, { status: 400 });
  }

  const { created_by: _createdBy, ...claimUpdatePayload } = claimPayload;
  const claimIdInput = cleanUuid(claim.id);
  const saved = claimIdInput
    ? await supabase.from("claims").update(claimUpdatePayload).eq("id", claimIdInput).select("id").single()
    : await supabase.from("claims").insert(claimPayload).select("id").single();
  if (saved.error) return NextResponse.json({ error: saved.error.message }, { status: 400 });

  const claimId = saved.data.id;

  if (claimIdInput && deletedLineIds.length) {
    const linked = await supabase.from("document_links").select("linked_record_id").eq("linked_record_type", "claim_line").in("linked_record_id", deletedLineIds).limit(1);
    if (linked.error) return NextResponse.json({ error: linked.error.message }, { status: 400 });
    if (linked.data?.length) return NextResponse.json({ error: "A removed claim line has linked evidence. Remove or re-link the evidence before deleting that line." }, { status: 409 });
    const deleted = await supabase.from("claim_lines").delete().eq("claim_id", claimId).in("id", deletedLineIds);
    if (deleted.error) return NextResponse.json({ error: deleted.error.message }, { status: 400 });
  }

  if (claimIdInput && deletedAdvanceIds.length) {
    const deleted = await supabase.from("claim_advances").delete().eq("claim_id", claimId).in("id", deletedAdvanceIds);
    if (deleted.error) return NextResponse.json({ error: deleted.error.message }, { status: 400 });
  }

  const savedLines = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineRow = buildLine(claimId, String(claim.entity_id), line, index);
    const lineId = cleanUuid(line.id);
    const result = lineId
      ? await supabase.from("claim_lines").update(lineRow).eq("id", lineId).eq("claim_id", claimId).select("id, client_key").single()
      : await supabase.from("claim_lines").insert(lineRow).select("id, client_key").single();
    if (result.error) return NextResponse.json({ error: result.error.message }, { status: 400 });
    savedLines.push(result.data);
  }

  const advanceRows = advances
    .filter((advance) => Number(parseAmount(advance.advance_amount) ?? 0) > 0)
    .map((advance) => ({
      id: cleanUuid(advance.id),
      claim_id: claimId,
      entity_id: String(claim.entity_id),
      advance_amount: Number(parseAmount(advance.advance_amount) ?? 0),
      advance_date: parseDate(advance.advance_date),
      advance_reference: cleanText(advance.advance_reference),
      amount_utilised: Number(parseAmount(advance.advance_amount) ?? 0),
      remarks: cleanText(advance.remarks),
      created_by: userData.user.id,
    }));
  for (const advanceRow of advanceRows) {
    const { id, ...row } = advanceRow;
    const result = id
      ? await supabase.from("claim_advances").update(row).eq("id", id).eq("claim_id", claimId)
      : await supabase.from("claim_advances").insert(row);
    if (result.error) return NextResponse.json({ error: result.error.message }, { status: 400 });
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
  return NextResponse.json({ claim: refreshed.data, lines: savedLines });
}

function buildLine(claimId: string, entityId: string, line: ClaimLineInput, index: number) {
  const lineType = cleanText(line.line_type) || "miscellaneous";
  const distance = Number(parseAmount(line.distance_km) ?? 0);
  const mileageRate = Number(parseAmount(line.mileage_rate) ?? 0);
  const mileageAmount = lineType === "mileage" ? roundMoney(distance * mileageRate) : 0;
  const amount = lineType === "mileage" ? mileageAmount : Number(parseAmount(line.amount) ?? 0);
  const exchange = Number(parseAmount(line.exchange_rate) ?? 1) || 1;
  const converted = Number(parseAmount(line.myr_converted_amount) ?? amount * exchange);
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
    distance_km: distance || null,
    mileage_rate: mileageRate || null,
    mileage_amount_calculated: mileageAmount || null,
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

function validateLines(lines: ClaimLineInput[]) {
  const issues: ValidationIssue[] = [];
  lines.forEach((line, index) => {
    const key = cleanText(line.client_key) || `line-${index}`;
    const lineType = cleanText(line.line_type) || "miscellaneous";
    const distance = Number(parseAmount(line.distance_km) ?? 0);
    const mileageRate = Number(parseAmount(line.mileage_rate) ?? 0);
    const amount = lineType === "mileage" ? distance * mileageRate : Number(parseAmount(line.amount) ?? 0);
    const description = cleanText(line.description || line.transaction_description || line.merchant_or_supplier);
    if (!description) issues.push({ key, field: "description", message: "Description is required." });
    if (lineType === "mileage") {
      if (distance <= 0) issues.push({ key, field: "distance_km", message: "Distance is required for mileage." });
      if (mileageRate <= 0) issues.push({ key, field: "mileage_rate", message: "Mileage rate is required." });
    }
    if (amount <= 0) issues.push({ key, field: "amount", message: "Amount must be greater than zero." });
    const checkIn = parseDate(line.check_in_date);
    const checkOut = parseDate(line.check_out_date);
    if (lineType === "accommodation" && checkIn && checkOut && checkOut < checkIn) {
      issues.push({ key, field: "check_out_date", message: "Check-out date cannot be before check-in date." });
    }
  });
  return issues;
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

function roundMoney(value: number) {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}
