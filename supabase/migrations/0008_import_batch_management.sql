alter table import_batches add column if not exists archived_at timestamptz;
alter table import_batches add column if not exists archived_by uuid references auth.users(id) on delete set null;
alter table import_batches add column if not exists archive_reason text;
alter table import_batches add column if not exists discarded_at timestamptz;
alter table import_batches add column if not exists discarded_by uuid references auth.users(id) on delete set null;
alter table import_batches add column if not exists discard_reason text;
alter table import_batches add column if not exists has_created_records boolean not null default false;
alter table import_batches add column if not exists last_action text;
alter table import_batches add column if not exists last_action_at timestamptz;
alter table import_batches add column if not exists last_action_by uuid references auth.users(id) on delete set null;

create index if not exists import_batches_active_history_idx on import_batches(import_type, uploaded_at desc) where archived_at is null and discarded_at is null;
create index if not exists import_batches_archived_history_idx on import_batches(import_type, archived_at desc) where archived_at is not null;

create or replace function public.import_batch_has_created_records(p_batch_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (select 1 from suppliers where source_import_batch_id = p_batch_id)
    or exists (select 1 from recurring_obligations where source_import_batch_id = p_batch_id)
    or exists (select 1 from import_batch_rows where import_batch_id = p_batch_id and (supplier_id is not null or recurring_obligation_id is not null));
$$;

create or replace function public.discard_supplier_recurring_import_batch(p_batch_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  batch_record import_batches%rowtype;
  preview_rows_deleted integer := 0;
  production_exists boolean := false;
begin
  if not app_private.current_user_is_owner() then raise exception 'Only owner users can discard import batches'; end if;
  select * into batch_record from import_batches where id = p_batch_id for update;
  if not found then raise exception 'Import batch not found'; end if;
  if batch_record.status not in ('uploaded', 'mapping', 'review', 'ready', 'failed') then raise exception 'Only unconfirmed or failed batches can be discarded'; end if;
  production_exists := public.import_batch_has_created_records(p_batch_id);
  if production_exists then raise exception 'This batch created production records and cannot be discarded. Use Revert Import Batch instead.'; end if;
  delete from import_batch_rows where import_batch_id = p_batch_id;
  get diagnostics preview_rows_deleted = row_count;
  update import_batches
  set discarded_at = now(), discarded_by = auth.uid(), discard_reason = nullif(trim(coalesce(p_reason, '')), ''), has_created_records = false,
      last_action = 'discarded', last_action_at = now(), last_action_by = auth.uid(), updated_at = now()
  where id = p_batch_id;
  insert into audit_logs (actor_user_id, action, entity_type, entity_id, payload, data_origin)
  values (auth.uid(), 'supplier_recurring_import_discarded', 'import_batch', p_batch_id, jsonb_build_object('filename', batch_record.filename, 'status', batch_record.status, 'preview_rows_deleted', preview_rows_deleted, 'reason', p_reason), 'manual');
  return jsonb_build_object('discarded', true, 'preview_rows_deleted', preview_rows_deleted, 'production_records_exist', false);
end;
$$;

create or replace function public.archive_supplier_recurring_import_batch(p_batch_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  batch_record import_batches%rowtype;
  production_exists boolean := false;
begin
  if not app_private.current_user_is_owner() then raise exception 'Only owner users can archive import batches'; end if;
  select * into batch_record from import_batches where id = p_batch_id for update;
  if not found then raise exception 'Import batch not found'; end if;
  if batch_record.status = 'processing' then raise exception 'Processing batches cannot be archived'; end if;
  if batch_record.discarded_at is not null then raise exception 'Discarded batches are already hidden from active history'; end if;
  production_exists := public.import_batch_has_created_records(p_batch_id);
  update import_batches
  set archived_at = coalesce(archived_at, now()), archived_by = coalesce(archived_by, auth.uid()), archive_reason = coalesce(nullif(trim(coalesce(p_reason, '')), ''), archive_reason),
      has_created_records = production_exists, last_action = 'archived', last_action_at = now(), last_action_by = auth.uid(), updated_at = now()
  where id = p_batch_id;
  insert into audit_logs (actor_user_id, action, entity_type, entity_id, payload, data_origin)
  values (auth.uid(), 'supplier_recurring_import_archived', 'import_batch', p_batch_id, jsonb_build_object('filename', batch_record.filename, 'status', batch_record.status, 'production_records_exist', production_exists, 'reason', p_reason), 'manual');
  return jsonb_build_object('archived', true, 'production_records_exist', production_exists);
end;
$$;

create or replace function public.revert_supplier_recurring_import_batch(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  batch_record import_batches%rowtype;
  blocked jsonb;
  removed_suppliers integer := 0;
  removed_recurring integer := 0;
  remaining_records boolean := false;
begin
  if not app_private.current_user_is_owner() then raise exception 'Only owner users can revert import batches'; end if;
  select * into batch_record from import_batches where id = p_batch_id for update;
  if not found then raise exception 'Import batch not found'; end if;
  if batch_record.status not in ('completed', 'completed_with_errors') then raise exception 'Only completed import batches can be reverted'; end if;
  if not public.import_batch_has_created_records(p_batch_id) then raise exception 'This batch has no created production records to revert'; end if;

  select jsonb_build_object(
    'recurring_obligations_used_by_bills', coalesce(jsonb_agg(distinct ro.id) filter (where sb.id is not null), '[]'::jsonb),
    'recurring_obligations_used_by_vouchers', coalesce(jsonb_agg(distinct ro.id) filter (where pv_ro.id is not null or pvi.id is not null), '[]'::jsonb),
    'recurring_obligations_with_documents', coalesce(jsonb_agg(distinct ro.id) filter (where dl_ro.id is not null), '[]'::jsonb),
    'suppliers_used_by_bills', coalesce(jsonb_agg(distinct s.id) filter (where sb2.id is not null), '[]'::jsonb),
    'suppliers_used_by_vouchers', coalesce(jsonb_agg(distinct s.id) filter (where pv.id is not null), '[]'::jsonb),
    'suppliers_with_remaining_obligations', coalesce(jsonb_agg(distinct s.id) filter (where ro_existing.id is not null), '[]'::jsonb)
  ) into blocked
  from import_batches ib
  left join recurring_obligations ro on ro.source_import_batch_id = ib.id
  left join supplier_bills sb on sb.recurring_obligation_id = ro.id
  left join payment_vouchers pv_ro on pv_ro.recurring_obligation_id = ro.id
  left join payment_voucher_items pvi on pvi.recurring_obligation_id = ro.id
  left join document_links dl_ro on dl_ro.linked_record_type = 'recurring_obligation' and dl_ro.linked_record_id = ro.id
  left join suppliers s on s.source_import_batch_id = ib.id
  left join supplier_bills sb2 on sb2.supplier_id = s.id
  left join payment_vouchers pv on pv.supplier_id = s.id
  left join recurring_obligations ro_existing on ro_existing.supplier_id = s.id and ro_existing.source_import_batch_id is distinct from p_batch_id
  where ib.id = p_batch_id;

  delete from recurring_obligations ro
  where ro.source_import_batch_id = p_batch_id
    and not exists (select 1 from supplier_bills sb where sb.recurring_obligation_id = ro.id)
    and not exists (select 1 from payment_vouchers pv where pv.recurring_obligation_id = ro.id)
    and not exists (select 1 from payment_voucher_items pvi where pvi.recurring_obligation_id = ro.id)
    and not exists (select 1 from document_links dl where dl.linked_record_type = 'recurring_obligation' and dl.linked_record_id = ro.id);
  get diagnostics removed_recurring = row_count;

  delete from supplier_entities se using suppliers s
  where se.supplier_id = s.id and s.source_import_batch_id = p_batch_id
    and not exists (select 1 from supplier_bills sb where sb.supplier_id = s.id)
    and not exists (select 1 from payment_vouchers pv where pv.supplier_id = s.id)
    and not exists (select 1 from recurring_obligations ro where ro.supplier_id = s.id);

  delete from suppliers s
  where s.source_import_batch_id = p_batch_id
    and not exists (select 1 from supplier_bills sb where sb.supplier_id = s.id)
    and not exists (select 1 from payment_vouchers pv where pv.supplier_id = s.id)
    and not exists (select 1 from recurring_obligations ro where ro.supplier_id = s.id);
  get diagnostics removed_suppliers = row_count;

  remaining_records := public.import_batch_has_created_records(p_batch_id);
  update import_batches
  set status = 'reverted', has_created_records = remaining_records, last_action = 'reverted', last_action_at = now(), last_action_by = auth.uid(),
      result_summary = jsonb_build_object('removed_suppliers', removed_suppliers, 'removed_recurring_obligations', removed_recurring, 'blocked', blocked, 'production_records_remain', remaining_records), updated_at = now()
  where id = p_batch_id;
  insert into audit_logs (actor_user_id, action, entity_type, entity_id, payload, data_origin)
  values (auth.uid(), 'supplier_recurring_import_reverted', 'import_batch', p_batch_id, jsonb_build_object('removed_suppliers', removed_suppliers, 'removed_recurring_obligations', removed_recurring, 'blocked', blocked, 'production_records_remain', remaining_records), 'manual');
  return jsonb_build_object('removed_suppliers', removed_suppliers, 'removed_recurring_obligations', removed_recurring, 'blocked', blocked, 'production_records_remain', remaining_records);
end;
$$;

revoke all on function public.import_batch_has_created_records(uuid) from public;
revoke all on function public.discard_supplier_recurring_import_batch(uuid, text) from public;
revoke all on function public.archive_supplier_recurring_import_batch(uuid, text) from public;
revoke all on function public.revert_supplier_recurring_import_batch(uuid) from public;
grant execute on function public.import_batch_has_created_records(uuid) to authenticated;
grant execute on function public.discard_supplier_recurring_import_batch(uuid, text) to authenticated;
grant execute on function public.archive_supplier_recurring_import_batch(uuid, text) to authenticated;
grant execute on function public.revert_supplier_recurring_import_batch(uuid) to authenticated;

notify pgrst, 'reload schema';
