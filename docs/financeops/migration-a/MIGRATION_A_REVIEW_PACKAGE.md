# FinanceOps Phase 1A — Migration A review package (DESIGN ONLY)

Status: **proposal for Claire's approval. Nothing here has been applied, deployed, or run against any database.** The SQL is in [`PROPOSED_migration_a_financeops_intake.sql.txt`](PROPOSED_migration_a_financeops_intake.sql.txt) — deliberately outside `supabase/migrations/`, un-numbered, and named `.sql.txt` so no tooling can pick it up. Authoritative design: `FINANCEOPS_HUB_PHASE1_IMPLEMENTATION_SPEC.md` and `FINANCEOPS_PHASE1_CLAUDE_HANDOVER.md` (D1–D11 preserved).

**Validation actually done on the SQL:** top-level syntax parse (46 statements) and a PL/pgSQL body parse of all four functions with the Postgres parser (WASM, no database). **Not done:** execution against Postgres, replay on 0001–0022, pgTAP, advisors. Those are the next gate and are listed in §9.

---

## 1. Stage 1B compatibility review (released `main` = `31e84d3`)

Released main = Stage 1B commit `338125a` + four application commits (`b08a302`, `e2aefea`, `93447b1`, `31e84d3`). `0022` is byte-identical (Git blob `1eadd009…`). The four commits touch only `app/api/bills/verify/route.ts`, `app/api/payment-vouchers/generate/route.ts`, `app/api/recurring/generate/route.ts`, `app/phase2-workspace.tsx`, `lib/bill-verification.ts`, `tests/stage1b-app-fix.test.cjs` — **no overlap** with the FinanceOps branch (rebase was conflict-free; all five commits patch-identical).

| Earlier FinanceOps assumption | Status on released main |
|---|---|
| Manual bill form defaulted to `unpaid` (would fail Stage 1B RLS) | **Fixed on main** (`draft` default; `created_by` now sent). |
| Draft bills appeared in "Awaiting Payment" / could start a PV | **Fixed on main** (`isBillPayable`, `/api/payment-vouchers/generate` returns 409 for draft). *Still true:* the `save_payment_voucher_draft` RPC itself does not check bill status (0022 unchanged) — DB-level guard remains a separate later item, not part of Migration A. |
| `data_entry` cannot move a bill out of `draft` | **Confirmed in 0022** (`enforce_finance_record_state`: "Data Entry users may only maintain bill drafts") and by RLS insert (`payment_status = 'draft'`, `created_by = auth.uid()`). So FinanceOps (data_entry) cannot do `draft → unpaid` at the database level. |
| Who releases `draft → unpaid` | **Released as** `POST /api/bills/verify` (Owner / Finance Manager / Finance Staff, via `lib/bill-verification.ts`), audited as `supplier_bill_verified`. The DB trigger only blocks `data_entry`; the app narrows to the three roles. The same three roles are the D11 reviewer set — the constant can be reused for the future "Resolve entity" UI gate (the database stays authoritative). |
| Insert must carry `created_by = auth.uid()` | **Confirmed** (e2aefea). FinanceOps persistence must send the identity's user id (from its signed-in session) on every bill insert. |
| Middleware exemption | `lib/supabase/middleware.ts` unchanged on main; the `/api/integrations/financeops/v1/` exemption applies cleanly. |
| Recurring bills start as `draft` | Confirmed; irrelevant to intake persistence. |

**Terminology collision (needs a decision, Q1).** Stage 1B now calls `draft → unpaid` "**verify**" ("Verify & Mark Ready for Payment", audit `supplier_bill_verified`). My earlier docs used "Verified" for the intern's data-check. To avoid two meanings of "verified", this proposal names the intake-level state **`data_verified`** (extracted data matches the original document; D2) and leaves "verify / ready for payment" to the Stage 1B route. `data_verified` never changes `supplier_bills.payment_status`.

## 2. Scope

**In Migration A:** two new tables, five functions (two `SECURITY DEFINER`, three triggers), three triggers, seven policies on the two tables, one view. Nothing existing is altered.

**Not in Migration A** (unchanged/deferred): any change to 0020/0021/0022, `supplier_bills`/`documents`/`document_links`/Storage/`bill_payments`/vouchers/claims/bank/reconciliation; `payment_evidence_*` and the `payment_evidence` link type (Migration B, edits `user_can_access_linked_record`); the draft guard in `save_payment_voucher_draft`; any role (D1: no `financeops_intake` role); AAL2 rules; SQL Account.

## 3. Object inventory

