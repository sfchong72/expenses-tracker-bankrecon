# FinanceOps Phase 1A — Migration A review package (v2: decisions applied, disposable validation passed)

**Status: READY FOR OWNER APPROVAL TO NUMBER. Not numbered. Not applied to Production. Not deployed.** The SQL is [`PROPOSED_migration_a_financeops_intake.sql.txt`](PROPOSED_migration_a_financeops_intake.sql.txt) — un-numbered, `.sql.txt`, deliberately outside `supabase/migrations/`. Tests and evidence: [`tests/`](tests/) and [`VALIDATION_EVIDENCE.md`](VALIDATION_EVIDENCE.md). Design authority: `FINANCEOPS_HUB_PHASE1_IMPLEMENTATION_SPEC.md` and `FINANCEOPS_PHASE1_CLAUDE_HANDOVER.md` (D1–D11 preserved).

Base: released `origin/main` = `31e84d3d56cf1ee8ed047ea2873147fa71119cf3` (Stage 1B complete). Migration `0022` blob `1eadd009af9f127eabc1f371c33548ad627d7fb1` unchanged.

---

## 1. Owner decisions Q1–Q9 — how each is applied

| Q | Decision | Where / how applied |
|---|---|---|
| Q1 | Intake status is `data_verified`, never `verified`; Stage 1B "Verify & Mark Ready for Payment" remains the separate `draft → unpaid` | `review_status` CHECK; UI label "Mark data verified"; spec §11 renamed |
| Q2 | Keep `finance_integration_identities`; identity must remain `data_entry`, never `finance_staff`; kill switch; approved entities; Owner + AAL2 administration | table + `enforce_finance_integration_identity()` + `fii_owner_write` policy; insert policy additionally requires the caller to *currently* be `data_entry` (promotion fails closed — tested) |
| Q3 | Keep the two `SECURITY DEFINER` helpers, `search_path = ''`, narrow and read-only | `current_user_can_review_unresolved_intakes()`, `intake_is_superseded(text)` (the latter narrowed to finance roles during review) |
| Q4 | D11-literal central visibility of unresolved intakes: Owner, Finance Manager, Finance Staff only | `fis_select` branch `entity_id IS NULL`; tested for 12 roles/identities |
| Q5 | **Modified:** no universal DB gate; Stage 1B trigger/policy untouched; the gate for FinanceOps-originated bills is **application-only** | nothing in the SQL; see §7 for the required application behaviour |
| Q6 | Entity resolution needs no AAL2 | `fis_update_resolve_entity` has no AAL2 term; tested with Finance Manager at `aal1` |
| Q7 | Reject an invalid unresolved intake without an entity | `fis_update_resolve_entity` WITH CHECK allows `entity_id IS NULL`; trigger allows `rejected`; tested |
| Q8 | Supported deletion of a linked draft bill/document clears only the link; intake and lineage preserved | `ON DELETE SET NULL` + cascade branch in the row trigger; audit `…_link_cleared`; tested (see note) |
| Q9 | Intakes not API-deletable; no service-role cleanup path; lineage retained | no DELETE grant/policy; tested for Owner, Finance Manager, FinanceOps, anon |

**Q8 note (found during validation).** After 0022 there is **no user-level path to delete a draft Supplier Bill** (policy `supplier_bills_draft_delete` dropped, `DELETE` revoked, no bill RPC). The supported *document* deletion RPC `delete_document_metadata` does exist and is tested; bill-link clearing is tested via administrative deletion, which is the only way it can occur today (or via a future bill-delete control).

## 2. Added invariant: `data_verified` ⇒ `process_state = 'complete'`

Declarative CHECK `fis_data_verified_needs_complete` (`review_status <> 'data_verified' OR process_state = 'complete'`), kept alongside `fis_data_verified_needs_review` (entity set + `reviewed_at`). The row trigger still requires, as defence in depth: entity resolved, linked draft bill, linked original document (same entity, matching SHA-256), `process_state = 'complete'`, and sets `reviewed_by`/`reviewed_at` server-side. Proven independently of the trigger: a test disables the trigger inside a rolled-back transaction and shows the CHECK alone rejects the update; the mutation that removes the CHECK fails the suite.

## 3. Registry trigger vs `app_profiles` RLS (checked against Stage 1B policies, not assumed)

