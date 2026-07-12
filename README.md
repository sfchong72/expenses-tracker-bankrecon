# Internal Finance Operations Dashboard

Supplier Bills, Student Payments, Bank Reconciliation & Audit Readiness.

This is an internal finance workspace for supplier bills, recurring obligations, payment vouchers, document evidence, student payment tracking, bank reconciliation, and audit preparation.

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
- Bank reconciliation workspace

## Phase Notes

- Phase 1 established the protected foundation, entities, roles, permissions, and settings.
- Phase 2 adds supplier bills, recurring obligations, payment vouchers, private documents, and missing-document readiness checks.

Routes and deployment project names are intentionally unchanged for now.
