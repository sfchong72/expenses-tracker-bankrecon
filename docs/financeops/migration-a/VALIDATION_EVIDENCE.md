# Migration A — disposable validation evidence (design-draft run)

> **Superseded for the numbered file by [`MIGRATION_0023_MANIFEST.md`](MIGRATION_0023_MANIFEST.md)**, which records the full re-validation of the exact committed `0023` file (including a second-application test, a one-shot replay comparison, and a rollback test). This document records the earlier run of the un-numbered design draft and is kept for history.

**Scope: a disposable local Supabase stack only.** No Production database, hosted project, Vercel, migration ledger, Auth provisioning or SQL Account was touched. Generated from the actual run outputs of the un-numbered design draft (`PROPOSED_migration_a_financeops_intake.sql.txt`, since numbered as 0023) on 2026-10-02.

## Environment
- Supabase CLI 2.117.0 (npm, local binary; commands used: `start`, `db reset --local`, `migration up --local`, `test db --local`, `db lint --local`, `db advisors --local`, `stop`; never `--linked`, `link`, `push`, `pull`, `--db-url`, `repair`).
- Images: `supabase/postgres:17.6.1.167`, `gotrue v2.196.0`, `storage-api v1.72.1`, `postgrest v16.2`, `kong 2.8.1`; Docker 29.7.2; Node v24.19.0.
- Disposable project id `fo-migration-a-lab` on offset ports (553xx); studio/realtime/edge-runtime/analytics/mail disabled.
- Baseline = released `origin/main` `31e84d3` migrations: 0001–0018, 0020, 0021, 0022 (0019 absent). 0022 file SHA-256 after LF normalisation `07ceb9b54d1c1ff0…` (matches the approved LF hash `07ceb9b5…0f55`); Git blob `1eadd009af9f127eabc1f371c33548ad627d7fb1`.

## 1. Final sequence console (long advisor JSON lines omitted)
> Note: the console section "advisor lines that are NEW after Migration A" shows nothing only because the advisors CLI prints a single JSON line, so a line diff is inconclusive. The authoritative, key-based advisor comparison is in §7.

```
### 0. clean replay 0001-0018, 0020, 0021, 0022 (CLI db reset)
{"target":"local","version":"","message":"Reset local database."}
history: 0001 0002 0003 0004 0005 0006 0008 0009 0010 0011 0012 0013 0014 0015 0016 0017 0018 0020 0021 0022 
0019 present in history: 0
0022 blob in lab source: 07ceb9b54d1c1ff0 (file); git blob 1eadd009af9f127eabc1f371c33548ad627d7fb1

### 1. Supabase advisors BEFORE Migration A (baseline)
exit=0
2

### 2. apply proposed Migration A (disposable only, no migration number)
Migration A applied cleanly

### 3. catalogue diff: nothing pre-existing changed
removed/changed pre-existing lines: 0
added lines: 138;  not mentioning a Migration A object: 0

### 4. Supabase advisors AFTER Migration A, db lint
exit=0
2
--- advisor lines that are NEW after Migration A:
--- (end new advisor lines)
db lint exit=0 :  No schema errors found {"results":[],"message":"db lint"} 

### 5. Migration A pgTAP
Files=1, Tests=240,  2 wallclock secs ( 0.16 usr  0.04 sys +  0.07 cusr  0.16 csys =  0.43 CPU) Result: PASS 
### 6. Stage 1B regression suites on the SAME database (with Migration A applied)
--- 0021_stage1b_preflight_security_hardening
Files=1, Tests=34,  0 wallclock secs ( 0.03 usr  0.03 sys +  0.01 cusr  0.02 csys =  0.09 CPU) Result: PASS --- 0022_stage1b_finance_security_boundary
Files=1, Tests=70,  0 wallclock secs ( 0.05 usr  0.06 sys +  0.02 cusr  0.09 csys =  0.22 CPU) Result: PASS Stage 1B fixtures loaded
--- s01_security_matrix
Files=1, Tests=16,  0 wallclock secs ( 0.03 usr  0.02 sys +  0.00 cusr  0.02 csys =  0.07 CPU) Result: PASS --- stage1a_regression
Files=1, Tests=16,  0 wallclock secs ( 0.02 usr  0.02 sys +  0.01 cusr  0.02 csys =  0.07 CPU) Result: PASS 
### 7. concurrency (two real sessions)
race fixtures committed
=== RACE 1: supersede holds the row lock; a concurrent reviewer resolution must lose
-- supersede session:
-- resolve session:
ERROR:  intake_already_resolved: the intake was superseded by a new intake
CONTEXT:  PL/pgSQL function public.enforce_finance_intake_rules() line 133 at RAISE
-- final: race_a_0001|NULL|1   successor row exists: 1
=== RACE 2: reviewer resolution holds the row lock; a concurrent supersession must lose
-- resolve session:
-- supersede session:
ERROR:  intake_already_resolved: the original intake already has an entity
CONTEXT:  PL/pgSQL function public.enforce_finance_intake_rules() line 82 at RAISE
-- final: race_b_0001|IEA|0   successor row exists: 0
=== RACE 3: two simultaneous successors for the same original: exactly one may exist
-- session A:
-- session B:
ERROR:  duplicate key value violates unique constraint "fis_supersedes_uidx"
-- final: race_c_0001|NULL|1
=== RACE 4: two identical idempotent inserts at once (ON CONFLICT DO NOTHING): exactly one row
-- rows for race_d_0001: 1   audit 'received' events: 1

FINAL SEQUENCE COMPLETE
```

