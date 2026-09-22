# FinanceOps Security Foundation Handoff

## Working State

- Repository: `sfchong72/expenses-tracker-bankrecon`
- Isolated branch: `agent/finance-security-integration`
- Live-main base: `0a8ba48f2f488739cedfc4c81bd2e871acad5361`
- Baseline integration commit: `0da3aa124d004c60b8e5063ccbd441a1c7ecb2d9`
- Working directory: `work/finance-security-integration-3`
- `0019` is permanently retired and must never be imported, renamed, applied or reused.
- Authoritative migration order: `0001–0018 → 0020 Finance reconciliation → 0021 Security hardening`.
- Authoritative `0020` SHA-256: `7450BF94E27B8B5F52DFB51ACD20FE47FF51D5BB2BFF02C71C08332D251B3932`.
- Recovered commit `7250e251a64124837885c7758e7b16aabe2fe3af` is reference-only. Evidence and the uncommitted patch are preserved in `docs/Stage1B_Recovery_*`; do not modify its worktree.

No migration in this worktree has been applied to Production. No Supabase Production, Vercel,
SQL Account, bank account, GitHub remote or migration-ledger change is authorised by this handoff.

## Implemented Locally For Review

- Private role boundary for Owner/Admin, Finance Manager, Finance Staff, Management and Data Entry.
- MFA `aal2` enforcement plus local TOTP enrollment/challenge UI for Owner/Admin and Finance Manager.
- Entity and explicit branch scoping; Data Entry does not inherit every branch from entity membership.
- Operation-specific Finance permissions for view, bill management, voucher preparation, issue,
  void, draft deletion, document deletion, sensitive payment data and confidential claims.
- Linked-record document metadata and private Storage authorization.
- Claim confidentiality and claimant self-check/self-approval prevention.
- Staff-safe supplier/bank views and raw bank-balance non-disclosure.
- Atomic voucher draft, claim-to-voucher and voucher-issue RPCs with entity/reference validation.
- Reasoned, audited voucher/student/document deletion; controlled student merge that preserves applicable
  duplicate-review history; file-deletion compensation plus a mandatory-reason UI action.
- Application routes changed to use the atomic/controlled RPCs.
- Behavioral pgTAP matrix for fictional roles, entity/branch isolation, Finance/Student permissions,
  document/claim confidentiality, MFA, finality, audit evidence and rollback.

## Validation Status

Completed successfully:

- SQL parser: all migration and test SQL files parsed.
- TypeScript: `tsc --noEmit`.
- ESLint: `eslint .`.
- Production build: `next build` (45 static/dynamic page entries generated successfully).
- `0020` hash reconfirmed unchanged.
- `.gitignore` contains no NUL bytes; generated `.pnpm-store` content is not tracked.

Still required before a local integration commit:

1. Start Docker Desktop outside the Codex sandbox and confirm `docker version` shows a server.
2. Replay `0001–0018`, authoritative `0020`, and the working `0021` into a fresh disposable local Supabase database.
3. Run all three pgTAP files in `supabase/tests`, including the 49-test Finance security matrix.
4. Run the existing Finance and Student Operations regression/UAT checks against that disposable stack.
5. Run Supabase database/security advisors and resolve material findings.
6. Re-run TypeScript, ESLint and production build after any SQL correction.

Do not call pgTAP or migration replay “passed” until those commands execute successfully. The
current sandbox could not start Docker because the Docker backend was denied access to its own
local CLI configuration; that is an environment blocker, not a database-test result.

## Urgent Account Transition For Claire's Approval

Perform only in a separately approved Production account window after the migration and app are deployed:

1. Claire signs in with the Owner account from a trusted device and confirms current recovery methods.
2. Create a new Supabase Auth user for the intern's personal email; never reuse or share the Owner login.
3. Create an active `app_profiles` row with role `data_entry` and only the intended entity and KL/PG branch assignments.
4. Grant only `can_manage_students`, `can_manage_enrolments`, permitted draft-entry and document-upload permissions; leave approval, issue, void, payment, deletion, merge, bank and confidential-claim permissions false.
5. In a separate browser profile, sign in as the intern and verify the deny matrix before entering real data.
6. Confirm the intern can create/correct an assigned-branch student and permitted drafts, and cannot access users, vouchers, bank data, confidential claims, final actions, deletion or merge.
7. Claire enrolls a personal TOTP factor for the Owner account and completes an `aal2` session. Each Finance Manager separately enrolls their own factor.
8. After the intern account is proven, stop sharing Owner credentials and change the Owner password to a new unique value.
9. Revoke all existing Owner sessions, then sign in again and complete MFA from Claire's trusted device.
10. Review Auth/session and application audit evidence; remove any obsolete shared or test account only through a separately approved account-cleanup action.

Deleting an Auth user alone does not immediately invalidate every existing access token, so session
revocation and a short token lifetime are part of the transition. Do not put passwords, TOTP secrets,
service-role keys or recovery codes in tickets, chat, source code or screenshots.

## Future Roadmap — Documented Only

### Phase 2 — Hermes FinanceOps Intake

- Stable intake ID plus Telegram message/file IDs.
- Preserve the original file; record a hash and detect duplicates.
- Store extracted values, confidence and clarification/exception state.
- Create only draft supplier bills/claims through a narrowly scoped signed server API.
- No payment, approval, issue, cancellation or deletion authority.
- Transactional reminder/notification outbox with retry and audit history.

### Phase 3 — SQL Account Integration

- Separate secure configuration for IEA, IETA, KALER and Premier.
- Explicit SQL master-data mappings and accountant-approved document-type mappings.
- Purchase Invoice, GL Payment Voucher, Customer Payment and approved-claim mapping.
- Human `Ready for SQL` gate, idempotency keys, posting queue, SQL document number/key,
  retry/failure history and sandbox validation.
- Never automatically delete, reverse or correct a posted SQL record.

### Phase 4 — SQL Reconciliation Status

- SQL Account remains the official bank-reconciliation system.
- Confirm supported API capabilities for reconciliation/clearing status with SQL Account.
- Do not assume its public REST API exposes bank-reconciliation endpoints.
- Do not reactivate the Finance App reconciliation engine without separate architecture approval.

## Fresh-Chat Prompt

Continue only in the isolated `agent/finance-security-integration` worktree at
`work/finance-security-integration-3`. Read `AGENTS.md`, the finance documents and this handoff.
Verify the branch/base/status and the authoritative `0020` hash before changing anything. Do not
contact Production. Start Docker Desktop outside the Codex sandbox, create a fresh disposable local
Supabase stack, replay `0001–0018 → 0020 → 0021`, and execute every pgTAP/regression check. Correct
only confirmed defects in the working `0021` or local application changes, then rerun the full suite.
If and only if all validation passes, create one local integration commit; do not push, merge, deploy,
alter the hosted migration ledger, create `0022`, or implement Hermes/SQL Account integration.
