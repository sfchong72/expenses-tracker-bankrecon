# Migration 0023 — immutable candidate manifest and exact-file validation

**Status: NUMBERED CANDIDATE. Immutable. Validated as this exact committed file in a disposable local stack. NOT applied to Production. NOT deployed. No application persistence started.**
Owner approval (2026-10-02): numbering as 0023 approved on condition that this exact numbered file passes the full disposable validation again before any application persistence or Production consideration. That condition is met by the results below. The next gate is the owner's decision — not Production deployment.

## 1. Identity (verify these before any environment ever applies it)
| Item | Value |
|---|---|
| Path | `supabase/migrations/0023_financeops_intake_persistence.sql` (filename ledger name `financeops_intake_persistence`) |
| Introduced by commit | `46f10a269337de8aa00ee9c4b07f8479e44ee73c` on branch `claude/financeops-phase1-prep` |
| Base | released `origin/main` `31e84d3d56cf1ee8ed047ea2873147fa71119cf3` (Stage 1B complete) |
| **Git blob id** (platform independent; preferred) | `b1a477448c1529a12fddd32f4822e2e809e39bc7` |
| **SHA-256 of the LF content** | `c4d76c10b646baf93fdaccf7c2ba751547e0d4d94b2c22eb994bc0784a41fca8` |
| SHA-256 of the CRLF form (Windows `core.autocrlf=true` checkout) | `92a3f0eb923b8e135b249c37dfd42630d7d02c87574d59d70f3748a5bc9a7c99` |
| Size / lines (LF) | 40770 bytes / 765 lines |
| Companion pgTAP suite | `supabase/tests/0023_financeops_intake_persistence.test.sql` — blob `a80c8a3db2cd028f7db66a93e19f53812a12df4b`, SHA-256 (LF) `3eca15ca034df2759901f457db7afe6a819a6b23b50ce2ec4fd613d29d981a7b` |
| Manual rollback (not a migration) | `docs/financeops/migration-a/ROLLBACK_0023_manual.sql.txt` — SHA-256 (LF) `dd17fecfeb150d6072d0c996808fbf6e71f17e9fb1217ae68bd2f97c6123698b` |

Verify (no dependence on line endings or working-tree state):
```
git rev-parse 46f10a269337de8aa00ee9c4b07f8479e44ee73c:supabase/migrations/0023_financeops_intake_persistence.sql                          # must print b1a477448c1529a12fddd32f4822e2e809e39bc7
git show 46f10a269337de8aa00ee9c4b07f8479e44ee73c:supabase/migrations/0023_financeops_intake_persistence.sql | tr -d '\r' | sha256sum     # must print c4d76c10b646baf93fdaccf7c2ba751547e0d4d94b2c22eb994bc0784a41fca8
```
**Immutability rule:** this file must never be edited after this commit. Any change is a NEW migration (0024 or later). The validation harness aborted unless the file it replayed matched the blob and SHA-256 above, and re-checked both at the end of the run.

