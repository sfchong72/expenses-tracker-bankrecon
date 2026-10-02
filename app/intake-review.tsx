"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ActionGroup, FieldValue, StatusBadge } from "@/app/ui-v2";
import { canVerifyIntake, verificationBlockers, type VerificationState } from "@/lib/financeops/verification";

/**
 * FinanceOps Intake Review - UI SHELL (Phase 1 prep).
 *
 * Presentational only: it receives data and callbacks as props, performs no database or
 * network calls, and persists nothing. It is NOT mounted anywhere yet. The real data source
 * (the finance_intake_submissions table) needs a future migration, so the shell stays disabled
 * until `enabled` is passed by a wired container. Never fake verification by writing these
 * values into existing bill fields.
 *
 * Verified != approved for payment. Verification only confirms the extracted data matches the
 * original document. Releasing a draft bill to Unpaid is a separate Finance Staff-or-higher action.
 */

export type IntakeFlag = string;

export type SupplierCandidateView = { supplierId: string; name: string; score: number; reason: string };
export type DuplicateMatchView = { type: string; billId: string; entityCode: string; strength: "hard" | "soft" };

export type ExtractedField = { label: string; value: string | null; confidence: number | null; flag?: IntakeFlag };

export type IntakeReviewItem = {
  intakeId: string;
  /** Auth user that created the intake (the FinanceOps identity). Used for the four-eyes check. */
  createdByUserId: string;
  receivedAt: string;
  entityCode: string | null;
  billId: string | null;
  flags: IntakeFlag[];
  extracted: ExtractedField[];
  /** Editable proposal currently stored on the draft bill. */
  current: VerificationState["current"];
  dueDateIsPlaceholder: boolean;
  supplierCandidates: SupplierCandidateView[];
  duplicates: DuplicateMatchView[];
  /** Short-lived signed URL for the original document, supplied by the container. */
  documentUrl: string | null;
  documentMime: string | null;
};

const FLAG_LABELS: Record<string, string> = {
  entity_unresolved: "Entity uncertain - choose the entity",
  due_date_missing: "Due date not stated - placeholder in use",
  bill_date_missing: "Invoice date not stated",
  amount_missing: "Amount not extracted",
  amount_mismatch: "Subtotal + tax does not equal total",
  total_derived_from_subtotal: "Total derived from subtotal",
  invoice_number_missing: "Invoice number not stated",
  description_inferred: "Description was generated",
  currency_assumed: "Currency assumed to be MYR",
  non_myr_currency: "Non-MYR currency",
  supplier_unmatched: "No matching supplier",
  supplier_ambiguous: "Several possible suppliers",
  category_unmatched: "No matching category",
  category_ambiguous: "Several possible categories",
  duplicate_suspected_file: "Identical file already on a bill in this entity",
  possible_duplicate_invoice_number: "Same supplier and invoice number exists",
  possible_duplicate_amount_date: "Same supplier, amount and date exists",
  same_file_in_other_entity: "Same file exists in another entity",
  due_date_before_bill_date: "Due date is before the invoice date",
};

export function flagLabel(flag: string): string {
  if (flag.startsWith("low_confidence:")) return `Low extraction confidence: ${flag.slice("low_confidence:".length).replace(/_/g, " ")}`;
  return FLAG_LABELS[flag] ?? flag.replace(/_/g, " ");
}

export function FlagList({ flags }: { flags: readonly IntakeFlag[] }) {
  if (!flags.length) return <p className="help">No extraction flags.</p>;
  return (
    <ul className="mini" aria-label="Extraction flags">
      {flags.map((f) => (
        <li key={f}>
          <span className="tag">{f.startsWith("duplicate") || f.includes("duplicate") ? "Check" : "Flag"}</span> {flagLabel(f)}
        </li>
      ))}
    </ul>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: number | null }) {
  if (confidence === null) return null;
  const pct = Math.round(confidence * 100);
  return <span className="tag" title="FinanceOps extraction confidence">{pct}%{confidence < 0.8 ? " - low" : ""}</span>;
}

