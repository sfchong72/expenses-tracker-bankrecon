-- Phase 2 Finance baseline reconciliation.
--
-- DRAFT ONLY. Forward-only reconciliation of the approved, read-only
-- Production catalog comparison through migration 0018. This migration must
-- be tested in the disposable local Supabase lab before any Production review.
-- It deliberately does not recreate migration 0019, modify Student Phase 1B,
-- or grant direct physical DELETE access to public.documents.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '10min';

do $preflight$
begin
  if current_setting('server_version_num')::integer < 150000 then
    raise exception '0020 requires PostgreSQL 15 or newer';
  end if;

  if to_regclass('public.bill_payments') is null
     or to_regclass('public.document_links') is null
     or to_regclass('public.documents') is null
     or to_regclass('public.finance_user_permissions') is null
     or to_regclass('public.payment_voucher_items') is null
     or to_regclass('public.payment_voucher_sequences') is null
     or to_regclass('public.payment_vouchers') is null
     or to_regclass('public.recurring_obligations') is null
     or to_regclass('public.supplier_bills') is null then
    raise exception '0020 preflight failed: expected Phase 2 Finance tables are missing';
  end if;

  if to_regprocedure('app_private.current_user_can(text)') is null
     or to_regprocedure('app_private.current_user_is_owner()') is null
     or to_regprocedure('app_private.user_can_access_entity(uuid)') is null
     or to_regprocedure('public.generate_payment_voucher_number(uuid)') is null
     or to_regprocedure('public.recalculate_supporting_document_status(text,uuid)') is null then
    raise exception '0020 preflight failed: expected Finance authorization or document functions are missing';
  end if;
end
$preflight$;

-- Reconcile only an approved source FK state (implicit ON DELETE NO ACTION)
-- or the approved target state. Any third state aborts instead of being
-- overwritten. New constraints are validated before the transaction commits.
do $foreign_keys$
declare
  spec record;
  existing record;