## 2. What was validated (exact committed file, fresh disposable stack)
| Check | Result |
|---|---|
| Sources are the committed git objects; blob + SHA-256 match; 0019 absent | PASS |
| Staged canonical replay 0001–0018, 0020 (0020 suite 66/66), 0021 (34/34), 0022 | PASS |
| 0023 applied **through the CLI migration mechanism**; ledger row `0023 / financeops_intake_persistence`; history 0001…0022, 0023 | PASS |
| Catalogue diff (policies, function bodies/ACLs, triggers, columns, constraints, grants, views, RLS flags, indexes) | **0 existing objects changed/removed; 138 added, all 0023's** |
| 0023 pgTAP (`supabase/tests/0023_financeops_intake_persistence.test.sql`) | **240/240 PASS** |
| Stage 1B regression with 0023 applied: 0021 / 0022 / S01–S16 matrix / Stage 1A regression | **34/34, 70/70, 16/16, 16/16 PASS** |
| **Second application of 0023** | fails safely at preflight (`0023 preflight failed: an object it creates already exists`); catalogue unchanged |
| Two-session race checks (resolve-vs-supersede both orders, two successors, concurrent idempotent insert) | exactly one wins each time; see §3 |
| **One-shot full replay** (`db reset` applies 0001–0023 from the migrations folder) | history 0001…0023; catalogue **identical** to the staged route; 0023 suite 240/240 again |
| **Manual rollback** (`ROLLBACK_0023_manual.sql.txt`) | catalogue **identical to pre-0023** (0 diff lines); 0023 re-applies and the catalogue is identical to the original post-0023 |
| Mutation checks on the committed file (12 deliberate defects) | **12 / 12 caught** |
| `supabase db lint --local --fail-on error` | PASS |
| Supabase advisors | **+9 findings: 7 INFO, 2 WARN (multiple_permissive_policies, performance); 0 ERROR, 0 security-class, 0 auth_rls_initplan**; 3 pre-existing search-path WARNs unchanged |

## 3. Race outcomes
- Race 1 (supersede holds lock; resolution concurrent): resolution fails `intake_already_resolved: the intake was superseded by a new intake`; original stays unresolved with 1 successor.
- Race 2 (resolution holds lock; supersession concurrent): supersession fails `intake_already_resolved: the original intake already has an entity`; original resolved, 0 successors.
- Race 3 (two simultaneous successors): second fails on unique index `fis_supersedes_uidx`; exactly 1 successor.
- Race 4 (two identical idempotent inserts): 1 row, 1 `financeops_intake_received` audit event.

## 4. Environment
Supabase CLI 2.117.0 (local binary; `start`, `db reset --local`, `migration up --local`, `test db --local`, `db lint --local`, `db advisors --local`, `stop`; never `--linked`, `link`, `push`, `pull`, `--db-url`, `repair`). Images `supabase/postgres:17.6.1.167`, `gotrue v2.196.0`, `storage-api v1.72.1`, `postgrest v16.2`, `kong 2.8.1`; Docker 29.7.2; Node v24.19.0. The stack and its volumes were stopped and deleted afterwards (no containers/volumes remain).

## 5. Operational notes for a future, separately approved Production window (not scheduled)
- The file starts with a preflight that **fails rather than overwrites** (PostgreSQL ≥ 15, Stage 1B markers present, none of its objects present) and sets `lock_timeout = 5s`, `statement_timeout = 2min`.
- It creates only new objects and takes no long locks on existing tables (no change to `supplier_bills`, `documents`, `document_links`, Storage, payments, vouchers, claims, bank, reconciliation). Foreign keys reference existing tables, which take brief `SHARE ROW EXCLUSIVE` locks only at creation.
- Confirm the hosted PostgreSQL major version (≥ 15) before approval; the lab ran 17.6.
- Rollback is valid only while 0023 is unused; it destroys intakes and registry rows.

## 6. Not done / still gated
Production application of 0023; application persistence (insert-first handler, `supersedes_intake_id` in the request schema, status endpoint, "Resolve entity" UI, Q5 gate in `/api/bills/verify`); provisioning the FinanceOps Auth user, `user_entity_access` rows and the registry row. None has started.