## 2. Catalogue snapshot diff
Snapshot = one line per object (`kind|identifier|md5(definition)`) for policies (public/storage/auth), function bodies + SECURITY DEFINER flag + config + ACL, triggers, columns, constraints, anon/authenticated/public table grants, views (+options), RLS flags, indexes. Query: `tests/catalogue_snapshot.sql`.
- Before Migration A: 2466 lines. After: 2604 lines.
- Pre-existing lines removed or changed: **0**. Lines added: **138** (every one names a Migration A object).

## 3. Stage 1B suites
| Suite | When | Result |
|---|---|---|
| 0020 Finance baseline | at the 0020 baseline, before 0021/0022 | 66/66 PASS |
| 0021 | with Migration A applied | 34/34 PASS (also 34/34 before A) |
| 0022 | with Migration A applied, before fixtures (count-sensitive) | 70/70 PASS |
| S01–S16 matrix | with Migration A applied, after fixtures | 16/16 PASS |
| Stage 1A regression | with Migration A applied, after fixtures | 16/16 PASS |
The 0020 suite is valid only at its baseline point: on the final state it fails 8 tests (bill_payments/supplier_bills/document_links policy assertions, tests 45–47, 49–51, 53–54) because 0022 intentionally replaced those policies. It fails identically before and after Migration A (Migration A changes none of those objects — see §2).

## 4. Migration A pgTAP
`supabase/tests/0023_financeops_intake_persistence.test.sql` (then named `tests/migration_a_financeops_intake.test.sql`): **240 assertions, 240 PASS** (registry; insert/idempotency; visibility; resolution; supersession; record links; review/data_verified invariants; kill switch; FK SET NULL cascades; audit incl. fail-closed; no-delete; Stage 1B guard rails for the FinanceOps identity including a forged `aal2` claim; structure/privileges).

## 5. Two-session race checks (`tests/race_setup.sql`, `tests/race_checks.sh`)
| Race | Outcome |
|---|---|
| 1. supersede holds the row lock; reviewer resolution concurrent | resolution **fails** `intake_already_resolved: the intake was superseded by a new intake`; original stays unresolved with 1 successor |
| 2. reviewer resolution holds the lock; supersession concurrent | supersession **fails** `intake_already_resolved: the original intake already has an entity`; original resolved, 0 successors |
| 3. two simultaneous successors of one original | second **fails** on unique index `fis_supersedes_uidx`; exactly 1 successor |
| 4. two identical idempotent inserts (`ON CONFLICT DO NOTHING`) | 1 row, 1 `financeops_intake_received` audit event |

