# FinanceOps Payment Register, bank matching and SQL tracking: handover

Written for the next person or agent who continues this work (Codex, Claude, or a developer). Read this first, then
`docs/FINANCEOPS_INTEGRATION.md` (the invoice-intake side) and `FINANCEOPS_PHASE1_CLAUDE_HANDOVER.md` (decision history).
It supersedes any older statement that "application persistence is not started" or "0024 does not exist".

**Status in one paragraph.** Migration 0023 (invoice intake) is applied to Production and on `main`. The Payment Register
module (migration 0024 plus the application code on `claude/financeops-phase1-prep`) is built and verified on a
disposable local database only. It is NOT applied to Production, NOT deployed, NOT enabled, and no FinanceOps Auth user,
registry row, Hermes secret or Production environment variable has been created for it. Everything is behind
`FINANCEOPS_PAYMENT_REGISTER_ENABLED` (default OFF).

## 1. Architecture (text diagram)

```
Documents / payment screenshots / wage sheets / invoices
        |
        v
 Hermes FinanceOps  --HMAC-signed HTTPS-->  POST /api/integrations/financeops/v1/payment-intakes   (and GET .../:intake_id)
        |                                        |  runs as the FinanceOps data_entry identity (its own Supabase session, RLS)
        |                                        v
        |                          finance_payment_register  (+ finance_payment_documents, private bucket)
        |                          status: captured | documents_pending | ready_for_bank_match     <- the ONLY statuses FinanceOps can set
        |
 People (Owner / Finance Manager / Finance Staff, and the data_entry intern for data entry)
        |
        |-- /finance-ops/payments            record, correct, attach documents, decide exceptions, move a payment along
        |-- /finance-ops/bank-import         CSV / XLSX / pasted statement rows  -> finance_bank_import_batches + finance_bank_statement_transactions
        |                                    (reviewers + MFA only; insert-only; NO balance stored)
        |-- /finance-ops/matching            rule-based SUGGESTIONS -> finance_payment_bank_matches; a human confirms / rejects
        |-- /finance-ops/missing-documents   everything a payment still needs; attach / not applicable / approve exception
        |-- /finance-ops/sql-queue           Ready for SQL -> person posts in SQL Account -> records the SQL reference -> Reconciled (tracking only)
        |-- /finance-ops/register-import     one-time import of the old Excel Payment Register (preview, no overwrite)
        v
 SQL Account (official accounting and bank reconciliation). The Hub does NOT connect to it in Phase 1.
```

The four things that are kept apart on purpose: a payment instruction or screenshot, a bank transaction, an accounting
posting in SQL Account, and the bank reconciliation. A Payment Register row is operational only.

## 2. Database objects (migration 0024, local candidate)

`supabase/migrations/0024_finance_payment_register_and_bank_matching.sql`. Adds only new objects; no existing table,
policy, trigger or function is changed.

| Object | Purpose |
|---|---|
| `finance_payment_register` | one row per payment: details, type, document requirements snapshot, status, `needs_attention`, human decision fields, SQL tracking fields, `legacy_state` for the Excel import |
| `finance_payment_documents` | documents of a payment (role, storage path, SHA-256, soft removal). One stored file may support several payments (unique per payment, not globally) |
| `finance_bank_import_batches`, `finance_bank_statement_transactions` | operational statement import. No balance column. Insert-only (no UPDATE/DELETE grant) |
| `finance_payment_bank_matches` | suggested / confirmed / rejected pairs with score and reasons; one confirmed match per payment and per bank row |
| bucket `finance-payment-documents` | private; read + insert policies only (nothing can be updated or deleted through the API) |
| `app_private.current_user_is_finance_reviewer()` | active owner / finance_manager / finance_staff |
| `app_private.current_user_is_financeops_identity()` | active registry identity |
| `app_private.finance_payment_has_confirmed_match(uuid)` | boolean-only definer helper so the status rules hold for a reviewer who cannot read bank rows (AAL1) |
| `app_private.finance_payment_missing_documents(...)` | INVOKER; used by the finance-review and ready-for-SQL gates |
| `app_private.user_can_access_payment_document_object(text)` | storage read helper |
| triggers `enforce_finance_payment_rules`, `enforce_finance_payment_document_rules`, `enforce_finance_bank_rows`, `enforce_finance_bank_match_rules` and audit triggers | the authority for who may do what; actor stamps are written from `auth.uid()` |

