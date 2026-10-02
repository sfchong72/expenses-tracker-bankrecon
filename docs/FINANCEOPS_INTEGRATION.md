# FinanceOps → Hub Integration (Phase 1)

Authoritative design: `FINANCEOPS_HUB_PHASE1_IMPLEMENTATION_SPEC.md` (repo root) plus the owner decisions D1–D9 recorded in `FINANCEOPS_PHASE1_CLAUDE_HANDOVER.md`.

**Status: application persistence is implemented against migration 0023 (applied to Production). The endpoint is still DISABLED by default and the FinanceOps database identity is NOT provisioned: with no `FINANCEOPS_DB_USER_*` credentials the endpoint answers `503 integration_db_not_configured` and stores nothing. Enabling it in Production, creating the Auth user, registering it and giving Hermes the URL and secret are separate steps that need Claire's approval.**

## Boundary

```
Telegram → Hermes FinanceOps → signed HTTPS request → Hub API (this repo) → intake stored (insert-first, idempotent)
        → entity resolved (or "needs entity": Finance Staff+ resolve it) → DRAFT Supplier Bill + original document
        → human "Data Verified" (a different person; the intern may) → "Verify & Mark Ready for Payment" draft→unpaid
          (Finance Staff or above; for FinanceOps bills only after Data Verified) → existing approval/payment flow
```

FinanceOps may only *propose* a **draft** Supplier Bill. It can never approve, pay, mark bank-cleared, reconcile, post to SQL Account, delete, or modify finalised records.

## What Hermes receives (and nothing else)

- The integration endpoint URL.
- The active HMAC key id and secret.

Hermes must **not** receive: the Supabase service-role key, Claire's Owner login, any Finance Staff or staff login, the database password, or banking credentials. Hermes must not generate, replace, rotate, expose or publish the HMAC secret. **Secret ownership and rotation: Claire or an explicitly authorised system administrator.**

## No secrets in Git

Only variable **names** are committed (see `.env.example`). Values live in Vercel server-side environment variables. Never log request signatures, secrets or document contents.

## Route authentication

`POST /api/integrations/financeops/v1/bill-intakes` (multipart: `metadata` JSON + `file`).

Headers: `X-FinanceOps-Key-Id`, `X-FinanceOps-Timestamp` (unix seconds), `X-FinanceOps-Signature: v1=<hex>`.

```
signing string = "{timestamp}\n{METHOD}\n{canonical_path}\n{canonical_query_string}\n{sha256_hex(raw_body)}"
signature      = HMAC_SHA256(secret, signing string)
```

Canonical query string: leading `?` and empty pairs dropped; keys/values percent-decoded (`+` = space; a literal plus is `%2B`) then re-encoded with the RFC 3986 unreserved set and upper-case hex; duplicate keys kept; pairs sorted by encoded key then value; empty string when there is no query. Reordering pairs is harmless; changing, adding or removing any parameter invalidates the signature; malformed percent-encoding is rejected. `canonical_path` is the pathname exactly as sent.

- Timestamp tolerance: 300 s by default (`FINANCEOPS_MAX_SKEW_SECONDS`, 30–900).
- Constant-time comparison; every authentication failure returns the same opaque `401 {"error":"unauthorized"}`.
- **Current/next rotation:** configure `…_CURRENT` and `…_NEXT` (different key ids). Hermes switches to the next key when told; Claire/admin then promotes next → current and clears next.
- The cookie-session middleware is bypassed **only** for paths under `/api/integrations/financeops/v1/` (strict matcher, `lib/financeops/routes.ts`, which also refuses `..`, `//`, backslash, `;` and any `%`); `/api/admin/**` and every other route are unchanged. Unexpected methods get 405.
- Rate limit: per authenticated key, default 30/min (`FINANCEOPS_RATE_LIMIT_PER_MINUTE`), best-effort per warm serverless instance.

## Entity allow-list

`FINANCEOPS_ALLOWED_ENTITY_CODES` (subset of `IEA,IETA,PLC,KALER`; `PLC` = Premier Language Centre) is the ceiling; `FINANCEOPS_ALLOWED_ENTITY_CODES_CURRENT/_NEXT` may narrow a key, never widen it. Empty means nothing is allowed (fails closed). Every **Supplier Bill** must resolve to exactly one authorised entity. If the entity is uncertain FinanceOps sends `entity_code: null`: an *intake* may exist, but **no bill is created** (no placeholder entity) and the case goes to human review; the entity is never guessed.

## Validation and limits

Strict allowlisted schemas (`lib/financeops/schema.ts`): unknown fields fail; an exact-name prohibited list (`payment_status`, `created_by`, `approved_by`, `approved_at`, `paid_at`, `bank_transaction_id`, `reconciliation_date`, `sql_document_id`, `sql_posted_at`, authoritative ids, …) is rejected as `forbidden_field`. No substring/token matching. Files: PDF/JPEG/PNG only, **max 4 MB** (larger → `413` with a manual-upload requirement). The server re-computes the SHA-256 and sniffs the file signature; a mismatch is rejected.

