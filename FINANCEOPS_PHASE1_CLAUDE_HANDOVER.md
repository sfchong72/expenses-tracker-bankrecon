# FinanceOps Phase 1 — Claude handover

Read this first, then `FINANCEOPS_HUB_PHASE1_IMPLEMENTATION_SPEC.md` (authoritative design) and `docs/FINANCEOPS_INTEGRATION.md`. Do not redo Stage 1B / migration archaeology.

## State

- Branch: `claude/financeops-phase1-prep` (not pushed, not merged).
- Base: `338125acccc8420ba96955e77eb78ec4dd7fb903` (Stage 1B). `origin/main` (`0a8ba48`) is an ancestor of it — no divergence.
- Worktree used: `<repo>/.claude/worktrees/financeops-prep` (git-ignored via `.git/info/exclude`). The main checkout has an old, unrelated paused rebase on `agent/option-a-publish-clean` (since 2026-08-06) — left untouched; do not `--abort`/`--continue` it without Claire's say-so.
- This branch makes **no database change**: no migration, no RLS, no SECURITY DEFINER, no Production contact.

## Owner decisions (approved by Claire)

- D1: dedicated Supabase Auth user + existing `data_entry` role + narrow API + entity allow-list + no service-role key + no Owner/staff login + four-eyes. No new `financeops_intake` role yet. **Do not provision the Production FinanceOps user before Stage 1B release.**
- D2: intern/`data_entry` may *verify* data matches the document; Verified ≠ approved for payment; Finance Staff+ performs `draft → unpaid`. FinanceOps never verifies its own intake.
- D3: Finance Staff may review payment evidence; final `bill_payments`, sensitive bank/payment info, payment and reconciliation actions keep the Stage 1B high-risk/AAL2 boundary. Do not widen Finance Staff access to bank balances.
- D4: entities `IEA`, `IETA`, `PLC` (Premier Language Centre), `KALER`; exactly one authorised entity per intake; uncertain → human review, never guess.
- D5: missing due date → `bill_date` placeholder + `due_date_missing`; Mark Verified blocked until a human confirms. Do not make `due_date` nullable.
- D6: identical file hash on an active bill in the same entity → no new bill, `duplicate_suspected`, human review. Soft signals → flagged draft.
- D7: 4 MB max; PDF/JPEG/PNG; larger → manual-upload message; no signed large-file upload.
- D8: PR-0 approved but **Codex owns it** (default `draft`; drafts excluded from Awaiting Payment; no PV from draft in UI; `/api/payment-vouchers/generate` rejects drafts). Do not touch those files; wait for Claire to give Codex's final commit.
- D9: Hermes gets only endpoint URL + HMAC secret. Rotation owned by Claire/authorised admin; Hermes never generates/rotates/exposes it. Current/next arrangement implemented.

## What is built (commits on the branch)

1. `feat(financeops): add signed intake request validation` — `lib/financeops/{auth,schema,duplicates,supplier-match,intake,routes}.ts` + tests; `package.json` script `test:financeops`. (This commit originally also added `allowImportingTsExtensions` to `tsconfig.json`; commit 4 removes it.)
2. `feat(financeops): scaffold secure bill intake endpoint` — `lib/financeops/{config,handler}.ts`, `app/api/integrations/financeops/v1/bill-intakes/route.ts`, `lib/supabase/middleware.ts` (single-prefix exemption), `.env.example` names.
3. `feat(financeops): prepare intake review UI` — `lib/financeops/verification.ts` (client-safe rules split out of `intake.ts`), `app/intake-review.tsx` (props-only shell, **not mounted**), docs, spec, this file.

Behaviour now: endpoint is disabled by default; when enabled+configured it authenticates, validates, verifies the file, then returns `503 intake_persistence_not_ready`. Nothing is stored.

4. `refactor(financeops): harden intake auth and validation` — see "Revision 2" below.

## Revision 2 (owner-reviewed hardening, still pre-DB)

