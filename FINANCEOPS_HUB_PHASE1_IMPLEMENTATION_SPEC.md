# FinanceOps → InterExcel Hub — Phase 1 Implementation Specification

Status: **DESIGN ONLY. Nothing in this document has been implemented.**
Author: Claude (Code), for Claire. Date: 2026-10-02.
Scope: Phase 1A (invoice → Draft Supplier Bill) and Phase 1B (payment slip → Unverified Payment Evidence).
Out of scope: SQL Account, bank reconciliation, broad claims automation, notification/outbox framework, unrelated UI redesign.

**Revision 2 (2026-10-02) — owner-approved changes, pre-DB only.** (1) HMAC now signs the canonical query string (§7). (2) Forbidden-field detection is no longer token-based; validation is strict allowlisted schemas plus an exact prohibited-field list (§6.1). (3) Unresolved-entity rule: an intake may exist without an entity, a Supplier Bill never may (§4a, §18, §19). Also recorded: `data_entry` is a transitional identity (§7), the middleware exemption is narrowed to `/api/integrations/financeops/v1/` and hardened (§7, §20), best-effort rate limiting and per-key entity allow-lists exist in code (§7), and the repo-wide `allowImportingTsExtensions` tsconfig change was **removed** (§20). Owner decisions D1–D9 are approved; see Appendix C for what remains.

Evidence base (read-only inspection, no checkout switch, no merge/rebase):

| Ref | Commit |
|---|---|
| Security/DB authority | `origin/agent/finance-security-integration` = `338125acccc8420ba96955e77eb78ec4dd7fb903` ("Stage 1B") |
| Application/UI reference | `origin/main` = `0a8ba48f2f488739cedfc4c81bd2e871acad5361` |

---

## 0. Headline findings (read this first)

1. **`origin/main` is an ancestor of Stage 1B.** `git merge-base 338125a origin/main` = `0a8ba48` = the tip of `main`. Stage 1B is `main` + 4 commits (35 files, +6607/−180). The two lines have **not diverged**. (My earlier handover message said they had diverged; that was wrong — I had tested ancestry in the wrong direction. `git merge-base --is-ancestor origin/main 338125a` is true.) Consequence: UI v2 is already inside Stage 1B; a branch from `338125a` contains everything on `main`.
2. **Production does not have Finance 0020–0022.** `main` migrations stop at 0018. Everything in this spec that depends on Stage 1B RLS is therefore *design-only until 0022 is released*. On today's Production (0018), `supplier_bills` RLS is the legacy `supplier_bills_entity_all` (any user with entity access may write any status, including `paid`). A FinanceOps identity must **not** be enabled there.
3. **A real Stage 1B / UI inconsistency was found while verifying Hermes' finding #4 — worth raising in the Stage 1B release review:** the manual bill form defaults `payment_status` to `"unpaid"` (`app/phase2-workspace.tsx:16`, saved at `:137`), but the Stage 1B insert policy `supplier_bills_finance_insert` requires `payment_status = 'draft'` (0022 line ~762). On Stage 1B the default "Create Supplier Bill" submit will be rejected by RLS unless the user manually changes Status to `draft`. The pgTAP suite does not exercise the UI. Not a security hole (it fails closed) but a functional regression in the release candidate.
4. **A draft bill is currently treated as "awaiting payment" by the UI and not blocked by the DB.** `awaiting = bills.filter(not paid/cancelled)` (`phase2-workspace.tsx:288`, `:354`) includes `draft`; `save_payment_voucher_draft` (0022 ~L2119) only checks the bill exists in the same entity, not its status; `/api/payment-vouchers/generate` does not check status either. So unverified FinanceOps drafts could be turned into payment vouchers unless this is closed (Section 15/17).
5. **No machine path exists.** `middleware.ts` → `updateSession` returns `401` for every `/api/*` request without a Supabase *cookie* session, and all routes use the cookie client. A Hermes call cannot reach any route today; a deliberate, narrow middleware exemption is required.

---

## 1. Current architecture found

- Next.js 15 App Router, React 19, `@supabase/ssr` cookie auth, Supabase Postgres + RLS + private Storage. No test runner in `package.json` (scripts: `dev`, `build`, `start`, `lint`, `typecheck`). Database tests are pgTAP in `supabase/tests/`.
- Auth gate: `middleware.ts` → `lib/supabase/middleware.ts`. Stage 1B adds: role allow-list, active-profile check, AAL2 gating for high-risk paths, `/mfa`.
- Data layer pattern: client pages (`app/phase2-workspace.tsx`) talk to Supabase directly with the user's session and rely on RLS; server routes (`app/api/**`) create a cookie-bound client via `lib/supabase/server.ts` and also rely on RLS (+ SECURITY DEFINER RPCs for atomic/controlled actions on Stage 1B).
- Service-role key is used in exactly one place (`app/api/admin/users/create/route.ts`), owner-only, AAL2-gated.
- Entities (0002 seed): `IEA`, `IETA`, `PLC` (Premier Language Centre), `KALER`. `entities.short_code` is unique.
- Roles on Stage 1B (`app_profiles.role` CHECK): `owner, finance_manager, finance_staff, management, data_entry, read_only, branch_manager, counsellor, marketing, student_services, trainer`. Finance roles: `owner, finance_manager, finance_staff, management, data_entry`.

## 2. Stage 1B vs `main` — differences relevant to this feature

`git diff origin/main 338125a` (35 files). Relevant ones:

