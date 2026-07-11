create or replace function app_private.current_user_is_active()
returns boolean
language sql
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.app_profiles
    where id = auth.uid()
      and active_status = true
  );
$$;
revoke all on function app_private.current_user_is_active() from public;
grant execute on function app_private.current_user_is_active() to authenticated;

create or replace function app_private.user_can_access_entity(target_entity_id uuid)
returns boolean
language sql
security definer
set search_path = public, auth
as $$
  select
    app_private.current_user_is_owner()
    or (
      target_entity_id is not null
      and exists (
        select 1
        from public.user_entity_access uea
        join public.app_profiles p on p.id = uea.user_id
        where uea.user_id = auth.uid()
          and uea.entity_id = target_entity_id
          and uea.active_status = true
          and p.active_status = true
      )
    );
$$;
revoke all on function app_private.user_can_access_entity(uuid) from public;
grant execute on function app_private.user_can_access_entity(uuid) to authenticated;

drop policy if exists "invoices_v1_read" on invoices;
drop policy if exists "invoices_v1_write" on invoices;
drop policy if exists "invoices_auth_select" on invoices;
create policy "invoices_auth_select" on invoices for select to authenticated
using (app_private.user_can_access_entity(entity_id));
drop policy if exists "invoices_auth_insert" on invoices;
create policy "invoices_auth_insert" on invoices for insert to authenticated
with check (app_private.user_can_access_entity(entity_id));
drop policy if exists "invoices_auth_update" on invoices;
create policy "invoices_auth_update" on invoices for update to authenticated
using (app_private.user_can_access_entity(entity_id))
with check (app_private.user_can_access_entity(entity_id));
drop policy if exists "invoices_auth_delete" on invoices;
create policy "invoices_auth_delete" on invoices for delete to authenticated
using (app_private.user_can_access_entity(entity_id));

drop policy if exists "receipts_v1_read" on receipts;
drop policy if exists "receipts_v1_write" on receipts;
drop policy if exists "receipts_auth_select" on receipts;
create policy "receipts_auth_select" on receipts for select to authenticated
using (app_private.user_can_access_entity(entity_id));
drop policy if exists "receipts_auth_insert" on receipts;
create policy "receipts_auth_insert" on receipts for insert to authenticated
with check (app_private.user_can_access_entity(entity_id));
drop policy if exists "receipts_auth_update" on receipts;
create policy "receipts_auth_update" on receipts for update to authenticated
using (app_private.user_can_access_entity(entity_id))
with check (app_private.user_can_access_entity(entity_id));
drop policy if exists "receipts_auth_delete" on receipts;
create policy "receipts_auth_delete" on receipts for delete to authenticated
using (app_private.user_can_access_entity(entity_id));

drop policy if exists "bank_transactions_v1_read" on bank_transactions;
drop policy if exists "bank_transactions_v1_write" on bank_transactions;
drop policy if exists "bank_transactions_auth_select" on bank_transactions;
create policy "bank_transactions_auth_select" on bank_transactions for select to authenticated
using (app_private.user_can_access_entity(entity_id));
drop policy if exists "bank_transactions_auth_insert" on bank_transactions;
create policy "bank_transactions_auth_insert" on bank_transactions for insert to authenticated
with check (app_private.user_can_access_entity(entity_id));
drop policy if exists "bank_transactions_auth_update" on bank_transactions;
create policy "bank_transactions_auth_update" on bank_transactions for update to authenticated
using (app_private.user_can_access_entity(entity_id))
with check (app_private.user_can_access_entity(entity_id));
drop policy if exists "bank_transactions_auth_delete" on bank_transactions;
create policy "bank_transactions_auth_delete" on bank_transactions for delete to authenticated
using (app_private.user_can_access_entity(entity_id));

drop policy if exists "reconciliation_matches_v1_read" on reconciliation_matches;
drop policy if exists "reconciliation_matches_v1_write" on reconciliation_matches;
drop policy if exists "reconciliation_matches_auth_select" on reconciliation_matches;
create policy "reconciliation_matches_auth_select" on reconciliation_matches for select to authenticated
using (app_private.user_can_access_entity(entity_id));
drop policy if exists "reconciliation_matches_auth_insert" on reconciliation_matches;
create policy "reconciliation_matches_auth_insert" on reconciliation_matches for insert to authenticated
with check (app_private.user_can_access_entity(entity_id));
drop policy if exists "reconciliation_matches_auth_update" on reconciliation_matches;
create policy "reconciliation_matches_auth_update" on reconciliation_matches for update to authenticated
using (app_private.user_can_access_entity(entity_id))
with check (app_private.user_can_access_entity(entity_id));
drop policy if exists "reconciliation_matches_auth_delete" on reconciliation_matches;
create policy "reconciliation_matches_auth_delete" on reconciliation_matches for delete to authenticated
using (app_private.user_can_access_entity(entity_id));

drop policy if exists "audit_logs_v1_read" on audit_logs;
drop policy if exists "audit_logs_v1_write" on audit_logs;
drop policy if exists "audit_logs_auth_select" on audit_logs;
create policy "audit_logs_auth_select" on audit_logs for select to authenticated
using (
  app_private.current_user_is_owner()
  or actor_user_id = auth.uid()
  or user_id = auth.uid()
  or app_private.user_can_access_entity(entity_id)
);
drop policy if exists "audit_logs_auth_insert" on audit_logs;
create policy "audit_logs_auth_insert" on audit_logs for insert to authenticated
with check (app_private.current_user_is_active());

revoke all on invoices from anon;
revoke all on receipts from anon;
revoke all on bank_transactions from anon;
revoke all on reconciliation_matches from anon;
revoke all on audit_logs from anon;
revoke all on bank_accounts from anon;
revoke all on bank_accounts_staff_safe from anon;
