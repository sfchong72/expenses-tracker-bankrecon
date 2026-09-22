# PRD - Internal Finance Operations Dashboard

Expense administration, payment preparation and supporting-document control.

Bank reconciliation and official accounting records are maintained in SQL Accounting. This application supports expense administration, payment preparation and supporting-document control.

## Target Users
This is a private Finance and Management application. Permitted roles are Owner/Admin,
Finance Manager, Finance Staff, specifically appointed Management, and Intern/Data Entry.
Trainers, counsellors, marketing personnel and other general staff have no application,
API, database or document access.

## Active Scope
- Suppliers and payees
- Expense categories
- Recurring obligations
- Supplier bills
- Payment vouchers
- Supporting documents
- Missing-document tracking
- Payment preparation and audit evidence
- Staff, director and personally paid claims with confidential supporting evidence
- Student, programme, intake and enrolment operations for specifically authorised users

## Core Objects
| Object | Purpose |
|---|---|
| Supplier / Payee | Party to be paid, with contact and payment details |
| Expense Category | Operational category used for bills and voucher items |
| Recurring Obligation | Monthly or periodic payment obligation |
| Supplier Bill | Invoice, statutory payment, payroll support, or other payable record |
| Payment Voucher | Prepared payment instruction with printable evidence |
| Document | Private supporting document linked to bills, vouchers, payments, or obligations |
| Claim | Staff, director or personally paid expense claim with controlled review and approval |
| Audit Log | Immutable record of important actions |

## Out Of Active Scope
- Bank statement import
- Bank reconciliation
- Bank balance calculation
- Official accounting ledger
- SQL Accounting posting
- OCR or AI invoice extraction

## Success Criteria
Authorised users can maintain suppliers, recurring obligations, bills, claims and supporting
documents; prepare controlled payment vouchers; operate Student Operations within assigned
entities/branches; and retain audit-ready evidence without using the app as the official
accounting ledger or bank-reconciliation system.