1. **Canonical query signing.** Signed string is now five lines: `timestamp / METHOD / canonical_path / canonical_query_string / sha256(raw_body)`. Canonical query = decode, re-encode (RFC 3986, upper-case hex), keep duplicate keys, sort by encoded key then value, drop empty pairs, `+` = space (literal plus must be `%2B`); malformed encoding fails verification; reordering is harmless, any other change fails. `path` and `query` are separate fields in the handler/auth API (`canonicalizeQuery` in `lib/financeops/auth.ts`). Kept: constant-time compare, skew limit, current/next rotation, opaque 401, no secret/signature logging. **Correction to my earlier report:** per-key entity allow-lists and rate limiting had been in the spec but were *not* actually implemented; they are now (per-key lists via `FINANCEOPS_ALLOWED_ENTITY_CODES_CURRENT/_NEXT`, always a subset of the `FINANCEOPS_ALLOWED_ENTITY_CODES` ceiling; per-key in-memory sliding-window rate limit, best-effort per warm serverless instance, applied only after the signature verifies; a hard global limit needs the platform firewall or a shared store).
2. **Exact-field validation.** The token/substring forbidden-key logic is gone. Every object has an allowlisted schema (unknown key → `unknown_field`) plus an exact-name `PROHIBITED_FIELDS` set (`payment_status, created_by, approved_by, approved_at, paid_at, bank_transaction_id, reconciliation_date, sql_document_id, sql_posted_at, authoritative ids …`) reported as `forbidden_field`. Near-miss names (e.g. `bank_note`) are simply unknown. Still fail-closed.
3. **Unresolved entity rule.** FinanceOps never guesses the entity. An *intake* may exist with an unresolved entity (`entity_code: null`); a *Supplier Bill* must not be created until exactly one authorised entity is resolved — no placeholder entity. Invalid entity strings are 422, not "uncertain". For future Migration A: `finance_intake_submissions.entity_id` nullable; `entity_id IS NULL` rows must **not** rely on normal entity-scoped RLS — recommend a central authorised Finance-review visibility rule (Owner / Finance Manager / Finance Staff via a small SECURITY DEFINER helper, not `data_entry`, not entity-membership based) plus a creator-only branch for the integration identity; entity resolution is set-once, audited, restricted to the four approved entities. Phase 1 persists **no file** for an unresolved intake (documents/Storage are entity-scoped). See spec §4a/§19 and D10/D11.
4. **Transitional `data_entry` identity (Option A).** Broader than ideal (can view all finance bills of its entities, update any draft bill, upload documents, holds claim permissions). Compensating controls listed in spec §7. **Hardening note:** before large-scale/permanent automation, introduce a dedicated least-privilege FinanceOps capability / RPC boundary (Option B). Not created now.
5. **Middleware hardening.** Exemption narrowed to `/api/integrations/financeops/v1/` (non-empty remainder) and refuses `..`, `//`, backslash, `;` and any `%` (covers `%2e%2e`, encoded slash/backslash, double-encoding). Tests cover `financeopsX`, `/api/admin/…`, wrong methods (405), missing signature and a valid signature for a different path/query (401), and assert the middleware uses the matcher before any cookie logic.
6. **tsconfig decision.** `allowImportingTsExtensions` was **not necessary** and was removed; `tsconfig.json` is identical to Stage 1B. Source uses extensionless imports; tests run via a test-only resolver hook (`lib/financeops/__tests__/register-ts.mjs`, `ts-resolve-hooks.mjs`) loaded only by `npm run test:financeops`.

Remaining owner decisions: **D10** (unresolved-entity intake without a file: manual Bills upload and/or resubmission under a new `intake_id`), **D11** (who resolves an unresolved entity; recommended Finance Staff+).

## Intentionally disabled / not implemented

Persistence of intakes and bills, idempotency table, review state, `payment_evidence` link type, any change to `user_can_access_linked_record`, new SECURITY DEFINER RPCs, FinanceOps Auth user, Phase 1B, wiring the review UI, status endpoint `GET /bill-intakes/{id}` (needs the table), DB-level draft-bill guard in `save_payment_voucher_draft`.

## Future migration still required (not created; number after the last released one — 0023 if Stage 1B releases nothing else)

