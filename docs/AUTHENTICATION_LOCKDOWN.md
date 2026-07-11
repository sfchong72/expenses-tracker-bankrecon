# Authentication Lockdown

## Implemented

- `/login` uses Supabase email/password sign-in.
- Middleware redirects unauthenticated visitors to `/login`.
- Middleware denies users without an `app_profiles` row.
- Middleware denies users where `active_status = false`.
- Owner-only settings routes redirect non-owner users to `/access-denied`.
- API routes return `401` for unauthenticated requests and `403` for inactive or unprofiled users.
- The dashboard header shows the signed-in user's display name or email, role, and logout button.
- Logout clears the Supabase session and redirects to `/login`.

## Required Database Change

Apply `supabase/migrations/0003_auth_lockdown.sql` after `0002_phase1_foundation.sql`.

This migration removes the original permissive demo policies from:

- `invoices`
- `receipts`
- `bank_transactions`
- `reconciliation_matches`
- `audit_logs`

Owner users can access all rows. Non-owner users can only access rows assigned to entities they can access through `user_entity_access`.

## Bank Balance Rule

Staff users must not query `bank_accounts` directly. RLS keeps that table owner-only. Staff-facing screens must use `bank_accounts_staff_safe`, which excludes:

- `opening_balance`
- `current_balance`
- `closing_balance`
- any future running-balance field

## Test Checklist

- Visit `/` in a private browser session and confirm redirect to `/login`.
- Submit a wrong password and confirm the visible invalid-credentials error.
- Sign in as the owner and confirm the dashboard opens.
- Confirm the header shows user identity, role, and logout.
- Click logout and confirm redirect to `/login`.
- Set a test user's `active_status = false` and confirm login is denied.
- Sign in as a read-only user and confirm `/settings/foundation` redirects to `/access-denied`.
- Sign in as staff and confirm direct access to `bank_accounts` is denied, while `bank_accounts_staff_safe` does not include balance columns.
