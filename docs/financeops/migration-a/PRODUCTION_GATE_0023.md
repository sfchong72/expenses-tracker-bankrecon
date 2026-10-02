# Production gate package — migration 0023 (database foundation ONLY)

**Status: PREPARED FOR CLAIRE'S APPROVAL. NOTHING HAS BEEN APPLIED TO PRODUCTION. The release branch has NOT been pushed or merged. Claude does not hold Production database credentials and will not execute any step below.**

## 0. Read first — four findings that affect this release
1. **The source commit is a rename, so the cherry-pick conflicted (resolved mechanically).** `46f10a2` moved the files from `docs/financeops/migration-a/…` (which exist only on the prep branch) into `supabase/…`. Cherry-picking it onto `main` therefore raised four rename/delete + modify/delete conflicts. I resolved them only by staging the two files exactly as Git left them (the commit's own versions); no byte was edited or recreated. Proof: both files hash to the expected Git blobs, "theirs" (stage 3) equalled those blobs before resolution, and the resulting branch differs from `main` by exactly those two files.
2. **A harness bug in my own first release run was caught and corrected.** The first replay silently used the prep worktree (a path override), as its printed HEAD `2f223f8` revealed. I discarded it and re-ran with the release worktree asserted (branch + full HEAD checked before anything ran). Only the corrected run is reported here.
3. **Merging to `main` may itself apply 0023 to Production — this must be confirmed in the Supabase dashboard before any merge.** The Production project has a Supabase *branch record* for `main` (created 2026-09-08, status `FUNCTIONS_DEPLOYED`, no preview branches), which is the shape left when **Branching / the GitHub integration** is enabled. If "deploy to production" is on, a merge of a migration to the production git branch applies it automatically. The repo has no CI/automation files, and this setting is not visible through the API. Until it is confirmed OFF, treat the merge as the Production apply (§16).
4. **Production was read once, read-only, as you instructed.** Only project metadata, the branch list and the migration ledger were listed (no SQL executed, no writes). Result: ledger ends at 0022 exactly as expected; hosted PostgreSQL is **17.6** (the migration's preflight needs ≥ 15).

## 1–5. Identity
| # | Item | Value |
|---|---|---|
| 1 | Release branch | `agent/financeops-0023-release` (local worktree `.claude/worktrees/financeops-0023-release`; not pushed) |
| 2 | Release HEAD | `a1dbe11f94298347125ff7aa3e13d3fdb81bbb1f` — cherry-pick of `46f10a269337de8aa00ee9c4b07f8479e44ee73c` (`-x` provenance line in the message) |
| 3 | Base `main` | `a1dbe11f94298347125ff7aa3e13d3fdb81bbb1f` (= current `origin/main`; Production application stays here) |
| 4 | **0023 Git blob** | `b1a477448c1529a12fddd32f4822e2e809e39bc7` |
| 5 | **0023 SHA-256 (LF)** | `c4d76c10b646baf93fdaccf7c2ba751547e0d4d94b2c22eb994bc0784a41fca8` |
| – | SHA-256 of the Windows checkout (CRLF form) | `92a3f0eb923b8e135b249c37dfd42630d7d02c87574d59d70f3748a5bc9a7c99` |
| – | Companion pgTAP suite | blob `a80c8a3db2cd028f7db66a93e19f53812a12df4b`, SHA-256 (LF) `3eca15ca034df2759901f457db7afe6a819a6b23b50ce2ec4fd613d29d981a7b` |
| – | Rollback file (not a migration) | `docs/financeops/migration-a/ROLLBACK_0023_manual.sql.txt` on the prep branch, SHA-256 (LF) `dd17fecfeb150d6072d0c996808fbf6e71f17e9fb1217ae68bd2f97c6123698b` |
The release branch contains **exactly one commit above `main` and exactly two added files**: the migration and its pgTAP suite. No app, middleware, auth, Stage 1B, package or docs file is touched.

## 6. Migration-ledger pre-state (read from Production on 2026-10-02, read-only)
Exactly these 20 rows, nothing else (note: no 0007 and no 0019 — both intentionally absent):
```
0001 init
0002 phase1_foundation
0003 auth_lockdown
0004 phase2_supplier_bills
0005 phase2_usability_vouchers_and_demo_data
0006 supplier_recurring_imports
0008 import_batch_management
0009 phase3a_bank_import_reconciliation
0010 phase3a_bank_reconciliation_policies
0011 staff_director_claims
0012 staff_trial_feedback
0013 operations_hub_foundation
0014 student_master_programmes_enrolments
0015 stage1a_uat_repairs
0016 stage1a_save_draft_enrolment_numbering
0017 stage1a_enrolment_rpc_permissions
0018 stage1a_student_import_and_enrolment_fix
0020 phase2_finance_baseline_reconciliation
0021 stage1b_preflight_security_hardening
0022 stage1b_finance_security_boundary
```
Hosted database: PostgreSQL 17.6 (project `expenses-tracker-bankrecon`, ref `gjmvqnkzhfuuntutxkio`, status ACTIVE_HEALTHY).

## 7. Expected post-state
The same 20 rows **plus exactly one new row**: version `0023`, name `financeops_intake_persistence` (ledger total **21**). No other ledger row changes. Both new tables are **empty** (0 rows). No other table has any data change.

## 8. Expected catalogue delta
No existing object changes. **138 catalogue lines are added**, all naming 0023 objects: column=68  constraint=34  function=5  grant=8  index=10  policy=7  rls=2  trigger=3  view=1
- tables `finance_integration_identities`, `finance_intake_submissions` (RLS on); view `finance_intake_queue`
- functions: `app_private.current_user_can_review_unresolved_intakes()`, `app_private.intake_is_superseded(text)` (the only two SECURITY DEFINER), and invoker triggers `enforce_finance_intake_rules`, `audit_finance_intake_change`, `enforce_finance_integration_identity`
- 3 triggers, 7 policies, 10 indexes, 34 constraints, 68 columns, 8 grants (anon: none; intakes: no DELETE for anyone)
- **Fingerprint of the expected additions** (the catalogue lines added, `LC_ALL=C sort`, then sha256): `da250fd3242fdbdadc31591d9a49db5e0c60bb126b812fb28b752852e423c31c`. Query: `docs/financeops/migration-a/tests/catalogue_snapshot.sql` (read-only SELECT; SHA-256 of that file `c6e55d9817f3364ca2cb5f415988588c2f4a1b5b733846e8a74cfe99c6332465`). Running it on Production before and after must reproduce exactly these additions and no removed/changed line.

## 9–12. Disposable validation of THIS release branch (fresh stack; sources = release HEAD git objects)
| Check | Result |
|---|---|
| Identity: release HEAD, blob, SHA-256 asserted before anything ran; 0019 absent; 21 migrations staged | PASS |
| Staged canonical replay 0001–0018, 0020 (0020 suite 66/66), 0021 (34/34), 0022, then 0023 via the CLI migration mechanism | PASS; ledger `0023 / financeops_intake_persistence` exactly once |
| Catalogue: pre-existing lines removed/changed | **0**; added **138**, all 0023 objects |
| Catalogue vs my earlier exact-file validation (pre, post, added list) | **byte-identical** (so the clean branch changed nothing) |
| **0023 pgTAP (11 groups)** | **240 / 240 PASS** (also 240/240 on the one-shot replay) |
| **Stage 1B regression with 0023 applied**: 0021 / 0022 / S01–S16 / Stage 1A regression | **34/34, 70/70, 16/16, 16/16 PASS** |
| One-shot replay of the release branch's migration folder (`db reset`) | history 0001…0023; catalogue **identical** to the staged route |
| `supabase db lint --local --fail-on error` | PASS (no schema errors) |
| Supabase advisors | 0023 contributes **0 ERROR and 0 security-class** findings. Added: 8 (INFO unindexed_foreign_keys: 3; INFO unused_index: 3; WARN multiple_permissive_policies: 2). Raw totals (pre 236 / post 227) are not comparable because this run sampled advisors after the suites had exercised the database, which clears some pre-existing "unused index" infos; the three pre-existing `function_search_path_mutable` WARNs are unchanged |
| Candidate unchanged at the end of the run; lab and volumes deleted | PASS (0 containers, 0 volumes) |
Not re-run here (already proven on the identical bytes, see `MIGRATION_0023_MANIFEST.md`): the two-session races, 12 mutants, second-apply, rollback round-trip.

```
### A. identity of what is replayed: branch agent/financeops-0023-release HEAD a1dbe11f94298347125ff7aa3e13d3fdb81bbb1f
migrations staged (21): 0001 0002 0003 0004 0005 0006 0008 0009 0010 0011 0012 0013 0014 0015 0016 0017 0018 0020 0021 0022 0023 
0019 staged? 0
git blob (release HEAD:0023): b1a477448c1529a12fddd32f4822e2e809e39bc7  expected b1a477448c1529a12fddd32f4822e2e809e39bc7
sha256 LF of lab 0023       : c4d76c10b646baf93fdaccf7c2ba751547e0d4d94b2c22eb994bc0784a41fca8
expected                    : c4d76c10b646baf93fdaccf7c2ba751547e0d4d94b2c22eb994bc0784a41fca8
INTEGRITY OK
0023 test blob: a80c8a3db2cd028f7db66a93e19f53812a12df4b (expected a80c8a3db2cd028f7db66a93e19f53812a12df4b)

### B. staged canonical replay 0001-0018, 0020, 0021, 0022, 0023
history@0020: 0001 0002 0003 0004 0005 0006 0008 0009 0010 0011 0012 0013 0014 0015 0016 0017 0018 0020 
--- 0020 suite at its own baseline (expect 66)
Files=1, Tests=66,  0 wallclock secs ( 0.07 usr  0.04 sys +  0.04 cusr  0.03 csys =  0.18 CPU) Result: PASS 
{"applied":["C:\\Users\\USER\\AppData\\Local\\Temp\\fo-lab\\supabase\\migrations\\0021_sta
--- 0021 suite (expect 34)
Files=1, Tests=34,  1 wallclock secs ( 0.05 usr  0.01 sys +  0.02 cusr  0.01 csys =  0.09 CPU) Result: PASS 
{"applied":["C:\\Users\\USER\\AppData\\Local\\Temp\\fo-lab\\supabase\\migrations\\0022_sta
history@0022: 0001 0002 0003 0004 0005 0006 0008 0009 0010 0011 0012 0013 0014 0015 0016 0017 0018 0020 0021 0022 
{"applied":["C:\\Users\\USER\\AppData\\Local\\Temp\\fo-lab\\supabase\\migrations\\0023_financeops_intake_persistence.sql
history@0023: 0001 0002 0003 0004 0005 0006 0008 0009 0010 0011 0012 0013 0014 0015 0016 0017 0018 0020 0021 0022 0023 
0023 ledger rows: 1  -> 0023 / financeops_intake_persistence

### C. catalogue
lines before 2466 / after 2604; pre-existing removed/changed: 0
added: 138; not naming a 0023 object: 0
release-branch pre-0023 snapshot identical to the earlier exact-file validation: YES
release-branch post-0023 snapshot identical to the earlier exact-file validation: YES
added-object list identical to the earlier validation: YES

### D. 0023 pgTAP and Stage 1B regression (same DB)
--- 0023 (expect 240)
Files=1, Tests=240,  2 wallclock secs ( 0.13 usr  0.02 sys +  0.08 cusr  0.11 csys =  0.34 CPU) Result: PASS 
--- 0021 (34)
Files=1, Tests=34,  1 wallclock secs ( 0.05 usr  0.00 sys +  0.01 cusr  0.02 csys =  0.08 CPU) Result: PASS 
--- 0022 (70, before fixtures)
Files=1, Tests=70,  1 wallclock secs ( 0.08 usr  0.04 sys +  0.02 cusr  0.05 csys =  0.19 CPU) Result: PASS 
Stage 1B fixtures loaded
--- S01-S16 matrix (16)
Files=1, Tests=16,  0 wallclock secs ( 0.05 usr  0.03 sys +  0.01 cusr  0.01 csys =  0.10 CPU) Result: PASS 
--- Stage 1A regression (16)
Files=1, Tests=16,  0 wallclock secs ( 0.04 usr  0.01 sys +  0.01 cusr  0.01 csys =  0.07 CPU) Result: PASS 

### E. lint and advisors
db lint exit=0 : No schema errors found {"results":[],"message":"db lint"} 
advisors exit=0

### F. one-shot replay of the release branch's migrations folder (db reset)
{"target":"local","version":"","message":"Reset local database."}
history: 0001 0002 0003 0004 0005 0006 0008 0009 0010 0011 0012 0013 0014 0015 0016 0017 0018 0020 0021 0022 0023 
one-shot catalogue identical to staged: YES
--- 0023 suite on the one-shot replay
Files=1, Tests=240,  2 wallclock secs ( 0.17 usr  0.02 sys +  0.05 cusr  0.19 csys =  0.43 CPU) Result: PASS 

### G. candidate still unchanged
release HEAD 0023 blob: b1a477448c1529a12fddd32f4822e2e809e39bc7  (expected b1a477448c1529a12fddd32f4822e2e809e39bc7); worktree changes: 0

### H. teardown
{"project_id_filter":"fo-migration-a-lab","backup":false,"message":"Stopped supabase local development setup."}
containers left: 0  volumes left: 0
lab folder removed
RELEASE VALIDATION COMPLETE
```

## 13. Backup requirements (before any apply)
0023 only **adds** objects and changes no existing data, so it is fully reversible while unused; the backup is insurance against operator error, not a rollback dependency. Required:
1. In the Supabase dashboard (Project → Database → Backups) record the plan's backup mode and the **latest restorable point** (daily backup timestamp, or PITR window). Proceed only if a restore point **within the last 24 hours** (or PITR) exists; write the timestamp into the release log.
2. If neither exists, take an on-demand logical backup first (`pg_dump` of schemas `public` and `app_private`, with data, to an encrypted location Claire controls) and record its checksum.
3. Capture the **pre-state evidence** with the read-only catalogue snapshot query and the ledger listing; keep both files.
4. Schedule a low-traffic window. The migration sets `lock_timeout = 5s` and `statement_timeout = 2min` and runs in one transaction, so a lock problem fails fast and leaves nothing behind. Creating the foreign keys takes brief share locks on the referenced tables (`entities`, `supplier_bills`, `documents`, `auth.users`); on `auth.users` that can briefly delay writes such as sign-in bookkeeping (milliseconds when idle).

## 14. Rollback procedure and limitations
- Procedure: `docs/financeops/migration-a/ROLLBACK_0023_manual.sql.txt` (one transaction: drops the view, triggers, both tables and the five functions). Then remove the ledger row deliberately: `delete from supabase_migrations.schema_migrations where version = '0023';` (or `supabase migration repair --status reverted 0023`). Re-run the ledger listing and the catalogue snapshot; they must equal the pre-state evidence.
- Proven in the lab: rollback returned the catalogue to the **exact pre-0023 state (0 diff lines)** and 0023 re-applied identically.
- **Limitations:** valid only while 0023 is unused. Once any real intake or registry row exists, the rollback **destroys it and its lineage**; after that the correct response to a defect is a forward-fix migration (0024+), never an edit of 0023. Rollback does not undo anything outside the database (Auth users, Hermes, Vercel). Do not run it with the migration partly applied by hand.

## 15. Abort conditions (stop; do not improvise)
1. `origin/main` is not `a1dbe11f94298347125ff7aa3e13d3fdb81bbb1f`, or any other migration/file has appeared.
2. The Production ledger is not exactly the 20 rows in §6 (0023 already present, anything missing or extra).
3. The 0023 file in the checkout being executed does not match the blob in §4 **or** the SHA-256 in §5 (any byte).
4. A restore point/backup per §13 cannot be confirmed.
5. The Supabase Branching/GitHub-integration "deploy to production" setting cannot be confirmed (see §0.3) — do not merge.
6. Any preflight error (`0023 preflight failed …`, PostgreSQL < 15), or a `lock timeout`/`statement timeout`: stop, do **not** raise the timeouts, investigate, retry only in a new window.
7. `db push --dry-run` lists anything other than `0023_financeops_intake_persistence.sql`.
8. Any post-check in §16 fails: ledger not exactly 21 rows with 0023 once; catalogue additions fingerprint ≠ §8; either new table non-empty; RLS not enabled on both tables; policy count ≠ 7.
9. Any unexpected error or application behaviour change after apply: stop; use the rollback only per §14 and only if 0023 is still unused.

## 16. Exact Production execution method (proposed; to be performed by Claire or an authorised admin, not by Claude)
**Constraint:** no prior Production runbook exists in the repo, and I cannot see how 0020–0022 were applied. The ledger's 4-digit versions are what the Supabase CLI records from filenames, so the CLI is the method that matches the existing ledger. Do **not** use the Supabase MCP `apply_migration` tool, which generates its own timestamp version and would record 0023 under a different version.

**Step 0 — resolve the merge/auto-apply question (blocking).** In the dashboard open **Project → Integrations → GitHub** (and **Branching**). Record whether a repository is connected and whether "Deploy to production" / automatic migrations is **on**.
- **If it is ON:** merging the release branch to `main` *is* the Production apply. Do all of §13 first, then merge, then verify (§ post-checks). Do not also run `db push`.
- **If it is OFF (or no repo connected):** use the CLI path below. Vercel will still rebuild `main` after the merge, producing a new deployment of **identical application code** (the release adds only SQL files).

**CLI path (integration OFF):**
1. Fast-forward `main` to `a1dbe11f94298347125ff7aa3e13d3fdb81bbb1f` by PR (exactly two files), then work from a clean checkout of that commit. Verify `git rev-parse HEAD:supabase/migrations/0023_financeops_intake_persistence.sql` = `b1a477448c1529a12fddd32f4822e2e809e39bc7` and the LF SHA-256 = `c4d76c10b646baf93fdaccf7c2ba751547e0d4d94b2c22eb994bc0784a41fca8` **before** linking.
2. `supabase link --project-ref gjmvqnkzhfuuntutxkio`, then `supabase migration list --linked`: local and remote must match through 0022 and show 0023 as local-only.
3. `supabase db push --linked --dry-run`: must list **only** `0023_financeops_intake_persistence.sql` (abort condition 7).
4. `supabase db push --linked` (the only write). The file is a single transaction guarded by its own preflight.
5. Fallback only if the CLI cannot be used: run the exact verified file contents once in the SQL editor/`psql` as `postgres`, then insert the ledger row (`version '0023'`, `name 'financeops_intake_persistence'`) in the same convention; record that the ledger was written manually.

**Post-checks (read-only):** ledger = 21 rows with `0023 / financeops_intake_persistence` once; `select count(*) from public.finance_intake_submissions` and `…finance_integration_identities` both 0; `relrowsecurity` true on both; `pg_policies` count 7 for the two tables; catalogue snapshot diff reproduces the §8 fingerprint; `authenticated` has no DELETE on the intakes table. **Do not run the pgTAP suite against Production.**

## 17. Scope confirmation
This release is **database foundation only**. Application persistence is **not** part of it. Production application stays at `31e84d3`; no FinanceOps request persistence is enabled; **no FinanceOps Auth user, `user_entity_access` rows or registry row is provisioned**; the FinanceOps endpoint stays disabled; Hermes is unchanged and does not become operational because 0023 exists; Stage 1B and SQL Account are untouched. After a successful release, application persistence will be built and tested separately on the FinanceOps prep branch against a disposable database that has 0023.

## Decisions for Claire
- **D-A:** approve this package (or require changes) — then who executes (§16) and when (§13 window).
- **D-B:** confirm the Supabase GitHub-integration / Branching setting (§0.3 / §16 step 0); this decides whether the merge is the apply.
- **D-C:** confirm the backup mode/restore point (§13).