begin
  for spec in
    select *
    from (values
      ('public','bill_payments','bill_payments_bank_account_id_fkey','bank_account_id','public','bank_accounts','id','n','SET NULL'),
      ('public','bill_payments','bill_payments_bank_transaction_id_fkey','bank_transaction_id','public','bank_transactions','id','n','SET NULL'),
      ('public','bill_payments','bill_payments_created_by_fkey','created_by','auth','users','id','n','SET NULL'),
      ('public','bill_payments','bill_payments_entity_id_fkey','entity_id','public','entities','id','r','RESTRICT'),
      ('public','bill_payments','bill_payments_payment_voucher_id_fkey','payment_voucher_id','public','payment_vouchers','id','n','SET NULL'),
      ('public','document_links','document_links_created_by_fkey','created_by','auth','users','id','n','SET NULL'),
      ('public','document_links','document_links_entity_id_fkey','entity_id','public','entities','id','r','RESTRICT'),
      ('public','documents','documents_archived_by_fkey','archived_by','auth','users','id','n','SET NULL'),
      ('public','documents','documents_deleted_by_fkey','deleted_by','auth','users','id','n','SET NULL'),
      ('public','documents','documents_entity_id_fkey','entity_id','public','entities','id','r','RESTRICT'),
      ('public','documents','documents_replaces_document_id_fkey','replaces_document_id','public','documents','id','n','SET NULL'),
      ('public','documents','documents_uploaded_by_fkey','uploaded_by','auth','users','id','n','SET NULL'),
      ('public','payment_voucher_items','payment_voucher_items_supplier_bill_id_fkey','supplier_bill_id','public','supplier_bills','id','n','SET NULL'),
      ('public','payment_voucher_sequences','payment_voucher_sequences_entity_id_fkey','entity_id','public','entities','id','c','CASCADE'),
      ('public','payment_vouchers','payment_vouchers_cancelled_by_fkey','cancelled_by','auth','users','id','n','SET NULL'),
      ('public','payment_vouchers','payment_vouchers_entity_id_fkey','entity_id','public','entities','id','r','RESTRICT'),
      ('public','payment_vouchers','payment_vouchers_prepared_by_fkey','prepared_by','auth','users','id','n','SET NULL'),
      ('public','payment_vouchers','payment_vouchers_supplier_id_fkey','supplier_id','public','suppliers','id','n','SET NULL'),
      ('public','recurring_obligations','recurring_obligations_created_by_fkey','created_by','auth','users','id','n','SET NULL'),
      ('public','recurring_obligations','recurring_obligations_entity_id_fkey','entity_id','public','entities','id','r','RESTRICT'),
      ('public','recurring_obligations','recurring_obligations_supplier_id_fkey','supplier_id','public','suppliers','id','n','SET NULL'),
      ('public','supplier_bills','supplier_bills_created_by_fkey','created_by','auth','users','id','n','SET NULL'),
      ('public','supplier_bills','supplier_bills_entity_id_fkey','entity_id','public','entities','id','r','RESTRICT'),
      ('public','supplier_bills','supplier_bills_expense_category_id_fkey','expense_category_id','public','categories','id','n','SET NULL'),
      ('public','supplier_bills','supplier_bills_recurring_obligation_id_fkey','recurring_obligation_id','public','recurring_obligations','id','n','SET NULL'),
      ('public','supplier_bills','supplier_bills_supplier_id_fkey','supplier_id','public','suppliers','id','n','SET NULL')
    ) as v(
      table_schema, table_name, constraint_name, column_name,
      referenced_schema, referenced_table, referenced_column,
      target_delete_code, target_delete_sql
    )
  loop
    select
      c.oid,
      c.confdeltype::text as delete_code,
      c.confupdtype::text as update_code,
      c.condeferrable,
      c.condeferred,
      c.convalidated,
      source_column.attname as source_column,
      referenced_namespace.nspname as referenced_schema,
      referenced_relation.relname as referenced_table,
      referenced_column.attname as referenced_column,
      cardinality(c.conkey) as source_column_count,
      cardinality(c.confkey) as referenced_column_count
    into existing
    from pg_constraint c
    join pg_attribute source_column
      on source_column.attrelid = c.conrelid
     and source_column.attnum = c.conkey[1]
    join pg_class referenced_relation on referenced_relation.oid = c.confrelid
    join pg_namespace referenced_namespace on referenced_namespace.oid = referenced_relation.relnamespace
    join pg_attribute referenced_column
      on referenced_column.attrelid = c.confrelid
     and referenced_column.attnum = c.confkey[1]
    where c.conrelid = format('%I.%I', spec.table_schema, spec.table_name)::regclass
      and c.conname = spec.constraint_name
      and c.contype = 'f';

    if not found then
      raise exception '0020 preflight failed: expected FK %.%.% is missing',
        spec.table_schema, spec.table_name, spec.constraint_name;
    end if;

    if existing.source_column_count <> 1
       or existing.referenced_column_count <> 1
       or existing.source_column <> spec.column_name
       or existing.referenced_schema <> spec.referenced_schema
       or existing.referenced_table <> spec.referenced_table
       or existing.referenced_column <> spec.referenced_column
       or existing.update_code <> 'a'
       or existing.condeferrable
       or existing.condeferred
       or not existing.convalidated then
      raise exception '0020 preflight failed: unexpected definition for FK %.%.%',
        spec.table_schema, spec.table_name, spec.constraint_name;
    end if;

    if existing.delete_code = spec.target_delete_code then
      continue;
    end if;

    if existing.delete_code <> 'a' then
      raise exception '0020 preflight failed: FK %.%.% has unapproved ON DELETE state %',
        spec.table_schema, spec.table_name, spec.constraint_name, existing.delete_code;
    end if;

    execute format(
      'alter table %I.%I drop constraint %I',
      spec.table_schema, spec.table_name, spec.constraint_name
    );

    execute format(
      'alter table %I.%I add constraint %I foreign key (%I) references %I.%I (%I) on delete %s not valid',
      spec.table_schema, spec.table_name, spec.constraint_name,
      spec.column_name,
      spec.referenced_schema, spec.referenced_table, spec.referenced_column,
      spec.target_delete_sql
    );

    execute format(
      'alter table %I.%I validate constraint %I',
      spec.table_schema, spec.table_name, spec.constraint_name
    );
  end loop;
end
$foreign_keys$;

do $reminder_days$
declare
  constraint_oid oid;
  constraint_definition text;
  constraint_validated boolean;