| Area | `main` (0a8ba48) | Stage 1B (338125a) | Impact on FinanceOps |
|---|---|---|---|
| Migrations | 0001–0018 | + 0020, 0021, 0022 (no 0019, no 0023) | `supplier_bills`/`documents`/`bill_payments` RLS and triggers differ completely |
| `supplier_bills` RLS | `supplier_bills_entity_all` (entity membership only) | `finance_select/insert/update/draft_delete`; insert must be `draft` with `created_by = auth.uid()`; trigger blocks `data_entry` from non-draft, `paid/cancelled` need Owner/FM + AAL2 | FinanceOps identity is only safe on Stage 1B |
| `bill_payments` RLS | entity-wide | insert/update **Owner/FM + AAL2 only**; select needs `can_view_sensitive_payments` + AAL2 | A non-Owner/FM machine identity cannot create a final payment — good, matches requirement |
| Documents RLS | `can_view/upload/manage_documents` global | visibility derived from the **linked record** (`user_can_access_document`, `user_can_access_linked_record`); Storage policy via `user_can_access_storage_object` | A document with no accessible link is invisible to everyone; link type determines who can read it (matters for payment slips, §14) |
| `suppliers` | readable by all authenticated | raw table needs AAL2 + `can_view_sensitive_payments`; app uses `suppliers_app_safe` view (bank details masked) | Supplier matching must use `suppliers_app_safe` |
| Middleware | login/inactive only; **no** role allow-list, **no** AAL2 | role allow-list, AAL2 on high-risk paths, `/mfa` | New exemption for the machine route must not weaken these |
| `app/api/documents/upload/route.ts` | basic | claim_line entity resolution + compensation via `discard_unlinked_document` | Reuse the Stage 1B version of the pattern |
| Voucher save | client-side inserts | atomic RPC `save_payment_voucher_draft` | Gap in §0.4 lives in this RPC |
| UI v2 (`ui-v2.tsx`, `BillsWorkspaceV21`) | present | present, identical except Stage 1B edits (safe supplier view, delete-document action, RPC voucher save) | Review UI is built on the same components in both lines |

Everything else under `app/` that touches bills/documents is byte-identical between the two lines.

## 3. Existing reusable tables / components / routes

Reusable as-is: `supplier_bills`, `suppliers_app_safe`, `supplier_entities`, `categories`, `entities`, `documents`, `document_links` (+ trigger `recalculate_document_link_status_trigger`, which maintains `supplier_bills.supporting_document_status`), private bucket `bill-documents` (PDF/JPEG/PNG, ≤10 MB), `audit_logs` (insert for any active app user; select scoped), `app_profiles` / `user_entity_access`, `finance_user_permissions`, route pattern `app/api/documents/upload/route.ts` (hash → storage → `documents` → `document_links` → audit + compensation), `GET /api/documents/[id]/download` (60 s signed URL), UI: `Phase2Workspace` → `BillsWorkspaceV21`, `BillListV21`, `DetailDrawer`, `PageTabs`, `StatusBadge`, `FieldValue`.

## 4. Phase 1A workflow (invoice → Draft Supplier Bill)

```
Claire → Telegram → FinanceOps (extract) → signed POST /api/integrations/financeops/v1/bill-intakes
   Hub: authenticate → validate strict schema → map entity → idempotency check
      → duplicate checks → supplier/category proposal → insert supplier_bills (payment_status='draft')
      → store original file + documents + document_links(supplier_bill) → intake record + audit
   → 201 {bill_id, flags, duplicates, review_url}
Hub UI: "Intake Review" queue → human verifies/corrects → Mark Verified
   → (existing workflow) authorised finance user releases draft → unpaid → voucher → approval → payment
```

Rules: FinanceOps may create only `payment_status='draft'` (already DB-enforced by RLS insert check). It never creates suppliers, categories, vouchers, payments, or touches reconciliation. Missing/uncertain fields are stored as *flags*, never invented.

## 4a. Unresolved-entity rule (approved)

FinanceOps never guesses the entity. Two different records must be kept apart:

- **A. Intake record** (the future `finance_intake_submissions` row): **may exist with an unresolved entity** (`entity_code: null` in the payload → `entity_id IS NULL`). It is routed to human review.
- **B. Supplier Bill:** **must not be created** until exactly one authorised entity is resolved. No placeholder entity, no "default" entity, and never a bill under the wrong company just to satisfy the NOT NULL `entity_id`.

Consequences: an invalid or unknown `entity_code` string is a validation error (`422`), not "uncertain" — FinanceOps must send `null`. `buildDraftBillProposal` returns `needs_human_review / entity_unresolved` and no bill for a null entity. An entity outside the key's allow-list is `403`. **No file is persisted for an unresolved intake in Phase 1** (the `documents`/Storage model is entity-scoped: `documents.entity_id` is NOT NULL and the Storage path starts with the entity id); the intake keeps only metadata, the document SHA-256 and the Telegram file references, and a human either uploads the invoice through the normal Bills screen after choosing the entity, or asks FinanceOps to resubmit under a **new** `intake_id` with the confirmed entity (the unresolved intake is then marked superseded). See owner decision D10.

## 5. Phase 1B workflow (payment slip → Unverified Payment Evidence)

```
Telegram slip → FinanceOps → GET bill-candidates (scoped, read-only)
   → POST /api/integrations/financeops/v1/payment-evidences (slip + proposed bill + values)
   Hub: record evidence (status 'unverified'), store slip, classify match, audit
Hub UI: "Payment Evidence" queue → human accepts → existing finance-manager flow creates the final bill_payments (Owner/FM + AAL2)
```

No `bill_payments` row, no bill status change, no `bank_transaction_id`, no reconciliation. Ambiguous / partial / combined / unmatched → `needs_review` with the classification recorded as a hint only.

## 6. Proposed API contracts

Base path: `/api/integrations/financeops/v1`. TLS only. Every request is HMAC-signed over method, path, canonical query string and body hash (§7). JSON responses. All timestamps ISO-8601 UTC. Unknown request fields → `422` (strict schema).

