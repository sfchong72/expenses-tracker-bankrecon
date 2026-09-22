# Security

## Secret Handling
- `SUPABASE_SERVICE_ROLE_KEY` and `OPENAI_API_KEY` live in Vercel environment variables only — never referenced in client-side code or committed to the repo.
- Frontend uses the public `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` only.
- All AI calls and service-role operations go through Next.js `/api` server routes.

## Permission Model
- **Owner/Admin:** full access, user administration and eligible reasoned deletion/merge; MFA required.
- **Finance Manager:** full Finance operations, approval, cancellation, void and eligible reasoned deletion; MFA required.
- **Finance Staff:** Finance draft/create/edit and voucher preparation; no self-approval, user administration or permanent deletion of finalized transactions.
- **Management:** Finance reporting and only specifically appointed approval permissions; no routine editing by default.
- **Intern/Data Entry:** separate personal login, assigned entity/branch scope, permitted drafts and Student Operations corrections only; no approval, issue, payment, cancellation, merge, permanent deletion, user administration, bank balances, sensitive payment data or confidential management/director claims.
- **All other, anonymous and inactive users:** no application, API, database, document or Storage access.

Owner/Admin and Finance Manager database access requires the Supabase JWT `aal2` claim. Browser
navigation is never treated as authorization; grants, RLS, Storage policies, RPC checks and
server-side route checks enforce the boundary.

## Deletion And Finality

- Empty duplicate students may be permanently deleted only by Owner/Admin or Finance Manager with a reason.
- Linked duplicate students must use the controlled merge workflow before the source is deleted.
- Incorrect files are removed from private Storage and metadata through a compensating server workflow.
- Eligible draft/incomplete Finance records may be deleted only by Owner/Admin or Finance Manager with a reason.
- Issued, approved, posted, paid or otherwise finalized Finance records are voided/cancelled, never hard-deleted.
- Every deletion, merge, cancellation and void records actor, timestamp, reason and affected record in the audit log.

## Approved-Tools Rule
No agent or background job may call ad-hoc SQL, arbitrary shell commands, or unscoped HTTP endpoints. Only the named tools in `AGENTIC_LAYER.md` are permitted. Any new tool requires a code-review entry in this document before use.

## Audit Principle
Every write that changes business state (match created, status updated, export triggered) appends a row to `audit_logs`. Logs are append-only in application code; no delete route exists for audit_logs. If data-loss risk arises (bulk delete, schema migration), stop and involve a human reviewer before proceeding.