`app_profiles_private_read` (0022): `current_user_has_eligible_role() AND (id = auth.uid() OR current_user_is_owner())`. The Owner can therefore read the designated user's profile, so the **SECURITY INVOKER** trigger `enforce_finance_integration_identity()` reliably validates "active, role = `data_entry`" when an Owner + AAL2 administrator writes the registry — the only writer the registry policy permits. `postgres`/`service_role` bypass RLS. Verified by tests (the Owner sees the target profile; a Finance Manager cannot). A non-owner writer is stopped by the policy, but the BEFORE trigger fires first and reports "must be an active data_entry user" rather than an RLS message — cosmetic only. **No change to `SECURITY DEFINER` is required.**

## 4. Exact proposed objects (all new; nothing existing is altered)

**Tables**
- `public.finance_integration_identities`: `user_id` PK → `auth.users` (CASCADE); `integration` (= `'financeops'`); `active_status`; `allowed_entity_ids uuid[]` (1–4; trigger: only IEA/IETA/PLC/KALER, no duplicates); `note`, `created_by`, `created_at`, `updated_at`.
- `public.finance_intake_submissions`: `id` PK; `intake_id` text UNIQUE (`^[A-Za-z0-9_-]{8,64}$`); `payload_hash`; `integration_key_id`, `request_id`; `source`, `payload` jsonb (≤ 64 KB); `entity_code_declared`; **`entity_id` NULLABLE**; `supplier_bill_id`, `document_id` (SET NULL); `document_sha256`, `document_mime_type` (pdf/jpeg/png), `document_filename`, `document_size_bytes` (1…4 194 304); `flags text[]`, `duplicate_matches jsonb`; `process_state` (`received`, `awaiting_entity`, `bill_created`, `document_attached`, `complete`); `review_status` (`pending_review`, `data_verified`, `rejected`, `duplicate_suspected`, `needs_attention`); `review_note`, `reviewed_by`, `reviewed_at`; `entity_resolved_by`, `entity_resolved_at`, `entity_resolution_note`; **`supersedes_intake_id`** (text, self-FK to `intake_id`, ON DELETE RESTRICT); `created_by`, `created_at`, `updated_at`.

**Constraints:** formats/enums as above; `fis_no_records_without_entity` (no bill/file while entity NULL); `fis_awaiting_entity_state` (`entity_id IS NULL` ⇔ `awaiting_entity`); `fis_data_verified_needs_review`; **`fis_data_verified_needs_complete`**; `fis_resolution_note_pair` / `_length`; `fis_no_self_supersede`; `fis_supersede_has_entity`.
**Indexes:** unique `intake_id`; unique partial `supersedes_intake_id` (**one successor**), `supplier_bill_id`, `document_id`; `(created_at) WHERE entity_id IS NULL`; `(entity_id, review_status, created_at DESC)`; `document_sha256`; `created_by`.

**Functions** — `app_private.current_user_can_review_unresolved_intakes()` (STABLE, DEFINER), `app_private.intake_is_superseded(text)` (VOLATILE, DEFINER, finance roles only), and three SECURITY INVOKER trigger functions: `public.enforce_finance_intake_rules()`, `public.audit_finance_intake_change()`, `public.enforce_finance_integration_identity()` (revoked from public/anon/authenticated).
**Triggers** — `fii_enforce_rules`, `fis_enforce_rules` (BEFORE INSERT/UPDATE), `fis_audit_changes` (AFTER INSERT/UPDATE).
**RLS** — enabled on both tables. Policies: `fii_select`, `fii_owner_write` (Owner + AAL2); `fis_select`, `fis_insert_integration`, `fis_update_integration`, `fis_update_review`, `fis_update_resolve_entity`. Grants: `SELECT, INSERT, UPDATE` on intakes (**no DELETE**); anon revoked everywhere. All policy `auth.uid()` calls are wrapped as `(select auth.uid())`.
**View** — `public.finance_intake_queue` (`security_invoker`, `security_barrier`; adds `is_unresolved`, `is_superseded`).
**Audit (database-enforced, INVOKER, fail-closed)** — `financeops_intake_received`, `…_superseded`, `…_superseded_by`, `…_entity_resolved`, `…_<review_status>`, `…_linked_bill`, `…_linked_document`, `…_bill_link_cleared`, `…_document_link_cleared`.

