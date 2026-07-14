# Internal Finance Operations Dashboard

Expense administration, payment preparation and supporting-document control.

Bank reconciliation and official accounting records are maintained in SQL Accounting. This application supports expense administration, payment preparation and supporting-document control.

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 App Router |
| Language | TypeScript |
| Auth + DB | Supabase Auth, Postgres, RLS, Storage |
| Package manager | pnpm |
| Deploy | Vercel through the existing GitHub connection |

## Current Modules

- Authentication and role-based access control
- Entity settings for IEA, IETA, PLC, and KALER
- Supplier bills and recurring monthly obligations
- Payment vouchers with entity/month numbering
- Private supporting document uploads
- Missing-document tracking
- Dormant historical bank-import tables retained for audit continuity only

## Phase Notes

- Phase 1 established the protected foundation, entities, roles, permissions, and settings.
- Phase 2 adds supplier bills, recurring obligations, payment vouchers, private documents, and missing-document readiness checks.
- Phase 3A bank import and reconciliation screens are inactive because SQL Accounting remains the official accounting and bank reconciliation system.

Routes and deployment project names are intentionally unchanged for now.
