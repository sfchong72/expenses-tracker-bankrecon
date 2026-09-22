# Architecture

## Active Product Scope

Bank reconciliation and official accounting records are maintained in SQL Accounting. This application supports expense administration, payment preparation and supporting-document control.

The approved future boundary is:

`Telegram → Hermes FinanceOps → Finance App → Human verification/approval → SQL Account → Accountant/Tax Agent`

Telegram is intake only. Hermes FinanceOps may extract, prepare, remind and manage exceptions,
but it has no payment or approval authority. The Finance App is the operational record. SQL
Account remains the official accounting ledger and official bank-reconciliation system. Google
Drive is archive/formal-output storage only. Hermes and SQL Account integrations are future work
and are not implemented by the Stage 1B security foundation.

## Stack
| Layer | Choice |
|---|---|
| Frontend | Next.js App Router on Vercel |
| Database | Supabase Postgres with RLS |
| Auth | Supabase email/password authentication |
| Storage | Private Supabase Storage for supporting documents |

## Access Boundary

Only Owner/Admin, Finance Manager, Finance Staff, specifically appointed Management and
Intern/Data Entry accounts may enter the application. Owner/Admin and Finance Manager sessions
require MFA assurance level 2. Authorization is enforced through database grants, RLS, Storage
policies and server routes; navigation visibility is not a security control.

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