Row-trigger behaviour is unchanged from v1 of this package except for the review changes listed in §5; see the SQL comments for each rule.

## 5. What the static review and validation changed (all re-validated)

| # | Finding | Resolution |
|---|---|---|
| 1 | `ON DELETE SET NULL` cascades (document/bill/auth-user deletion) would trip the "set once"/immutability rules, and `auth.uid()` is NULL for admin-driven cascades | Row trigger detects the nested referential update (`pg_trigger_depth() > 1`) and allows only NULLing five reference columns, changing nothing else. Mutation without it breaks the suite (abort). |
| 2 | A second registered FinanceOps identity could review the first one's intakes through the human path | Human-review branch refuses any registry identity |
| 3 | A *rejected* unresolved intake could still be *resolved* (frozen-state check ran after the resolution branch) | Terminal-state freeze moved first |
| 4 | A deactivated FinanceOps identity fell through to the human path and could keep advancing its rows | Kill-switch freeze rule |
| 5 | `intake_is_superseded` was callable by every app role (existence oracle) | Restricted to finance roles; tested (trainer gets FALSE) |
| 6 | Reviewers could not reject unresolved junk without assigning an entity | Q7 path added |
| 7 | `data_verified` could coexist with `bill_created`/`document_attached` | New CHECK + trigger rule (§2) |
| 8 | `auth_rls_initplan` advisor warnings on four new policies | `(select auth.uid())` |
| 9 | **Validation:** documents RLS exposes a document only through a `document_links` row, and the trigger reads the document as the caller | Application ordering requirement (§7) |
| 10 | **Validation:** BEFORE triggers fire before RLS `WITH CHECK`, so some denials carry trigger messages | Cosmetic; tests accept either denial source |
| 11 | Resolution to an inaccessible entity reported "approved entities" (RLS hides the entity row) | Message clarified |
| 12 | **Validation:** no user-level draft-bill delete exists after 0022 | Q8 note (§1) |

## 6. Disposable validation (summary; full evidence in `VALIDATION_EVIDENCE.md`)

| Check | Result |
|---|---|
| Replay 0001–0018, 0020, 0021, 0022 (CLI `db reset`), 0019 absent, 0022 content hash matches the approved LF hash | PASS |
| Migration A applied (fresh, no migration number) | PASS, no errors |
| Catalogue snapshot diff (policies, function bodies/ACLs, triggers, columns, constraints, grants, views, RLS flags, indexes) | **0 existing objects changed or removed**; 138 added, all Migration A |
| Migration A pgTAP (registry, insert/idempotency, visibility, resolution, supersession, links, review, kill switch, cascades, audit incl. fail-closed, no-delete, Stage 1B guard rails incl. forged `aal2`, structure) | **240 / 240 PASS** |
| Stage 1B suites with Migration A applied: 0021 / 0022 / S01–S16 matrix / Stage 1A regression | **34/34, 70/70, 16/16, 16/16 PASS** |
| 0020 suite | 66/66 at its own baseline point; fails 8 tests after 0022 *by design*, identically before and after A |
| Two-session race checks | resolve-vs-supersede: **exactly one wins in both orders** (loser: `intake_already_resolved`); two successors: unique index; concurrent identical insert: one row, one audit event |
| Mutation checks (12 deliberate defects: CHECK removed, terminal freeze, second-identity review, kill switch, unresolved visibility widened, supersede helper stubbed, non-draft link, audit trigger, entity set-once, cascade allowance, DELETE granted, registry any-role) | **12 / 12 caught** |
| `supabase db lint --local --fail-on error` | PASS |
| Supabase advisors (security + performance) | Migration A adds **9** findings: 7 INFO (FK/unused index on an empty DB) and 2 WARN `multiple_permissive_policies` (inherent to the three UPDATE paths); **0 ERROR, 0 security-class, 0 `auth_rls_initplan`**; the 3 pre-existing `function_search_path_mutable` warnings are unchanged |

## 7. Q5 application follow-up (required when the Review UI/API is built — NOT implemented now)