export function ExtractedFields({ fields }: { fields: readonly ExtractedField[] }) {
  return (
    <div className="detail-grid">
      {fields.map((f) => (
        <FieldValue key={f.label} label={f.label}>
          {f.value ?? <em>not stated</em>} <ConfidenceBadge confidence={f.confidence} />
          {f.flag === "due_date_missing" && <span className="tag" title="Stored only because the system requires a value">PLACEHOLDER - not verified</span>}
        </FieldValue>
      ))}
    </div>
  );
}

export function SupplierCandidates({ candidates, selectedId, onSelect }: { candidates: readonly SupplierCandidateView[]; selectedId: string | null; onSelect?: (supplierId: string) => void }) {
  if (!candidates.length) return <p className="help">No supplier candidates. Choose or create the supplier in Suppliers.</p>;
  return (
    <div className="mini" role="radiogroup" aria-label="Supplier candidates">
      {candidates.map((c) => (
        <label key={c.supplierId}>
          <input type="radio" name="supplier-candidate" checked={selectedId === c.supplierId} disabled={!onSelect} onChange={() => onSelect?.(c.supplierId)} /> {c.name} <span className="tag">{Math.round(c.score * 100)}%</span> <span className="help">{c.reason.replace(/_/g, " ")}</span>
        </label>
      ))}
    </div>
  );
}

export function DuplicateWarnings({ matches, onOpenBill }: { matches: readonly DuplicateMatchView[]; onOpenBill?: (billId: string) => void }) {
  if (!matches.length) return null;
  return (
    <div className="mini" role="alert">
      <b>Possible duplicates</b>
      {matches.map((m) => (
        <p key={`${m.type}-${m.billId}`}>
          {m.strength === "hard" ? "Identical file" : "Similar"} - {m.type.replace(/_/g, " ")} ({m.entityCode}){" "}
          {onOpenBill && <button type="button" className="neutral" onClick={() => onOpenBill(m.billId)}>Open bill</button>}
        </p>
      ))}
    </div>
  );
}

export function OriginalDocument({ url, mime }: { url: string | null; mime: string | null }) {
  if (!url) return <div className="empty">Original document not available.</div>;
  if (mime === "application/pdf") return <iframe title="Original invoice" src={url} style={{ width: "100%", height: 520, border: "1px solid var(--line)", borderRadius: 8 }} />;
  return <img alt="Original invoice" src={url} style={{ maxWidth: "100%", border: "1px solid var(--line)", borderRadius: 8 }} />;
}

export type IntakeReviewPanelProps = {
  item: IntakeReviewItem;
  /** Current signed-in user. */
  actorUserId: string | null;
  onVerify?: () => void;
  onReject?: () => void;
  onSelectSupplier?: (supplierId: string) => void;
  onOpenBill?: (billId: string) => void;
  /** Rendered between the fields and the actions, e.g. the existing bill edit form. */
  children?: ReactNode;
};