## Persistence (after 0023)

`POST …/bill-intakes` runs: HMAC → strict validation → file re-hash and MIME sniff → **INSERT the intake first** → (entity known?) → draft bill → document → complete. Every database call runs as the FinanceOps data_entry identity through RLS (`lib/financeops/persist.ts`, `store-supabase.ts`, `db-session.ts`); there is no service-role key anywhere in this code, and the 0023 / Stage 1B triggers stay authoritative.

| Situation | Result |
|---|---|
| New `intake_id`, entity known, no exact duplicate | `201 complete`: intake → draft bill (`payment_status='draft'`, `created_by` = FinanceOps) → file in `bill-documents` → `documents` row → `document_links` row → intake linked; `process_state` walks `received → bill_created → document_attached → complete` |
| Same `intake_id` + same payload hash | idempotent replay: `200`, resumes from the stored `process_state`, never a second bill or document |
| Same `intake_id` + different payload or file | `409 intake_conflict`, nothing changes; use a new `intake_id` |
| `entity_code: null` | `202 needs_entity`: intake only (`awaiting_entity`); **no bill, no file, no document**; the entity is never guessed |
| After a reviewer resolves the entity | re-send the SAME intake (same id and payload): it continues (`next_action: resubmit_same_intake`). Alternatively send a NEW intake with `supersedes_intake_id` (and its own entity) |
| Exact duplicate (same file, same entity, active bill) | `409 duplicate_file`: no bill; intake flagged `duplicate_suspected` with `duplicate_matches` stored; replays stay held |
| Soft duplicate (same supplier + invoice no., same supplier + amount + date, same file in another entity) | the draft is created and flagged for the reviewer |
| Missing due date | `due_date = bill_date` plus flag `due_date_missing` (a human confirms it before Data Verified) |
| A step fails (storage, database) | `503 retryable`; the intake is never reported complete; the retry resumes. Bill and document primary keys are derived from the intake id, so a retry ADOPTS what the earlier attempt created |
| A database rule refuses a step (e.g. the bill is no longer draft) | `409 intake_update_rejected` (not retryable): a reviewer must look at it |

Both endpoints re-check on EVERY request that the identity is still an active `data_entry` profile and an active registry row (otherwise `503 integration_identity_inactive`, nothing read or written). When a reviewer has resolved the entity, the resumed intake is only processed if that entity is also allowed for the registry identity and for the HMAC key (`403 entity_not_permitted` otherwise, nothing created). The duplicate check ignores the intake's own earlier draft bill.

`supersedes_intake_id` (optional, same format as `intake_id`, never null) is on the request allow-list. The database enforces the supersession rules (only an unresolved original, one successor, not rejected, the successor must declare an entity); the API answers `already_superseded`, `intake_already_resolved`, `supersedes_intake_not_found`, `supersede_requires_entity`, `supersede_not_permitted` or `supersede_rejected_intake`.

## Status endpoint

`GET …/bill-intakes/:intake_id`: HMAC-signed (empty body), read through the FinanceOps identity's own RLS, and only for intakes **that identity created** (another id, or an intake created by someone else, is `404`, even where RLS would show it: proven with a second registry identity). Returns only `intake_id, process_state, review_status, entity_code, entity_resolved, needs_entity, duplicate_suspected, bill_created, document_attached, flags, next_action, created_at, updated_at`. No bill, document or user ids, suppliers, amounts, bank or payment data.

## Human review screen

`/finance-intakes` (`app/finance-intake-workspace.tsx`, rules in `lib/financeops/review.ts`): **Needs entity** (Owner / Finance Manager / Finance Staff only: pick exactly one approved entity plus a note, or reject), **In review** (original document, extracted fields, flags, supplier candidates, duplicate warnings, draft-bill corrections, **Data Verified** / reject / flag), **Done**. Every action is a direct update through the user's own session; RLS and the 0023 triggers decide. The creator (FinanceOps) is never offered a review action. **Data Verified is not payment approval.**

## Q5 application gate

`POST /api/bills/verify` (draft → unpaid): if the bill is linked to a FinanceOps intake (`finance_intake_submissions.supplier_bill_id`), the intake must be `data_verified`, else `409 financeops_intake_not_data_verified`. Bills with no intake row are unaffected. If the lookup fails the release is refused (fails closed). The Stage 1B database trigger and policy are unchanged and no migration was added; the gate is intentionally application-level in Phase 1, so a direct database write by a Finance Staff-or-above user bypasses it (those users could already release any draft).

## Human verification

