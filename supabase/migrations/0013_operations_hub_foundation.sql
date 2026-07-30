create extension if not exists pgcrypto;

create table if not exists organisations (
  id uuid primary key default gen_random_uuid(),
  organisation_name text not null unique,
  short_code text not null unique,
  active_status boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into organisations (organisation_name, short_code)
values ('Inter-Excel Group', 'INTEREXCEL')
on conflict (short_code) do update
set organisation_name = excluded.organisation_name,
    active_status = true,
    updated_at = now();

alter table entities add column if not exists organisation_id uuid references organisations(id) on delete set null;

update entities
set organisation_id = (select id from organisations where short_code = 'INTEREXCEL')
where short_code in ('IETA', 'IEA', 'PLC', 'KALER')
  and organisation_id is null;

create table if not exists branches (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references entities(id) on delete cascade,
  branch_code text not null,
  branch_name text not null,
  address text,
  phone text,
  email text,
  active_status boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entity_id, branch_code)
);

insert into branches (entity_id, branch_code, branch_name)
select e.id, seed.branch_code, seed.branch_name
from entities e
cross join (
  values
    ('KL', 'Kuala Lumpur'),
    ('PG', 'Penang'),
    ('JB', 'Johor Bahru')
) as seed(branch_code, branch_name)
where e.short_code = 'IETA'
on conflict (entity_id, branch_code) do update
set branch_name = excluded.branch_name,
    active_status = true,
    updated_at = now();

create table if not exists user_branch_access (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_id uuid not null references entities(id) on delete cascade,
  branch_id uuid not null references branches(id) on delete cascade,
  access_role text not null default 'staff' check (access_role in ('branch_manager', 'counsellor', 'marketing', 'finance', 'student_services', 'trainer', 'read_only', 'staff')),
  active_status boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, branch_id)
);

create table if not exists operations_user_permissions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  can_view_student_pii boolean not null default false,
  can_manage_students boolean not null default false,
  can_manage_programmes boolean not null default false,
  can_manage_enrolments boolean not null default false,
  can_view_student_fees boolean not null default false,
  can_manage_fee_plans boolean not null default false,
  can_submit_payment_notifications boolean not null default false,
  can_verify_student_payments boolean not null default false,
  can_allocate_student_payments boolean not null default false,
  can_issue_official_receipts boolean not null default false,
  can_export_student_reports boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  alter table app_profiles drop constraint if exists app_profiles_role_check;
  alter table app_profiles add constraint app_profiles_role_check
    check (role in ('owner', 'finance_manager', 'finance_staff', 'data_entry', 'read_only', 'branch_manager', 'counsellor', 'marketing', 'student_services', 'trainer'));

  alter table user_entity_access drop constraint if exists user_entity_access_role_check;
  alter table user_entity_access add constraint user_entity_access_role_check
    check (role in ('owner', 'finance_manager', 'finance_staff', 'data_entry', 'read_only', 'branch_manager', 'counsellor', 'marketing', 'student_services', 'trainer'));
end $$;

create or replace function app_private.current_user_has_operations_permission(permission_name text)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  profile_role text;
  is_active boolean;
  explicit_value boolean;
begin
  select role, active_status into profile_role, is_active
  from public.app_profiles
  where id = auth.uid();

  if coalesce(is_active, false) = false then
    return false;
  end if;

  if profile_role = 'owner' then
    return true;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'operations_user_permissions'
      and column_name = permission_name
  ) then
    execute format('select %I from public.operations_user_permissions where user_id = $1', permission_name)
    using auth.uid()
    into explicit_value;

    if explicit_value is not null then
      return explicit_value;
    end if;
  end if;

  if permission_name = 'can_view_student_pii' then
    return false;
  elsif permission_name in ('can_manage_students', 'can_manage_enrolments', 'can_submit_payment_notifications') then
    return profile_role in ('finance_manager', 'finance_staff', 'data_entry', 'branch_manager', 'counsellor', 'marketing');
  elsif permission_name in ('can_manage_programmes', 'can_view_student_fees', 'can_export_student_reports') then
    return profile_role in ('finance_manager', 'finance_staff', 'branch_manager');
  elsif permission_name in ('can_manage_fee_plans', 'can_verify_student_payments', 'can_allocate_student_payments', 'can_issue_official_receipts') then
    return profile_role in ('finance_manager', 'finance_staff');
  end if;

  return false;
end;
$$;

revoke all on function app_private.current_user_has_operations_permission(text) from public;
grant execute on function app_private.current_user_has_operations_permission(text) to authenticated;

create or replace function app_private.current_user_can(permission_name text)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  profile_role text;
  is_active boolean;
  explicit_value boolean;