begin
  select c.oid, pg_get_constraintdef(c.oid, true), c.convalidated
  into constraint_oid, constraint_definition, constraint_validated
  from pg_constraint c
  where c.conrelid = 'public.recurring_obligations'::regclass
    and c.conname = 'recurring_obligations_reminder_days_check'
    and c.contype = 'c';

  if constraint_oid is not null
     and constraint_definition <> 'CHECK (reminder_days >= 0 AND reminder_days <= 31)' then
    raise exception '0020 preflight failed: unexpected recurring_obligations_reminder_days_check definition: %',
      constraint_definition;
  end if;

  if exists (
    select 1
    from public.recurring_obligations
    where reminder_days < 0 or reminder_days > 31
  ) then
    raise exception '0020 preflight failed: reminder_days contains values outside 0..31';
  end if;

  if constraint_oid is null then
    alter table public.recurring_obligations
      add constraint recurring_obligations_reminder_days_check
      check (reminder_days >= 0 and reminder_days <= 31) not valid;
    alter table public.recurring_obligations
      validate constraint recurring_obligations_reminder_days_check;
  elsif not constraint_validated then
    alter table public.recurring_obligations
      validate constraint recurring_obligations_reminder_days_check;
  end if;
end
$reminder_days$;

do $index_preflight$
declare
  index_is_expected boolean;
begin
  if to_regclass('public.documents_uploaded_by_idx') is not null then
    index_is_expected := false;
    select
      i.indisvalid
      and i.indisready
      and not i.indisunique
      and i.indpred is null
      and pg_get_indexdef(i.indexrelid, 1, true) = 'uploaded_by'
    into index_is_expected
    from pg_index i
    where i.indexrelid = 'public.documents_uploaded_by_idx'::regclass
      and i.indrelid = 'public.documents'::regclass;

    if coalesce(index_is_expected, false) = false then
      raise exception '0020 preflight failed: documents_uploaded_by_idx has an unexpected definition';
    end if;
  end if;

  if to_regclass('public.supplier_bills_document_status_idx') is not null then
    index_is_expected := false;
    select
      i.indisvalid
      and i.indisready
      and not i.indisunique
      and i.indpred is null
      and pg_get_indexdef(i.indexrelid, 1, true) = 'supporting_document_status'
    into index_is_expected
    from pg_index i
    where i.indexrelid = 'public.supplier_bills_document_status_idx'::regclass
      and i.indrelid = 'public.supplier_bills'::regclass;

    if coalesce(index_is_expected, false) = false then
      raise exception '0020 preflight failed: supplier_bills_document_status_idx has an unexpected definition';
    end if;
  end if;
end
$index_preflight$;

create index if not exists documents_uploaded_by_idx
  on public.documents using btree (uploaded_by);

create index if not exists supplier_bills_document_status_idx
  on public.supplier_bills using btree (supporting_document_status);

create or replace function public.set_phase2_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

create or replace function public.recalculate_document_link_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if tg_op = 'DELETE' then
    perform public.recalculate_supporting_document_status(old.linked_record_type, old.linked_record_id);
    return old;
  end if;

  perform public.recalculate_supporting_document_status(new.linked_record_type, new.linked_record_id);
  return new;
end;
$function$;

-- Trigger functions are internal database implementation details. PostgreSQL
-- does not require the invoking table user to retain direct EXECUTE on them.
revoke all privileges on function public.recalculate_document_link_status()
  from public, anon, authenticated, service_role;
revoke all privileges on function public.set_phase2_updated_at()
  from public, anon, authenticated, service_role;

drop trigger if exists set_bill_payments_updated_at on public.bill_payments;
create trigger set_bill_payments_updated_at
before update on public.bill_payments
for each row execute function public.set_phase2_updated_at();

drop trigger if exists recalculate_document_link_status_trigger on public.document_links;
create trigger recalculate_document_link_status_trigger
after insert or update or delete on public.document_links
for each row execute function public.recalculate_document_link_status();

drop trigger if exists set_documents_updated_at on public.documents;
create trigger set_documents_updated_at
before update on public.documents
for each row execute function public.set_phase2_updated_at();

