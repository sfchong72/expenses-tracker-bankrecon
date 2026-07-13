alter table suppliers add column if not exists default_description text;
alter table suppliers add column if not exists is_demo boolean not null default false;
alter table suppliers add column if not exists archived_at timestamptz;

alter table supplier_entities add column if not exists is_demo boolean not null default false;
alter table supplier_entities add column if not exists data_origin text not null default 'manual'
  check (data_origin in ('demo', 'production', 'imported', 'manual'));

alter table supplier_bills add column if not exists is_demo boolean not null default false;
alter table supplier_bills add column if not exists data_origin text not null default 'manual'
  check (data_origin in ('demo', 'production', 'imported', 'manual'));

alter table recurring_obligations add column if not exists is_demo boolean not null default false;
alter table recurring_obligations add column if not exists data_origin text not null default 'manual'
  check (data_origin in ('demo', 'production', 'imported', 'manual'));

alter table documents add column if not exists is_demo boolean not null default false;
alter table documents add column if not exists data_origin text not null default 'manual'
  check (data_origin in ('demo', 'production', 'imported', 'manual'));

alter table document_links add column if not exists is_demo boolean not null default false;
alter table document_links add column if not exists data_origin text not null default 'manual'
  check (data_origin in ('demo', 'production', 'imported', 'manual'));

alter table payment_vouchers add column if not exists voucher_source text not null default 'manual'
  check (voucher_source in ('manual', 'supplier_bill', 'recurring_obligation', 'demo'));
alter table payment_vouchers add column if not exists paying_bank_account_id uuid references bank_accounts(id) on delete set null;
alter table payment_vouchers add column if not exists payee_bank_details jsonb not null default '{}'::jsonb;
alter table payment_vouchers add column if not exists recurring_obligation_id uuid references recurring_obligations(id) on delete set null;
alter table payment_vouchers add column if not exists is_demo boolean not null default false;
alter table payment_vouchers add column if not exists data_origin text not null default 'manual'
  check (data_origin in ('demo', 'production', 'imported', 'manual'));

alter table payment_voucher_items add column if not exists expense_category_id uuid references categories(id) on delete set null;
alter table payment_voucher_items add column if not exists recurring_obligation_id uuid references recurring_obligations(id) on delete set null;
alter table payment_voucher_items add column if not exists is_demo boolean not null default false;
alter table payment_voucher_items add column if not exists data_origin text not null default 'manual'
  check (data_origin in ('demo', 'production', 'imported', 'manual'));

alter table bill_payments add column if not exists is_demo boolean not null default false;
alter table bill_payments add column if not exists data_origin text not null default 'manual'
  check (data_origin in ('demo', 'production', 'imported', 'manual'));

create index if not exists suppliers_demo_idx on suppliers(is_demo, active_status);
create index if not exists supplier_entities_entity_active_idx on supplier_entities(entity_id, supplier_id);
create index if not exists supplier_bills_demo_idx on supplier_bills(is_demo, entity_id);
create index if not exists payment_vouchers_source_idx on payment_vouchers(voucher_source, status, is_demo);
create index if not exists payment_voucher_items_category_idx on payment_voucher_items(expense_category_id);
create index if not exists payment_vouchers_recurring_idx on payment_vouchers(recurring_obligation_id);

create or replace function public.remove_phase2_demo_data()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  removed jsonb;
begin
  if not app_private.current_user_is_owner() then
    raise exception 'Only owner users can remove demo data';
  end if;

  with deleted_links as (
    delete from document_links where is_demo = true or data_origin = 'demo' returning 1
  ), deleted_items as (
    delete from payment_voucher_items where is_demo = true or data_origin = 'demo' returning 1
  ), deleted_payments as (
    delete from bill_payments where is_demo = true or data_origin = 'demo' returning 1
  ), deleted_vouchers as (
    delete from payment_vouchers where is_demo = true or data_origin = 'demo' returning 1
  ), deleted_docs as (
    delete from documents where is_demo = true or data_origin = 'demo' returning 1
  ), deleted_bills as (
    delete from supplier_bills where is_demo = true or data_origin = 'demo' returning 1
  ), deleted_recurring as (
    delete from recurring_obligations where is_demo = true or data_origin = 'demo' returning 1
  ), deleted_supplier_entities as (
    delete from supplier_entities where is_demo = true or data_origin = 'demo' returning 1
  ), deleted_suppliers as (
    delete from suppliers where is_demo = true or data_origin = 'demo' returning 1
  )
  select jsonb_build_object(
    'document_links', (select count(*) from deleted_links),
    'payment_voucher_items', (select count(*) from deleted_items),
    'bill_payments', (select count(*) from deleted_payments),
    'payment_vouchers', (select count(*) from deleted_vouchers),
    'documents', (select count(*) from deleted_docs),
    'supplier_bills', (select count(*) from deleted_bills),
    'recurring_obligations', (select count(*) from deleted_recurring),
    'supplier_entities', (select count(*) from deleted_supplier_entities),
    'suppliers', (select count(*) from deleted_suppliers)
  ) into removed;

  insert into audit_logs (actor_user_id, action, entity_type, payload, is_demo, data_origin)
  values (auth.uid(), 'phase2_demo_data_removed', 'phase2_demo_data', removed, false, 'manual');

  return removed;
end;
$$;

revoke all on function public.remove_phase2_demo_data() from public;
grant execute on function public.remove_phase2_demo_data() to authenticated;

notify pgrst, 'reload schema';