**Reused vs new, and why.** Existing `bank_transactions` / `bank_import_*` were NOT reused: they are Owner or
`can_view_bank_balances` plus AAL2 and carry `running_balance`; reviewers need to read statement rows without balances.
Existing `documents` / `document_links` were NOT reused: their access function (`user_can_access_linked_record`, a Stage 1B
SECURITY DEFINER function) has no payment-register type, and changing it would touch Stage 1B. Nothing touches
`bill_payments`, payment vouchers, `bank_accounts` or reconciliation tables.

## 3. Migration status

| Migration | Production | Repo |
|---|---|---|
| 0001-0018, 0020-0022 | applied | `main` |
| 0023 `financeops_intake_persistence` | **applied, immutable** (ledger row once) | `main` (`a1dbe11`) |
| 0024 `finance_payment_register_and_bank_matching` | **NOT applied** | `claude/financeops-phase1-prep` only |

Validation done on a disposable local stack: replay 0001-0023 then 0024 via the CLI migration mechanism; catalogue diff
shows 0 pre-existing objects changed and only 0024 objects added; `db lint` clean; the focused pgTAP suite
(`supabase/tests/0024_*.test.sql`, 167 assertions) passes; advisors add INFO items only (unused indexes on empty
tables, unindexed audit-actor FKs); the manual rollback (`docs/financeops/payment-register/ROLLBACK_0024_manual.sql.txt`)
returns the catalogue to the exact pre-0024 state. Once 0024 is committed to `main` it is immutable: fix defects with 0025.

## 4. Routes

| Route | Who | Notes |
|---|---|---|
| `POST /api/integrations/financeops/v1/payment-intakes` | Hermes (HMAC) | multipart `metadata` + `file_0..file_4`; flag + HMAC + registry identity + entity allow-lists |
| `GET  /api/integrations/financeops/v1/payment-intakes/:intake_id` | Hermes (HMAC) | own captures only; no amounts, beneficiaries or ids |
| `POST /api/finance-ops/bank-import/preview`, `.../confirm` | reviewer + AAL2 | the file is re-read on confirm; client-held rows are never trusted |
| `POST /api/finance-ops/matching/run` | reviewer + AAL2 | inserts suggestions only |
| `POST /api/finance-ops/register-import/preview`, `.../confirm` | capture roles | closed historical rows need Owner / Finance Manager |
| `POST/GET .../bill-intakes...` | Hermes | the existing invoice intake (0023); unchanged |

Everything else (confirming a match, moving a status, attaching a document, decisions) is a direct update through the
signed-in user's own session; RLS and the 0024 triggers decide. The middleware exemption is still exactly one prefix
(`/api/integrations/financeops/v1/`). `/finance-ops/bank-import`, `/finance-ops/matching` and their API routes are added
to the AAL2 path list.

## 5. UI pages

