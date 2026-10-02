/**
 * Pure duplicate classification for Phase 1A intake. No database access: the caller
 * loads the (RLS-scoped) rows and passes them in.
 *
 * Decision policy (owner decision D6):
 *  - identical file hash already linked to an ACTIVE bill in the SAME entity
 *    -> block (no new bill; case goes to human review as `duplicate_suspected`);
 *  - supplier+invoice number, supplier+amount+date, same file in another entity
 *    -> soft: a flagged draft may still be created.
 * Duplicate checks are advisory; the authoritative guard against double-submission
 * is the UNIQUE intake_id in the future intake table, not this module.
 */

export type DuplicateType = "exact_file" | "cross_entity_same_file" | "same_invoice_number" | "same_amount_date";

export type DuplicateMatch = {
  type: DuplicateType;
  strength: "hard" | "soft";
  billId: string;
  entityId: string;
};

export type DuplicateCandidate = {
  entityId: string;
  supplierId: string | null;
  invoiceNumber: string | null;
  totalAmount: number | null;
  billDate: string | null;
  fileSha256: string;
};

export type ExistingBill = {
  id: string;
  entityId: string;
  supplierId: string | null;
  billNumber: string | null;
  totalAmount: number;
  billDate: string | null;
  paymentStatus: string;
};

export type ExistingDocumentLink = {
  fileSha256: string | null;
  /** Bill the document is linked to; null if linked to something else. */
  billId: string | null;
  deleted: boolean;
};

export type DuplicateDecision = {
  decision: "block_duplicate_file" | "create_draft";
  matches: DuplicateMatch[];
  flags: string[];
};

export function normalizeInvoiceNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const n = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return n.length >= 2 ? n : null;
}

function cents(value: number): number {
  return Math.round(value * 100);
}

/** A cancelled bill is not "active" for duplicate purposes. */
export function isActiveBill(bill: Pick<ExistingBill, "paymentStatus">): boolean {
  return bill.paymentStatus !== "cancelled";
}

export function classifyDuplicates(
  candidate: DuplicateCandidate,
  bills: readonly ExistingBill[],
  documents: readonly ExistingDocumentLink[],
): DuplicateDecision {
  const matches: DuplicateMatch[] = [];
  const byId = new Map(bills.map((b) => [b.id, b]));
  const sha = candidate.fileSha256.toLowerCase();

  for (const doc of documents) {
    if (doc.deleted || !doc.billId || !doc.fileSha256 || doc.fileSha256.toLowerCase() !== sha) continue;
    const bill = byId.get(doc.billId);
    if (!bill || !isActiveBill(bill)) continue;
    if (bill.entityId === candidate.entityId) {
      matches.push({ type: "exact_file", strength: "hard", billId: bill.id, entityId: bill.entityId });
    } else {
      matches.push({ type: "cross_entity_same_file", strength: "soft", billId: bill.id, entityId: bill.entityId });
    }
  }

  const number = normalizeInvoiceNumber(candidate.invoiceNumber);
  for (const bill of bills) {
    if (!isActiveBill(bill) || bill.entityId !== candidate.entityId) continue;
    if (!candidate.supplierId || bill.supplierId !== candidate.supplierId) continue;
    if (number && normalizeInvoiceNumber(bill.billNumber) === number) {
      matches.push({ type: "same_invoice_number", strength: "soft", billId: bill.id, entityId: bill.entityId });
    }
    if (
      candidate.totalAmount !== null &&
      candidate.totalAmount > 0 &&
      candidate.billDate &&
      bill.billDate === candidate.billDate &&
      cents(bill.totalAmount) === cents(candidate.totalAmount)
    ) {
      matches.push({ type: "same_amount_date", strength: "soft", billId: bill.id, entityId: bill.entityId });
    }
  }

  const seen = new Set<string>();
  const unique = matches.filter((m) => {
    const k = `${m.type}|${m.billId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const rank: Record<DuplicateType, number> = { exact_file: 0, same_invoice_number: 1, same_amount_date: 2, cross_entity_same_file: 3 };
  unique.sort((a, b) => rank[a.type] - rank[b.type] || a.billId.localeCompare(b.billId));

  const flags: string[] = [];
  if (unique.some((m) => m.type === "exact_file")) flags.push("duplicate_suspected_file");
  if (unique.some((m) => m.type === "same_invoice_number")) flags.push("possible_duplicate_invoice_number");
  if (unique.some((m) => m.type === "same_amount_date")) flags.push("possible_duplicate_amount_date");
  if (unique.some((m) => m.type === "cross_entity_same_file")) flags.push("same_file_in_other_entity");

  return {
    decision: unique.some((m) => m.strength === "hard") ? "block_duplicate_file" : "create_draft",
    matches: unique,
    flags,
  };
}