drop trigger if exists set_finance_user_permissions_updated_at on public.finance_user_permissions;
create trigger set_finance_user_permissions_updated_at
before update on public.finance_user_permissions
for each row execute function public.set_phase2_updated_at();

drop trigger if exists set_payment_vouchers_updated_at on public.payment_vouchers;
create trigger set_payment_vouchers_updated_at
before update on public.payment_vouchers
for each row execute function public.set_phase2_updated_at();

drop trigger if exists set_recurring_obligations_updated_at on public.recurring_obligations;
create trigger set_recurring_obligations_updated_at
before update on public.recurring_obligations
for each row execute function public.set_phase2_updated_at();

drop trigger if exists set_supplier_bills_updated_at on public.supplier_bills;
create trigger set_supplier_bills_updated_at
before update on public.supplier_bills
for each row execute function public.set_phase2_updated_at();

alter table public.bill_payments enable row level security;
drop policy if exists bill_payments_entity_all on public.bill_payments;
drop policy if exists bill_payments_entity_select on public.bill_payments;
drop policy if exists bill_payments_entity_insert on public.bill_payments;
drop policy if exists bill_payments_entity_update on public.bill_payments;
create policy bill_payments_entity_select
  on public.bill_payments for select to authenticated
  using (app_private.user_can_access_entity(entity_id));
create policy bill_payments_entity_insert
  on public.bill_payments for insert to authenticated
  with check (app_private.user_can_access_entity(entity_id));
create policy bill_payments_entity_update
  on public.bill_payments for update to authenticated
  using (app_private.user_can_access_entity(entity_id))
  with check (app_private.user_can_access_entity(entity_id));

alter table public.supplier_bills enable row level security;
drop policy if exists supplier_bills_entity_all on public.supplier_bills;
drop policy if exists supplier_bills_entity_select on public.supplier_bills;
drop policy if exists supplier_bills_entity_insert on public.supplier_bills;
drop policy if exists supplier_bills_entity_update on public.supplier_bills;
create policy supplier_bills_entity_select
  on public.supplier_bills for select to authenticated
  using (app_private.user_can_access_entity(entity_id));
create policy supplier_bills_entity_insert
  on public.supplier_bills for insert to authenticated
  with check (app_private.user_can_access_entity(entity_id));
create policy supplier_bills_entity_update
  on public.supplier_bills for update to authenticated
  using (app_private.user_can_access_entity(entity_id))
  with check (app_private.user_can_access_entity(entity_id));

alter table public.document_links enable row level security;
drop policy if exists document_links_manage on public.document_links;
drop policy if exists document_links_delete on public.document_links;
create policy document_links_manage
  on public.document_links for update to authenticated
  using (
    app_private.current_user_can('can_manage_documents')
    or app_private.current_user_is_owner()
  )
  with check (
    app_private.current_user_can('can_manage_documents')
    or app_private.current_user_is_owner()
  );
create policy document_links_delete
  on public.document_links for delete to authenticated
  using (
    app_private.current_user_can('can_manage_documents')
    or app_private.current_user_is_owner()
  );

alter table public.payment_voucher_sequences enable row level security;
drop policy if exists payment_voucher_sequences_owner on public.payment_voucher_sequences;
drop policy if exists payment_voucher_sequences_owner_select on public.payment_voucher_sequences;
drop policy if exists payment_voucher_sequences_owner_update on public.payment_voucher_sequences;
create policy payment_voucher_sequences_owner_select
  on public.payment_voucher_sequences for select to authenticated
  using (app_private.current_user_is_owner());
create policy payment_voucher_sequences_owner_update
  on public.payment_voucher_sequences for all to authenticated
  using (app_private.current_user_is_owner())
  with check (app_private.current_user_is_owner());

-- Owner approval: documents use archive/soft-delete. Direct physical DELETE is
-- unavailable even if a future policy is accidentally introduced without a
-- matching relation privilege. A separate audited purge workflow is deferred.
drop policy if exists documents_delete_owner on public.documents;
revoke delete on table public.documents from authenticated, anon, service_role;

-- Preserve the existing voucher numbering implementation unchanged.
-- It remains the database-atomic writer for payment_voucher_sequences.

notify pgrst, 'reload schema';

commit;