### 3.1 `public.finance_integration_identities` (the FinanceOps designation registry — *proposal Q2*)
Not a role. Names which active `data_entry` user is the FinanceOps identity and which entities it may submit for.

| Column | Type / default | Notes |
|---|---|---|
| `user_id` | uuid PK → `auth.users` ON DELETE CASCADE | |
| `integration` | text NOT NULL default `'financeops'` | CHECK `= 'financeops'` |
| `active_status` | boolean NOT NULL default true | kill-switch |
| `allowed_entity_ids` | uuid[] NOT NULL | CHECK 1–4 elements; trigger: each must be an existing entity with short_code in IEA/IETA/PLC/KALER, no duplicates |
| `note`, `created_by` (→ users, SET NULL), `created_at`, `updated_at` | | |

Trigger `fii_enforce_rules` (BEFORE INSERT/UPDATE, INVOKER): profile must be **active and role `data_entry`** (never `finance_staff` or anything else); entity list validated; `updated_at`.
RLS: `fii_select` (self or Owner); `fii_owner_write` ALL — **Owner + AAL2** only (mirrors `user_entity_access_owner_all`). Grants: authenticated only (anon/public revoked).

### 3.2 `public.finance_intake_submissions`
| Group | Columns |
|---|---|
| Identity / idempotency | `id` uuid PK; `intake_id` text **UNIQUE** (`^[A-Za-z0-9_-]{8,64}$`); `payload_hash` (64 hex) |
| Provenance | `integration_key_id`, `request_id`, `source` jsonb (Telegram refs), `payload` jsonb (validated metadata ≤ 64 KB) |
| Entity (D4/D10) | `entity_code_declared` (IEA/IETA/PLC/KALER or NULL); **`entity_id` NULLABLE → `entities`** (NULL = unresolved) |
| Records created | `supplier_bill_id` → `supplier_bills` SET NULL; `document_id` → `documents` SET NULL |
| Original document facts | `document_sha256`, `document_mime_type` (pdf/jpeg/png), `document_filename`, `document_size_bytes` (1 … 4 194 304) |
| Review record | `flags` text[] (≤ 64), `duplicate_matches` jsonb array, `process_state`, `review_status`, `review_note`, `reviewed_by`, `reviewed_at` |
| Entity resolution (D10 path 1) | `entity_resolved_by`, `entity_resolved_at`, `entity_resolution_note` |
| Lineage (D10 path 2) | `supersedes_intake_id` text → `finance_intake_submissions(intake_id)` ON DELETE RESTRICT |
| Audit | `created_by` (→ users SET NULL), `created_at`, `updated_at` |

States — `process_state`: `received`, `awaiting_entity`, `bill_created`, `document_attached`, `complete` (forward-only). `review_status`: `pending_review`, `data_verified`, `rejected`, `duplicate_suspected`, `needs_attention` ("superseded" is **derived**, not stored).

**Constraints beyond formats/enums:**
- `fis_no_records_without_entity`: `entity_id IS NOT NULL OR (supplier_bill_id IS NULL AND document_id IS NULL)` — **no bill and no file until exactly one authorised entity is resolved.**
- `fis_awaiting_entity_state`: `(entity_id IS NULL) = (process_state = 'awaiting_entity')`.
- `fis_data_verified_needs_review`: `data_verified` ⇒ `reviewed_at` and `entity_id` set.
- `fis_resolution_note_pair` / `_length`: resolution timestamp and note set together; note ≥ 3 chars.
- `fis_no_self_supersede`; `fis_supersede_has_entity`: a superseding intake carries its entity and was never reviewer-resolved.

**Indexes:** unique `intake_id` (constraint); unique partial on `supersedes_intake_id` (**one successor per original**), `supplier_bill_id`, `document_id`; `(created_at) WHERE entity_id IS NULL` (unresolved queue); `(entity_id, review_status, created_at DESC)`; `document_sha256`; `created_by`.

### 3.3 Functions
| Function | Kind | Purpose |
|---|---|---|
| `app_private.current_user_can_review_unresolved_intakes()` | STABLE, **SECURITY DEFINER**, `search_path=''` | D11: active app user with role `owner` / `finance_manager` / `finance_staff`. Not `data_entry`, not `management`. |
| `app_private.intake_is_superseded(text)` | VOLATILE, **SECURITY DEFINER**, `search_path=''` | Boolean existence of a successor so a reviewer can't miss a successor hidden by entity scope; VOLATILE for a fresh snapshot in the resolve-vs-supersede race. |
| `public.enforce_finance_intake_rules()` | trigger, INVOKER | The state machine (below). |
| `public.audit_finance_intake_change()` | trigger, INVOKER | DB-enforced audit rows. |
| `public.enforce_finance_integration_identity()` | trigger, INVOKER | Registry validation. |

