drop trigger if exists set_bank_import_batches_updated_at on bank_import_batches;
create trigger set_bank_import_batches_updated_at before update on bank_import_batches for each row execute function public.set_phase3a_updated_at();
drop trigger if exists set_bank_import_rows_updated_at on bank_import_rows;
create trigger set_bank_import_rows_updated_at before update on bank_import_rows for each row execute function public.set_phase3a_updated_at();
drop trigger if exists set_bank_internal_transfers_updated_at on bank_internal_transfers;
create trigger set_bank_internal_transfers_updated_at before update on bank_internal_transfers for each row execute function public.set_phase3a_updated_at();
drop trigger if exists set_bank_manual_exceptions_updated_at on bank_manual_exceptions;
create trigger set_bank_manual_exceptions_updated_at before update on bank_manual_exceptions for each row execute function public.set_phase3a_updated_at();
drop trigger if exists set_bank_reconciliation_allocations_updated_at on bank_reconciliation_allocations;
create trigger set_bank_reconciliation_allocations_updated_at before update on bank_reconciliation_allocations for each row execute function public.set_phase3a_updated_at();

create or replace function public.recalculate_bank_reconciliation_status(p_bank_transaction_id uuid)
returns void
language plpgsql
security definer
set search_path = public, app_private
as $$
declare
  tx_amount numeric;
  tx_reversed boolean;
  allocated numeric;
  has_exception boolean;
  next_status text;
begin
  select abs(amount), is_reversal into tx_amount, tx_reversed
  from public.bank_transactions
  where id = p_bank_transaction_id;

  if tx_amount is null then
    return;
  end if;

  select coalesce(sum(allocated_amount), 0) into allocated
  from public.bank_reconciliation_allocations
  where bank_transaction_id = p_bank_transaction_id
    and status = 'confirmed'
    and reversed_at is null;

  select exists (
    select 1
    from public.bank_manual_exceptions
    where bank_transaction_id = p_bank_transaction_id
      and review_status in ('open', 'under_review')
  ) into has_exception;

  if tx_reversed then
    next_status := 'reversed';
  elsif has_exception and allocated = 0 then
    next_status := 'exception';
  elsif allocated = 0 then
    next_status := 'unmatched';
  elsif allocated < tx_amount then
    next_status := 'partially_matched';
  elsif allocated = tx_amount then
    next_status := 'matched';
  else
    next_status := 'exception';
  end if;

  update public.bank_transactions
  set reconciliation_status = next_status,
      updated_at = now()
  where id = p_bank_transaction_id;
end;
$$;

revoke all on function public.recalculate_bank_reconciliation_status(uuid) from public;

