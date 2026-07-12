create extension if not exists pgcrypto;

create table if not exists finance_user_permissions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  can_view_documents boolean not null default false,
  can_upload_documents boolean not null default false,
  can_manage_documents boolean not null default false,
  can_view_bank_balances boolean not null default false,
  can_manage_recurring_bills boolean not null default false,
  can_generate_payment_vouchers boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function app_private.current_user_can(permission_name text)
returns boolean language plpgsql security definer set search_path = public, auth as $$
declare profile_role text; is_active boolean; explicit_value boolean;
begin
  select role, active_status into profile_role, is_active from public.app_profiles where id = auth.uid();
  if coalesce(is_active, false) = false then return false; end if;
  if profile_role = 'owner' then return true; end if;
  execute format('select %I from public.finance_user_permissions where user_id = $1', permission_name) using auth.uid() into explicit_value;
  if explicit_value is not null then return explicit_value; end if;
  if permission_name = 'can_view_documents' then return profile_role in ('finance_manager','finance_staff','data_entry','read_only');
  elsif permission_name = 'can_upload_documents' then return profile_role in ('finance_manager','finance_staff','data_entry');
  elsif permission_name in ('can_manage_documents','can_manage_recurring_bills','can_generate_payment_vouchers') then return profile_role = 'finance_manager';
  elsif permission_name = 'can_view_bank_balances' then return false;
  end if;
  return false;
end; $$;
revoke all on function app_private.current_user_can(text) from public;
grant execute on function app_private.current_user_can(text) to authenticated;

create table if not exists documents (
  id uuid primary key default gen_random_uuid(), entity_id uuid not null references entities(id),
  document_type text not null check (document_type in ('supplier_invoice','receipt','payment_slip','payment_voucher','quotation','contract','payroll_support','other')),
  original_filename text not null, storage_path text not null unique, mime_type text not null,
  file_size bigint not null check (file_size > 0 and file_size <= 10485760), file_hash text,
  uploaded_by uuid references auth.users(id), uploaded_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active','replaced','archived','deleted')),
  is_archived boolean not null default false, archived_at timestamptz, archived_by uuid references auth.users(id),
  version_number integer not null default 1, replaces_document_id uuid references documents(id),
  deleted_at timestamptz, deleted_by uuid references auth.users(id), deletion_reason text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (status <> 'deleted' or nullif(deletion_reason, '') is not null)
);

create table if not exists document_links (
  id uuid primary key default gen_random_uuid(), document_id uuid not null references documents(id) on delete cascade,
  entity_id uuid not null references entities(id), linked_record_type text not null check (linked_record_type in ('supplier_bill','payment_voucher','bill_payment','bank_transaction','recurring_obligation','other')),
  linked_record_id uuid not null, created_by uuid references auth.users(id), created_at timestamptz not null default now(),
  unique (document_id, linked_record_type, linked_record_id)
);