### 6.1 `POST /bill-intakes` — `multipart/form-data`
Parts: `metadata` (JSON, below) and `file` (PDF/JPEG/PNG). Size cap **4 MB** in Phase 1 (Vercel serverless request-body limit is ~4.5 MB — verify against the deployed plan; the bucket's 10 MB limit is not reachable through a single serverless request). Larger → `413` + a `needs_manual_upload` audit entry; a signed-upload-URL flow is deferred.

```jsonc
{
  "intake_id": "fo_bill_01J...",                // required, FinanceOps-generated, stable per source document, ^[A-Za-z0-9_-]{8,64}$
  "source": { "channel": "telegram", "chat_id": "…", "message_id": "…", "file_id": "…", "file_unique_id": "…", "received_at": "…", "sender_ref": "claire" },
  "entity_code": "IEA|IETA|PLC|KALER|null",     // key required; null = FinanceOps could not determine the entity (intake only, never a bill - §4a)
  "supplier": { "name": "…", "registration_number": "…" },       // proposal only
  "invoice": { "number": null, "date": null, "due_date": null, "currency": "MYR",
               "subtotal": null, "tax_amount": null, "total_amount": null,
               "description": "…", "bill_type": "supplier_invoice" },   // only supplier_invoice accepted
  "category_hint": { "name": "…" },
  "extraction": { "agent": "financeops-hermes", "version": "…", "overall_confidence": 0.0,
                  "fields": { "total_amount": { "value": 0, "confidence": 0.0 } } },
  "document": { "sha256": "…", "mime_type": "application/pdf", "filename": "…" }
}
```
**Validation model (exact fields, fail closed).** Each object (top level, `source`, `supplier`, `invoice`, `category_hint`, `extraction`, `extraction.fields`, `document`) has an explicit allowlist of keys; any other key → `422 unknown_field`. Separately, an **exact-name** list of sensitive/authoritative fields is rejected with `forbidden_field` at any level, so the audit trail records the attempt: `payment_status`, `supporting_document_status`, `status`, `review_status`, `process_state`, `approval_status`, `created_by`, `updated_by`, `uploaded_by`, `reviewed_by`, `verified_by`, `approved_by`, `approved_at`, `verified_at`, `reviewed_at`, `paid_at`, `paid_by`, `paid_amount`, `outstanding_amount`, `bank_transaction_id`, `bank_account_id`, `reconciliation_date`, `reconciliation_id`, `reconciled_at`, `reconciled_by`, `sql_document_id`, `sql_posted_at`, `sql_posted`, `sql_account_ref`, `id`, `supplier_id`, `entity_id`, `bill_id`, `supplier_bill_id`, `document_id`, `payment_voucher_id`, `bill_payment_id`, `expense_category_id`, `recurring_obligation_id`, `storage_path`, `file_hash`, `data_origin`, `is_demo` (source of truth: `PROHIBITED_FIELDS` in `lib/financeops/schema.ts`). There is **no substring or token matching**: a near-miss such as `bank_note` is simply an unknown field, and a legitimate field is never blocked because its name contains a word like "status" or "payment". The earlier token-based rule was replaced because it could over-block legitimate future fields.

Responses
- `201` `{ "intake_id", "state": "complete", "bill_id", "document_id", "review_url", "flags": ["due_date_missing", …], "supplier_match": { "status": "exact|candidates|none", "candidates": [{ "supplier_id", "name", "score" }] }, "duplicates": [{ "type": "same_invoice_number|same_amount_date|same_file", "bill_id" }] }`
- `200` + `Idempotent-Replayed: true` — same `intake_id`, same payload hash (returns original result).
- `409 intake_conflict` — same `intake_id`, different payload hash.
- `409 duplicate_file` — identical file hash already linked to an active bill in the entity; no new bill; side record `duplicate_suspected` + audit; body names the existing `bill_id`.
- `401` bad/expired signature · `403` entity not permitted for this identity · `413` · `415` unsupported type (HEIC/WebP must be converted by FinanceOps) · `422` validation · `429` rate limit · `503` Hub cannot reach DB.

### 6.2 `GET /bill-intakes/{intake_id}` — status only
Returns `{state, review_status, bill_id, flags}`. No amounts, bank data or document URLs.

### 6.3 `GET /bill-candidates?entity_code=&supplier=&invoice_number=&amount=` (Phase 1B)
The query string is part of the signature (canonical form, §7): changing, adding or removing any parameter invalidates the request; merely reordering pairs does not.
Returns ≤10 bills in the identity's permitted entities with `payment_status in ('unpaid','scheduled','partially_paid','overdue')` **and** a verified review status, projected to `{bill_id, bill_number, supplier_name, total_amount, outstanding_amount, due_date, payment_status}`. No bank details, no payments, no vouchers.

### 6.4 `POST /payment-evidences` — `multipart/form-data` (Phase 1B)
```jsonc
{
  "intake_id": "fo_pay_01J...",
  "source": { … same as 6.1 … },
  "entity_code": "IEA",
  "proposed_bill_id": "uuid|null",              // must be a 6.3 candidate or null
  "alternate_bill_ids": [],
  "amount": 0.00, "currency": "MYR",
  "payment_instruction_date": "YYYY-MM-DD|null",
  "stated_payment_date": "YYYY-MM-DD|null",
  "method": "bank_transfer|cash|cheque|card|other|null",
  "reference": "…|null",
  "payee_text": "…", "payer_text": "…",
  "extraction": { … },
  "document": { "sha256": "…", "mime_type": "…", "filename": "…" }
}
```
`201` `{evidence_id, state: "unverified", match_class: "single|ambiguous|partial|combined|unmatched", flags, review_url}`. Same 200/409/413/415/422 semantics as 6.1.

## 7. Authentication / service identity design

Two separate layers; Hermes holds neither a Supabase key nor a user login.

1. **Hermes → Hub (transport auth):** HMAC-SHA256 request signing. Headers: `X-FinanceOps-Key-Id`, `X-FinanceOps-Timestamp` (unix seconds), `X-FinanceOps-Signature: v1=<hex>`. The signed string is five lines joined by `\n`:

   ```
   timestamp
   METHOD
   canonical_path              pathname exactly as sent (percent-encoded), no query
   canonical_query_string      "" when there is no query
   sha256_hex(raw_body)        lower-case; hash of the empty string for GET
   ```

   **Canonical query string:** drop the leading `?` and empty pairs; percent-decode each key/value (`+` = space, as in form encoding; a literal plus must be `%2B`); re-encode with the RFC 3986 unreserved set and upper-case hex (so `%2f`/`%2F`/`/` variants of one value are equivalent); `a` and `a=` are equivalent; **duplicate keys are kept** (never merged); sort pairs by encoded key then encoded value; join with `&`. Malformed percent-encoding fails verification. Altering, adding or removing any parameter changes the signature; merely reordering pairs does not. Constant-time comparison; max clock skew 300 s by default (configurable 30–900 s); two secrets (`current`/`next`) in Vercel server-only env for rotation; every authentication failure returns the same opaque `401`, and signatures/secrets are never logged or returned. **Per-key entity allow-list:** `FINANCEOPS_ALLOWED_ENTITY_CODES` is the ceiling; `…_CURRENT`/`…_NEXT` may narrow (never widen) a key; an intake outside a key's list gets `403`. **Rate limiting:** per authenticated key id (after the signature verifies, so unauthenticated traffic cannot consume a key's budget), default 30/min, `429` + `Retry-After`. This is **best-effort per warm serverless instance** (in-memory); a hard global limit needs the platform firewall or a shared store and is future work. Replay of a *create* is neutralised by `intake_id` idempotency (future table); replay of GETs is harmless.