## 7. Evidence (from the run; long advisor JSON lines omitted)
```
### A. exact-file integrity (sources are the COMMITTED git objects)
git blob (HEAD:0023)      : b1a477448c1529a12fddd32f4822e2e809e39bc7   expected b1a477448c1529a12fddd32f4822e2e809e39bc7
sha256 LF of lab 0023 file: c4d76c10b646baf93fdaccf7c2ba751547e0d4d94b2c22eb994bc0784a41fca8
expected                  : c4d76c10b646baf93fdaccf7c2ba751547e0d4d94b2c22eb994bc0784a41fca8
INTEGRITY OK: lab 0023 == committed candidate
0019 staged? 0

### B. staged canonical replay
history: 0001 0002 0003 0004 0005 0006 0008 0009 0010 0011 0012 0013 0014 0015 0016 0017 0018 0020 
--- 0020 suite (valid at this baseline; expect 66)
Files=1, Tests=66,  0 wallclock secs ( 0.06 usr  0.02 sys +  0.01 cusr  0.04 csys =  0.13 CPU) Result: PASS {"applied":["C:\\Users\\USER\\AppData\\Local\\Temp\\fo-lab\\supabase\\migrations\\0021_stage1b_preflight_security_harden
--- 0021 suite (expect 34)
Files=1, Tests=34,  0 wallclock secs ( 0.01 usr  0.02 sys +  0.01 cusr  0.01 csys =  0.05 CPU) Result: PASS {"applied":["C:\\Users\\USER\\AppData\\Local\\Temp\\fo-lab\\supabase\\migrations\\0022_stage1b_finance_security_boundary
history@0022: 0001 0002 0003 0004 0005 0006 0008 0009 0010 0011 0012 0013 0014 0015 0016 0017 0018 0020 0021 0022 
snapshot pre-0023 lines: 2466

### C. apply 0023 THROUGH THE CLI MIGRATION MECHANISM (ledger entry)
Applying migration 0023_financeops_intake_persistence.sql...
{"applied":["C:\\Users\\USER\\AppData\\Local\\Temp\\fo-lab\\supabase\\migrations\\0023_financeops_intake_persistence.sql"],"message":"Migrations applied"}
history@0023: 0001 0002 0003 0004 0005 0006 0008 0009 0010 0011 0012 0013 0014 0015 0016 0017 0018 0020 0021 0022 0023 
ledger row: 0023 / financeops_intake_persistence
catalogue: before 2466 / after 2604; pre-existing lines removed/changed: 0
added: 138; not naming a 0023 object: 0
advisors exit=0
db lint exit=0 : No schema errors found {"results":[],"message":"db lint"} 

### D. 0023 pgTAP (the committed file) and Stage 1B regression on the same DB
--- 0023 suite (expect 240)
Files=1, Tests=240,  1 wallclock secs ( 0.10 usr  0.01 sys +  0.03 cusr  0.09 csys =  0.23 CPU) Result: PASS --- 0021 suite
Files=1, Tests=34,  1 wallclock secs ( 0.04 usr  0.01 sys +  0.01 cusr  0.01 csys =  0.07 CPU) Result: PASS --- 0022 suite (before fixtures)
Files=1, Tests=70,  1 wallclock secs ( 0.05 usr  0.02 sys +  0.02 cusr  0.02 csys =  0.11 CPU) Result: PASS Stage 1B fixtures loaded
--- S01-S16 matrix
Files=1, Tests=16,  1 wallclock secs ( 0.02 usr  0.01 sys +  0.01 cusr  0.01 csys =  0.05 CPU) Result: PASS --- Stage 1A regression
Files=1, Tests=16,  0 wallclock secs ( 0.02 usr  0.00 sys +  0.00 cusr  0.01 csys =  0.03 CPU) Result: PASS 
### E. second application of 0023 must fail safely at preflight and change nothing
exit=3 : ERROR:  0023 preflight failed: an object it creates already exists
catalogue unchanged by the failed re-apply: YES

### F. two-session race checks
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

### G. one-shot full replay (db reset applies 0001-0023 from the migrations folder)
{"target":"local","version":"","message":"Reset local database."}
history: 0001 0002 0003 0004 0005 0006 0008 0009 0010 0011 0012 0013 0014 0015 0016 0017 0018 0020 0021 0022 0023 
one-shot replay catalogue identical to staged route: YES
--- 0023 suite on the one-shot replay
Files=1, Tests=240,  1 wallclock secs ( 0.11 usr  0.01 sys +  0.04 cusr  0.10 csys =  0.26 CPU) Result: PASS 
### H. manual rollback restores the exact pre-0023 catalogue (and 0023 re-applies)
rollback applied
catalogue identical to pre-0023: YES  (diff lines: 0)
0023 re-applied after rollback
catalogue identical to the original post-0023: YES

### I. mutation checks against the COMMITTED file (baseline 0001-0022, mutant applied by psql)
12 mutants of the committed 0023 written
m01_drop_check_complete | Result: FAIL | failed_assertions=2 | aborted_on_error=0
m02_terminal_not_frozen | Result: FAIL | failed_assertions=4 | aborted_on_error=0
m03_second_identity_can_review | Result: FAIL | failed_assertions=1 | aborted_on_error=0
m04_no_kill_switch_freeze | Result: FAIL | failed_assertions=2 | aborted_on_error=0
m05_unresolved_visible_to_all_app_users | Result: FAIL | failed_assertions=5 | aborted_on_error=0
m06_superseded_helper_always_false | Result: FAIL | failed_assertions=3 | aborted_on_error=0
m07_link_non_draft_bill_allowed | Result: FAIL | failed_assertions=1 | aborted_on_error=0
m08_no_audit_trigger | Result: FAIL | failed_assertions=18 | aborted_on_error=0
m09_entity_not_set_once | Result: FAIL | failed_assertions=2 | aborted_on_error=0
m10_no_cascade_allowance | Result: FAIL | failed_assertions=0 | aborted_on_error=1
m11_delete_granted | Result: FAIL | failed_assertions=4 | aborted_on_error=0
m12_registry_any_role | Result: FAIL | failed_assertions=3 | aborted_on_error=0
mutants caught: 12 of 12

### J. candidate unchanged
git blob now: b1a477448c1529a12fddd32f4822e2e809e39bc7 (expected b1a477448c1529a12fddd32f4822e2e809e39bc7)
worktree 0023 tracked change: 0
VALIDATION SEQUENCE COMPLETE
```