create table if not exists recurring_obligations (
  id uuid primary key default gen_random_uuid(), entity_id uuid not null references entities(id), supplier_id uuid references suppliers(id),
  description text not null, frequency text not null default 'monthly' check (frequency in ('monthly')),
  start_date date not null default current_date, end_date date, fixed_or_variable text not null default 'fixed' check (fixed_or_variable in ('fixed','variable')),
  expected_amount numeric(14,2) not null default 0, due_day integer not null check (due_day between 1 and 31), reminder_days integer not null default 3,
  required_document_type text not null default 'supplier_invoice' check (required_document_type in ('supplier_invoice','receipt','payment_slip','payment_voucher','quotation','contract','payroll_support','other','not_applicable')),
  next_due_date date, next_generation_date date, last_generated_date date, auto_generate_bill boolean not null default true, auto_generate_pv boolean not null default true,
  active_status boolean not null default true, remarks text, created_by uuid references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists supplier_bills (
  id uuid primary key default gen_random_uuid(), entity_id uuid not null references entities(id), supplier_id uuid references suppliers(id), bill_number text,
  description text not null, bill_type text not null default 'supplier_invoice' check (bill_type in ('supplier_invoice','recurring_obligation','statutory_payment','payroll_support','other')),
  bill_date date not null default current_date, due_date date not null, subtotal numeric(14,2) not null default 0, tax_amount numeric(14,2) not null default 0,
  total_amount numeric(14,2) not null default 0, outstanding_amount numeric(14,2) not null default 0, currency text not null default 'MYR', expense_category_id uuid references categories(id),
  payment_status text not null default 'draft' check (payment_status in ('draft','unpaid','scheduled','partially_paid','paid','overdue','cancelled')),
  payment_date date, payment_reference text, payment_method text,
  supporting_document_status text not null default 'no_document' check (supporting_document_status in ('no_document','invoice_uploaded','payment_slip_uploaded','partial_evidence','complete','not_applicable')),
  not_applicable_reason text, is_recurring_generated boolean not null default false, recurring_obligation_id uuid references recurring_obligations(id), generated_month text, remarks text,
  created_by uuid references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (recurring_obligation_id, generated_month), check (supporting_document_status <> 'not_applicable' or nullif(not_applicable_reason, '') is not null)
);

create table if not exists payment_vouchers (
  id uuid primary key default gen_random_uuid(), entity_id uuid not null references entities(id), supplier_id uuid references suppliers(id), voucher_number text,
  voucher_date date not null default current_date, payee text not null, purpose text not null, total_amount numeric(14,2) not null default 0, currency text not null default 'MYR',
  payment_method text, bank_reference text, status text not null default 'draft' check (status in ('draft','issued','paid','cancelled')),
  prepared_by uuid references auth.users(id), remarks text, issued_at timestamptz, cancelled_at timestamptz, cancelled_by uuid references auth.users(id), cancellation_reason text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (entity_id, voucher_number), check (status <> 'cancelled' or nullif(cancellation_reason, '') is not null)
);

create table if not exists payment_voucher_items (
  id uuid primary key default gen_random_uuid(), payment_voucher_id uuid not null references payment_vouchers(id) on delete cascade,
  supplier_bill_id uuid references supplier_bills(id), description text not null, amount numeric(14,2) not null check (amount >= 0), sort_order integer not null default 1, created_at timestamptz not null default now()
);

create table if not exists payment_voucher_sequences (
  entity_id uuid not null references entities(id), sequence_year integer not null, sequence_month integer not null, last_number integer not null default 0, updated_at timestamptz not null default now(), primary key (entity_id, sequence_year, sequence_month)
);

create table if not exists bill_payments (
  id uuid primary key default gen_random_uuid(), entity_id uuid not null references entities(id), supplier_bill_id uuid not null references supplier_bills(id) on delete cascade,
  payment_voucher_id uuid references payment_vouchers(id), bank_account_id uuid references bank_accounts(id), payment_date date not null default current_date,
  amount numeric(14,2) not null check (amount > 0), method text, payment_reference text, bank_transaction_id uuid references bank_transactions(id),
  supporting_document_status text not null default 'no_document' check (supporting_document_status in ('no_document','invoice_uploaded','payment_slip_uploaded','partial_evidence','complete','not_applicable')),
  not_applicable_reason text, remarks text, created_by uuid references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (supporting_document_status <> 'not_applicable' or nullif(not_applicable_reason, '') is not null)
);

create index if not exists documents_entity_idx on documents(entity_id); create index if not exists documents_file_hash_idx on documents(file_hash);
create index if not exists document_links_record_idx on document_links(linked_record_type, linked_record_id);
create index if not exists supplier_bills_entity_due_status_idx on supplier_bills(entity_id, due_date, payment_status);
create index if not exists recurring_obligations_generation_idx on recurring_obligations(entity_id, active_status, next_generation_date);
create index if not exists payment_vouchers_number_idx on payment_vouchers(entity_id, voucher_number); create index if not exists bill_payments_bill_idx on bill_payments(supplier_bill_id, payment_date);

create or replace function public.generate_payment_voucher_number(p_entity_id uuid)
returns text language plpgsql security definer set search_path = public, auth as $$
declare yy integer := extract(year from current_date)::integer % 100; mm integer := extract(month from current_date)::integer; seq integer; entity_code text;
begin
  if not app_private.current_user_can('can_generate_payment_vouchers') then raise exception 'Not authorised to generate payment vouchers'; end if;
  select short_code into entity_code from entities where id = p_entity_id; if entity_code is null then raise exception 'Unknown entity'; end if;
  insert into payment_voucher_sequences(entity_id, sequence_year, sequence_month, last_number) values (p_entity_id, yy, mm, 1)
  on conflict(entity_id, sequence_year, sequence_month) do update set last_number = payment_voucher_sequences.last_number + 1, updated_at = now() returning last_number into seq;
  return entity_code || '/PV' || lpad(yy::text,2,'0') || '-' || lpad(mm::text,2,'0') || '/' || lpad(seq::text,3,'0');
end; $$;
revoke all on function public.generate_payment_voucher_number(uuid) from public; grant execute on function public.generate_payment_voucher_number(uuid) to authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types) values ('bill-documents','bill-documents',false,10485760,array['application/pdf','image/jpeg','image/png'])
on conflict(id) do update set public=false, file_size_limit=10485760, allowed_mime_types=array['application/pdf','image/jpeg','image/png'];

