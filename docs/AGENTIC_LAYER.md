# Agentic Layer

## Risk Classification

### Low — auto-execute (no approval)
- Tag an invoice as overdue when `due_date < today` and `status = 'unpaid'` (nightly rule)
- Generate reconciliation summary statistics (matched %, unmatched MYR total)
- Produce draft CSV export

### Medium — show draft, user clicks Confirm
- `suggest_fuzzy_match`: AI proposes a match pairing → displayed as a suggestion card → user clicks Accept or Reject
- `mark_invoice_paid`: triggered after a match is accepted → updates `invoices.status` → user sees change immediately, can undo within the session

### High — always requires explicit approval
- Bulk-import bank statement rows (user must confirm row count before insert)
- Override an already-accepted match (audit trail required)

### Critical — human only (no agent path)
- Delete any invoice, receipt, or bank transaction
- Purge a reconciliation period

## Named Tools (approved list)
| Tool | Risk | Description |
|---|---|---|
| `run_auto_match` | Low | Deterministic match engine; reads + inserts |
| `suggest_fuzzy_match` | Medium | AI candidate proposal; writes suggestion only |
| `export_reconciliation_csv` | Low | Streams CSV from DB; read-only |
| `mark_invoice_paid` | Medium | Updates one status field |
| `log_audit_event` | Low | Appends to audit_logs |

No `run_any_sql`, no `send_any_email`, no raw file-system access.

## Audit Log Fields
`action`, `entity_type`, `entity_id`, `payload` (before/after), `user_id`, `created_at`

## v1 vs Later
**v1:** `run_auto_match` + `export_reconciliation_csv` only. 
**Later:** `suggest_fuzzy_match` in Sprint 4; email reminders in a post-v1 sprint.