`/finance-ops` (dashboard), `/finance-ops/payments`, `/finance-ops/bank-import`, `/finance-ops/matching`,
`/finance-ops/missing-documents`, `/finance-ops/sql-queue`, `/finance-ops/register-import`, plus the earlier
`/finance-intakes` (invoice intake review). Pages are server-rendered shells that show a "not enabled" notice unless the flag is
on, then mount client components (`app/finance-ops-*.tsx`). Client bundles are guarded by `pay-client-bundle.test.ts`
(no Node built-ins, no server-only module, no secrets in any screen's import tree).

## 6. Permissions matrix

| Action | FinanceOps (data_entry registry) | Intern (data_entry) | Finance Staff | Finance Manager | Owner | Management |
|---|---|---|---|---|---|---|
| Capture a payment (via HMAC endpoint) | yes, statuses captured / documents_pending / ready_for_bank_match only | n/a | n/a | n/a | n/a | n/a |
| Record / edit a payment (early stages) | no | yes | yes | yes | yes | no |
| Attach a document | own captures | yes | yes | yes | yes | no |
| Remove a document (soft, with reason) | no | no | yes | yes | yes | no |
| Approve a document exception / mark a document not applicable | no | no | yes | yes | yes | no |
| Mark bank match not applicable | no | no | yes | yes | yes | no |
| Read bank statement rows / batches / matches | **no** | no | yes (AAL2) | yes (AAL2) | yes (AAL2) | no |
| Import a statement, run matching, suggest / confirm / reject / unmatch | **no** | no | yes (AAL2) | yes (AAL2) | yes (AAL2) | no |
| Move to bank_matched | no | no | yes (needs a confirmed match) | same | same | no |
| Finance review, Ready for SQL | no | no | yes | yes | yes | no |
| Record Posted to SQL (reference + date), Reconciled (date) | no | no | yes | yes | yes | no |
| Reverse a posting / reconciliation | no | no | no | yes | yes | no |
| Import closed historical rows from Excel | no | no | no (downgraded to documents_pending) | yes | yes | no |
| See the register | own entities | yes | yes | yes | yes | read only |

FinanceOps can never: confirm a bank match, set any status past `ready_for_bank_match`, approve an exception, read bank
data, create `bill_payments` / vouchers, release a bill (`draft -> unpaid`), or call SQL Account. All entity scoping is by
`user_entity_access`; the registry additionally limits which entities the FinanceOps identity may capture for.

## 7. Statuses

`captured -> documents_pending -> ready_for_bank_match -> bank_match_suggested -> bank_matched -> finance_review -> ready_for_sql -> posted_to_sql -> reconciled`,
plus the orthogonal flag `needs_attention` with `attention_reasons[]`. The first four are "early". Moves and prerequisites are
enforced by `enforce_finance_payment_rules()` and mirrored for the UI in `lib/financeops/payments/rules.ts`:
bank_matched needs a confirmed match; finance_review and ready_for_sql need (a confirmed match or "bank match not applicable") and
(required documents present / not applicable, or an approved exception); posted_to_sql needs the SQL reference and posting
date; reconciled needs the reconciliation date; details lock once the payment reaches finance_review (return it to edit).

## 8. Matching rules (`lib/financeops/payments/matching.ts`)

Rule based and explained; the output is a score and reasons, never a verdict. Only a bank DEBIT can match a payment; fee rows
(e.g. Public Bank's separate "OTHER TRANSFER FEE 0.10" with the same reference) are excluded. Points: reference
exact 40 / tail 38 (the statement shows the tail of the long payment reference); same company account 10 (a different
account disqualifies); amount exact 40, rounded to the ringgit 28 (+10 if the payee also matches); beneficiary account 15;
payee name exact 15 / truncated prefix 13 / similar 8 (space-insensitive, tolerant of OCR splits and truncation); date same
day 8, 1 day 6, 3 days 4, 7 days 2. Score >= 90 strong, >= 70 likely, else weak. Several equally good candidates are
flagged ambiguous and capped at 69. Matching reference with a different amount is capped at 60. Real examples used in the tests: RM800
Eveyiana (ref tail 49882921), RM321 bank debit vs RM320.83 payroll, RM1,250 Ingyin May.

## 9. Document requirement rules (`lib/financeops/payments/requirements.ts`)

supplier expense: invoice + payment evidence. Intern wage: wage schedule + payment evidence (no invoice needed; shown as N/A).
Staff claim: claim form / receipt + payment evidence. Rent / deposit / agreement: agreement-or-invoice-or-schedule + payment
evidence. Other: payment evidence, a human may adjust. A linked Supplier Bill whose invoice is uploaded satisfies the invoice
requirement. Missing documents never reject a payment: it stays `documents_pending` and appears in Missing documents until a
person attaches the document, marks it not applicable, or a reviewer approves an exception.

## 10. SQL posting workflow

Ready for SQL shows the posting package per payment (entity, date, payee, description, amount, account code if known, pay-from
account, invoice / reference, PV / payment reference, Hub ID, linked bill, bank transaction reference, documents) with a CSV
download (formula-injection safe). A person posts in SQL Account, then records the SQL reference and posting date in the Hub
(Posted to SQL), and later the reconciliation date (Reconciled). The Hub never writes to or reads from SQL Account.

## 11. Feature flags and environment variables

| Variable | Default | Meaning |
|---|---|---|
| `FINANCEOPS_PAYMENT_REGISTER_ENABLED` | off (must be exactly `true`) | the whole module: screens, human API routes, payment-capture endpoint. Needs 0024 |
| `FINANCEOPS_INTAKE_ENABLED`, `FINANCEOPS_ALLOWED_ENTITY_CODES`, `FINANCEOPS_ALLOWED_ENTITY_CODES_CURRENT/_NEXT`, `FINANCEOPS_HMAC_KEY_ID_CURRENT/_NEXT`, `FINANCEOPS_HMAC_SECRET_CURRENT/_NEXT`, `FINANCEOPS_MAX_SKEW_SECONDS`, `FINANCEOPS_RATE_LIMIT_PER_MINUTE` | disabled / empty | the existing HMAC integration settings; payment capture reuses them |
| `FINANCEOPS_DB_USER_EMAIL`, `FINANCEOPS_DB_USER_PASSWORD` | unset | the FinanceOps data_entry identity (server only, never to Hermes or the browser, never logged) |

Fail-closed order for payment capture: flag -> integration enabled -> keys and entities configured -> method -> size -> HMAC ->
identity (active data_entry profile + active registry row) -> entity limits. Hermes only ever receives the endpoint URL and the
HMAC key id and secret. No service-role key exists anywhere in this code.

## 12. Tests and results (all run on the final tree)

| Check | Result |
|---|---|
| FinanceOps unit tests (`npm run test:financeops`) | 321 pass |
| Stage 1B application tests (`node --test tests/stage1b-app-fix.test.cjs`) | 50 pass |
| pgTAP for 0024 (disposable local DB) | 167 assertions pass |
| Opt-in real-RLS integration (`npm run test:financeops:integration`; both invoice and payment suites, AAL2 via a real TOTP factor) | 25 of 25 pass |
| `tsc --noEmit`, `npm run lint`, `npm run build` | pass |
| 0024 catalogue diff / lint / rollback round-trip | 0 existing objects changed / clean / exact |

The 240-assertion 0023 pgTAP suite and the Stage 1B suites were not re-run: 0024 is additive and the catalogue diff proves no
existing object changed.

## 13. What is Production today

`main` = `a1dbe11f94298347125ff7aa3e13d3fdb81bbb1f`. Production ledger: 21 rows ending `0023 / financeops_intake_persistence`
(once). The invoice-intake application code is NOT deployed either (Production application is still `31e84d3` + the SQL-only
`a1dbe11`). No FinanceOps Auth user, registry row, Hermes secret, or `FINANCEOPS_*` Vercel variable exists.

## 14. Local / preview only

Migration 0024; the payment endpoints; every `/finance-ops/*` screen and `/api/finance-ops/*` route; the invoice-intake
persistence and review screen (`/finance-intakes`); the Q5 gate in `/api/bills/verify`; all tests above.

## 15. Exact next deployment steps (each needs Claire's explicit approval; do not skip or reorder)

1. Review the diff `a1dbe11..<branch HEAD>`; open a PR from `claude/financeops-phase1-prep` to `main` (identity `sfchong72`, never `interexcel-my`).
2. Fresh Production backup outside Git (as done for 0023: SHA-256 manifest, restore-tested), record the ledger (expect 21 rows).
3. Apply 0024 once with the pinned Supabase CLI (`db push --linked` from a clean checkout of the exact commit; dry-run must list only `0024_...`). No MCP `apply_migration`. Verify: ledger 22 rows with 0024 once; 5 tables empty; RLS on; 13 policies.
4. Merge to `main` (Vercel deploys application code; the flag is OFF so nothing activates).
5. Preview or Production smoke with the flag ON but WITHOUT FinanceOps credentials: screens load for reviewers, the capture endpoint answers `503 integration_db_not_configured`.
6. Provision the FinanceOps identity: create the Auth user, set role `data_entry`, add `user_entity_access` for the four entities, register it in `finance_integration_identities` (Owner with AAL2), set `FINANCEOPS_DB_USER_*` and the HMAC variables in Vercel, then enable `FINANCEOPS_PAYMENT_REGISTER_ENABLED=true` and `FINANCEOPS_INTAKE_ENABLED=true`.
7. Give Hermes ONLY the endpoint URL and the HMAC key id and secret. Run one real capture end to end, then a statement import, matching, confirmation.
8. Optionally import the old Excel register (preview first).

## 16. Known limitations

- Hub document upload (`/api/documents/upload`) has a separate Stage 1B RLS defect (insert + select before a link exists). The Payment Register uses its own insert-only sequence and is unaffected. Not fixed here.
- Capture, documents and status are separate writes (no cross-table transaction); deterministic IDs and replay make a retry safe.
- One payment <-> one bank row. Split and combined payments: match the part you can and add a note (flagged `needs_attention`).
- Statement import supports CSV, XLSX and pasted rows. A structured PDF listing is not parsed (the batch `file_type` value `pdf_listing` is reserved).
- The Excel XLSX reader is the repo's own minimal one (the same used by the other imports); exotic workbooks may need saving as CSV.
- Matching is rule based and runs when a reviewer clicks Run matching (not automatically after import).
- Bank rows and matches need MFA (AAL2) even for the Owner, as Stage 1B requires for bank data. A reviewer without MFA sees an explanation and a link to verify.
- A payment moved past `ready_for_bank_match` is never touched again by FinanceOps; replays report its current state.
- No direct SQL Account integration; posting and reconciliation are tracked, not performed.
- Entity inference for the old register uses the pay-from name/account and a small alias list (IETA, IEA, Premier = PLC, KALER); anything unclear is left for the person importing to choose.

## 17. Deferred enhancements

Automatic matching after import; split / combined payment allocation; structured PDF statement parsing; a database function that
creates payment + documents atomically; Telegram notifications back to Hermes; per-payment audit timeline view; SQL Account
integration (a separate approval); a least-privilege FinanceOps capability instead of the `data_entry` role; scheduled
reminders for the Missing documents queue.

## 18. Rollback notes

0024 is only additive. While the module is unused, `docs/financeops/payment-register/ROLLBACK_0024_manual.sql.txt` drops the
five tables, the functions and the two storage policies in one transaction (delete the empty bucket from the dashboard / Storage API),
then remove the ledger row (`delete from supabase_migrations.schema_migrations where version = '0024'` or
`supabase migration repair --status reverted 0024`). Once real payments exist the rollback destroys them: fix forward with 0025.
Application rollback: set `FINANCEOPS_PAYMENT_REGISTER_ENABLED` to anything other than `true` (instant kill switch for the screens,
the human routes and the capture endpoint); to stop only Hermes, deactivate the registry row or unset the HMAC variables.

## 19. Exact Git SHAs

- `main` / Production: `a1dbe11f94298347125ff7aa3e13d3fdb81bbb1f` (adds 0023 + its test to `31e84d3d56cf1ee8ed047ea2873147fa71119cf3`).
- Baseline this work started from: `b3dfac4` (reviewed invoice-intake persistence).
- 0023 blob (immutable): `b1a477448c1529a12fddd32f4822e2e809e39bc7`.
- 0024 candidate blob and the final branch HEAD: 0024 blob `d1972a9ca3a64090c889542cc7da79bd4664d6f4`, LF SHA-256 `14b610dd40b2045802458ae854cc19a8fcfddd7b4565e49c495bdc43eaa411d4`. Branch `claude/financeops-phase1-prep`: code commit `ca83dc8`, screens commit `1e0c091`, followed by one documentation commit (the branch tip: `git log -1`).

## 20. Instructions for another agent continuing this

1. `git fetch`; check out `claude/financeops-phase1-prep`; verify `git rev-parse HEAD:supabase/migrations/0023_financeops_intake_persistence.sql` is `b1a477448c1529a12fddd32f4822e2e809e39bc7`. Never edit 0023; never edit 0024 once it is on `main`.
2. `npm install`, then `npx tsc --noEmit`, `npm run lint`, `npm run test:financeops`, `node --test tests/stage1b-app-fix.test.cjs`, `npm run build`.
3. To re-prove the database side, start a DISPOSABLE local Supabase stack (never link a hosted project), enable `[auth.mfa.totp]` in its `config.toml`, replay `supabase/migrations`, load `lib/financeops/__integration__/local-fixtures.sql` (pass the password with `psql -v pw=...`), run the pgTAP file with `supabase test db --local`, then run `npm run test:financeops:integration` with `FINANCEOPS_IT_API_URL` (localhost only), `FINANCEOPS_IT_ANON_KEY`, `FINANCEOPS_IT_PASSWORD`. The test refuses non-local URLs and uses only the anon key.
4. Frozen unless a feature truly needs it: FinanceOps = `data_entry` (never `finance_staff`); no `draft -> unpaid` by FinanceOps; no service-role key; the HMAC design; the Q5 gate; the identity / retry / ownership rules in `persist.ts` and `payments/persist.ts`; Stage 1B policies.
5. Do not deploy, apply a migration to Production, provision an Auth user, create secrets or enable Hermes without the owner's explicit approval for that exact step (section 15).
6. Key files: `lib/financeops/payments/*` (pure rules and engines, server services, HMAC handler), `app/finance-ops-*.tsx` (screens), `supabase/migrations/0024_*`, `supabase/tests/0024_*`, `lib/financeops/__tests__/pay-*.test.ts`, `lib/financeops/__integration__/*.integration.ts`.