2. **Hub → Database (RLS identity):** the route signs in server-side as a **dedicated Supabase Auth user** (`financeops-hermes`, never Claire's Owner login, never shared with staff) using credentials held only in Vercel server-only env, and uses *that user's JWT* so RLS and the Stage 1B triggers apply. **No service-role key is used or given to FinanceOps.** The user has an `app_profiles` row (`active_status=true`) and `user_entity_access` rows only for the entities Claire approves.
3. **Middleware:** one narrow exemption, **only** for paths under `/api/integrations/financeops/v1/` (with a non-empty remainder). Those requests skip the *cookie* user check and are authenticated inside the route by (1); the route also answers `503` unless `FINANCEOPS_INTAKE_ENABLED=true`. The matcher (`lib/financeops/routes.ts`, edge-safe, no imports) additionally refuses any path containing `..`, `//`, a backslash, `;` or any `%` (covering `%2e%2e`, encoded slash/backslash and double-encoding such as `%252e`), so such paths fall through to the normal cookie gate. `/api/admin/**`, high-risk AAL2 routes and every other `/api/*` route are unchanged; the unversioned prefix, `/api/integrations/financeopsX/…`, `/v2/…` and the bare `/v1/` are not exempt. Wrong HTTP methods get `405`; a valid signature minted for a different path or query fails verification (`401`).
4. The identity never holds an AAL2 session, so every AAL2-gated capability (payments, vouchers issue/void, bank, document delete, draft delete, user admin) is unreachable by construction.

**Role choice for the DB identity (owner decision D1).** On Stage 1B the closest existing role is `data_entry`: can view finance, manage bills (draft only — trigger enforces), upload documents; cannot insert `bill_payments`, prepare vouchers, see sensitive payments, touch reconciliation. But `data_entry` is broader than FinanceOps needs (it can update any *draft* bill in its entities, and holds `can_manage_claims`). Options:
- **A (recommended for Phase 1):** `data_entry` + route code that exposes only the narrow operations + four-eyes DB rule on verification (§11). No change to the Stage 1B role boundary.
- **Transitional status of Option A (approved D1 for the pilot).** `data_entry` is **broader than ideal**: it can view all finance bills of its entities, update any *draft* bill, upload documents, and holds claim-management permissions FinanceOps does not need. Compensating controls: credentials live only in Vercel server-side env and never reach Hermes; the Hub exposes only narrow operations; no AAL2; no service-role key; the identity can only create `draft` bills (RLS + trigger); it cannot create `bill_payments`, vouchers, reconciliation or deletions; four-eyes prevents it verifying its own intakes; entity-access rows limit it to approved entities. **Hardening note:** before any large-scale or permanent automation, introduce a dedicated least-privilege FinanceOps capability / RPC boundary (Option B). Do **not** create that role now.
- **B (later hardening):** a dedicated `financeops_intake` capability implemented as SECURITY DEFINER RPCs (`submit_bill_intake`, `submit_payment_evidence`) granted to a new integration role. This needs a new role value, new SECURITY DEFINER functions and edits to the 0022 permission functions → **stop-and-approve item, post-release only**. It also makes bill+document+intake creation atomic.

## 8. Least-privilege permission model

| Capability | FinanceOps | Intern (`data_entry`) | Finance Staff | Finance Mgr / Owner |
|---|---|---|---|---|
| Create bill, `draft` only | **yes** | yes | yes | yes |
| Set any other bill status | **no** (RLS insert check + trigger) | no (trigger) | yes | yes (paid/cancel also AAL2) |
| Upload/link invoice document | yes (new bill only) | yes | yes | yes |
| Read bills / supplier-safe view / categories | scoped to approved entities | yes | yes | yes |
| Verify / correct intake | **no** (four-eyes) | yes | yes | yes |
| Release draft → `unpaid` | no | no | yes | yes |
| Create final `bill_payments` | **no** (Owner/FM + AAL2 only) | no | no | yes + AAL2 |
| Vouchers prepare/issue, bank, reconciliation, user admin, delete | no | no | partial | per Stage 1B |
| Create suppliers/categories | **no** | per existing | per existing | per existing |

## 9. Existing fields that can be reused

`supplier_bills`: `entity_id, supplier_id, bill_number, description, bill_type('supplier_invoice'), bill_date, due_date, subtotal, tax_amount, total_amount, outstanding_amount, currency, expense_category_id, payment_status('draft'), supporting_document_status (trigger-maintained), remarks, created_by, data_origin('imported'), is_demo(false)`.
`documents`: `entity_id, document_type('supplier_invoice'|'payment_slip'), original_filename, storage_path, mime_type, file_size, file_hash, uploaded_by, version_number`.
`document_links`: `document_id, entity_id, linked_record_type('supplier_bill'), linked_record_id, created_by`.
`audit_logs`: `actor_user_id, action, entity_type, entity_id (= entity id by existing convention), payload, data_origin`.
`data_origin` allows only `demo|production|imported|manual` (0005); use `imported`. A distinct `financeops` value would need a migration — not worth it given the provenance table below.

## 10. Missing fields / schema requirements

Confirmed gaps against Hermes' findings:

| Need | Gap | Minimum fix |
|---|---|---|
| Stable external id / idempotency | none on any table; `documents.file_hash` is indexed but **not unique** | new `finance_intake_submissions.intake_id UNIQUE` |
| Provenance (Telegram chat/message/file ids, agent, version, confidence, flags) | none; only free-text `remarks` | same table (jsonb) |
| Review/verification state | none; only `payment_status='draft'`, no verifier/time, and no UI to move draft→unpaid (no `supplier_bills` update exists anywhere in `app/`) | `review_status, reviewed_by, reviewed_at, review_note` on the same table |
| Missing due date | `due_date NOT NULL` | **Phase 1:** placeholder `due_date = bill_date` plus flag `due_date_missing` that blocks "Mark Verified" until a human sets it. Relaxing NOT NULL on a core table is deferred. |
| Missing amount | `total_amount NOT NULL default 0` | store `0` + flag `amount_missing`; verification blocked until > 0 |
| Missing description | `NOT NULL` | server-built fallback "Supplier invoice {number} – {supplier text}" + flag `description_inferred` |
| Unverified payment evidence | `bill_payments` has no status column, insert is final and Owner/FM+AAL2 | new `payment_evidence_submissions` table; never write `bill_payments` |
| Evidence document visibility | `document_links.linked_record_type` has no evidence type; `'other'` makes the document unreadable to everyone (`user_can_access_linked_record` returns false) | add `payment_evidence` type to the CHECK **and** to `user_can_access_linked_record` (touches the 0022 boundary) |
| Data-origin value for FinanceOps | not available | use `imported` + provenance table |

## 11. Review / verification state model

Two independent axes; FinanceOps can only ever create `bill.payment_status='draft'` and `review_status='pending_review'`.

- `finance_intake_submissions.review_status`: `pending_review → verified | rejected`; side states `duplicate_suspected` (no bill created) and `needs_attention` (e.g. document step failed).
- `finance_intake_submissions.process_state` (idempotent resume): `received → bill_created → document_attached → complete`.
- `supplier_bills.payment_status`: `draft` (unverified) → `unpaid` (released by an authorised finance user — this is the existing human approval path) → existing states.
- **Four-eyes rule (DB-enforced):** a before-update trigger on the intake table requires `reviewed_by = auth.uid()` and `auth.uid() <> created_by` when `review_status` changes. The FinanceOps identity created the row, so it can never verify its own submission, regardless of what the API layer does.
- "Mark Verified" additionally requires: supplier chosen, amount > 0, due date confirmed, entity confirmed, document attached, no unresolved hard flag.
- **D2 (owner decision):** may an intern's "Verified" suffice, with release to `unpaid` done by Finance Staff+ (this is what the trigger already forces for `data_entry`), or must Finance Staff verify directly?

## 12. Duplicate / idempotency design

1. **Idempotency:** `intake_id` UNIQUE; the table stores `payload_hash = sha256(canonical metadata + file sha256)`. Insert-first (`ON CONFLICT DO NOTHING`), then branch: same hash → replay result/resume the incomplete step; different hash → `409`.
2. **Hard duplicate (blocks bill creation):** same `file_hash` already linked to a non-deleted `supplier_bill` in the same entity → `409 duplicate_file`, record `duplicate_suspected`.
3. **Soft duplicates (create the draft, flag it, list the matches):** (a) same `entity + supplier_id + bill_number`; (b) same `entity + supplier + total_amount + bill_date`; (c) same file hash in another entity.
4. **Race safety:** serverless requests are concurrent; correctness comes from the UNIQUE `intake_id`, not from check-then-insert. Duplicate checks are advisory; the intake UNIQUE is authoritative.
5. Retries are always safe: FinanceOps must reuse the same `intake_id` and the same bytes.

## 13. Document handling

Reuse the existing storage convention: `{entityId}/{yyyy}/{mm}/supplier_invoice/{billId}/{uuid}.{ext}` in private `bill-documents`. Server recomputes SHA-256 and compares with `document.sha256` (mismatch → `422`). Allowed MIME: PDF/JPEG/PNG only (matches bucket). Order: bill → file to storage → `documents` → `document_links` → trigger sets `supporting_document_status='invoice_uploaded'`. On failure after the bill exists, the bill stays `draft`, the intake is `needs_attention` / `process_state` unchanged, and a retry with the same `intake_id` completes the missing step. The FinanceOps identity cannot delete (no `can_delete_documents`, no AAL2), so cleanup of stuck rows is a human action. Non-atomicity is inherent in Option A and disappears with Option B RPCs. Originals are never modified; any correction creates a new document version through the existing replace flow.

## 14. Payment-evidence handling

- Never insert `bill_payments`; never set bill `paid/partially_paid`; never fill `bank_transaction_id`.
- **Do not link the slip to the supplier bill at intake.** The existing trigger recalculates `supporting_document_status` from linked documents; a `payment_slip` link beside the invoice would flip the bill to `complete` before any human has looked at it. Link the slip to the evidence record (new `payment_evidence` link type, §10).
- Evidence visibility follows the sensitivity of payments: same gate as `bill_payments` reads (`can_view_sensitive_payments` + AAL2) — **D3 (owner decision):** confirm, or allow Finance Staff without AAL2 to review evidence.
- Match classes are hints stored on the record: `single`, `ambiguous` (2+ candidates), `partial` (amount < outstanding), `combined` (one slip, several bills), `unmatched`. Only a human with the existing Owner/FM + AAL2 payment authority converts accepted evidence into a `bill_payments` row.

## 15. Human verification UI

Built inside the existing `BillsWorkspaceV21` (no redesign):
- New tab **"Intake Review"** (count badge) beside Bill List / Create Bill / Create PV Draft; a "FinanceOps" chip on drafts in Bill List.
- Detail drawer: original document preview (existing signed-URL route) next to editable fields; per-field flags/confidence from `extraction`; supplier candidate picker; duplicate warnings with links; actions **Save corrections**, **Mark Verified**, **Reject** (side-table state; hard deletion stays an Owner/FM+AAL2 action).
- **Mandatory guard fix (closes §0.4):** exclude `payment_status='draft'` from `awaiting` (Bill List, "Create PV Draft"), have the "Create PV Draft" button hidden for drafts, and have `/api/payment-vouchers/generate` refuse drafts. A DB-level guard (reject draft bills in `save_payment_voucher_draft`) is the proper fix but is a change to a Stage 1B SECURITY DEFINER function → post-release migration item.
- Fix the manual form default status to `draft` (closes §0.3).
- Phase 1B: **"Payment Evidence"** tab with slip preview, proposed bill, values, and an "Accept → open payment form prefilled" action that leads into the existing Owner/FM flow.

## 16. Audit / provenance requirements

Every FinanceOps call writes `audit_logs` rows (actor = FinanceOps user id, `entity_id` = entity): `financeops_intake_received`, `financeops_bill_draft_created`, `financeops_duplicate_suspected`, `financeops_intake_conflict`, `financeops_payment_evidence_received`. Payload: `intake_id`, `payload_hash`, Telegram chat/message/file ids, `key_id`, request id, flags. Human actions: `intake_verified`, `intake_rejected`, `intake_corrected` (before/after diff), `evidence_accepted`. `audit_logs` has insert/select policies only (no update/delete) so entries are append-only for app users. Raw invoice contents are not duplicated into logs; hashes and ids only. The Auth user id + `key_id` identifies the machine actor; never log secrets or the HMAC string.

## 17. Proposed files that would change (not changed now)

New: `app/api/integrations/financeops/v1/bill-intakes/route.ts`, `…/bill-intakes/[intakeId]/route.ts`, `…/bill-candidates/route.ts`, `…/payment-evidences/route.ts`; `lib/financeops/{auth.ts,schema.ts,intake.ts,duplicates.ts,supplier-match.ts}`; `app/intake-review.tsx` (tab content); `supabase/migrations/00NN_financeops_intake.sql`; `supabase/tests/00NN_financeops_intake.test.sql`; `docs/FINANCEOPS_INTEGRATION.md`.
Edited (small): `lib/supabase/middleware.ts` (one exempt prefix), `app/phase2-workspace.tsx` (draft exclusion, default status, Intake Review tab wiring), `app/api/payment-vouchers/generate/route.ts` (refuse draft), `.env.example` (server-only `FINANCEOPS_HMAC_SECRET_CURRENT/NEXT`, `FINANCEOPS_DB_USER_EMAIL/PASSWORD` — names only, no values), `docs/SECURITY.md`, `docs/TEST_PLAN.md`.
Not touched: 0020, 0021, 0022, Student Operations, bank/reconciliation, vouchers RPCs (pre-release).
(`00NN` is deliberately not fixed: if the Stage 1B release produces any corrective migration it takes 0023.)

## 18. Is a migration required?

- **Phase 1A, strictly minimal, no migration:** technically possible (provenance in `audit_logs.payload`, flags in `remarks`, idempotency by check-then-insert). **Not recommended:** idempotency would be racy, there would be no verification state, and the four-eyes rule could not be DB-enforced.
- **Recommended: one small additive migration**, new tables only, no change to existing tables or functions:
  - `finance_intake_submissions` (intake_id UNIQUE, payload_hash, source jsonb, **entity_id NULLABLE** — NULL only while the entity is unresolved —, supplier_bill_id, document_id, process_state, review_status, extraction jsonb, flags jsonb, duplicate_of, created_by, reviewed_by/at/note, timestamps) + four-eyes trigger.
  - Phase 1B: `payment_evidence_submissions` (same shape + proposed/alternate bill ids, amounts, dates, method, reference, match_class) **and** the `payment_evidence` link-type extension, which is the only part that touches a 0022 function (`user_can_access_linked_record`) and the `document_links` CHECK.
- Split into two migrations so 1A can ship without the 0022-function edit.
- Per the handover: this requires explicit approval; **nothing is created now**.

## 19. RLS / security impact

**Unresolved-entity intakes (`entity_id IS NULL`) — visibility rule for Migration A.** Normal entity-scoped RLS (`user_can_access_entity(entity_id)`) is false for NULL and must not be the only rule, but "visible to everyone with finance access" would leak cross-company invoices. Recommended: a **central authorised Finance-review rule** — a small STABLE SECURITY DEFINER helper such as `app_private.current_user_can_review_unresolved_intakes()` (active user; role Owner, Finance Manager or Finance Staff; **not** `data_entry`; **not** entity-membership-based) used in the SELECT/UPDATE policy branch `entity_id IS NULL`; plus a creator-only branch (`created_by = auth.uid()`) so the FinanceOps identity can read the status/replay of its own submissions and nothing else. Resolving the entity is a controlled transition: set once (immutable thereafter via trigger), only to one of the four approved entities, only by a reviewer who has access to that entity, audited, and the four-eyes rule still applies. Once resolved, the row becomes ordinary entity-scoped. A new helper function is new SECURITY DEFINER surface → stop-and-review item for Migration A; nothing is created now.

- New tables: RLS enabled; insert = `can_manage_bills` + entity access + `created_by = auth.uid()`; select = `can_view_finance` (+ sensitive/AAL2 gate for evidence); update = review fields only, by users who are not `created_by` (trigger); no delete grant; `anon` revoked.
- Existing policies unchanged in 1A. 1B changes one SECURITY DEFINER function and one CHECK (flagged: new/changed SECURITY DEFINER surface → needs review).
- New attack surface: one internet-reachable machine route group. Mitigations: HMAC + timestamp, strict schema, size/MIME limits, per-key entity allow-list, rate limit, no service-role key, DB identity without AAL2, append-only audit.
- Residual risks: (i) `data_entry` is broader than needed at the DB layer (Option A) — compromise of the Vercel env would expose it, so the credentials live only there; (ii) shared-secret HMAC means anyone holding it can submit drafts (never approve/pay); (iii) prompt-injection text inside invoices/slips is stored as inert data and must never be rendered as HTML or interpreted as instructions by the Hub.

## 20. Tests required

Implemented now (pre-DB, `npm run test:financeops`, Node's built-in runner, no dependency added): HMAC incl. canonical query (valid, reordered, tampered, added, removed, empty, duplicate keys, encoded/equivalent values, malformed encoding, wrong path/method/body/key, skew, current/next); strict schema with exact prohibited fields at every nesting level, near-miss names rejected as *unknown* not forbidden, every allowlisted field accepted; duplicates; supplier/category matching; draft proposal and verification blockers; handler end-to-end (opaque 401, 405 for unexpected methods, per-key entities, rate limit, size/MIME/hash); middleware matcher (`/v1` prefix only, `financeopsX`, `..`, `%2e%2e`, encoded slash/backslash, double-encoding, `;`) and a source check that the middleware uses the matcher before any cookie logic.

**tsconfig / test-tooling decision.** The first test cut added `allowImportingTsExtensions` to the repo-wide `tsconfig.json` plus `.ts` import suffixes so Node could run the tests. That was test convenience leaking into global compiler behaviour, so it was **removed**: source files use extensionless imports like the rest of the app, and tests run through a tiny test-only resolver hook (`lib/financeops/__tests__/register-ts.mjs` + `ts-resolve-hooks.mjs`, loaded only by the `test:financeops` script). `tsconfig.json` is unchanged from Stage 1B.

pgTAP (against Stage 1B fixtures): FinanceOps identity can insert draft bill + document + link + intake; **cannot** insert non-draft bill, update bill to `unpaid/paid/cancelled`, insert `bill_payments`, prepare/issue vouchers, read `bank_*`/`reconciliation`, delete documents/drafts, or create suppliers; cannot verify its own intake (four-eyes); cross-entity insert denied; inactive identity denied; evidence slip not visible to unauthorised roles; payment-evidence insert leaves `supplier_bills.supporting_document_status` unchanged.
Application (Node built-in `node --test` on pure modules, or a one-off script — repo has no runner): HMAC verify (valid, wrong key, skew, tampered body), strict-schema rejection of forbidden fields, idempotent replay vs conflict, duplicate classification, entity mapping, supplier exact/candidate/none, missing-field flags, MIME/size rejection, middleware matcher (exempt prefix does not match `/api/admin/*` or high-risk paths).
Manual/UAT on a disposable Supabase stack with Stage 1B applied: end-to-end curl intake → review queue → verify → release; draft excluded from "awaiting payment"/PV creation; manual bill form default now `draft`.
Standard gate: `typecheck`, `lint`, `build`.

## 21. What can be implemented without DB changes

Safe to build and unit-test now on a branch (inert until deployed against Stage 1B): HMAC auth + strict schema + canonicalisation + payload hash modules; supplier/category matching and duplicate classification modules; the middleware exemption; draft exclusion from "awaiting payment" and from `/api/payment-vouchers/generate`; manual bill form default → `draft`; Intake Review UI shell reading existing `supplier_bills` where `payment_status='draft'`; API route skeleton returning `501` until the tables exist.

## 22. What must wait for Stage 1B release

Anything that writes in a live environment (the FinanceOps DB identity, intake tables, route enabling, UAT with real documents), the migration itself (numbering depends on whether Stage 1B releases any corrective 0023), the DB-level voucher-draft guard, and every Phase 1B DB element. Do **not** provision the FinanceOps Auth user on the pre-0022 Production schema (legacy `supplier_bills_entity_all` would let it write any status).

## 23. Recommended future Git base after Stage 1B release

Because `origin/main` is already an ancestor of Stage 1B, the integration is trivial and linear:
1. When Claire approves the release, merge `agent/finance-security-integration` into `main` by PR (a fast-forward is possible if `main` has not moved; verify `git rev-list --count 338125a..origin/main` is still `0`).
2. Create `claude/financeops-bill-intake` from the **new `main`** (equivalent to `338125a` if nothing else landed).
3. If the release changes Stage 1B (e.g. a corrective 0023 or amended app code), base on the merged `main`, not on `338125a`; number the FinanceOps migration after the last released one.
4. If the release is delayed: start from `338125a` for the no-DB items in §21 (it already contains all of `main`); if `main` later advances, rebase that branch onto `main` once. No separate integration branch is needed.
Do not base on the current checked-out branch (`agent/option-a-publish-clean`).

## 24. Smallest practical implementation sequence

1. **PR-0 (no DB, ship-able with Stage 1B):** manual bill default `draft`; exclude drafts from "awaiting payment"/PV creation and refuse in `/api/payment-vouchers/generate`.
2. **PR-1 (no DB):** `lib/financeops/*` (auth, schema, hash, duplicates, supplier match) + `node --test` tests + middleware exemption (route disabled by missing env).
3. **Approval gate:** Claire approves D1–D5 and the intake migration.
4. **PR-2 (after Stage 1B release):** migration 1A + pgTAP + `POST/GET bill-intakes` + provision FinanceOps Auth user (separately approved account-window, like the existing intern transition plan).
5. **PR-3:** Intake Review tab; staff UAT with real invoices in a disposable/staging project.
6. **Then Phase 1B** in the same order: migration (incl. 0022-function edit, reviewed as a security change) → `bill-candidates` + `payment-evidences` → Payment Evidence tab.

---

## Appendix A — Verification of Hermes' earlier findings

| # | Hermes finding | Verdict | Evidence |
|---|---|---|---|
| 1 | `supplier_bills` exists | **Confirmed** | 0004; both lines |
| 2 | `documents` / `document_links` exist | **Confirmed** | 0004, extended 0011/0014; links drive `supporting_document_status` via trigger (0020) |
| 3 | Private bill storage | **Confirmed** | bucket `bill-documents`, `public=false`, 10 MB, PDF/JPEG/PNG; scoped policies in 0022 |
| 4 | UI default payment status differs from schema | **Confirmed, and worse on Stage 1B** | UI default `unpaid` (`phase2-workspace.tsx:16`) vs schema default `draft` (0004) vs Stage 1B insert policy requiring `draft` (§0.3) |
| 5 | Required `due_date` problematic | **Confirmed** | `due_date date NOT NULL` (0004); UI defaults to today; `BillListV21` already tolerates null display |
| 6 | No FinanceOps machine endpoint | **Confirmed** | all routes cookie-based; middleware 401s cookie-less `/api/*` (no exemptions, including the Stripe webhook route) |
| 7 | Bill verification/approval state insufficient | **Confirmed** | no verifier/provenance/review fields; no `supplier_bills` update path in `app/`; drafts appear as awaiting payment; voucher RPC ignores bill status |
| 8 | `bill_payments` lacks unverified state | **Confirmed** | no status column; insert is final; Stage 1B limits insert to Owner/FM + AAL2 |
| 9 | Upload APIs interactive/cookie based | **Confirmed** | `app/api/documents/upload/route.ts`, `download/route.ts` use `createClient()` cookie session |
| 10 | Needs a narrower machine boundary | **Confirmed** | closest role `data_entry` is broader than required (§7 D1) |

## Appendix B — Migration 0022 line-ending / hash clarification

- Approved SHA-256 `6F4E0862631A2927324A1D53EFCB24BA6DEB46615C23103D3E601B1BE58431B2` is the hash of the file **with CRLF line endings** (a Windows working tree with `core.autocrlf=true`).
- Git stores the blob with LF. Blob id at `338125a`: `1eadd009af9f127eabc1f371c33548ad627d7fb1`. SHA-256 of the LF content: `07ceb9b54d1c1ff0f11c6ac025fa8080fb0bdd739a310f1de8273bd039f20f55`.
- Verified: converting the committed LF content to CRLF yields exactly `6f4e0862…31b2`, i.e. the approved hash. The only difference is LF vs CRLF. **Not content drift.**
- No `.gitattributes` exists in the repo, so the working-tree hash depends on each machine's `core.autocrlf`.
- Recommended platform-independent integrity checks: (1) Git object identity — `git rev-parse 338125a:supabase/migrations/0022_stage1b_finance_security_boundary.sql` must equal `1eadd009af9f127eabc1f371c33548ad627d7fb1` (strongest, no line-ending dependence); or (2) SHA-256 after explicit LF normalisation (`git show <commit>:<path> | tr -d '\r' | sha256sum`) must equal `07ceb9b5…0f55`. Keep the CRLF hash only as a documented alias. Optionally add `.gitattributes` with `*.sql text eol=lf` in a future housekeeping commit (does not change blob ids for already-LF content).

## Appendix C — Owner decisions

**D1–D9 are approved** (see `FINANCEOPS_PHASE1_CLAUDE_HANDOVER.md`). Remaining / new:

- **D10 — unresolved-entity intake without a file:** Phase 1 stores no file for an intake whose entity is unresolved (§4a). Confirm: a human completes it manually via the Bills screen, or FinanceOps resubmits under a new `intake_id` once the entity is confirmed (recommended: allow both; the unresolved intake is then marked superseded). The alternative — a quarantine Storage bucket — adds a new Storage policy surface and is not recommended for Phase 1.
- **D11 — who resolves an unresolved entity:** recommended Finance Staff or above (not `data_entry`), because choosing the company is a financial-control decision; the intern then verifies the entity-scoped intake as in D2.

Original questions (all now answered; kept for the record):

- **D1** DB identity for FinanceOps: Option A (`data_entry` + narrow route + four-eyes trigger) now, or wait for Option B (dedicated role + SECURITY DEFINER RPCs, needs post-release security review)?
- **D2** Who may mark an intake "Verified": intern, or Finance Staff and above? Who releases `draft → unpaid`?
- **D3** Payment evidence visibility: Owner/FM with AAL2 only (matches `bill_payments`), or also Finance Staff?
- **D4** Entities FinanceOps may submit for (IEA, IETA, PLC = Premier Language Centre, KALER) — confirm the list and that "Premier" means `PLC`.
- **D5** Missing due date: accept the `bill_date` placeholder + blocking flag (recommended), or approve a later migration to make `due_date` nullable?
- **D6** Hard-duplicate policy: block new bill on identical file in the same entity (recommended) or always create a flagged draft?
- **D7** File size: accept the 4 MB Phase 1 cap, or approve a signed-upload-URL design later?
- **D8** Approve closing §0.3/§0.4 as a small PR-0 (ordinary application change, no DB) and raise §0.3 in the Stage 1B release review.
- **D9** Hermes will receive only an HMAC secret and the endpoint URL; confirm that is acceptable and who owns secret rotation.
