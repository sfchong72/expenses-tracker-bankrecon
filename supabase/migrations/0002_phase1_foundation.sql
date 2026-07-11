create extension if not exists pgcrypto;

create schema if not exists app_private;

create table if not exists entities (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null,
  display_name text not null,
  short_code text not null unique,
  registration_number text,
  tax_number text,
  address text,
  base_currency text not null default 'MYR',
  active_status boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  role text not null default 'read_only' check (role in ('owner', 'finance_manager', 'finance_staff', 'data_entry', 'read_only')),
  active_status boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function app_private.current_user_is_owner()
returns boolean
language sql
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.app_profiles
    where id = auth.uid()
      and role = 'owner'
      and active_status = true
  );
$$;
revoke all on function app_private.current_user_is_owner() from public;
grant usage on schema app_private to authenticated;
grant execute on function app_private.current_user_is_owner() to authenticated;

create table if not exists user_entity_access (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_id uuid not null references entities(id) on delete cascade,
  role text not null default 'data_entry' check (role in ('owner', 'finance_manager', 'finance_staff', 'data_entry', 'read_only')),
  can_manage_bills boolean not null default false,
  can_import_bank boolean not null default false,
  can_reconcile boolean not null default false,
  can_view_sensitive_balances boolean not null default false,
  active_status boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, entity_id)
);

