# PRD - Internal Finance Operations Dashboard

Supplier Bills, Student Payments, Bank Reconciliation & Audit Readiness

## Problem
Every month the team manually cross-checks company invoices and personal expense receipts against a bank statement to produce an auditor-ready reconciliation for SQL accounting entry. The process takes several hours and is error-prone.

## Target Users
Business owner + finance staff (internal only, not a public product).

## Core Objects
| Object | Purpose |
|---|---|
| Invoice | Company bill to pay — vendor, amount, due date, status |
| Receipt | Personal/daily expense — merchant, amount, date, category |
| Bank Transaction | Row from the monthly bank statement |
| Reconciliation Match | Links a bank transaction to an invoice or receipt |
| Audit Log | Immutable record of every meaningful action |

## MVP Must-Haves
- [ ] Create, edit, delete invoices with payment deadline and status
- [ ] Create, edit, delete expense receipts with category
- [ ] Enter or CSV-import bank statement transactions
- [ ] Auto-match engine: exact amount + date ±3 days → creates a match
- [ ] Reconciliation view: matched pairs / unmatched invoices / unmatched bank rows
- [ ] Manual match override by the user
- [ ] CSV export of the full reconciliation report
- [ ] All pages render without login (demo-first)

## Non-Goals (v1)
- Bank feed / open-banking API
- Direct push to SQL accounting software
- Multi-currency conversion
- Invoice approval workflow
- Multi-tenant SaaS features

## Success Criteria
**Pass:** User enters 5 invoices, 5 receipts, and imports a 10-row bank statement. The auto-match engine links the correct pairs, the reconciliation view shows the 2 unmatched rows, the user manually resolves one, and exports a CSV — all in under 5 minutes. No data loss on refresh.
