# Phase 1 Foundation

## Scope Implemented

- Added the four operating entities: `IEA`, `IETA`, `PLC`, and `KALER`.
- Added user profiles, roles, and entity access records for owner/staff separation.
- Added bank account master data with balances restricted to owner-only table access.
- Added a staff-safe bank account view that does not expose opening, current, or closing balances.
- Added suppliers, supplier-to-entity links, and shared expense categories.
- Marked existing prototype tables with `is_demo` and `data_origin = 'demo'` without assigning an entity.
- Added Supabase Auth login and foundation settings pages without forcing login on the existing dashboard yet.

## Required Database Change

Apply `supabase/migrations/0002_phase1_foundation.sql` to the existing Supabase project.

After the migration, the first real owner account should be promoted manually:

```sql
update app_profiles
set role = 'owner', active_status = true
where email = '<owner email>';
```

Then assign staff or intern users to the relevant entities through `user_entity_access`.

## Environment Variables

No new environment variable names are required for Phase 1.

The existing variables must remain configured in Vercel:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Do not expose a Supabase service-role key to the browser.

## Security Notes

- Direct access to `bank_accounts` is owner-only through RLS.
- Staff/intern users must read bank account metadata through `bank_accounts_staff_safe`, which excludes all balance columns.
- Existing demo workflow tables still keep their original permissive policies so the deployed prototype is not broken during Phase 1.
- Locking down the existing invoice, receipt, transaction, and reconciliation tables should be a later migration after the app is moved fully behind login.

## Phase 1 Limits

Not included in this phase: personal expenses, credit-card claims, OCR, Gmail, Drive monitoring, WhatsApp reminders, payroll calculation, accounting-ledger replacement, payment voucher numbering, or official receipt numbering.