Both definer functions: `revoke … from public, anon`; `grant execute … to authenticated, service_role` (same pattern as the Stage 1B helpers). The three trigger functions are revoked from public/anon/authenticated like 0022's.

### 3.4 `enforce_finance_intake_rules()` — what it enforces
- **INSERT:** only a registry identity; `created_by = auth.uid()`; no review/resolution/links on a new row; entity (if given) is one of the four and equals `entity_code_declared`; unresolved ⇒ no declared code and `awaiting_entity`; **supersession**: locks the original (`FOR UPDATE`), requires original still unresolved, same creating identity, not rejected (second successor ⇒ unique-index error).
- **UPDATE, always:** provenance, payload, hash, source, original-document facts, `supersedes_intake_id`, `created_by` are immutable; `updated_at` set by the server; terminal `data_verified`/`rejected` rows frozen.
- **Entity resolution (path 1), standalone & set-once:** only `current_user_can_review_unresolved_intakes()` (never the integration identity); refuses if a successor exists; entity must be one of the four; note required; trigger **overwrites** `entity_resolved_by := auth.uid()`, `entity_resolved_at := now()`, state → `received`; nothing else may change in the same statement. Afterwards the entity and its trail are immutable.
- **Links:** bill/document link set once; bill must be in the **same entity** and still **`draft`**; document must be the **same entity** and its `file_hash` must equal the intake's `document_sha256` (proves it is the original file).
- **FinanceOps identity (own rows only):** may advance `process_state`, set the two links, and flag `duplicate_suspected`/`needs_attention` from `pending_review`. Nothing else — never review fields, never entity, never `data_verified`/`rejected`.
- **Human review:** a FinanceOps identity is refused here outright; flags/duplicates immutable; allowed transitions only (`pending_review → data_verified|rejected|needs_attention|duplicate_suspected`, `needs_attention → pending_review|data_verified|rejected`, `duplicate_suspected → pending_review|rejected`); `data_verified`/`rejected` **four-eyes** (`created_by ≠ auth.uid()`) with `reviewed_by/at` server-set; `data_verified` requires linked bill **and** original document.
- **Referential SET NULL cascades** (draft bill/document/auth user deleted): detected by `pg_trigger_depth() > 1`; may only null the link/actor columns and change nothing else (so Stage 1B draft/document deletion and user deletion are **not** blocked by this table).

### 3.5 Audit (DB-enforced, INVOKER, fail-closed)
`financeops_intake_received` (+ `…_superseded` on the new row and `…_superseded_by` on the original), `…_entity_resolved` (before/after), `…_<review_status>` for each review transition, `…_linked_bill` / `…_linked_document` and `…_bill_link_cleared` / `…_document_link_cleared`. `entity_type = 'finance_intake'`, `entity_id` = the intake's entity (NULL while unresolved), `is_demo = false`, `data_origin = 'imported'` for integration events and `'manual'` for human ones. *Note:* audit rows for an unresolved intake have `entity_id NULL`, so under the existing `audit_logs_private_select` only the Owner and the actor can read them.

### 3.6 RLS and grants
`finance_intake_submissions`: RLS on; `REVOKE ALL` from public/anon/authenticated, then `GRANT SELECT, INSERT, UPDATE` to authenticated — **no DELETE grant** (lineage is never deleted through the API; `service_role` keeps its default privileges and is never given to FinanceOps).

| Policy | Rule |
|---|---|
| `fis_select` | active app user AND (creator **or** `entity_id IS NULL` & reviewer set **or** `entity_id IS NOT NULL` & `user_can_access_entity` & `can_view_finance`) |
| `fis_insert_integration` | `created_by = auth.uid()` AND `current_user_is_data_entry()` AND active registry row AND (`entity_id IS NULL` OR in `allowed_entity_ids`) AND `user_can_access_entity` AND status in (`pending_review`,`duplicate_suspected`). Promoting the identity to `finance_staff` makes this fail closed. |
| `fis_update_integration` | own rows, data_entry, active registry, allowed entities (column limits by trigger) |
| `fis_update_review` | resolved rows: `user_can_access_entity` AND `can_manage_bills` (this is how the **intern** data-verifies, D2) |
| `fis_update_resolve_entity` | unresolved rows: reviewer set; new entity must be accessible to the reviewer (Owner: all); also lets the set reject a junk unresolved intake |

