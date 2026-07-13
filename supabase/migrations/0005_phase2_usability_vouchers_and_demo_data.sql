-- Phase 2 usability pass: voucher lifecycle, supplier defaults, demo-data controls
-- Additive only. This migration does not insert demo data or modify production records.

alter table public.suppliers
  add column if not exists default_description text,
  add column if not exists is_demo boolean not null default false,
  add column if not exists data_origin text not null default 'manual',
  add column if not exists archived_at timestamptz;

alter table public.supplier_entities
  add column if not exists is_demo boolean not null default false,
  add column if not exists data_origin text not null default 'manual';

alter table public.supplier_bills
  add column if not exists is_demo boolean not null default false,
  add column if not exists data_origin text not null default 'manual';

alter table public.recurring_obligations
  add column if not exists is_demo boolean not null default false,
  add column if not exists data_origin text not null default 'manual';

alter table public.documents
  add column if not exists is_demo boolean not null default false,
  add column if not exists data_origin text not null default 'manual';

alter table public.document_links
  add column if not exists is_demo boolean not null default false,
  add column if not exists data_origin text not null default 'manual';

alter table public.payment_vouchers
  add column if not exists voucher_source text not null default 'manual',
  add column if not exists paying_bank_account_id uuid references public.bank_accounts(id),
  add column if not exists payee_bank_details text,
  add column if not exists recurring_obligation_id uuid references public.recurring_obligations(id),
  add column if not exists is_demo boolean not null default false,
  add column if not exists data_origin text not null default 'manual';

alter table public.payment_voucher_items
  add column if not exists expense_category_id uuid references public.expense_categories(id),
  add column if not exists recurring_obligation_id uuid references public.recurring_obligations(id),
  add column if not exists is_demo boolean not null default false,
  add column if not exists data_origin text not null default 'manual';

alter table public.bill_payments
  add column if not exists is_demo boolean not null default false,
  add column if not exists data_origin text not null default 'manual';

create index if not exists idx_suppliers_demo on public.suppliers(is_demo, data_origin);
create index if not exists idx_supplier_entities_supplier_entity on public.supplier_entities(supplier_id, entity_id);
create index if not exists idx_supplier_bills_demo on public.supplier_bills(is_demo, data_origin);
create index if not exists idx_recurring_obligations_demo on public.recurring_obligations(is_demo, data_origin);
create index if not exists idx_documents_demo on public.documents(is_demo, data_origin);
create index if not exists idx_document_links_demo on public.document_links(is_demo, data_origin);
create index if not exists idx_payment_vouchers_demo on public.payment_vouchers(is_demo, data_origin);
create index if not exists idx_payment_voucher_items_demo on public.payment_voucher_items(is_demo, data_origin);

alter table public.payment_vouchers
  drop constraint if exists payment_vouchers_voucher_source_check;
alter table public.payment_vouchers
  add constraint payment_vouchers_voucher_source_check
  check (voucher_source in ('manual','supplier_bill','recurring_obligation','demo'));

create or replace function public.remove_phase2_demo_data()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_profile public.app_profiles%rowtype;
  deleted_counts jsonb;
begin
  select * into current_profile
  from public.app_profiles
  where user_id = auth.uid()
    and active_status = true;

  if current_profile.id is null or current_profile.role <> 'owner' then
    raise exception 'Only an active owner may remove Phase 2 demo data';
  end if;

  delete from public.document_links where is_demo = true or data_origin = 'demo';
  delete from public.documents where is_demo = true or data_origin = 'demo';
  delete from public.bill_payments where is_demo = true or data_origin = 'demo';
  delete from public.payment_voucher_items where is_demo = true or data_origin = 'demo';
  delete from public.payment_vouchers where is_demo = true or data_origin = 'demo';
  delete from public.recurring_obligations where is_demo = true or data_origin = 'demo';
  delete from public.supplier_bills where is_demo = true or data_origin = 'demo';
  delete from public.supplier_entities where is_demo = true or data_origin = 'demo';
  delete from public.suppliers where is_demo = true or data_origin = 'demo';

  deleted_counts := jsonb_build_object('removed', true, 'removed_at', now());

  insert into public.audit_log(user_id, action, table_name, record_id, metadata)
  values (auth.uid(), 'phase2_demo_data_removed', 'phase2_demo_data', null, deleted_counts);

  return deleted_counts;
end;
$$;

grant execute on function public.remove_phase2_demo_data() to authenticated;

notify pgrst, 'reload schema';