export function IntakeReviewPanel({ item, actorUserId, onVerify, onReject, onSelectSupplier, onOpenBill, children }: IntakeReviewPanelProps) {
  const [confirmed, setConfirmed] = useState({ dueDate: false, amount: false, supplier: false, entity: false });
  const [duplicatesAcknowledged, setDuplicatesAcknowledged] = useState(false);

  const blockers = useMemo(
    () => verificationBlockers({ flags: item.flags, confirmed, current: item.current, duplicatesAcknowledged }),
    [item.flags, item.current, confirmed, duplicatesAcknowledged],
  );
  const mayVerify = canVerifyIntake(actorUserId, item.createdByUserId);
  const hasDuplicateFlags = item.duplicates.length > 0;

  return (
    <section className="panel" aria-label={`Intake ${item.intakeId}`}>
      <h2>
        Review FinanceOps intake <StatusBadge status="draft" label="Draft - unverified" />
      </h2>
      <p className="help">
        Received {item.receivedAt} - Entity {item.entityCode ?? "UNCERTAIN"}. Verifying confirms the data matches the original document. It does not approve payment.
      </p>
      <div className="grid">
        <div>
          <OriginalDocument url={item.documentUrl} mime={item.documentMime} />
        </div>
        <div>
          <FlagList flags={item.flags} />
          <ExtractedFields fields={item.extracted} />
          <SupplierCandidates candidates={item.supplierCandidates} selectedId={item.current.supplierId} onSelect={onSelectSupplier} />
          <DuplicateWarnings matches={item.duplicates} onOpenBill={onOpenBill} />
          {children}
          <fieldset className="mini">
            <legend>Confirm before verifying</legend>
            {item.flags.includes("due_date_missing") && (
              <label><input type="checkbox" checked={confirmed.dueDate} onChange={(e) => setConfirmed({ ...confirmed, dueDate: e.target.checked })} /> I confirmed or corrected the due date (the stored date is only a placeholder)</label>
            )}
            {item.flags.includes("amount_missing") && (
              <label><input type="checkbox" checked={confirmed.amount} onChange={(e) => setConfirmed({ ...confirmed, amount: e.target.checked })} /> I confirmed the amount against the document</label>
            )}
            {item.flags.includes("entity_unresolved") && (
              <label><input type="checkbox" checked={confirmed.entity} onChange={(e) => setConfirmed({ ...confirmed, entity: e.target.checked })} /> I confirmed the entity</label>
            )}
            {(item.flags.includes("supplier_unmatched") || item.flags.includes("supplier_ambiguous")) && (
              <label><input type="checkbox" checked={confirmed.supplier} onChange={(e) => setConfirmed({ ...confirmed, supplier: e.target.checked })} /> I confirmed the supplier</label>
            )}
            {hasDuplicateFlags && (
              <label><input type="checkbox" checked={duplicatesAcknowledged} onChange={(e) => setDuplicatesAcknowledged(e.target.checked)} /> I reviewed the duplicate warnings</label>
            )}
          </fieldset>
          {!mayVerify && <p className="help">The identity that created this intake cannot verify it. A staff member must review it.</p>}
          {mayVerify && blockers.length > 0 && (
            <ul className="mini" aria-label="Verification blockers">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          )}
          <ActionGroup label="Intake review actions">
            <button type="button" className="primary" disabled={!mayVerify || blockers.length > 0 || !onVerify} onClick={onVerify}>Mark verified</button>
            <button type="button" className="neutral" disabled={!onReject} onClick={onReject}>Reject intake</button>
          </ActionGroup>
          <p className="help">After verification a Finance Staff member or above releases the draft to Unpaid. Verified bills are not payable until then.</p>
        </div>
      </div>
    </section>
  );
}

export function IntakeReviewShell({ enabled = false, items = [], actorUserId = null, renderItem }: { enabled?: boolean; items?: readonly IntakeReviewItem[]; actorUserId?: string | null; renderItem?: (item: IntakeReviewItem) => ReactNode }) {
  if (!enabled) {
    return (
      <section className="panel" aria-label="FinanceOps intake review (disabled)">
        <h2>FinanceOps intake review</h2>
        <div className="empty">FinanceOps intake is not enabled yet. It requires the Stage 1B release and the approved intake migration.</div>
      </section>
    );
  }
  if (!items.length) {
    return (
      <section className="panel" aria-label="FinanceOps intake review">
        <h2>FinanceOps intake review</h2>
        <div className="empty">No intakes are waiting for review.</div>
      </section>
    );
  }
  return <>{items.map((item) => <div key={item.intakeId}>{renderItem ? renderItem(item) : <IntakeReviewPanel item={item} actorUserId={actorUserId} />}</div>)}</>;
}