Migration A (Phase 1A, new tables only): `finance_intake_submissions` — `intake_id` UNIQUE, `payload_hash`, `source` jsonb, `entity_id` **NULLABLE (only while the entity is unresolved; unresolved rows need the central Finance-review visibility rule, not entity-scoped RLS)**, `supplier_bill_id`, `document_id`, `process_state` (received→bill_created→document_attached→complete), `review_status` (pending_review|verified|rejected|duplicate_suspected|needs_attention), `extraction` jsonb, `flags` jsonb, `duplicate_of`, `created_by`, `reviewed_by/at/note`, timestamps; four-eyes trigger (`reviewed_by = auth.uid()` and `<> created_by`); RLS (insert: can_manage_bills + entity + `created_by = auth.uid()`; select: can_view_finance; update: review fields only; no delete; anon revoked); pgTAP tests.
Migration B (Phase 1B): `payment_evidence_submissions`, `payment_evidence` link type in the `document_links` CHECK **and** in `app_private.user_can_access_linked_record` (edits a 0022 security function — needs a dedicated security review).
Later: DB guard rejecting draft bills in `save_payment_voucher_draft`.

## Environment variable names (values only in Vercel server env; never in Git)

`FINANCEOPS_INTAKE_ENABLED`, `FINANCEOPS_ALLOWED_ENTITY_CODES`, `FINANCEOPS_ALLOWED_ENTITY_CODES_CURRENT`, `FINANCEOPS_ALLOWED_ENTITY_CODES_NEXT`, `FINANCEOPS_MAX_SKEW_SECONDS`, `FINANCEOPS_RATE_LIMIT_PER_MINUTE`, `FINANCEOPS_HMAC_KEY_ID_CURRENT`, `FINANCEOPS_HMAC_SECRET_CURRENT`, `FINANCEOPS_HMAC_KEY_ID_NEXT`, `FINANCEOPS_HMAC_SECRET_NEXT`, `FINANCEOPS_DB_USER_EMAIL`, `FINANCEOPS_DB_USER_PASSWORD` (last two unused until persistence exists).

## How to move this branch onto the final base

1. Claire supplies Codex's final PR-0 commit (call it `P`) and, later, the released Stage 1B/main state (`B`).
2. Inspect `P`: `git fetch origin && git log --oneline 338125a..P && git diff --stat 338125a P`. Expect no overlap with this branch (PR-0 touches `app/phase2-workspace.tsx` and `app/api/payment-vouchers/generate/route.ts`; this branch touches `lib/financeops/**`, the new route, `lib/supabase/middleware.ts`, `package.json`, `.env.example`, `app/intake-review.tsx`, docs; `tsconfig.json` is unchanged).
3. Move only this branch's three commits: `git rebase --onto <P-or-B> 338125a claude/financeops-phase1-prep`. Resolve conflicts conservatively; **keep Codex's PR-0 code as-is**; in `package.json`/`.env.example` keep both sides' additions.
4. If `main` was fast-forwarded to Stage 1B+PR-0, base on `main` (`git rev-list --count 338125a..origin/main` shows what moved).
5. Re-run: `npm run test:financeops`, `npx tsc --noEmit`, `npx eslint .`, `npm run build`.
6. Do not push, merge or deploy without Claire's approval.

## Suggested next prompt for the next coding agent

> Continue `claude/financeops-phase1-prep` after Claire provides Codex's final PR-0 commit and the Stage 1B release outcome. First rebase per `FINANCEOPS_PHASE1_CLAUDE_HANDOVER.md`. Do not touch PR-0 files. When Claire approves the Phase 1A migration: write Migration A (new tables only) + pgTAP tests in a disposable local Supabase (never Production); then replace the 503 branch in `lib/financeops/handler.ts` with persistence (server-side sign-in as the dedicated `data_entry` user, insert-first on `intake_id` UNIQUE, resume incomplete steps, hard-duplicate block, draft bill + document + link + audit via the existing upload conventions), add `GET /bill-intakes/{id}`, and mount `app/intake-review.tsx` as an "Intake Review" tab in `BillsWorkspaceV21`. Phase 1B only after Migration B's security review. Keep changes small; stop and ask before any new SECURITY DEFINER function, RLS change or Production access.
