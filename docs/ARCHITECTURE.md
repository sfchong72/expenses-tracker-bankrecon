# Architecture

## Active Product Scope

Bank reconciliation and official accounting records are maintained in SQL Accounting. This application supports expense administration, payment preparation and supporting-document control.

## Stack
| Layer | Choice |
|---|---|
| Frontend | Next.js App Router on Vercel |
| Database | Supabase Postgres with RLS |
| Auth | Supabase email/password authentication |
| Storage | Private Supabase Storage for supporting documents |

## Active Workflow

1. Maintain suppliers/payees and expense categories.
2. Create recurring obligations and generate monthly draft supplier bills.
3. Create supplier bills and upload supporting invoices or receipts.
4. Prepare manual or bill-based payment voucher drafts.
5. Issue payment vouchers using entity/month numbering.
6. Record payment method, paying bank account, payment reference and payment date where needed.
7. Track missing supporting documents and audit evidence.

## Dormant Bank Structures

Phase 3A bank import and reconciliation tables may remain in the database for historical continuity. They are not part of the active UI and should not be dropped or edited without a separate approval.
