alter table suppliers add column if not exists source_import_batch_id uuid;
alter table suppliers add column if not exists source_import_row_id uuid;
alter table recurring_obligations add column if not exists source_import_batch_id uuid;
alter table recurring_obligations add column if not exists source_import_row_id uuid;
alter table recurring_obligations add column if not exists account_reference_details text;
alter table recurring_obligations add column if not exists expense_category_id uuid references categories(id) on delete set null;

create table if not exists import_batches (
  id uuid primary key default gen_random_uuid(),
  import_type text not null default 'supplier_recurring' check (import_type in ('supplier_recurring')),
  filename text not null,
  file_type text not null check (file_type in ('csv', 'xlsx')),
  worksheet_name text,
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_at timestamptz not null default now(),
  status text not null default 'uploaded' check (status in ('uploaded', 'mapping', 'review', 'ready', 'processing', 'completed', 'completed_with_errors', 'failed', 'reverted')),
  mapping_config jsonb not null default '{}'::jsonb,
  total_rows integer not null default 0,
  successful_rows integer not null default 0,
  skipped_rows integer not null default 0,
  failed_rows integer not null default 0,
  result_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists import_batch_rows (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references import_batches(id) on delete cascade,
  row_number integer not null,
  original_data jsonb not null default '{}'::jsonb,
  mapped_data jsonb not null default '{}'::jsonb,
  validation_errors jsonb not null default '[]'::jsonb,
  duplicate_warnings jsonb not null default '[]'::jsonb,
  requires_confirmation boolean not null default false,
  excluded boolean not null default false,
  duplicate_decision text not null default 'pending' check (duplicate_decision in ('pending', 'skip', 'update_existing', 'import_as_new')),
  result_status text not null default 'pending' check (result_status in ('pending', 'success', 'skipped', 'failed')),
  result_message text,
  supplier_id uuid references suppliers(id) on delete set null,
  recurring_obligation_id uuid references recurring_obligations(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (import_batch_id, row_number)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'suppliers_source_import_batch_id_fkey') then
    alter table suppliers add constraint suppliers_source_import_batch_id_fkey foreign key (source_import_batch_id) references import_batches(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'suppliers_source_import_row_id_fkey') then
    alter table suppliers add constraint suppliers_source_import_row_id_fkey foreign key (source_import_row_id) references import_batch_rows(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'recurring_obligations_source_import_batch_id_fkey') then
    alter table recurring_obligations add constraint recurring_obligations_source_import_batch_id_fkey foreign key (source_import_batch_id) references import_batches(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'recurring_obligations_source_import_row_id_fkey') then
    alter table recurring_obligations add constraint recurring_obligations_source_import_row_id_fkey foreign key (source_import_row_id) references import_batch_rows(id) on delete set null;
  end if;
end $$;

create index if not exists import_batches_uploaded_by_idx on import_batches(uploaded_by, uploaded_at desc);
create index if not exists import_batches_status_idx on import_batches(status);
create index if not exists import_batch_rows_batch_idx on import_batch_rows(import_batch_id, row_number);
create index if not exists suppliers_source_import_idx on suppliers(source_import_batch_id, source_import_row_id);
create index if not exists recurring_source_import_idx on recurring_obligations(source_import_batch_id, source_import_row_id);

alter table import_batches enable row level security;
alter table import_batch_rows enable row level security;

drop policy if exists "import_batches_owner_select" on import_batches;
create policy "import_batches_owner_select" on import_batches for select to authenticated using (app_private.current_user_is_owner());
drop policy if exists "import_batches_owner_insert" on import_batches;
create policy "import_batches_owner_insert" on import_batches for insert to authenticated with check (app_private.current_user_is_owner());
drop policy if exists "import_batches_owner_update" on import_batches;
create policy "import_batches_owner_update" on import_batches for update to authenticated using (app_private.current_user_is_owner()) with check (app_private.current_user_is_owner());
drop policy if exists "import_batch_rows_owner_select" on import_batch_rows;
create policy "import_batch_rows_owner_select" on import_batch_rows for select to authenticated using (app_private.current_user_is_owner());
drop policy if exists "import_batch_rows_owner_insert" on import_batch_rows;
create policy "import_batch_rows_owner_insert" on import_batch_rows for insert to authenticated with check (app_private.current_user_is_owner());
drop policy if exists "import_batch_rows_owner_update" on import_batch_rows;
create policy "import_batch_rows_owner_update" on import_batch_rows for update to authenticated using (app_private.current_user_is_owner()) with check (app_private.current_user_is_owner());

grant select, insert, update on import_batches to authenticated;
grant select, insert, update on import_batch_rows to authenticated;

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
begin
  if not app_private.current_user_is_owner() then raise exception 'Only owner users can revert import batches'; end if;
  select * into batch_record from import_batches where id = p_batch_id for update;
  if batch_record.id is null then raise exception 'Import batch not found'; end if;
  if batch_record.status = 'reverted' then raise exception 'Import batch is already reverted'; end if;

  select jsonb_build_object(
    'recurring_used_by_bills', coalesce(jsonb_agg(distinct ro.id) filter (where sb.id is not null), '[]'::jsonb),
    'suppliers_used_by_bills', coalesce(jsonb_agg(distinct s.id) filter (where sb2.id is not null), '[]'::jsonb),
    'suppliers_used_by_vouchers', coalesce(jsonb_agg(distinct s.id) filter (where pv.id is not null), '[]'::jsonb)
  ) into blocked
  from import_batches ib
  left join recurring_obligations ro on ro.source_import_batch_id = ib.id
  left join supplier_bills sb on sb.recurring_obligation_id = ro.id
  left join suppliers s on s.source_import_batch_id = ib.id
  left join supplier_bills sb2 on sb2.supplier_id = s.id
  left join payment_vouchers pv on pv.supplier_id = s.id
  where ib.id = p_batch_id;

  delete from recurring_obligations ro where ro.source_import_batch_id = p_batch_id and not exists (select 1 from supplier_bills sb where sb.recurring_obligation_id = ro.id);
  get diagnostics removed_recurring = row_count;
  delete from supplier_entities se using suppliers s where se.supplier_id = s.id and s.source_import_batch_id = p_batch_id and not exists (select 1 from supplier_bills sb where sb.supplier_id = s.id) and not exists (select 1 from payment_vouchers pv where pv.supplier_id = s.id);
  delete from suppliers s where s.source_import_batch_id = p_batch_id and not exists (select 1 from supplier_bills sb where sb.supplier_id = s.id) and not exists (select 1 from payment_vouchers pv where pv.supplier_id = s.id);
  get diagnostics removed_suppliers = row_count;
  update import_batches set status = 'reverted', result_summary = jsonb_build_object('removed_suppliers', removed_suppliers, 'removed_recurring_obligations', removed_recurring, 'blocked', blocked), updated_at = now() where id = p_batch_id;
  insert into audit_logs (actor_user_id, action, entity_type, entity_id, payload, data_origin) values (auth.uid(), 'supplier_recurring_import_reverted', 'import_batch', p_batch_id, jsonb_build_object('removed_suppliers', removed_suppliers, 'removed_recurring_obligations', removed_recurring, 'blocked', blocked), 'manual');
  return jsonb_build_object('removed_suppliers', removed_suppliers, 'removed_recurring_obligations', removed_recurring, 'blocked', blocked);
end;
$$;

revoke all on function public.revert_supplier_recurring_import_batch(uuid) from public;
grant execute on function public.revert_supplier_recurring_import_batch(uuid) to authenticated;
notify pgrst, 'reload schema';