## 6. Mutation checks (each defect applied to a fresh replay; the suite must fail)
```
m01_drop_check_complete | Result: FAIL | failed_assertions=2 | aborted_on_error=0
      # Failed test 152: "declarative CHECK: data_verified => process_state = 'complete' (trigger disabled to prove the constraint itself)"
      # Failed test 239: "key constraints exist"
m02_terminal_not_frozen | Result: FAIL | failed_assertions=4 | aborted_on_error=0
      # Failed test 112: "a rejected unresolved intake cannot be resolved afterwards (terminal)"
      # Failed test 161: "terminal: a data_verified intake cannot be edited"
      # Failed test 162: "terminal: not even a Finance Manager can reject a data_verified intake"
      # Failed test 163: "terminal: the FinanceOps identity cannot touch a data_verified intake"
m03_second_identity_can_review | Result: FAIL | failed_assertions=1 | aborted_on_error=0
      # Failed test 149: "a SECOND FinanceOps identity cannot review the first one's intake"
m04_no_kill_switch_freeze | Result: FAIL | failed_assertions=2 | aborted_on_error=0
      # Failed test 166: "a deactivated identity cannot advance its own intake"
      # Failed test 167: "a deactivated identity cannot act through the human-review path either"
m05_unresolved_visible_to_all_app_users | Result: FAIL | failed_assertions=5 | aborted_on_error=0
      # Failed test 69: "int does NOT see an unresolved intake"
      # Failed test 70: "mgt does NOT see an unresolved intake"
      # Failed test 71: "ro does NOT see an unresolved intake"
      # Failed test 72: "trn does NOT see an unresolved intake"
m06_superseded_helper_always_false | Result: FAIL | failed_assertions=3 | aborted_on_error=0
      # Failed test 125: "...yet the original shows as superseded (definer helper, not RLS-hidden)"
      # Failed test 126: "a superseded intake cannot then be resolved by a reviewer"
      # Failed test 127: "helper intake_is_superseded works for finance roles (intern)"
m07_link_non_draft_bill_allowed | Result: FAIL | failed_assertions=1 | aborted_on_error=0
      # Failed test 133: "non-draft bill is rejected"
m08_no_audit_trigger | Result: FAIL | failed_assertions=18 | aborted_on_error=0
      # Failed test 130: "audit: superseded event exists"
      # Failed test 131: "audit: superseded_by event exists on the original"
      # Failed test 160: "audit: data_verified recorded"
      # Failed test 171: "audit: bill_link_cleared recorded"
m09_entity_not_set_once | Result: FAIL | failed_assertions=2 | aborted_on_error=0
      # Failed test 104: "entity resolution is set-once (cannot be changed afterwards)"
      # Failed test 105: "resolution trail is immutable"
m10_no_cascade_allowance | Result: FAIL | failed_assertions=0 | aborted_on_error=1
      ABORT: psql:/Users/USER/AppData/Local/Temp/fo-lab/supabase/tests/migration_a.test.sql:502: ERROR:  The supplier bill link can only be set once
m11_delete_granted | Result: FAIL | failed_assertions=4 | aborted_on_error=0
      # Failed test 201: "authenticated has no DELETE privilege on intakes"
      # Failed test 205: "even the Owner (AAL2) cannot delete an intake"
      # Failed test 206: "a Finance Manager (AAL2) cannot delete an intake"
      # Failed test 207: "the FinanceOps identity cannot delete an intake"
m12_registry_any_role | Result: FAIL | failed_assertions=3 | aborted_on_error=0
      # Failed test 5: "finance_staff designation is REJECTED"
      # Failed test 8: "owner designation is rejected"
      # Failed test 9: "management designation is rejected"
DONE
```
12 of 12 mutants caught (the cascade-allowance mutant aborts the suite outright, showing that rule is required).

## 7. Lint and advisors
- `supabase db lint --local --fail-on error`: no schema errors.
- Supabase advisors (`--type all --level info`): before 236 findings, after 245; removed 0; **added 9**.
```
BEFORE
INFO rls_enabled_no_policy: 1
INFO unindexed_foreign_keys: 125
INFO unused_index: 58
WARN auth_rls_initplan: 28
WARN function_search_path_mutable: 3
WARN multiple_permissive_policies: 21

AFTER
INFO rls_enabled_no_policy: 1
INFO unindexed_foreign_keys: 128
INFO unused_index: 62
WARN auth_rls_initplan: 28
WARN function_search_path_mutable: 3
WARN multiple_permissive_policies: 23
```
Added by Migration A:
- [INFO] unindexed_foreign_keys: Table 'public.finance_intake_submissions' has a foreign key 'finance_intake_submissions_entity_resolved_by_fkey' without a covering index. This can lead to suboptimal query performance.
- [INFO] unindexed_foreign_keys: Table 'public.finance_intake_submissions' has a foreign key 'finance_intake_submissions_reviewed_by_fkey' without a covering index. This can lead to suboptimal query performance.
- [INFO] unindexed_foreign_keys: Table 'public.finance_integration_identities' has a foreign key 'finance_integration_identities_created_by_fkey' without a covering index. This can lead to suboptimal query performance.
- [INFO] unused_index: Index 'fis_unresolved_idx' on table 'public.finance_intake_submissions' has not been used
- [INFO] unused_index: Index 'fis_entity_review_idx' on table 'public.finance_intake_submissions' has not been used
- [INFO] unused_index: Index 'fis_document_sha256_idx' on table 'public.finance_intake_submissions' has not been used
- [INFO] unused_index: Index 'fis_created_by_idx' on table 'public.finance_intake_submissions' has not been used
- [WARN] multiple_permissive_policies: Table 'public.finance_intake_submissions' has multiple permissive policies for role 'authenticated' for action 'UPDATE'. Policies include '{fis_update_integration,fis_update_resolve_entity,f
- [WARN] multiple_permissive_policies: Table 'public.finance_integration_identities' has multiple permissive policies for role 'authenticated' for action 'SELECT'. Policies include '{fii_owner_write,fii_select}'

No ERROR-level, no security-category and no `auth_rls_initplan` findings are added; the three pre-existing `function_search_path_mutable` WARNs are unchanged. The remaining additions are performance-class and accepted for Phase 1 (see the review package §8).