create table if not exists bank_accounts (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references entities(id) on delete restrict,
  bank_name text not null,
  account_name text not null,
  masked_account_number text,
  currency text not null default 'MYR',
  account_type text not null default 'current',
  statement_format text,
  opening_balance numeric(14,2),
  current_balance numeric(14,2),
  closing_balance numeric(14,2),
  owner_only_balance_visibility boolean not null default true,
  remarks text,
  active_status boolean not null default true,
  data_origin text not null default 'manual' check (data_origin in ('demo', 'production', 'imported', 'manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid references entities(id) on delete cascade,
  category_type text not null default 'expense' check (category_type in ('expense', 'income', 'bank_fee', 'tax', 'other')),
  name text not null,
  account_code text,
  active_status boolean not null default true,
  data_origin text not null default 'manual' check (data_origin in ('demo', 'production', 'imported', 'manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, category_type, name)
);

create table if not exists suppliers (
  id uuid primary key default gen_random_uuid(),
  supplier_name text not null,
  registration_number text,
  contact_person text,
  email text,
  phone text,
  bank_details jsonb not null default '{}'::jsonb,
  default_expense_category text,
  account_code text,
  remarks text,
  active_status boolean not null default true,
  data_origin text not null default 'manual' check (data_origin in ('demo', 'production', 'imported', 'manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists supplier_entities (
  supplier_id uuid not null references suppliers(id) on delete cascade,
  entity_id uuid not null references entities(id) on delete cascade,
  default_category_id uuid references categories(id) on delete set null,
  account_code text,
  notes text,
  active_status boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (supplier_id, entity_id)
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
revoke all on function public.set_updated_at() from public;

drop trigger if exists set_entities_updated_at on entities;
create trigger set_entities_updated_at before update on entities for each row execute function public.set_updated_at();
drop trigger if exists set_app_profiles_updated_at on app_profiles;
create trigger set_app_profiles_updated_at before update on app_profiles for each row execute function public.set_updated_at();
drop trigger if exists set_user_entity_access_updated_at on user_entity_access;
create trigger set_user_entity_access_updated_at before update on user_entity_access for each row execute function public.set_updated_at();
drop trigger if exists set_bank_accounts_updated_at on bank_accounts;
create trigger set_bank_accounts_updated_at before update on bank_accounts for each row execute function public.set_updated_at();
drop trigger if exists set_categories_updated_at on categories;
create trigger set_categories_updated_at before update on categories for each row execute function public.set_updated_at();
drop trigger if exists set_suppliers_updated_at on suppliers;
create trigger set_suppliers_updated_at before update on suppliers for each row execute function public.set_updated_at();

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  insert into public.app_profiles (id, email, display_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)),
    'read_only'
  )
  on conflict (id) do update
    set email = excluded.email,
        updated_at = now();
  return new;
end;
$$;
revoke all on function public.handle_new_auth_user() from public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

alter table entities enable row level security;
alter table app_profiles enable row level security;
alter table user_entity_access enable row level security;
alter table bank_accounts enable row level security;
alter table categories enable row level security;
alter table suppliers enable row level security;
alter table supplier_entities enable row level security;

drop policy if exists "entities_owner_all" on entities;
create policy "entities_owner_all" on entities for all to authenticated
using (app_private.current_user_is_owner())
with check (app_private.current_user_is_owner());
drop policy if exists "entities_authenticated_read_active" on entities;
create policy "entities_authenticated_read_active" on entities for select to authenticated
using (active_status = true or app_private.current_user_is_owner());

drop policy if exists "app_profiles_read_self" on app_profiles;
create policy "app_profiles_read_self" on app_profiles for select to authenticated
using (id = auth.uid() or app_private.current_user_is_owner());
drop policy if exists "app_profiles_owner_update" on app_profiles;
create policy "app_profiles_owner_update" on app_profiles for update to authenticated
using (app_private.current_user_is_owner())
with check (app_private.current_user_is_owner());
drop policy if exists "app_profiles_owner_insert" on app_profiles;
create policy "app_profiles_owner_insert" on app_profiles for insert to authenticated
with check (app_private.current_user_is_owner());

drop policy if exists "user_entity_access_owner_all" on user_entity_access;
create policy "user_entity_access_owner_all" on user_entity_access for all to authenticated
using (app_private.current_user_is_owner())
with check (app_private.current_user_is_owner());
drop policy if exists "user_entity_access_read_self" on user_entity_access;
create policy "user_entity_access_read_self" on user_entity_access for select to authenticated
using (user_id = auth.uid() or app_private.current_user_is_owner());

drop policy if exists "bank_accounts_owner_all" on bank_accounts;
create policy "bank_accounts_owner_all" on bank_accounts for all to authenticated
using (app_private.current_user_is_owner())
with check (app_private.current_user_is_owner());

drop policy if exists "categories_owner_all" on categories;
create policy "categories_owner_all" on categories for all to authenticated
using (app_private.current_user_is_owner())
with check (app_private.current_user_is_owner());
drop policy if exists "categories_entity_read" on categories;
create policy "categories_entity_read" on categories for select to authenticated
using (
  app_private.current_user_is_owner()
  or entity_id is null
  or exists (
    select 1
    from user_entity_access uea
    where uea.user_id = auth.uid()
      and uea.entity_id = categories.entity_id
      and uea.active_status = true
  )
);

drop policy if exists "suppliers_owner_all" on suppliers;
create policy "suppliers_owner_all" on suppliers for all to authenticated
using (app_private.current_user_is_owner())
with check (app_private.current_user_is_owner());
drop policy if exists "suppliers_authenticated_read" on suppliers;
create policy "suppliers_authenticated_read" on suppliers for select to authenticated
using (active_status = true or app_private.current_user_is_owner());

drop policy if exists "supplier_entities_owner_all" on supplier_entities;
create policy "supplier_entities_owner_all" on supplier_entities for all to authenticated
using (app_private.current_user_is_owner())
with check (app_private.current_user_is_owner());
drop policy if exists "supplier_entities_entity_read" on supplier_entities;
create policy "supplier_entities_entity_read" on supplier_entities for select to authenticated
using (
  app_private.current_user_is_owner()
  or exists (
    select 1
    from user_entity_access uea
    where uea.user_id = auth.uid()
      and uea.entity_id = supplier_entities.entity_id
      and uea.active_status = true
  )
);

create or replace view bank_accounts_staff_safe
with (security_barrier = true)
as
select
  ba.id,
  ba.entity_id,
  e.short_code as entity_code,
  e.display_name as entity_name,
  ba.bank_name,
  ba.account_name,
  ba.masked_account_number,
  ba.currency,
  ba.account_type,
  ba.statement_format,
  ba.owner_only_balance_visibility,
  ba.remarks,
  ba.active_status,
  ba.created_at,
  ba.updated_at
from bank_accounts ba
join entities e on e.id = ba.entity_id
where
  app_private.current_user_is_owner()
  or exists (
    select 1
    from user_entity_access uea
    where uea.user_id = auth.uid()
      and uea.entity_id = ba.entity_id
      and uea.active_status = true
  );

grant select, insert, update, delete on entities to authenticated;
grant select, insert, update, delete on app_profiles to authenticated;
grant select, insert, update, delete on user_entity_access to authenticated;
grant select, insert, update, delete on bank_accounts to authenticated;
grant select on bank_accounts_staff_safe to authenticated;
grant select, insert, update, delete on categories to authenticated;
grant select, insert, update, delete on suppliers to authenticated;
grant select, insert, update, delete on supplier_entities to authenticated;

insert into entities (legal_name, display_name, short_code)
values
  ('Inter-Excel Advisory Sdn Bhd', 'IEA', 'IEA'),
  ('Inter Excel Tourism Academy Sdn Bhd', 'IETA', 'IETA'),
  ('Premier Language Centre', 'PLC', 'PLC'),
  ('Agensi Pekerjaan Kaler Sdn Bhd', 'KALER', 'KALER')
on conflict (short_code) do update
set legal_name = excluded.legal_name,
    display_name = excluded.display_name,
    active_status = true,
    updated_at = now();

insert into bank_accounts (entity_id, bank_name, account_name, masked_account_number, data_origin)
select e.id, bank_name, account_name, 'To be updated', 'manual'
from entities e
join (
  values
    ('IEA', 'Public Bank', 'IEA Main Operating Account'),
    ('IETA', 'CIMB', 'IETA Main Operating Account'),
    ('PLC', 'CIMB', 'PLC Main Operating Account'),
    ('KALER', 'CIMB', 'KALER Main Operating Account')
) as seed(entity_code, bank_name, account_name) on seed.entity_code = e.short_code
where not exists (
  select 1
  from bank_accounts ba
  where ba.entity_id = e.id
    and ba.bank_name = seed.bank_name
    and ba.account_name = seed.account_name
);

insert into categories (entity_id, category_type, name, account_code, data_origin)
select null, 'expense', name, account_code, 'manual'
from (
  values
    ('General', null),
    ('Office', null),
    ('Transport', null),
    ('Meals & Entertainment', null),
    ('Utilities', null),
    ('Rent', null),
    ('Bank Charges', null)
) as seed(name, account_code)
where not exists (
  select 1
  from categories c
  where c.entity_id is null
    and c.category_type = 'expense'
    and c.name = seed.name
);

alter table invoices add column if not exists entity_id uuid references entities(id) on delete set null;
alter table invoices add column if not exists is_demo boolean not null default true;
alter table invoices add column if not exists data_origin text not null default 'demo' check (data_origin in ('demo', 'production', 'imported', 'manual'));

alter table receipts add column if not exists entity_id uuid references entities(id) on delete set null;
alter table receipts add column if not exists is_demo boolean not null default true;
alter table receipts add column if not exists data_origin text not null default 'demo' check (data_origin in ('demo', 'production', 'imported', 'manual'));

alter table bank_transactions add column if not exists entity_id uuid references entities(id) on delete set null;
alter table bank_transactions add column if not exists bank_account_id uuid references bank_accounts(id) on delete set null;
alter table bank_transactions add column if not exists is_demo boolean not null default true;
alter table bank_transactions add column if not exists data_origin text not null default 'demo' check (data_origin in ('demo', 'production', 'imported', 'manual'));

alter table reconciliation_matches add column if not exists entity_id uuid references entities(id) on delete set null;
alter table reconciliation_matches add column if not exists is_demo boolean not null default true;
alter table reconciliation_matches add column if not exists data_origin text not null default 'demo' check (data_origin in ('demo', 'production', 'imported', 'manual'));

alter table audit_logs add column if not exists actor_user_id uuid references auth.users(id) on delete set null;
alter table audit_logs add column if not exists is_demo boolean not null default true;
alter table audit_logs add column if not exists data_origin text not null default 'demo' check (data_origin in ('demo', 'production', 'imported', 'manual'));
alter table audit_logs add column if not exists before_data jsonb;
alter table audit_logs add column if not exists after_data jsonb;
alter table audit_logs add column if not exists ip_address inet;
alter table audit_logs add column if not exists user_agent text;

update invoices set is_demo = true, data_origin = 'demo' where data_origin = 'demo';
update receipts set is_demo = true, data_origin = 'demo' where data_origin = 'demo';
update bank_transactions set is_demo = true, data_origin = 'demo' where data_origin = 'demo';
update reconciliation_matches set is_demo = true, data_origin = 'demo' where data_origin = 'demo';
update audit_logs set is_demo = true, data_origin = 'demo' where data_origin = 'demo';