`finance_intake_queue` view (`security_invoker`, `security_barrier`): all columns + `is_unresolved` + `is_superseded`.

## 4. Who can do what (resulting matrix)
| Action | FinanceOps (data_entry + registry) | Intern (data_entry) | Finance Staff | Finance Manager / Owner |
|---|---|---|---|---|
| Create an intake | **yes** (allowed entities only) | no | no | no |
| Read own submissions (status/replay) | yes | – | – | – |
| See an **unresolved** intake | own only | **no** | yes | yes |
| Resolve an unresolved entity | **no** | **no** | yes (entities they can access) | yes (Owner: all) |
| Reject an unresolved intake | no | no | yes | yes |
| `data_verified` / `rejected` on a resolved intake | **no** (four-eyes + refused) | yes | yes | yes |
| Delete an intake | no | no | no | no |
| `draft → unpaid` of the bill | **no** (Stage 1B trigger) | no | yes (`/api/bills/verify`) | yes |
| Create `bill_payments`, vouchers, bank, reconciliation | no | no | per Stage 1B | per Stage 1B + AAL2 |

## 5. D1–D11 traceability
D1 data_entry identity, no new role, no service role → registry + policy `current_user_is_data_entry()`; D2 intern verifies data, not payment → `data_verified` only, no effect on bill status; D3 untouched (no evidence tables); D4 four entities → CHECKs + registry trigger; D5 due-date placeholder → app/flags (no schema change to `due_date`); D6 exact-file duplicate → app logic + `duplicate_suspected`, `document_sha256` index; D7 4 MB → CHECK 4 194 304; D8 released main base; D9 HMAC unchanged; D10 both paths → resolution columns + `supersedes_intake_id` + unique/locking/triggers; D11 reviewer set → helper function and policies.

## 6. Corrections to earlier documents (made with this package)
1. **Integration identity UPDATE.** Earlier text said it "has no UPDATE right on intake rows". Insert-first idempotency needs it to advance *its own mechanical columns* (state, links, duplicate/attention flag). It now has exactly that, enforced by the trigger; it can never touch review, entity, lineage or other rows.
2. **`verified` → `data_verified`** for the intake-level state (Q1).
3. **`supersedes_intake_id` is text** referencing `intake_id` (API-aligned lineage), not a row uuid.
4. PR-0 items in the spec's headline findings are now **delivered on main**.

## 7. Security-sensitive items for explicit review
1. **Two new `SECURITY DEFINER` functions** (read-only booleans, `search_path=''`, role/EXISTS only). Alternative for the first: an inline role subquery in the policies (`app_profiles_private_read` lets a user read their own role) — saves one definer function, duplicates logic. The second cannot be inlined without the visibility gap in §3.3.
2. **Registry table** (Q2) — adds the DB-level designation and entity allow-list; without it any `can_manage_bills` user could insert forged "FinanceOps" intakes.
3. **Central visibility of unresolved intakes** (D11 literal): any Owner/Finance Manager/Finance Staff sees every unresolved intake regardless of their entity access (Q4).
4. **`pg_trigger_depth() > 1` cascade allowance** — can only null five reference columns; reachable only by a trigger-nested UPDATE, and no other trigger updates this table.
5. **No DELETE grant / no delete trigger:** `service_role`/admin could still delete; operational cleanup procedure needed (Q9).
6. **Not a hard boundary:** the in-memory rate limiter. HMAC (canonical five-line signature, unchanged) remains the integration boundary; the DB layer above is the second line.
7. **Stage 1B untouched:** no existing policy, trigger, function or table is modified; Migration A can be dropped without affecting Stage 1B (rollback §10).

## 8. Open decisions for Claire
- **Q1** Intake-level state name: `data_verified` (recommended) vs reuse "verified".
- **Q2** Approve the `finance_integration_identities` registry table (recommended) — or fall back to the spec's original "any `can_manage_bills` user may insert" (weaker).
- **Q3** Approve the two `SECURITY DEFINER` helpers (recommended) or the inline alternative for the first.
- **Q4** Unresolved-intake visibility: D11 literal (recommended; approved) vs tighter "reviewer must have access to at least one entity in the integration's allowed list".
- **Q5** Release gate: keep `draft → unpaid` independent of `data_verified` (recommended — Finance Staff+ remains the authoritative checker; Stage 1B trigger untouched) vs a DB/app gate requiring `data_verified` first for intake-originated bills.
- **Q6** Entity resolution needs **no** AAL2 (recommended; not a listed high-risk operation) — confirm.
- **Q7** Reviewers may reject a junk unresolved intake without resolving it (included) — confirm.
- **Q8** Deleting a draft bill/document linked to an intake leaves the intake with a cleared link (lineage kept) — confirm.
- **Q9** Retention: intakes are never API-deletable; who may clean up via service role, and when?