### Advisors (key-based diff of findings)
```
BEFORE (236)
INFO rls_enabled_no_policy: 1
INFO unindexed_foreign_keys: 125
INFO unused_index: 58
WARN auth_rls_initplan: 28
WARN function_search_path_mutable: 3
WARN multiple_permissive_policies: 21

AFTER (245)
INFO rls_enabled_no_policy: 1
INFO unindexed_foreign_keys: 128
INFO unused_index: 62
WARN auth_rls_initplan: 28
WARN function_search_path_mutable: 3
WARN multiple_permissive_policies: 23
```
Added by 0023 (9):
- [INFO] unindexed_foreign_keys: Table 'public.finance_intake_submissions' has a foreign key 'finance_intake_submissions_entity_resolved_by_fkey' without a covering index. This can lead to suboptimal que
- [INFO] unindexed_foreign_keys: Table 'public.finance_intake_submissions' has a foreign key 'finance_intake_submissions_reviewed_by_fkey' without a covering index. This can lead to suboptimal query perf
- [INFO] unindexed_foreign_keys: Table 'public.finance_integration_identities' has a foreign key 'finance_integration_identities_created_by_fkey' without a covering index. This can lead to suboptimal que
- [INFO] unused_index: Index 'fis_unresolved_idx' on table 'public.finance_intake_submissions' has not been used
- [INFO] unused_index: Index 'fis_entity_review_idx' on table 'public.finance_intake_submissions' has not been used
- [INFO] unused_index: Index 'fis_document_sha256_idx' on table 'public.finance_intake_submissions' has not been used
- [INFO] unused_index: Index 'fis_created_by_idx' on table 'public.finance_intake_submissions' has not been used
- [WARN] multiple_permissive_policies: Table 'public.finance_intake_submissions' has multiple permissive policies for role 'authenticated' for action 'UPDATE'. Policies include '{fis_update_integration,fis_upd
- [WARN] multiple_permissive_policies: Table 'public.finance_integration_identities' has multiple permissive policies for role 'authenticated' for action 'SELECT'. Policies include '{fii_owner_write,fii_select
