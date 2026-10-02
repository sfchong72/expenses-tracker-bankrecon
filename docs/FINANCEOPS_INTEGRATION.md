# FinanceOps → Hub Integration (Phase 1 preparation)

Authoritative design: `FINANCEOPS_HUB_PHASE1_IMPLEMENTATION_SPEC.md` (repo root) plus the owner decisions D1–D9 recorded in `FINANCEOPS_PHASE1_CLAUDE_HANDOVER.md`.

**Status: PREPARATION ONLY. The endpoint is disabled by default and performs no finance database writes. Production stays disabled until Claire explicitly enables it after the Stage 1B release and the intake migration.**

## Boundary

```
Telegram → Hermes FinanceOps → signed HTTPS request → Hub API (this repo) → [future] draft Supplier Bill
        → human verification (intern/Data Entry) → release draft→Unpaid (Finance Staff or above) → existing approval/payment flow
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
signing string = "{timestamp}\n{METHOD}\n{path_and_query}\n{sha256_hex(raw_body)}"
signature      = HMAC_SHA256(secret, signing string)
```

- Timestamp tolerance: 300 s by default (`FINANCEOPS_MAX_SKEW_SECONDS`, 30–900).
- Constant-time comparison; every authentication failure returns the same opaque `401 {"error":"unauthorized"}`.
- **Current/next rotation:** configure `…_CURRENT` and `…_NEXT` (different key ids). Hermes switches to the next key when told; Claire/admin then promotes next → current and clears next.
- The cookie-session middleware is bypassed **only** for paths under `/api/integrations/financeops/` (strict matcher, `lib/financeops/routes.ts`); `/api/admin/**` and every other route are unchanged.

## Entity allow-list

`FINANCEOPS_ALLOWED_ENTITY_CODES` (subset of `IEA,IETA,PLC,KALER`; `PLC` = Premier Language Centre). Empty means nothing is allowed (fails closed). Every intake must resolve to exactly one authorised entity. If the entity is uncertain FinanceOps sends `entity_code: null`; the case is routed to human review and the entity is never guessed.

## Validation and limits

Strict schema (`lib/financeops/schema.ts`): unknown fields fail; fields FinanceOps must never set (`payment_status`, approval, paid/payment, bank, reconciliation, SQL, verification, `created_by`, authoritative `supplier_id`/`entity_id`/ids) are rejected. Files: PDF/JPEG/PNG only, **max 4 MB** (larger → `413` with a manual-upload requirement). The server re-computes the SHA-256 and sniffs the file signature; a mismatch is rejected.

## Human verification (not yet wired)

- Intern / `data_entry` may verify that the extracted data matches the original document (entity, supplier, invoice number/date, due date, amount, category, description, attachment, duplicate warnings).
- **Verified ≠ approved for payment.** Releasing `draft → unpaid` is a separate action by Finance Staff or above. Keep this separation visible in the UI and the data model.
- FinanceOps can never verify its own intake (four-eyes; app helper in `lib/financeops/verification.ts`, DB trigger required in the future migration).
- Missing due date: stored as `bill_date` placeholder + flag `due_date_missing`; **Mark Verified** is blocked until a human confirms it.
- Exact same file already on an active bill in the same entity: no new bill, `duplicate_suspected`, human review.
- UI shell: `app/intake-review.tsx` (props-only, not mounted).

## Current behaviour

After successful authentication and validation the route returns `503 intake_persistence_not_ready` and stores nothing. FinanceOps must treat it as "not delivered" and retry later with the same `intake_id`.

## Database identity (future) and a note on the stored password

Plan (D1): a dedicated Supabase Auth user with the existing `data_entry` role used server-side by the Hub so RLS applies — configured via `FINANCEOPS_DB_USER_EMAIL` / `FINANCEOPS_DB_USER_PASSWORD`. Not provisioned; **do not create it in Production before the Stage 1B release** (the legacy RLS would let it write any bill status).

A stored DB-user password is the simplest RLS-preserving option and is acceptable only as a Vercel server-side secret. Alternatives considered: minting JWTs requires the project JWT secret (as sensitive as the service-role key — rejected); a SECURITY DEFINER intake RPC granted to a dedicated role (post-Phase-1 hardening, also makes bill + document + intake creation atomic) — to be reconsidered after Phase 1 proves useful. No silent redesign was made.

## Not implemented here

Intake/idempotency/review tables, payment-evidence tables and link type, any change to `user_can_access_linked_record`, new SECURITY DEFINER RPCs, the FinanceOps Auth user, Phase 1B, SQL Account, reconciliation, claims automation, large-file signed uploads, notification/outbox.

## Tests

`npm run test:financeops` (Node built-in runner; no external services).