alter table finance_user_permissions enable row level security; alter table documents enable row level security; alter table document_links enable row level security; alter table supplier_bills enable row level security; alter table recurring_obligations enable row level security; alter table payment_vouchers enable row level security; alter table payment_voucher_items enable row level security; alter table payment_voucher_sequences enable row level security; alter table bill_payments enable row level security;

create policy "finance_user_permissions_owner_all" on finance_user_permissions for all to authenticated using (app_private.current_user_is_owner()) with check (app_private.current_user_is_owner());
create policy "finance_user_permissions_read_self" on finance_user_permissions for select to authenticated using (user_id = auth.uid() or app_private.current_user_is_owner());
create policy "documents_view" on documents for select to authenticated using (app_private.current_user_can('can_view_documents'));
create policy "documents_insert" on documents for insert to authenticated with check (app_private.current_user_can('can_upload_documents') and uploaded_by = auth.uid());
create policy "documents_manage" on documents for update to authenticated using (app_private.current_user_can('can_manage_documents') or app_private.current_user_is_owner()) with check (app_private.current_user_can('can_manage_documents') or app_private.current_user_is_owner());
create policy "document_links_view" on document_links for select to authenticated using (app_private.current_user_can('can_view_documents'));
create policy "document_links_insert" on document_links for insert to authenticated with check (app_private.current_user_can('can_upload_documents'));
create policy "document_links_manage" on document_links for all to authenticated using (app_private.current_user_can('can_manage_documents') or app_private.current_user_is_owner()) with check (app_private.current_user_can('can_manage_documents') or app_private.current_user_is_owner());
create policy "supplier_bills_entity_all" on supplier_bills for all to authenticated using (app_private.user_can_access_entity(entity_id)) with check (app_private.user_can_access_entity(entity_id));
create policy "recurring_obligations_entity_select" on recurring_obligations for select to authenticated using (app_private.user_can_access_entity(entity_id));
create policy "recurring_obligations_manage" on recurring_obligations for all to authenticated using (app_private.user_can_access_entity(entity_id) and app_private.current_user_can('can_manage_recurring_bills')) with check (app_private.user_can_access_entity(entity_id) and app_private.current_user_can('can_manage_recurring_bills'));
create policy "payment_vouchers_entity_select" on payment_vouchers for select to authenticated using (app_private.user_can_access_entity(entity_id));
create policy "payment_vouchers_manage" on payment_vouchers for all to authenticated using (app_private.user_can_access_entity(entity_id) and app_private.current_user_can('can_generate_payment_vouchers')) with check (app_private.user_can_access_entity(entity_id) and app_private.current_user_can('can_generate_payment_vouchers'));
create policy "payment_voucher_items_select" on payment_voucher_items for select to authenticated using (exists (select 1 from payment_vouchers pv where pv.id = payment_voucher_id and app_private.user_can_access_entity(pv.entity_id)));
create policy "payment_voucher_items_manage" on payment_voucher_items for all to authenticated using (exists (select 1 from payment_vouchers pv where pv.id = payment_voucher_id and app_private.user_can_access_entity(pv.entity_id) and app_private.current_user_can('can_generate_payment_vouchers'))) with check (exists (select 1 from payment_vouchers pv where pv.id = payment_voucher_id and app_private.user_can_access_entity(pv.entity_id) and app_private.current_user_can('can_generate_payment_vouchers')));
create policy "payment_voucher_sequences_owner" on payment_voucher_sequences for all to authenticated using (app_private.current_user_is_owner()) with check (app_private.current_user_is_owner());
create policy "bill_payments_entity_all" on bill_payments for all to authenticated using (app_private.user_can_access_entity(entity_id)) with check (app_private.user_can_access_entity(entity_id));
create policy "bill_documents_storage_read" on storage.objects for select to authenticated using (bucket_id = 'bill-documents' and app_private.current_user_can('can_view_documents'));
create policy "bill_documents_storage_insert" on storage.objects for insert to authenticated with check (bucket_id = 'bill-documents' and app_private.current_user_can('can_upload_documents'));
create policy "bill_documents_storage_update" on storage.objects for update to authenticated using (bucket_id = 'bill-documents' and app_private.current_user_can('can_manage_documents')) with check (bucket_id = 'bill-documents' and app_private.current_user_can('can_manage_documents'));
create policy "bill_documents_storage_delete" on storage.objects for delete to authenticated using (bucket_id = 'bill-documents' and app_private.current_user_is_owner());

grant select, insert, update, delete on finance_user_permissions, documents, document_links, supplier_bills, recurring_obligations, payment_vouchers, payment_voucher_items, payment_voucher_sequences, bill_payments to authenticated;
revoke all on finance_user_permissions, documents, document_links, supplier_bills, recurring_obligations, payment_vouchers, payment_voucher_items, payment_voucher_sequences, bill_payments from anon;