create or replace function public.recalculate_bank_reconciliation_status_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, app_private
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and old.bank_transaction_id is not null then
    perform public.recalculate_bank_reconciliation_status(old.bank_transaction_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.bank_transaction_id is not null then
    perform public.recalculate_bank_reconciliation_status(new.bank_transaction_id);
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists recalculate_bank_reconciliation_status_on_allocations on bank_reconciliation_allocations;
create trigger recalculate_bank_reconciliation_status_on_allocations
after insert or update or delete on bank_reconciliation_allocations
for each row execute function public.recalculate_bank_reconciliation_status_trigger();

create or replace function public.confirm_bank_reconciliation_allocation(p_allocation_id uuid, p_override_reason text default null)
returns bank_reconciliation_allocations
language plpgsql
security definer
set search_path = public, app_private
as $$
declare
  allocation bank_reconciliation_allocations;
  tx bank_transactions;
  existing_total numeric;
  target_outstanding numeric;
begin
  select * into allocation
  from public.bank_reconciliation_allocations
  where id = p_allocation_id
  for update;

  if allocation.id is null then
    raise exception 'Allocation not found';
  end if;

  if not (app_private.current_user_is_owner() or (app_private.user_can_access_entity(allocation.entity_id) and exists (
    select 1 from public.user_entity_access uea
    where uea.user_id = auth.uid()
      and uea.entity_id = allocation.entity_id
      and uea.can_reconcile = true
  ))) then
    raise exception 'Not authorised to confirm reconciliation matches';
  end if;

  select * into tx
  from public.bank_transactions
  where id = allocation.bank_transaction_id
  for update;

  if tx.id is null then
    raise exception 'Bank transaction not found';
  end if;

  if allocation.linked_record_type <> 'internal_transfer' and tx.entity_id <> allocation.entity_id then
    raise exception 'Cross-entity matching requires an internal or intercompany transfer classification';
  end if;

  select coalesce(sum(allocated_amount), 0) into existing_total
  from public.bank_reconciliation_allocations
  where bank_transaction_id = allocation.bank_transaction_id
    and status = 'confirmed'
    and reversed_at is null
    and id <> allocation.id;

  if existing_total + allocation.allocated_amount > abs(tx.amount) then
    raise exception 'Allocation exceeds the bank transaction amount';
  end if;

  if allocation.linked_record_type = 'supplier_bill' and allocation.linked_record_id is not null then
    select outstanding_amount into target_outstanding
    from public.supplier_bills
    where id = allocation.linked_record_id;

    if target_outstanding is not null and allocation.allocated_amount > target_outstanding then
      if not app_private.current_user_is_owner() or nullif(p_override_reason, '') is null then
        raise exception 'Allocation exceeds supplier bill outstanding amount. Owner override reason is required.';
      end if;
      allocation.overpayment_override := true;
      allocation.overpayment_reason := p_override_reason;
    end if;
  end if;

  update public.bank_reconciliation_allocations
  set status = 'confirmed',
      confirmed_by = auth.uid(),
      confirmed_at = now(),
      overpayment_override = allocation.overpayment_override,
      overpayment_reason = allocation.overpayment_reason,
      updated_at = now()
  where id = allocation.id
  returning * into allocation;

  insert into public.bank_reconciliation_events(allocation_id, bank_transaction_id, action, actor_user_id, payload)
  values (allocation.id, allocation.bank_transaction_id, 'confirm_match', auth.uid(), jsonb_build_object('override_reason', p_override_reason));

  perform public.recalculate_bank_reconciliation_status(allocation.bank_transaction_id);
  return allocation;
end;
$$;

revoke all on function public.confirm_bank_reconciliation_allocation(uuid, text) from public;
grant execute on function public.confirm_bank_reconciliation_allocation(uuid, text) to authenticated;

create or replace function public.reverse_bank_reconciliation_allocation(p_allocation_id uuid, p_reason text)
returns bank_reconciliation_allocations
language plpgsql
security definer
set search_path = public, app_private
as $$
declare
  allocation bank_reconciliation_allocations;
begin
  if nullif(p_reason, '') is null then
    raise exception 'Reversal reason is required';
  end if;

  select * into allocation
  from public.bank_reconciliation_allocations
  where id = p_allocation_id
  for update;

  if allocation.id is null then
    raise exception 'Allocation not found';
  end if;

  if not (app_private.current_user_is_owner() or (app_private.user_can_access_entity(allocation.entity_id) and exists (
    select 1 from public.user_entity_access uea
    where uea.user_id = auth.uid()
      and uea.entity_id = allocation.entity_id
      and uea.can_reconcile = true
  ))) then
    raise exception 'Not authorised to reverse reconciliation matches';
  end if;

  update public.bank_reconciliation_allocations
  set status = 'reversed',
      reversed_by = auth.uid(),
      reversed_at = now(),
      reversal_reason = p_reason,
      updated_at = now()
  where id = allocation.id
  returning * into allocation;

  insert into public.bank_reconciliation_events(allocation_id, bank_transaction_id, action, actor_user_id, payload)
  values (allocation.id, allocation.bank_transaction_id, 'reverse_match', auth.uid(), jsonb_build_object('reason', p_reason));

  perform public.recalculate_bank_reconciliation_status(allocation.bank_transaction_id);
  return allocation;
end;
$$;

revoke all on function public.reverse_bank_reconciliation_allocation(uuid, text) from public;
grant execute on function public.reverse_bank_reconciliation_allocation(uuid, text) to authenticated;

create or replace function public.discard_bank_import_batch(p_batch_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, app_private
as $$
declare
  batch bank_import_batches;
  created_count integer;
begin
  select * into batch from public.bank_import_batches where id = p_batch_id for update;
  if batch.id is null then raise exception 'Batch not found'; end if;
  if not (app_private.current_user_is_owner() or (app_private.user_can_access_entity(batch.entity_id) and exists (
    select 1 from public.user_entity_access uea where uea.user_id = auth.uid() and uea.entity_id = batch.entity_id and uea.can_import_bank = true
  ))) then
    raise exception 'Not authorised to discard bank import batches';
  end if;
  if batch.status not in ('uploaded', 'mapping', 'review', 'ready', 'failed') then
    raise exception 'Only unconfirmed or failed batches may be discarded';
  end if;
  select count(*) into created_count from public.bank_import_rows where bank_import_batch_id = p_batch_id and bank_transaction_id is not null;
  if created_count > 0 then
    raise exception 'This batch created bank transactions and cannot be discarded';
  end if;
  delete from public.bank_import_rows where bank_import_batch_id = p_batch_id;
  update public.bank_import_batches
  set status = 'discarded',
      discarded_at = now(),
      discarded_by = auth.uid(),
      discard_reason = p_reason,
      updated_at = now()
  where id = p_batch_id;
  insert into public.audit_logs(actor_user_id, action, entity_type, entity_id, payload, data_origin)
  values (auth.uid(), 'bank_import_batch_discarded', 'bank_import_batch', p_batch_id, jsonb_build_object('reason', p_reason), 'manual');
end;
$$;

revoke all on function public.discard_bank_import_batch(uuid, text) from public;
grant execute on function public.discard_bank_import_batch(uuid, text) to authenticated;

create or replace function public.archive_bank_import_batch(p_batch_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, app_private
as $$
declare
  batch bank_import_batches;
begin
  select * into batch from public.bank_import_batches where id = p_batch_id for update;
  if batch.id is null then raise exception 'Batch not found'; end if;
  if not (app_private.current_user_is_owner() or (app_private.user_can_access_entity(batch.entity_id) and exists (
    select 1 from public.user_entity_access uea where uea.user_id = auth.uid() and uea.entity_id = batch.entity_id and (uea.can_import_bank = true or uea.can_reconcile = true)
  ))) then
    raise exception 'Not authorised to archive bank import batches';
  end if;
  update public.bank_import_batches
  set status = 'archived',
      archived_at = now(),
      archived_by = auth.uid(),
      archive_reason = p_reason,
      updated_at = now()
  where id = p_batch_id;
  insert into public.audit_logs(actor_user_id, action, entity_type, entity_id, payload, data_origin)
  values (auth.uid(), 'bank_import_batch_archived', 'bank_import_batch', p_batch_id, jsonb_build_object('reason', p_reason), 'manual');
end;
$$;

revoke all on function public.archive_bank_import_batch(uuid, text) from public;
grant execute on function public.archive_bank_import_batch(uuid, text) to authenticated;

create or replace view public.bank_transactions_staff_safe
with (security_barrier = true)
as
select
  bt.id,
  bt.entity_id,
  bt.bank_account_id,
  bt.description,
  bt.additional_description,
  bt.reference_number,
  bt.bank_reference,
  bt.transaction_date,
  bt.transaction_time,
  bt.value_date,
  bt.direction,
  bt.debit_amount,
  bt.credit_amount,
  bt.amount,
  bt.statement_month,
  bt.source_import_batch_id,
  bt.source_import_row_id,
  bt.reconciliation_status,
  bt.is_reversal,
  bt.duplicate_fingerprint,
  bt.legacy_review_required,
  bt.legacy_review_reason,
  bt.data_origin,
  bt.is_demo,
  bt.created_at,
  bt.updated_at
from public.bank_transactions bt
where app_private.user_can_access_entity(bt.entity_id);

create or replace view public.bank_import_batches_staff_safe
with (security_barrier = true)
as
select
  id,
  entity_id,
  bank_account_id,
  statement_month,
  filename,
  file_type,
  file_hash,
  worksheet_name,
  uploaded_by,
  uploaded_at,
  mapping_config,
  date_format,
  direction_mode,
  bank_preset,
  total_rows,
  successful_rows,
  skipped_rows,
  failed_rows,
  status,
  discarded_at,
  archived_at,
  result_summary,
  created_at,
  updated_at
from public.bank_import_batches
where app_private.user_can_access_entity(entity_id);

create or replace view public.bank_import_rows_staff_safe
with (security_barrier = true)
as
select
  bir.id,
  bir.bank_import_batch_id,
  bir.row_number,
  bir.original_data_sanitized as original_data,
  bir.mapped_data_sanitized as mapped_data,
  bir.validation_errors,
  bir.duplicate_warnings,
  bir.excluded,
  bir.duplicate_decision,
  bir.result_status,
  bir.result_message,
  bir.bank_transaction_id,
  bir.created_at,
  bir.updated_at
from public.bank_import_rows bir
join public.bank_import_batches bib on bib.id = bir.bank_import_batch_id
where app_private.user_can_access_entity(bib.entity_id);

alter table bank_import_batches enable row level security;
alter table bank_import_rows enable row level security;
alter table bank_internal_transfers enable row level security;
alter table bank_manual_exceptions enable row level security;
alter table bank_reconciliation_allocations enable row level security;
alter table bank_reconciliation_events enable row level security;

drop policy if exists "bank_transactions_v1_read" on bank_transactions;
drop policy if exists "bank_transactions_v1_write" on bank_transactions;
drop policy if exists "bank_transactions_auth_select" on bank_transactions;
drop policy if exists "bank_transactions_auth_insert" on bank_transactions;
drop policy if exists "bank_transactions_auth_update" on bank_transactions;
drop policy if exists "bank_transactions_auth_delete" on bank_transactions;

create policy "bank_transactions_owner_or_balance_select" on bank_transactions for select to authenticated
using (app_private.current_user_is_owner() or app_private.current_user_can('can_view_bank_balances'));
create policy "bank_transactions_import_insert" on bank_transactions for insert to authenticated
with check (
  app_private.user_can_access_entity(entity_id)
  and (app_private.current_user_is_owner() or exists (
    select 1 from public.user_entity_access uea
    where uea.user_id = auth.uid() and uea.entity_id = bank_transactions.entity_id and uea.can_import_bank = true
  ))
);
create policy "bank_transactions_reconcile_update" on bank_transactions for update to authenticated
using (
  app_private.current_user_is_owner() or exists (
    select 1 from public.user_entity_access uea
    where uea.user_id = auth.uid() and uea.entity_id = bank_transactions.entity_id and uea.can_reconcile = true
  )
)
with check (app_private.user_can_access_entity(entity_id));
create policy "bank_transactions_owner_delete" on bank_transactions for delete to authenticated
using (app_private.current_user_is_owner());

create policy "bank_import_batches_full_select" on bank_import_batches for select to authenticated
using (app_private.current_user_is_owner() or app_private.current_user_can('can_view_bank_balances'));
create policy "bank_import_batches_insert" on bank_import_batches for insert to authenticated
with check (
  app_private.user_can_access_entity(entity_id)
  and (app_private.current_user_is_owner() or exists (
    select 1 from public.user_entity_access uea
    where uea.user_id = auth.uid() and uea.entity_id = bank_import_batches.entity_id and uea.can_import_bank = true
  ))
);
create policy "bank_import_batches_update" on bank_import_batches for update to authenticated
using (
  app_private.current_user_is_owner() or exists (
    select 1 from public.user_entity_access uea
    where uea.user_id = auth.uid() and uea.entity_id = bank_import_batches.entity_id and (uea.can_import_bank = true or uea.can_reconcile = true)
  )
)
with check (app_private.user_can_access_entity(entity_id));

create policy "bank_import_rows_full_select" on bank_import_rows for select to authenticated
using (app_private.current_user_is_owner() or app_private.current_user_can('can_view_bank_balances'));
create policy "bank_import_rows_insert" on bank_import_rows for insert to authenticated
with check (exists (
  select 1 from public.bank_import_batches bib
  where bib.id = bank_import_batch_id
    and app_private.user_can_access_entity(bib.entity_id)
    and (app_private.current_user_is_owner() or exists (
      select 1 from public.user_entity_access uea
      where uea.user_id = auth.uid() and uea.entity_id = bib.entity_id and uea.can_import_bank = true
    ))
));
create policy "bank_import_rows_update" on bank_import_rows for update to authenticated
using (exists (
  select 1 from public.bank_import_batches bib
  where bib.id = bank_import_batch_id
    and (app_private.current_user_is_owner() or exists (
      select 1 from public.user_entity_access uea
      where uea.user_id = auth.uid() and uea.entity_id = bib.entity_id and (uea.can_import_bank = true or uea.can_reconcile = true)
    ))
))
with check (exists (
  select 1 from public.bank_import_batches bib
  where bib.id = bank_import_batch_id
    and app_private.user_can_access_entity(bib.entity_id)
));

create policy "bank_internal_transfers_select" on bank_internal_transfers for select to authenticated
using (app_private.user_can_access_entity(source_entity_id) or app_private.user_can_access_entity(destination_entity_id));
create policy "bank_internal_transfers_manage" on bank_internal_transfers for all to authenticated
using (app_private.current_user_is_owner() or exists (
  select 1 from public.user_entity_access uea
  where uea.user_id = auth.uid() and uea.entity_id = source_entity_id and uea.can_reconcile = true
))
with check (app_private.user_can_access_entity(source_entity_id) and app_private.user_can_access_entity(destination_entity_id));

create policy "bank_manual_exceptions_select" on bank_manual_exceptions for select to authenticated
using (app_private.user_can_access_entity(entity_id));
create policy "bank_manual_exceptions_manage" on bank_manual_exceptions for all to authenticated
using (app_private.current_user_is_owner() or exists (
  select 1 from public.user_entity_access uea
  where uea.user_id = auth.uid() and uea.entity_id = bank_manual_exceptions.entity_id and uea.can_reconcile = true
))
with check (app_private.user_can_access_entity(entity_id));

create policy "bank_reconciliation_allocations_select" on bank_reconciliation_allocations for select to authenticated
using (app_private.user_can_access_entity(entity_id));
create policy "bank_reconciliation_allocations_manage" on bank_reconciliation_allocations for all to authenticated
using (app_private.current_user_is_owner() or exists (
  select 1 from public.user_entity_access uea
  where uea.user_id = auth.uid() and uea.entity_id = bank_reconciliation_allocations.entity_id and uea.can_reconcile = true
))
with check (app_private.user_can_access_entity(entity_id));

create policy "bank_reconciliation_events_select" on bank_reconciliation_events for select to authenticated
using (exists (
  select 1 from public.bank_transactions bt
  where bt.id = bank_transaction_id and app_private.user_can_access_entity(bt.entity_id)
));
create policy "bank_reconciliation_events_insert" on bank_reconciliation_events for insert to authenticated
with check (true);

grant select, insert, update on bank_import_batches to authenticated;
grant select, insert, update, delete on bank_import_rows to authenticated;
grant select, insert, update on bank_internal_transfers to authenticated;
grant select, insert, update on bank_manual_exceptions to authenticated;
grant select, insert, update on bank_reconciliation_allocations to authenticated;
grant select, insert on bank_reconciliation_events to authenticated;
grant select on bank_transactions_staff_safe to authenticated;
grant select on bank_import_batches_staff_safe to authenticated;
grant select on bank_import_rows_staff_safe to authenticated;
grant execute on function public.bank_transaction_fingerprint(uuid, date, time, numeric, text, text, text) to authenticated;
grant execute on function public.bank_normalise_text(text) to authenticated;

revoke all on bank_import_batches from anon;
revoke all on bank_import_rows from anon;
revoke all on bank_internal_transfers from anon;
revoke all on bank_manual_exceptions from anon;
revoke all on bank_reconciliation_allocations from anon;
revoke all on bank_reconciliation_events from anon;