## 9. Test plan (pgTAP, disposable local stack only — after approval)
*Registry:* non-Owner cannot write; Owner without AAL2 cannot; cannot designate a non-`data_entry` or inactive user; cannot include a non-approved or unknown entity; promoting the identity to `finance_staff` makes its insert fail.
*Insert/idempotency:* non-registry `data_entry` cannot insert; identity can insert for allowed entity and for NULL entity; not for a disallowed entity; `created_by` mismatch rejected; duplicate `intake_id` conflicts; row cannot carry review/resolution/links; unresolved row with a declared code rejected; resolved row with mismatching code rejected.
*Unresolved visibility:* intern cannot select or update; `management`/`read_only` cannot; Finance Staff/Manager/Owner can; creator can read own; resolved rows visible to intern with entity access and not to others.
*Resolution:* intern cannot resolve; integration cannot resolve; Finance Staff can only to an accessible approved entity; note required; set-once; bill/document/review cannot change in the same statement; resolution after supersession rejected.
*Supersession:* new intake with `supersedes_intake_id` needs entity; second successor rejected; successor of a resolved original rejected; of a rejected original rejected; by a different identity rejected; original and audit rows preserved; concurrent resolve-vs-supersede (two sessions) — exactly one wins.
*Review:* creator/identity cannot `data_verified`/`rejected`; second identity cannot either; intern can on resolved rows; requires linked bill + original document; transitions table; terminal states frozen; flags/duplicates immutable to humans.
*Links:* bill in another entity rejected; non-draft bill rejected; document with different hash/entity rejected; set-once.
*Cascades:* deleting a linked draft bill (Owner/FM + AAL2) and a linked document (`delete_document_metadata`) succeeds and clears the link; deleting an auth user clears actor columns; nothing else changes.
*Audit:* every action above writes the expected `audit_logs` row; a failed audit insert aborts the change.
*Stage 1B regression:* existing Stage 1B pgTAP suites still pass; the FinanceOps identity still cannot `draft → unpaid`, insert `bill_payments`, or reach vouchers/bank/reconciliation.

## 10. Rollout and rollback (when approved — not now)
Order: (1) replay 0001–0018, 0020–0022 in a disposable local Supabase stack and apply Migration A; (2) pgTAP above + Stage 1B suites + Supabase advisors; (3) review outcomes with Claire; (4) only then a separately approved Production window (no `db push` before that). Manual rollback (disposable/pre-use): drop view `finance_intake_queue`; drop triggers `fis_audit_changes`, `fis_enforce_rules`, `fii_enforce_rules`; drop the five functions; drop tables `finance_intake_submissions` then `finance_integration_identities`. No existing object depends on them.

## 11. Application follow-ups (not SQL; start only after Migration A is approved/validated)
1. `schema.ts`: add `supersedes_intake_id` to the top-level allowlist **only now that persistence validates it**.
2. Handler persistence (insert-first): sign in as the registry identity (RLS applies, `created_by` = its id) → `INSERT … ON CONFLICT (intake_id) DO NOTHING` → on conflict read own row: same `payload_hash` ⇒ idempotent replay/resume by `process_state`, different ⇒ `409 intake_conflict` (never silently reuse an `intake_id` for another entity) → NULL entity ⇒ stop with `needs_entity` (no bill, no file) → exact-file duplicate check ⇒ flag `duplicate_suspected`, `409` → create **draft** bill (`payment_status='draft'`, `created_by`) → link → upload file + `documents` + `document_links` → link → `complete`. Status endpoint reads only its own row.
3. Review UI: **replace the generic entity checkbox** with a "Resolve entity" action visible only to the three reviewer roles (reuse `BILL_VERIFIER_ROLES`); keep "Data verified" visibly separate from the Stage 1B "Verify & Mark Ready for Payment"; intern sees only resolved intakes; an intake-originated draft shows its intake status.
4. Provisioning (separately approved, Production window): create the FinanceOps Auth user (`data_entry`), `user_entity_access` rows for the four entities, one registry row. Never `finance_staff`; never a service-role key to Hermes.

## 12. Confirmation
No Production database, Vercel Production, migration ledger or SQL Account was touched. No migration file exists in `supabase/migrations/` for this work. No `db push`, deployment or Auth-user provisioning occurred.
