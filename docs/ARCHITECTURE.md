# Architecture

## Stack
| Layer | Choice |
|---|---|
| Frontend | Next.js 14 (App Router) on Vercel |
| Database | Supabase (Postgres + RLS) |
| Auth (later) | Supabase Auth — Sprint 5 only |
| AI (later) | OpenAI API via server-side route — Sprint 4 |

## Build Sequence
**Now:** Invoice CRUD → Receipt CRUD → Bank transaction entry + CSV import → Auto-match engine → Reconciliation view → CSV export 
**Next:** Auth + per-user RLS, PDF/CSV bank statement parser, AI fuzzy match 
**Later:** Bank feed, SQL accounting connector, multi-currency

## Key User Action — Step-by-Step
1. User pastes/imports June bank statement rows → stored in `bank_transactions`
2. User clicks **Run Auto-Match** → server function queries invoices + receipts; for each bank row finds a record where `amount` matches exactly and `date` is within ±3 days
3. Matched pairs written to `reconciliation_matches` with `matched_by='system'`
4. Reconciliation view reads joined query → renders matched / unmatched columns
5. User drags an unmatched invoice onto an unmatched bank row → manual match written, `audit_log` entry created
6. User clicks **Export CSV** → server streams the joined report

## Layer Plan
1. **Data layer** (Postgres schema, constraints, RLS) — built first; truth survives a refresh
2. **App logic** (match engine, CSV parser, export) — coded rules, no AI dependency
3. **Smart layer** (AI fuzzy match suggestions) — additive; disabling it leaves the app fully functional

## Why the Core Runs Without AI
Auto-matching is deterministic (exact amount + date window). The AI layer only proposes fuzzy candidates that a human must approve. Removing the AI call changes nothing about data integrity.