- Intern / `data_entry` may mark **Data Verified** (the extracted data matches the original document) (entity, supplier, invoice number/date, due date, amount, category, description, attachment, duplicate warnings).
- **Data Verified ≠ approved for payment.** Releasing `draft → unpaid` is a separate action by Finance Staff or above. Keep this separation visible in the UI and the data model.
- FinanceOps can never verify its own intake (four-eyes; enforced by the 0023 trigger, mirrored by `lib/financeops/verification.ts` and `review.ts`).
- Missing due date: stored as `bill_date` placeholder + flag `due_date_missing`; **Mark Verified** is blocked until a human confirms it.
- Exact same file already on an active bill in the same entity: no new bill, `duplicate_suspected`, human review.
- Panel: `app/intake-review.tsx`, mounted by the `/finance-intakes` screen.

## Current behaviour

Disabled unless `FINANCEOPS_INTAKE_ENABLED=true`. Enabled but with no database credentials: `503 integration_db_not_configured`. A handler with no store wired (tests only) answers `503 intake_persistence_not_ready`. FinanceOps must treat any 5xx as "not delivered" and retry with the same `intake_id`.

## Database identity (future) and a note on the stored password

**Hard rule (after the Stage 1B release): the FinanceOps identity must be `data_entry` and must never be `finance_staff` (or any other role).** FinanceOps is maker/assistant, never checker: it cannot perform `draft → unpaid` (Stage 1B: `POST /api/bills/verify`, Owner/Finance Manager/Finance Staff; the database trigger already blocks `data_entry`). Proposed Migration A (design only, `docs/financeops/migration-a/`) additionally designates the identity in a registry and fails closed if it is ever promoted.

Implemented (D1): the Hub signs in server-side as a dedicated Supabase Auth user with the `data_entry` role (`FINANCEOPS_DB_USER_EMAIL` / `FINANCEOPS_DB_USER_PASSWORD`, plus the public anon key) so RLS applies; the session is cached until shortly before it expires. At the start of every request the code re-checks that the identity is an ACTIVE `data_entry` profile AND an active row in `finance_integration_identities` (the kill switch), and that the declared entity is in its `allowed_entity_ids`. **Not provisioned in Production**: creating the Auth user, registering it (Owner, AAL2), granting entity access and setting the Vercel variables is a separate, approved step.

**Transitional:** the `data_entry` identity is broader than ideal (see the spec §7); a dedicated least-privilege FinanceOps capability/RPC boundary should be considered before large-scale permanent automation. Not created now.

A stored DB-user password is the simplest RLS-preserving option and is acceptable only as a Vercel server-side secret. Alternatives considered: minting JWTs requires the project JWT secret (as sensitive as the service-role key — rejected); a SECURITY DEFINER intake RPC granted to a dedicated role (post-Phase-1 hardening, also makes bill + document + intake creation atomic) — to be reconsidered after Phase 1 proves useful. No silent redesign was made.

## Not implemented here

Payment-evidence tables and link type, any change to `user_can_access_linked_record`, new SECURITY DEFINER RPCs, a database-level FinanceOps release gate, the FinanceOps Auth user and registry row (Production), Phase 1B, SQL Account, reconciliation, claims automation, large-file signed uploads, notification/outbox, atomic bill + document + intake creation (a SECURITY DEFINER RPC; post-Phase-1 hardening).

## Operational limitations

- Bill, document and intake are written in separate calls (no cross-table transaction). Deterministic ids and resumable states make a retry safe, but a half-finished intake needs the retry; a reviewer can see `process_state` for any that did not finish.
- An unresolved intake does not store the file: after the reviewer resolves the entity FinanceOps must re-send the same intake (or send a superseding one). The status endpoint says so via `next_action`.
- Duplicate detection is advisory except the exact-file rule; humans catch the rest. It only sees documents and bills the FinanceOps identity can read.
- The Q5 gate is application-level (see above). The per-instance rate limiter is best-effort.
- A FinanceOps session is cached per warm serverless instance. Disabling the user in Auth does not end an access token already issued, but the registry kill switch and profile status are checked in the database on every request.
- Hub document upload (`/api/documents/upload`) inserts `documents` with `.insert().select()`; under Stage 1B RLS that RETURNING read is refused until a link exists (found while building this; FinanceOps uses an insert-only call and is unaffected).

## Tests

`npm run test:financeops` (Node built-in runner; no external services; includes the in-memory persistence, status, review-rule, gate and boundary tests).
`npm run test:financeops:integration` is opt-in: it needs a DISPOSABLE LOCAL Supabase stack with migrations 0001-0018, 0020-0023 and `lib/financeops/__integration__/local-fixtures.sql` applied, plus `FINANCEOPS_IT_API_URL` (localhost only), `FINANCEOPS_IT_ANON_KEY` and `FINANCEOPS_IT_PASSWORD`. It drives the real handler and store through real RLS and the real 0023 triggers, and refuses non-local URLs.