- **`/api/bills/verify` or its caller must detect whether the draft Supplier Bill is linked to a FinanceOps intake** (`finance_intake_submissions.supplier_bill_id = <bill id>`).
  - **Linked:** require `review_status = 'data_verified'` before the application permits `draft → unpaid` ("Verify & Mark Ready for Payment"). Otherwise refuse with a clear message.
  - **Not linked:** preserve the normal Stage 1B manual-bill behaviour unchanged.
- Do **not** implement this in Migration A or by altering the Supplier Bill policy/trigger.
- `data_verified` itself never changes `supplier_bills.payment_status`.
- Accepted limit of an application-level gate: a Finance Staff-or-higher user acting directly against the database (not through the app) can still release such a bill. The audit trail shows the intake; reviewers are trusted finance roles.
- Required flow: FinanceOps intake → entity resolved if required → draft bill → original document attached → human data review → `data_verified` → Finance Staff / Finance Manager / Owner → `draft → unpaid` → normal PV/payment workflow.

Other application requirements: persistence order = insert intake → create draft bill (`payment_status='draft'`, `created_by` = the identity) → upload file + `documents` + **`document_links` to the same-entity bill** → update the intake links (the row trigger reads the document as the caller) → `complete`; add `supersedes_intake_id` to the request schema only once persistence validates it; replace the generic entity checkbox with a Finance Staff-or-higher "Resolve entity" action; keep "Mark data verified" visibly separate from "Verify & Mark Ready for Payment".

## 8. Remaining risks and open decisions

**No Q1–Q9 decision remains open.** Remaining risks (none blocks numbering):
1. **Central unresolved visibility (Q4, accepted):** any Owner/Finance Manager/Finance Staff sees every unresolved intake regardless of entity access.
2. **Q5 gate is application-level (decision):** see §7.
3. **`data_entry` identity is still broader than ideal (D1, transitional):** Migration A constrains *intake rows*, not what the same identity may do to `supplier_bills` under Stage 1B RLS (it can create/maintain draft bills in its entities). Controls: Hub exposes only narrow operations; never `draft → unpaid`; no payments/vouchers/bank/reconciliation (all re-verified, including with a forged `aal2` claim).
4. **Cascade allowance** (`pg_trigger_depth() > 1`) is reachable only by a trigger-nested UPDATE; nothing else updates this table; limited to nulling five reference columns.
5. **Performance advisors accepted for Phase 1:** two `multiple_permissive_policies` WARNs and a few unindexed-FK INFOs (low volume). Option later: merge the three UPDATE policies or add FK indexes.
6. **Personal data in audit payloads** (Telegram chat/message ids) — same sensitivity class as existing finance audit rows.
7. **Not run:** Production-volume/performance testing; hosted-Supabase version differences (the lab uses the local Postgres 17.6 image; the preflight requires ≥ 15 — confirm the hosted version at approval time); `service_role` bypasses everything and must never reach Hermes.
8. The in-memory rate limiter is **not** a hard boundary; the five-line canonical HMAC remains the integration boundary, unchanged.

**Decisions needed only to proceed:** (a) approve numbering Migration A (next free number after 0022) and moving the SQL to `supabase/migrations/` and the pgTAP file to `supabase/tests/`; (b) confirm the application follow-ups in §7 are the next work item.

## 9. How to reproduce (local only; no hosted project, no `--linked`, no `db push`)
1. Disposable folder with `supabase init`, ports offset, studio/realtime/edge-runtime/analytics/mail disabled; copy 0001–0018, 0020 into `supabase/migrations/`, `supabase start`; run `supabase test db --local` on the 0020 suite; add 0021, `supabase migration up --local`, run its suite; add 0022 likewise (run the 0022 suite **before** loading Stage 1B fixtures — it is count-sensitive).
2. Snapshot the catalogue, apply the proposed SQL with `psql` (no migration number), snapshot again and diff.
3. Run `tests/migration_a_financeops_intake.test.sql` with `supabase test db --local`; then `tests/race_setup.sql` and `tests/race_checks.sh` (set `DBC` to the disposable db container).
4. Run `supabase db advisors --local` and `supabase db lint --local` before and after.
5. `supabase stop --no-backup`, delete the disposable folder.

## 10. Confirmation
No Production database, Vercel Production, migration ledger, Supabase hosted project, Auth user provisioning or SQL Account was touched. No file exists in `supabase/migrations/` for this work. No `db push`, deployment or merge occurred.
