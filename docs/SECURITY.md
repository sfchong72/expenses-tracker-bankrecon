# Security

## Secret Handling
- `SUPABASE_SERVICE_ROLE_KEY` and `OPENAI_API_KEY` live in Vercel environment variables only — never referenced in client-side code or committed to the repo.
- Frontend uses the public `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` only.
- All AI calls and service-role operations go through Next.js `/api` server routes.

## Permission Model
- **v1 (demo):** Permissive RLS — all rows readable and writable by any visitor. Suitable for internal preview only.
- **Sprint 5 (lock-down):** Replace every v1 RLS policy with `auth.uid() = user_id`. Unauthenticated users get zero rows. Agent actions inherit the authenticated user's session — no elevated privileges.

## Approved-Tools Rule
No agent or background job may call ad-hoc SQL, arbitrary shell commands, or unscoped HTTP endpoints. Only the named tools in `AGENTIC_LAYER.md` are permitted. Any new tool requires a code-review entry in this document before use.

## Audit Principle
Every write that changes business state (match created, status updated, export triggered) appends a row to `audit_logs`. Logs are append-only in application code; no delete route exists for audit_logs. If data-loss risk arises (bulk delete, schema migration), stop and involve a human reviewer before proceeding.