begin
  select role, active_status into profile_role, is_active
  from public.app_profiles
  where id = auth.uid();

  if coalesce(is_active, false) = false then
    return false;
  end if;

  if profile_role = 'owner' then
    return true;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'finance_user_permissions'
      and column_name = permission_name
  ) then
    execute format('select %I from public.finance_user_permissions where user_id = $1', permission_name)
    using auth.uid()
    into explicit_value;

    if explicit_value is not null then
      return explicit_value;
    end if;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'operations_user_permissions'
      and column_name = permission_name
  ) then
    return app_private.current_user_has_operations_permission(permission_name);
  end if;

  if permission_name = 'can_view_documents' then
    return profile_role in ('finance_manager', 'finance_staff', 'data_entry', 'read_only', 'branch_manager', 'counsellor', 'marketing', 'student_services', 'trainer');
  elsif permission_name = 'can_upload_documents' then
    return profile_role in ('finance_manager', 'finance_staff', 'data_entry', 'branch_manager', 'counsellor', 'marketing');
  elsif permission_name = 'can_manage_documents' then
    return profile_role in ('finance_manager', 'branch_manager');
  elsif permission_name = 'can_manage_recurring_bills' then
    return profile_role = 'finance_manager';
  elsif permission_name = 'can_generate_payment_vouchers' then
    return profile_role in ('finance_manager', 'finance_staff');
  elsif permission_name = 'can_manage_claims' then
    return profile_role in ('finance_manager', 'finance_staff', 'data_entry');
  elsif permission_name = 'can_review_claims' then
    return profile_role in ('finance_manager', 'finance_staff');
  elsif permission_name = 'can_check_claims' then
    return profile_role in ('finance_manager', 'finance_staff');
  elsif permission_name = 'can_approve_claims' then
    return profile_role = 'finance_manager';
  elsif permission_name = 'can_prepare_claim_reimbursements' then
    return profile_role in ('finance_manager', 'finance_staff');
  elsif permission_name = 'can_export_claims_sql' then
    return profile_role in ('finance_manager', 'finance_staff');
  elsif permission_name = 'can_view_bank_balances' then
    return false;
  end if;

  return false;
end;
$$;

revoke all on function app_private.current_user_can(text) from public;
grant execute on function app_private.current_user_can(text) to authenticated;

create or replace function app_private.user_can_access_branch(target_entity_id uuid, target_branch_id uuid)
returns boolean
language sql
security definer
set search_path = public, auth
as $$
  select app_private.current_user_is_owner()
    or exists (
      select 1
      from public.user_branch_access uba
      where uba.user_id = auth.uid()
        and uba.entity_id = target_entity_id
        and (target_branch_id is null or uba.branch_id = target_branch_id)
        and uba.active_status = true
    )
    or exists (
      select 1
      from public.user_entity_access uea
      where uea.user_id = auth.uid()
        and uea.entity_id = target_entity_id
        and uea.active_status = true
        and (
          target_branch_id is null
          or uea.role in ('owner', 'finance_manager', 'finance_staff')
        )
    );
$$;

revoke all on function app_private.user_can_access_branch(uuid, uuid) from public;
grant execute on function app_private.user_can_access_branch(uuid, uuid) to authenticated;

drop trigger if exists set_organisations_updated_at on organisations;
create trigger set_organisations_updated_at before update on organisations for each row execute function public.set_updated_at();
drop trigger if exists set_branches_updated_at on branches;
create trigger set_branches_updated_at before update on branches for each row execute function public.set_updated_at();
drop trigger if exists set_user_branch_access_updated_at on user_branch_access;
create trigger set_user_branch_access_updated_at before update on user_branch_access for each row execute function public.set_updated_at();
drop trigger if exists set_operations_user_permissions_updated_at on operations_user_permissions;
create trigger set_operations_user_permissions_updated_at before update on operations_user_permissions for each row execute function public.set_updated_at();

alter table organisations enable row level security;
alter table branches enable row level security;
alter table user_branch_access enable row level security;
alter table operations_user_permissions enable row level security;

drop policy if exists "organisations_active_select" on organisations;
create policy "organisations_active_select" on organisations for select to authenticated
using (active_status = true or app_private.current_user_is_owner());
drop policy if exists "organisations_owner_manage" on organisations;
create policy "organisations_owner_manage" on organisations for all to authenticated
using (app_private.current_user_is_owner())
with check (app_private.current_user_is_owner());

drop policy if exists "branches_scoped_select" on branches;
create policy "branches_scoped_select" on branches for select to authenticated
using (app_private.user_can_access_branch(entity_id, id) or app_private.user_can_access_entity(entity_id));
drop policy if exists "branches_owner_manage" on branches;
create policy "branches_owner_manage" on branches for all to authenticated
using (app_private.current_user_is_owner())
with check (app_private.current_user_is_owner());

drop policy if exists "user_branch_access_owner_all" on user_branch_access;
create policy "user_branch_access_owner_all" on user_branch_access for all to authenticated
using (app_private.current_user_is_owner())
with check (app_private.current_user_is_owner());
drop policy if exists "user_branch_access_read_self" on user_branch_access;
create policy "user_branch_access_read_self" on user_branch_access for select to authenticated
using (user_id = auth.uid() or app_private.current_user_is_owner());

drop policy if exists "operations_user_permissions_owner_all" on operations_user_permissions;
create policy "operations_user_permissions_owner_all" on operations_user_permissions for all to authenticated
using (app_private.current_user_is_owner())
with check (app_private.current_user_is_owner());
drop policy if exists "operations_user_permissions_read_self" on operations_user_permissions;
create policy "operations_user_permissions_read_self" on operations_user_permissions for select to authenticated
using (user_id = auth.uid() or app_private.current_user_is_owner());

grant select, insert, update, delete on organisations, branches, user_branch_access, operations_user_permissions to authenticated;
revoke all on organisations, branches, user_branch_access, operations_user_permissions from anon;

notify pgrst, 'reload schema';
