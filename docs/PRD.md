# PRD - Internal Finance Operations Dashboard

Expense administration, payment preparation and supporting-document control.

Bank reconciliation and official accounting records are maintained in SQL Accounting. This application supports expense administration, payment preparation and supporting-document control.

## Target Users
Business owner, finance staff, data-entry staff and read-only reviewers.

## Active Scope
- Suppliers and payees
- Expense categories
- Recurring obligations
- Supplier bills
- Payment vouchers
- Supporting documents
- Missing-document tracking
- Payment preparation and audit evidence

## Core Objects
| Object | Purpose |
|---|---|
| Supplier / Payee | Party to be paid, with contact and payment details |
| Expense Category | Operational category used for bills and voucher items |
| Recurring Obligation | Monthly or periodic payment obligation |
| Supplier Bill | Invoice, statutory payment, payroll support, or other payable record |
| Payment Voucher | Prepared payment instruction with printable evidence |
| Document | Private supporting document linked to bills, vouchers, payments, or obligations |
| Audit Log | Immutable record of important actions |

## Out Of Active Scope
- Bank statement import
- Bank reconciliation
- Bank balance calculation
- Official accounting ledger
- SQL Accounting posting
- OCR or AI invoice extraction
- Personal expenses and credit-card claims

## Success Criteria
User can maintain suppliers, import or create recurring obligations, create supplier bills with supporting documents, prepare payment vouchers, track missing evidence, and keep audit-ready payment records without using the app for official bank reconciliation.
