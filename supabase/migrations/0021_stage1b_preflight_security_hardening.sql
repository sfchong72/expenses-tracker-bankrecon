-- Student Operations Phase 1B preflight security hardening.
--
-- DRAFT ONLY. Do not apply until migrations 0001-0018 have been replayed in a
-- disposable environment and normalized against the production catalog.
-- This migration contains DDL/security changes only and does not transform data.

begin;

do $preflight$
begin
  if current_setting('server_version_num')::integer < 150000 then
    raise exception '0021 requires PostgreSQL 15 or newer for security_invoker views';
  end if;

  if to_regclass('public.students') is null
     or to_regclass('public.programmes') is null
     or to_regclass('public.programme_intakes') is null
     or to_regclass('public.enrolments') is null
     or to_regclass('public.student_import_batches') is null
     or to_regclass('public.student_import_rows') is null
     or to_regclass('public.student_legacy_records') is null
     or to_regclass('app_private.student_enrolment_number_sequences') is null then
    raise exception '0021 preflight failed: expected Stage 1A tables are missing';
  end if;

  if to_regprocedure('public.generate_student_number(uuid)') is null
     or to_regprocedure('public.find_student_duplicate_warnings(uuid,uuid,text,text,text,text,text,date)') is null
     or to_regprocedure('public.merge_students(uuid,uuid,text)') is null
     or to_regprocedure('public.get_student_sensitive_identity(uuid)') is null
     or to_regprocedure('public.normalise_student_identity(text)') is null
     or to_regprocedure('public.mask_student_identity(text)') is null
     or to_regprocedure('public.student_identity_fingerprint(text,text)') is null then
    raise exception '0021 preflight failed: expected Stage 1A functions are missing';
  end if;
end
$preflight$;

-- Keep identity helpers deterministic and prevent caller-controlled name
-- resolution. Authenticated execution remains required by the existing
-- security-invoker student trigger; anonymous execution is not required.
alter function public.normalise_student_identity(text)
  set search_path = '';

alter function public.mask_student_identity(text)
  set search_path = '';

create or replace function public.student_identity_fingerprint(identity_type text, identity_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when public.normalise_student_identity(identity_value) is null then null
    else pg_catalog.encode(
      extensions.digest(
        pg_catalog.lower(coalesce(identity_type, 'unknown')) || ':' ||
        public.normalise_student_identity(identity_value),
        'sha256'
      ),
      'hex'
    )
  end;
$$;

revoke all on function public.normalise_student_identity(text) from public, anon;
revoke all on function public.mask_student_identity(text) from public, anon;
revoke all on function public.student_identity_fingerprint(text, text) from public, anon;
grant execute on function public.normalise_student_identity(text) to authenticated, service_role;
grant execute on function public.mask_student_identity(text) to authenticated, service_role;
grant execute on function public.student_identity_fingerprint(text, text) to authenticated, service_role;

-- Student number allocation remains database-atomic. Add the missing entity
-- scope check and use an empty search path with qualified application objects.
create or replace function public.generate_student_number(p_entity_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  yy integer := extract(year from current_date)::integer % 100;
  seq integer;
  entity_code text;
begin
  if not app_private.current_user_can('can_manage_students')
     or not app_private.user_can_access_entity(p_entity_id) then
    raise exception 'Not authorised to generate student numbers';
  end if;

  select e.short_code
    into entity_code
  from public.entities e
  where e.id = p_entity_id;

  if entity_code is null then
    raise exception 'Unknown entity';
  end if;

  insert into public.student_number_sequences as sns (entity_id, sequence_year, last_number)
  values (p_entity_id, yy, 1)
  on conflict (entity_id, sequence_year)
  do update
    set last_number = sns.last_number + 1,
        updated_at = pg_catalog.now()
  returning last_number into seq;

  return entity_code || '-STU-' || pg_catalog.lpad(yy::text, 2, '0') || '-' ||
         pg_catalog.lpad(seq::text, 4, '0');
end;
$$;

-- Duplicate checks return only safe summary fields and now apply the same
-- branch/counsellor visibility boundary used by Student Operations lists.
create or replace function public.find_student_duplicate_warnings(
  p_student_id uuid,
  p_entity_id uuid,
  p_full_name text,
  p_identity_document_type text,
  p_identity_number text,
  p_phone text,
  p_email text,
  p_date_of_birth date
)
returns table (
  student_id uuid,
  student_number text,
  full_name text,
  match_reason text,
  match_strength text
)
language sql
stable
security definer
set search_path = ''
as $$
  with incoming as (
    select
      public.student_identity_fingerprint(p_identity_document_type, p_identity_number) as fp,
      nullif(pg_catalog.regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '') as phone_norm,
      nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, ''))), '') as email_norm,
      nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_full_name, ''))), '') as name_norm
  ),
  candidates as (
    select s.*
    from public.students s
    where s.entity_id = p_entity_id
      and s.id is distinct from p_student_id
      and s.lifecycle_status <> 'merged'
      and app_private.current_user_can('can_manage_students')
      and (
        app_private.current_user_is_owner()
        or app_private.user_can_access_branch(s.entity_id, s.home_branch_id)
        or exists (
          select 1
          from public.enrolments en
          where en.student_id = s.id
            and (
              app_private.user_can_access_branch(en.entity_id, en.branch_id)
              or en.counsellor_user_id = auth.uid()
            )
        )
      )
  )
  select s.id, s.student_number, s.full_name,
         'IC/passport fingerprint'::text, 'strong'::text
  from candidates s cross join incoming i
  where i.fp is not null and s.identity_number_fingerprint = i.fp
  union
  select s.id, s.student_number, s.full_name,
         'Phone number'::text, 'possible'::text
  from candidates s cross join incoming i
  where i.phone_norm is not null and s.phone_normalised = i.phone_norm
  union
  select s.id, s.student_number, s.full_name,
         'Email address'::text, 'possible'::text
  from candidates s cross join incoming i
  where i.email_norm is not null and s.email_normalised = i.email_norm
  union
  select s.id, s.student_number, s.full_name,
         'Name and date of birth'::text, 'possible'::text
  from candidates s cross join incoming i
  where i.name_norm is not null
    and p_date_of_birth is not null
    and pg_catalog.lower(pg_catalog.btrim(s.full_name)) = i.name_norm
    and s.date_of_birth = p_date_of_birth;
$$;

-- Merging is a privileged operation and must not cross entity or caller scope.
create or replace function public.merge_students(
  p_source_student_id uuid,
  p_target_student_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  moved_enrolments integer := 0;
  moved_documents integer := 0;
  source_entity_id uuid;
  source_branch_id uuid;
  target_entity_id uuid;
  target_branch_id uuid;
begin
  if not app_private.current_user_can('can_manage_students') then
    raise exception 'Not authorised to merge students';
  end if;
  if p_source_student_id = p_target_student_id then
    raise exception 'Source and target student must be different';
  end if;
  if nullif(pg_catalog.btrim(p_reason), '') is null then
    raise exception 'Merge reason is required';
  end if;

  select s.entity_id, s.home_branch_id
    into source_entity_id, source_branch_id
  from public.students s
  where s.id = p_source_student_id
  for update;

  if not found then
    raise exception 'Source student not found';
  end if;

  select s.entity_id, s.home_branch_id
    into target_entity_id, target_branch_id
  from public.students s
  where s.id = p_target_student_id
  for update;

  if not found then
    raise exception 'Target student not found';
  end if;

  if source_entity_id <> target_entity_id then
    raise exception 'Students from different entities cannot be merged';
  end if;

  if not app_private.user_can_access_branch(source_entity_id, source_branch_id)
     or not app_private.user_can_access_branch(target_entity_id, target_branch_id) then
    raise exception 'Not authorised to merge one or both student records';
  end if;

  update public.enrolments
  set student_id = p_target_student_id,
      updated_by = auth.uid(),
      updated_at = pg_catalog.now()
  where student_id = p_source_student_id;
  get diagnostics moved_enrolments = row_count;

  update public.document_links
  set linked_record_id = p_target_student_id
  where linked_record_type = 'student'
    and linked_record_id = p_source_student_id;
  get diagnostics moved_documents = row_count;

  update public.students
  set lifecycle_status = 'merged',
      active_status = false,
      duplicate_review_status = 'merged',
      merged_into_student_id = p_target_student_id,
      updated_by = auth.uid(),
      updated_at = pg_catalog.now()
  where id = p_source_student_id;

  insert into public.student_merge_events (
    source_student_id,
    target_student_id,
    merged_by,
    merge_reason,
    preserved_summary
  ) values (
    p_source_student_id,
    p_target_student_id,
    auth.uid(),
    pg_catalog.btrim(p_reason),
    pg_catalog.jsonb_build_object(
      'moved_enrolments', moved_enrolments,
      'moved_document_links', moved_documents
    )
  );

  insert into public.audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    payload,
    data_origin
  ) values (
    auth.uid(),
    'students_merged',
    'student',
    p_target_student_id,
    pg_catalog.jsonb_build_object(
      'source_student_id', p_source_student_id,
      'target_student_id', p_target_student_id,
      'reason', pg_catalog.btrim(p_reason),
      'moved_enrolments', moved_enrolments,
      'moved_document_links', moved_documents
    ),
    'manual'
  );

  return pg_catalog.jsonb_build_object(
    'moved_enrolments', moved_enrolments,
    'moved_document_links', moved_documents
  );
end;
$$;

create or replace function public.get_student_sensitive_identity(p_student_id uuid)
returns table (
  id uuid,
  identity_document_type text,
  identity_number_protected text
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.identity_document_type, s.identity_number_protected
  from public.students s
  where s.id = p_student_id
    and app_private.current_user_can('can_view_student_pii')
    and (
      app_private.current_user_is_owner()
      or app_private.user_can_access_branch(s.entity_id, s.home_branch_id)
      or exists (
        select 1
        from public.enrolments e
        where e.student_id = s.id
          and (
            app_private.user_can_access_branch(e.entity_id, e.branch_id)
            or e.counsellor_user_id = auth.uid()
          )
      )
    );
$$;

revoke all on function public.generate_student_number(uuid) from public, anon;
revoke all on function public.find_student_duplicate_warnings(uuid, uuid, text, text, text, text, text, date) from public, anon;
revoke all on function public.merge_students(uuid, uuid, text) from public, anon;
revoke all on function public.get_student_sensitive_identity(uuid) from public, anon;

grant execute on function public.generate_student_number(uuid) to authenticated, service_role;
grant execute on function public.find_student_duplicate_warnings(uuid, uuid, text, text, text, text, text, date) to authenticated, service_role;
grant execute on function public.merge_students(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.get_student_sensitive_identity(uuid) to authenticated, service_role;

-- A security-invoker view cannot directly read protected fingerprint and
-- normalised columns because client roles intentionally lack SELECT on those
-- columns. Keep matching inside a private, branch-scoped helper that returns
-- only the existing safe warning fields.
create or replace function app_private.student_duplicate_warning_rows()
returns table (
  student_id uuid,
  possible_duplicate_student_id uuid,
  possible_duplicate_student_number text,
  possible_duplicate_name text,
  match_reason text,
  match_strength text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s1.id,
    s2.id,
    s2.student_number,
    s2.full_name,
    case
      when s1.identity_number_fingerprint is not null
       and s1.identity_number_fingerprint = s2.identity_number_fingerprint
        then 'IC/passport fingerprint'
      when s1.email_normalised is not null
       and s1.email_normalised = s2.email_normalised
        then 'Email address'
      when s1.phone_normalised is not null
       and s1.phone_normalised = s2.phone_normalised
        then 'Phone number'
      when s1.date_of_birth is not null
       and pg_catalog.lower(pg_catalog.btrim(s1.full_name)) = pg_catalog.lower(pg_catalog.btrim(s2.full_name))
       and s1.date_of_birth = s2.date_of_birth
        then 'Name and date of birth'
      else 'Possible duplicate'
    end,
    case
      when s1.identity_number_fingerprint is not null
       and s1.identity_number_fingerprint = s2.identity_number_fingerprint
        then 'strong'
      else 'possible'
    end
  from public.students s1
  join public.students s2
    on s1.entity_id = s2.entity_id
   and s1.id < s2.id
  where s1.lifecycle_status <> 'merged'
    and s2.lifecycle_status <> 'merged'
    and app_private.current_user_can('can_manage_students')
    and (
      app_private.current_user_is_owner()
      or app_private.user_can_access_branch(s1.entity_id, s1.home_branch_id)
      or exists (
        select 1 from public.enrolments en
        where en.student_id = s1.id
          and (
            app_private.user_can_access_branch(en.entity_id, en.branch_id)
            or en.counsellor_user_id = auth.uid()
          )
      )
    )
    and (
      app_private.current_user_is_owner()
      or app_private.user_can_access_branch(s2.entity_id, s2.home_branch_id)
      or exists (
        select 1 from public.enrolments en
        where en.student_id = s2.id
          and (
            app_private.user_can_access_branch(en.entity_id, en.branch_id)
            or en.counsellor_user_id = auth.uid()
          )
      )
    )
    and (
      (s1.identity_number_fingerprint is not null
       and s1.identity_number_fingerprint = s2.identity_number_fingerprint)
      or (s1.email_normalised is not null
          and s1.email_normalised = s2.email_normalised)
      or (s1.phone_normalised is not null
          and s1.phone_normalised = s2.phone_normalised)
      or (s1.date_of_birth is not null
          and pg_catalog.lower(pg_catalog.btrim(s1.full_name)) = pg_catalog.lower(pg_catalog.btrim(s2.full_name))
          and s1.date_of_birth = s2.date_of_birth)
    );
$$;

revoke all on function app_private.student_duplicate_warning_rows() from public, anon;
grant execute on function app_private.student_duplicate_warning_rows() to authenticated, service_role;

create or replace view public.student_duplicate_warning_view
with (security_invoker = true)
as
select *
from app_private.student_duplicate_warning_rows();

revoke all on public.student_duplicate_warning_view from public, anon, authenticated;
grant select on public.student_duplicate_warning_view to authenticated, service_role;

-- Replace broad FOR ALL policies with operation-specific policies. Existing
-- predicates are retained, while DELETE is available only for import preview
-- rows because the current import parser clears and replaces those rows.
drop policy if exists "programmes_manage" on public.programmes;
create policy "programmes_insert" on public.programmes
for insert to authenticated
with check (
  app_private.current_user_can('can_manage_programmes')
  and app_private.user_can_access_entity(entity_id)
);
create policy "programmes_update" on public.programmes
for update to authenticated
using (
  app_private.current_user_can('can_manage_programmes')
  and app_private.user_can_access_entity(entity_id)
)
with check (
  app_private.current_user_can('can_manage_programmes')
  and app_private.user_can_access_entity(entity_id)
);

drop policy if exists "programme_intakes_manage" on public.programme_intakes;
create policy "programme_intakes_insert" on public.programme_intakes
for insert to authenticated
with check (
  app_private.current_user_can('can_manage_programmes')
  and app_private.user_can_access_branch(entity_id, branch_id)
);
create policy "programme_intakes_update" on public.programme_intakes
for update to authenticated
using (
  app_private.current_user_can('can_manage_programmes')
  and app_private.user_can_access_branch(entity_id, branch_id)
)
with check (
  app_private.current_user_can('can_manage_programmes')
  and app_private.user_can_access_branch(entity_id, branch_id)
);

drop policy if exists "enrolments_manage" on public.enrolments;
create policy "enrolments_insert" on public.enrolments
for insert to authenticated
with check (
  app_private.current_user_can('can_manage_enrolments')
  and app_private.user_can_access_branch(entity_id, branch_id)
);
create policy "enrolments_update" on public.enrolments
for update to authenticated
using (
  app_private.current_user_can('can_manage_enrolments')
  and app_private.user_can_access_branch(entity_id, branch_id)
)
with check (
  app_private.current_user_can('can_manage_enrolments')
  and app_private.user_can_access_branch(entity_id, branch_id)
);

drop policy if exists "student_import_batches_manage" on public.student_import_batches;
create policy "student_import_batches_insert" on public.student_import_batches
for insert to authenticated
with check (
  app_private.current_user_can('can_manage_students')
  and app_private.user_can_access_branch(entity_id, default_branch_id)
);
create policy "student_import_batches_update" on public.student_import_batches
for update to authenticated
using (
  app_private.current_user_can('can_manage_students')
  and app_private.user_can_access_branch(entity_id, default_branch_id)
)
with check (
  app_private.current_user_can('can_manage_students')
  and app_private.user_can_access_branch(entity_id, default_branch_id)
);

drop policy if exists "student_import_rows_manage" on public.student_import_rows;
create policy "student_import_rows_insert" on public.student_import_rows
for insert to authenticated
with check (
  exists (
    select 1
    from public.student_import_batches b
    where b.id = student_import_batch_id
      and app_private.current_user_can('can_manage_students')
      and app_private.user_can_access_branch(b.entity_id, b.default_branch_id)
  )
);
create policy "student_import_rows_update" on public.student_import_rows
for update to authenticated
using (
  exists (
    select 1
    from public.student_import_batches b
    where b.id = student_import_batch_id
      and app_private.current_user_can('can_manage_students')
      and app_private.user_can_access_branch(b.entity_id, b.default_branch_id)
  )
)
with check (
  exists (
    select 1
    from public.student_import_batches b
    where b.id = student_import_batch_id
      and app_private.current_user_can('can_manage_students')
      and app_private.user_can_access_branch(b.entity_id, b.default_branch_id)
  )
);
create policy "student_import_rows_delete" on public.student_import_rows
for delete to authenticated
using (
  exists (
    select 1
    from public.student_import_batches b
    where b.id = student_import_batch_id
      and app_private.current_user_can('can_manage_students')
      and app_private.user_can_access_branch(b.entity_id, b.default_branch_id)
  )
);

drop policy if exists "student_legacy_records_manage" on public.student_legacy_records;

-- Remove default/broad client privileges and grant only operations used by the
-- current Stage 1A application. Direct deletion is deliberately retained only
-- for student_import_rows; privileged revert logic remains in its RPC.
revoke all on public.programmes from authenticated;
revoke all on public.programme_intakes from authenticated;
revoke all on public.enrolments from authenticated;
revoke all on public.student_import_batches from authenticated;
revoke all on public.student_import_rows from authenticated;
revoke all on public.student_legacy_records from authenticated;

grant select, insert, update on public.programmes to authenticated;
grant select, insert, update on public.programme_intakes to authenticated;
grant select, insert, update on public.enrolments to authenticated;
grant select, insert, update on public.student_import_batches to authenticated;
grant select, insert, update, delete on public.student_import_rows to authenticated;
grant select on public.student_legacy_records to authenticated;

revoke all on public.programmes, public.programme_intakes, public.enrolments,
  public.student_import_batches, public.student_import_rows,
  public.student_legacy_records from anon;

-- The private enrolment-number counter remains reachable only through the
-- existing server/RPC path. No client role receives a direct policy or grant.
alter table app_private.student_enrolment_number_sequences enable row level security;
revoke all on app_private.student_enrolment_number_sequences from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Private Finance/Management application boundary
-- ---------------------------------------------------------------------------

do $roles$
begin
  alter table public.app_profiles drop constraint if exists app_profiles_role_check;
  alter table public.app_profiles add constraint app_profiles_role_check
    check (role in (
      'owner', 'finance_manager', 'finance_staff', 'management', 'data_entry',
      'read_only', 'branch_manager', 'counsellor', 'marketing',
      'student_services', 'trainer'
    ));

  alter table public.user_entity_access drop constraint if exists user_entity_access_role_check;
  alter table public.user_entity_access add constraint user_entity_access_role_check
    check (role in (
      'owner', 'finance_manager', 'finance_staff', 'management', 'data_entry',
      'read_only', 'branch_manager', 'counsellor', 'marketing',
      'student_services', 'trainer'
    ));
end
$roles$;

alter table public.finance_user_permissions
  add column if not exists can_view_finance boolean not null default false,
  add column if not exists can_manage_bills boolean not null default false,
  add column if not exists can_prepare_vouchers boolean not null default false,
  add column if not exists can_issue_vouchers boolean not null default false,
  add column if not exists can_void_vouchers boolean not null default false,
  add column if not exists can_delete_drafts boolean not null default false,
  add column if not exists can_delete_documents boolean not null default false,
  add column if not exists can_view_sensitive_payments boolean not null default false,
  add column if not exists can_view_confidential_claims boolean not null default false;

create or replace function app_private.current_user_has_eligible_role()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.app_profiles p
    where p.id = auth.uid() and p.active_status = true
      and p.role in ('owner', 'finance_manager', 'finance_staff', 'management', 'data_entry')
  );
$$;

create or replace function app_private.current_user_has_app_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.app_profiles p
    where p.id = auth.uid()
      and p.active_status = true
      and p.role in ('owner', 'finance_manager', 'finance_staff', 'management', 'data_entry')
      and (
        p.role not in ('owner', 'finance_manager')
        or coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
      )
  );
$$;

create or replace function app_private.current_user_is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.current_user_has_app_access()
    and exists (
      select 1 from public.app_profiles p
      where p.id = auth.uid() and p.role = 'owner' and p.active_status = true
    );
$$;

create or replace function app_private.current_user_is_finance_manager()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.current_user_has_app_access()
    and exists (
      select 1 from public.app_profiles p
      where p.id = auth.uid() and p.role = 'finance_manager' and p.active_status = true
    );
$$;

create or replace function app_private.current_user_is_data_entry()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.current_user_has_app_access()
    and exists (
      select 1 from public.app_profiles p
      where p.id = auth.uid() and p.role = 'data_entry' and p.active_status = true
    );
$$;

create or replace function app_private.current_user_has_operations_permission(permission_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  profile_role text;
  explicit_value boolean := false;
begin
  if not app_private.current_user_has_app_access() then
    return false;
  end if;

  select p.role into profile_role
  from public.app_profiles p
  where p.id = auth.uid() and p.active_status = true;

  if profile_role = 'owner' then
    return true;
  end if;

  if permission_name in (
    'can_view_student_pii', 'can_manage_students', 'can_manage_programmes',
    'can_manage_enrolments', 'can_view_student_fees', 'can_manage_fee_plans',
    'can_submit_payment_notifications', 'can_verify_student_payments',
    'can_allocate_student_payments', 'can_issue_official_receipts',
    'can_export_student_reports'
  ) then
    execute pg_catalog.format(
      'select %I from public.operations_user_permissions where user_id = $1',
      permission_name
    ) using auth.uid() into explicit_value;
  end if;

  if coalesce(explicit_value, false) then
    return true;
  end if;

  if permission_name in ('can_manage_students', 'can_manage_enrolments') then
    return profile_role in ('finance_manager', 'finance_staff', 'data_entry');
  elsif permission_name = 'can_submit_payment_notifications' then
    return profile_role in ('finance_manager', 'finance_staff');
  elsif permission_name in ('can_manage_programmes', 'can_view_student_fees', 'can_export_student_reports') then
    return profile_role in ('finance_manager', 'finance_staff');
  elsif permission_name in (
    'can_manage_fee_plans', 'can_verify_student_payments',
    'can_allocate_student_payments', 'can_issue_official_receipts'
  ) then
    return profile_role = 'finance_manager';
  end if;

  return false;
end;
$$;

create or replace function app_private.current_user_can(permission_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  profile_role text;
  explicit_value boolean := false;
begin
  if not app_private.current_user_has_app_access() then
    return false;
  end if;

  select p.role into profile_role
  from public.app_profiles p
  where p.id = auth.uid() and p.active_status = true;

  if profile_role = 'owner' then
    return true;
  end if;

  if permission_name in (
    'can_view_documents', 'can_upload_documents', 'can_manage_documents',
    'can_view_bank_balances', 'can_manage_recurring_bills',
    'can_generate_payment_vouchers', 'can_manage_claims', 'can_review_claims',
    'can_check_claims', 'can_approve_claims',
    'can_prepare_claim_reimbursements', 'can_export_claims_sql',
    'can_view_finance', 'can_manage_bills', 'can_prepare_vouchers',
    'can_issue_vouchers', 'can_void_vouchers', 'can_delete_drafts',
    'can_delete_documents', 'can_view_sensitive_payments',
    'can_view_confidential_claims'
  ) then
    execute pg_catalog.format(
      'select %I from public.finance_user_permissions where user_id = $1',
      permission_name
    ) using auth.uid() into explicit_value;
  elsif permission_name in (
    'can_view_student_pii', 'can_manage_students', 'can_manage_programmes',
    'can_manage_enrolments', 'can_view_student_fees', 'can_manage_fee_plans',
    'can_submit_payment_notifications', 'can_verify_student_payments',
    'can_allocate_student_payments', 'can_issue_official_receipts',
    'can_export_student_reports'
  ) then
    return app_private.current_user_has_operations_permission(permission_name);
  else
    return false;
  end if;

  if coalesce(explicit_value, false) then
    if profile_role = 'management' then
      return permission_name in (
        'can_view_finance', 'can_view_documents', 'can_review_claims',
        'can_approve_claims', 'can_view_confidential_claims'
      );
    end if;
    if profile_role = 'data_entry' then
      return permission_name in (
        'can_view_finance', 'can_view_documents', 'can_upload_documents',
        'can_manage_bills', 'can_manage_claims'
      );
    end if;
    if profile_role = 'finance_staff' then
      return permission_name not in (
        'can_approve_claims', 'can_issue_vouchers', 'can_void_vouchers',
        'can_delete_drafts', 'can_delete_documents', 'can_view_bank_balances'
      );
    end if;
    return profile_role = 'finance_manager';
  end if;

  if profile_role = 'finance_manager' then
    return permission_name <> 'can_view_bank_balances';
  elsif profile_role = 'finance_staff' then
    return permission_name in (
      'can_view_finance', 'can_view_documents', 'can_upload_documents',
      'can_manage_documents', 'can_manage_bills', 'can_prepare_vouchers',
      'can_generate_payment_vouchers', 'can_manage_claims',
      'can_review_claims', 'can_check_claims',
      'can_prepare_claim_reimbursements', 'can_export_claims_sql',
      'can_view_sensitive_payments'
    );
  elsif profile_role = 'management' then
    return permission_name in ('can_view_finance', 'can_view_documents', 'can_review_claims');
  elsif profile_role = 'data_entry' then
    return permission_name in (
      'can_view_finance', 'can_view_documents', 'can_upload_documents',
      'can_manage_bills', 'can_manage_claims'
    );
  end if;

  return false;
end;
$$;

create or replace function app_private.current_user_is_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.current_user_has_app_access();
$$;

create or replace function app_private.user_can_access_entity(target_entity_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.current_user_has_app_access()
    and (
      app_private.current_user_is_owner()
      or (
        target_entity_id is not null
        and exists (
          select 1
          from public.user_entity_access uea
          where uea.user_id = auth.uid()
            and uea.entity_id = target_entity_id
            and uea.active_status = true
            and uea.role in ('finance_manager', 'finance_staff', 'management', 'data_entry')
        )
      )
    );
$$;

create or replace function app_private.user_can_access_branch(
  target_entity_id uuid,
  target_branch_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.current_user_has_app_access()
    and (
      app_private.current_user_is_owner()
      or (
        target_entity_id is not null
        and target_branch_id is not null
        and (
          exists (
            select 1
            from public.user_branch_access uba
            where uba.user_id = auth.uid()
              and uba.entity_id = target_entity_id
              and uba.branch_id = target_branch_id
              and uba.active_status = true
          )
          or exists (
            select 1
            from public.user_entity_access uea
            where uea.user_id = auth.uid()
              and uea.entity_id = target_entity_id
              and uea.active_status = true
              and uea.role in ('finance_manager', 'finance_staff')
          )
        )
      )
    );
$$;

revoke all on function app_private.current_user_has_app_access() from public, anon;
revoke all on function app_private.current_user_has_eligible_role() from public, anon;
revoke all on function app_private.current_user_is_owner() from public, anon;
revoke all on function app_private.current_user_is_finance_manager() from public, anon;
revoke all on function app_private.current_user_is_data_entry() from public, anon;
revoke all on function app_private.current_user_is_active() from public, anon;
revoke all on function app_private.current_user_can(text) from public, anon;
revoke all on function app_private.current_user_has_operations_permission(text) from public, anon;
revoke all on function app_private.user_can_access_entity(uuid) from public, anon;
revoke all on function app_private.user_can_access_branch(uuid, uuid) from public, anon;

grant execute on function app_private.current_user_has_app_access() to authenticated, service_role;
grant execute on function app_private.current_user_has_eligible_role() to authenticated, service_role;
grant execute on function app_private.current_user_is_owner() to authenticated, service_role;
grant execute on function app_private.current_user_is_finance_manager() to authenticated, service_role;
grant execute on function app_private.current_user_is_data_entry() to authenticated, service_role;
grant execute on function app_private.current_user_is_active() to authenticated, service_role;
grant execute on function app_private.current_user_can(text) to authenticated, service_role;
grant execute on function app_private.current_user_has_operations_permission(text) to authenticated, service_role;
grant execute on function app_private.user_can_access_entity(uuid) to authenticated, service_role;
grant execute on function app_private.user_can_access_branch(uuid, uuid) to authenticated, service_role;

create or replace function app_private.user_can_access_claim(p_claim_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.claims c
    where c.id = p_claim_id
      and app_private.current_user_has_app_access()
      and (
        c.claimant_user_id = auth.uid()
        or (
          app_private.user_can_access_entity(c.entity_id)
          and app_private.current_user_can('can_view_finance')
          and (
            c.claim_type not in ('director_claim', 'director_advance', 'personal_credit_card_claim')
            or app_private.current_user_can('can_view_confidential_claims')
          )
        )
      )
  );
$$;

create or replace function app_private.user_can_access_linked_record(
  p_entity_id uuid,
  p_record_type text,
  p_record_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app_private.user_can_access_entity(p_entity_id) then
    return false;
  end if;

  if p_record_type = 'supplier_bill' then
    return app_private.current_user_can('can_view_finance') and exists (
      select 1 from public.supplier_bills b where b.id = p_record_id and b.entity_id = p_entity_id
    );
  elsif p_record_type = 'payment_voucher' then
    return app_private.current_user_can('can_view_finance') and exists (
      select 1 from public.payment_vouchers v where v.id = p_record_id and v.entity_id = p_entity_id
    );
  elsif p_record_type = 'bill_payment' then
    return app_private.current_user_can('can_view_sensitive_payments') and exists (
      select 1 from public.bill_payments p where p.id = p_record_id and p.entity_id = p_entity_id
    );
  elsif p_record_type = 'recurring_obligation' then
    return app_private.current_user_can('can_view_finance') and exists (
      select 1 from public.recurring_obligations r where r.id = p_record_id and r.entity_id = p_entity_id
    );
  elsif p_record_type = 'claim' then
    return app_private.user_can_access_claim(p_record_id);
  elsif p_record_type = 'claim_line' then
    return exists (
      select 1
      from public.claim_lines l
      join public.claims c on c.id = l.claim_id
      where l.id = p_record_id and c.entity_id = p_entity_id
        and app_private.user_can_access_claim(c.id)
    );
  elsif p_record_type = 'claim_reimbursement' then
    return exists (
      select 1
      from public.claim_reimbursements r
      where r.id = p_record_id and r.entity_id = p_entity_id
        and app_private.user_can_access_claim(r.claim_id)
    );
  elsif p_record_type = 'student' then
    return app_private.current_user_can('can_manage_students') and exists (
      select 1 from public.students s
      where s.id = p_record_id and s.entity_id = p_entity_id
        and app_private.user_can_access_branch(s.entity_id, s.home_branch_id)
    );
  elsif p_record_type = 'enrolment' then
    return app_private.current_user_can('can_manage_enrolments') and exists (
      select 1 from public.enrolments e
      where e.id = p_record_id and e.entity_id = p_entity_id
        and app_private.user_can_access_branch(e.entity_id, e.branch_id)
    );
  elsif p_record_type = 'programme' then
    return app_private.current_user_can('can_manage_programmes') and exists (
      select 1 from public.programmes p where p.id = p_record_id and p.entity_id = p_entity_id
    );
  elsif p_record_type = 'programme_intake' then
    return app_private.current_user_can('can_manage_programmes') and exists (
      select 1
      from public.programme_intakes i
      join public.programmes p on p.id = i.programme_id
      where i.id = p_record_id and p.entity_id = p_entity_id
    );
  elsif p_record_type = 'bank_transaction' then
    return app_private.current_user_is_owner()
      or app_private.current_user_is_finance_manager();
  end if;

  return app_private.current_user_is_owner()
    or app_private.current_user_is_finance_manager();
end;
$$;

create or replace function app_private.user_can_access_document(p_document_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.documents d
    join public.document_links dl on dl.document_id = d.id
    where d.id = p_document_id
      and d.entity_id = dl.entity_id
      and d.deleted_at is null
      and app_private.current_user_can('can_view_documents')
      and app_private.user_can_access_linked_record(
        dl.entity_id, dl.linked_record_type, dl.linked_record_id
      )
  );
$$;

create or replace function app_private.user_can_access_storage_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.documents d
    where d.storage_path = p_name
      and app_private.user_can_access_document(d.id)
  );
$$;

revoke all on function app_private.user_can_access_claim(uuid) from public, anon;
revoke all on function app_private.user_can_access_linked_record(uuid, text, uuid) from public, anon;
revoke all on function app_private.user_can_access_document(uuid) from public, anon;
revoke all on function app_private.user_can_access_storage_object(text) from public, anon;
grant execute on function app_private.user_can_access_claim(uuid) to authenticated, service_role;
grant execute on function app_private.user_can_access_linked_record(uuid, text, uuid) to authenticated, service_role;
grant execute on function app_private.user_can_access_document(uuid) to authenticated, service_role;
grant execute on function app_private.user_can_access_storage_object(text) to authenticated, service_role;

-- Broad legacy document policies are replaced with linked-record scope.
drop policy if exists documents_view on public.documents;
drop policy if exists documents_insert on public.documents;
drop policy if exists documents_manage on public.documents;
create policy documents_scoped_select on public.documents for select to authenticated
  using (app_private.user_can_access_document(id));
create policy documents_scoped_insert on public.documents for insert to authenticated
  with check (
    app_private.current_user_can('can_upload_documents')
    and app_private.user_can_access_entity(entity_id)
    and uploaded_by = auth.uid()
  );
create policy documents_scoped_update on public.documents for update to authenticated
  using (
    app_private.user_can_access_document(id)
    and app_private.current_user_can('can_manage_documents')
  )
  with check (
    app_private.user_can_access_document(id)
    and app_private.current_user_can('can_manage_documents')
  );

drop policy if exists document_links_view on public.document_links;
drop policy if exists document_links_insert on public.document_links;
drop policy if exists document_links_manage on public.document_links;
drop policy if exists document_links_delete on public.document_links;
create policy document_links_scoped_select on public.document_links for select to authenticated
  using (
    app_private.current_user_can('can_view_documents')
    and app_private.user_can_access_linked_record(entity_id, linked_record_type, linked_record_id)
  );
create policy document_links_scoped_insert on public.document_links for insert to authenticated
  with check (
    app_private.current_user_can('can_upload_documents')
    and created_by = auth.uid()
    and app_private.user_can_access_linked_record(entity_id, linked_record_type, linked_record_id)
  );
create policy document_links_scoped_update on public.document_links for update to authenticated
  using (
    app_private.current_user_can('can_manage_documents')
    and app_private.user_can_access_linked_record(entity_id, linked_record_type, linked_record_id)
  )
  with check (
    app_private.current_user_can('can_manage_documents')
    and app_private.user_can_access_linked_record(entity_id, linked_record_type, linked_record_id)
  );

drop policy if exists bill_documents_storage_read on storage.objects;
drop policy if exists bill_documents_storage_insert on storage.objects;
drop policy if exists bill_documents_storage_update on storage.objects;
drop policy if exists bill_documents_storage_delete on storage.objects;
create policy bill_documents_storage_scoped_read on storage.objects for select to authenticated
  using (
    bucket_id = 'bill-documents'
    and app_private.user_can_access_storage_object(name)
  );
create policy bill_documents_storage_scoped_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'bill-documents'
    and app_private.current_user_can('can_upload_documents')
    and app_private.user_can_access_entity((storage.foldername(name))[1]::uuid)
  );
create policy bill_documents_storage_scoped_update on storage.objects for update to authenticated
  using (
    bucket_id = 'bill-documents'
    and app_private.current_user_can('can_manage_documents')
    and app_private.user_can_access_storage_object(name)
  )
  with check (
    bucket_id = 'bill-documents'
    and app_private.current_user_can('can_manage_documents')
    and app_private.user_can_access_storage_object(name)
  );
create policy bill_documents_storage_scoped_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'bill-documents'
    and app_private.current_user_can('can_delete_documents')
    and app_private.user_can_access_storage_object(name)
  );

-- Finance relations require both entity membership and an operation-specific
-- Finance permission. Entity membership by itself is never sufficient.
drop policy if exists supplier_bills_entity_select on public.supplier_bills;
drop policy if exists supplier_bills_entity_insert on public.supplier_bills;
drop policy if exists supplier_bills_entity_update on public.supplier_bills;
create policy supplier_bills_finance_select on public.supplier_bills for select to authenticated
  using (
    app_private.user_can_access_entity(entity_id)
    and app_private.current_user_can('can_view_finance')
  );
create policy supplier_bills_finance_insert on public.supplier_bills for insert to authenticated
  with check (
    app_private.user_can_access_entity(entity_id)
    and app_private.current_user_can('can_manage_bills')
    and (not app_private.current_user_is_data_entry() or payment_status = 'draft')
    and created_by = auth.uid()
  );
create policy supplier_bills_finance_update on public.supplier_bills for update to authenticated
  using (
    app_private.user_can_access_entity(entity_id)
    and app_private.current_user_can('can_manage_bills')
  )
  with check (
    app_private.user_can_access_entity(entity_id)
    and app_private.current_user_can('can_manage_bills')
  );
create policy supplier_bills_draft_delete on public.supplier_bills for delete to authenticated
  using (
    payment_status = 'draft'
    and app_private.user_can_access_entity(entity_id)
    and app_private.current_user_can('can_delete_drafts')
  );

drop policy if exists bill_payments_entity_select on public.bill_payments;
drop policy if exists bill_payments_entity_insert on public.bill_payments;
drop policy if exists bill_payments_entity_update on public.bill_payments;
create policy bill_payments_sensitive_select on public.bill_payments for select to authenticated
  using (
    app_private.user_can_access_entity(entity_id)
    and app_private.current_user_can('can_view_sensitive_payments')
  );
create policy bill_payments_manager_insert on public.bill_payments for insert to authenticated
  with check (
    app_private.user_can_access_entity(entity_id)
    and (app_private.current_user_is_owner() or app_private.current_user_is_finance_manager())
    and created_by = auth.uid()
  );
create policy bill_payments_manager_update on public.bill_payments for update to authenticated
  using (
    app_private.user_can_access_entity(entity_id)
    and (app_private.current_user_is_owner() or app_private.current_user_is_finance_manager())
  )
  with check (
    app_private.user_can_access_entity(entity_id)
    and (app_private.current_user_is_owner() or app_private.current_user_is_finance_manager())
  );

drop policy if exists payment_vouchers_entity_select on public.payment_vouchers;
drop policy if exists payment_vouchers_manage on public.payment_vouchers;
create policy payment_vouchers_sensitive_select on public.payment_vouchers for select to authenticated
  using (
    app_private.user_can_access_entity(entity_id)
    and app_private.current_user_can('can_view_sensitive_payments')
  );
create policy payment_vouchers_prepare_insert on public.payment_vouchers for insert to authenticated
  with check (
    app_private.user_can_access_entity(entity_id)
    and app_private.current_user_can('can_prepare_vouchers')
    and status = 'draft'
    and prepared_by = auth.uid()
  );
create policy payment_vouchers_prepare_update on public.payment_vouchers for update to authenticated
  using (
    app_private.user_can_access_entity(entity_id)
    and (
      app_private.current_user_can('can_prepare_vouchers')
      or app_private.current_user_can('can_issue_vouchers')
      or app_private.current_user_can('can_void_vouchers')
    )
  )
  with check (
    app_private.user_can_access_entity(entity_id)
    and (
      app_private.current_user_can('can_prepare_vouchers')
      or app_private.current_user_can('can_issue_vouchers')
      or app_private.current_user_can('can_void_vouchers')
    )
  );
create policy payment_vouchers_draft_delete on public.payment_vouchers for delete to authenticated
  using (
    status = 'draft'
    and app_private.user_can_access_entity(entity_id)
    and app_private.current_user_can('can_delete_drafts')
  );

drop policy if exists payment_voucher_items_select on public.payment_voucher_items;
drop policy if exists payment_voucher_items_manage on public.payment_voucher_items;
create policy payment_voucher_items_sensitive_select on public.payment_voucher_items for select to authenticated
  using (exists (
    select 1 from public.payment_vouchers pv
    where pv.id = payment_voucher_id
      and app_private.user_can_access_entity(pv.entity_id)
      and app_private.current_user_can('can_view_sensitive_payments')
  ));
create policy payment_voucher_items_draft_insert on public.payment_voucher_items for insert to authenticated
  with check (exists (
    select 1 from public.payment_vouchers pv
    where pv.id = payment_voucher_id and pv.status = 'draft'
      and app_private.user_can_access_entity(pv.entity_id)
      and app_private.current_user_can('can_prepare_vouchers')
  ));
create policy payment_voucher_items_draft_update on public.payment_voucher_items for update to authenticated
  using (exists (
    select 1 from public.payment_vouchers pv
    where pv.id = payment_voucher_id and pv.status = 'draft'
      and app_private.user_can_access_entity(pv.entity_id)
      and app_private.current_user_can('can_prepare_vouchers')
  ))
  with check (exists (
    select 1 from public.payment_vouchers pv
    where pv.id = payment_voucher_id and pv.status = 'draft'
      and app_private.user_can_access_entity(pv.entity_id)
      and app_private.current_user_can('can_prepare_vouchers')
  ));
create policy payment_voucher_items_draft_delete on public.payment_voucher_items for delete to authenticated
  using (exists (
    select 1 from public.payment_vouchers pv
    where pv.id = payment_voucher_id and pv.status = 'draft'
      and app_private.user_can_access_entity(pv.entity_id)
      and app_private.current_user_can('can_prepare_vouchers')
  ));

drop policy if exists recurring_obligations_entity_select on public.recurring_obligations;
drop policy if exists recurring_obligations_manage on public.recurring_obligations;
create policy recurring_obligations_finance_select on public.recurring_obligations for select to authenticated
  using (
    app_private.user_can_access_entity(entity_id)
    and app_private.current_user_can('can_view_finance')
  );
create policy recurring_obligations_manager_insert on public.recurring_obligations for insert to authenticated
  with check (
    app_private.user_can_access_entity(entity_id)
    and app_private.current_user_can('can_manage_recurring_bills')
  );
create policy recurring_obligations_manager_update on public.recurring_obligations for update to authenticated
  using (
    app_private.user_can_access_entity(entity_id)
    and app_private.current_user_can('can_manage_recurring_bills')
  )
  with check (
    app_private.user_can_access_entity(entity_id)
    and app_private.current_user_can('can_manage_recurring_bills')
  );

drop policy if exists claims_select on public.claims;
drop policy if exists claims_insert on public.claims;
drop policy if exists claims_update on public.claims;
create policy claims_confidential_select on public.claims for select to authenticated
  using (app_private.user_can_access_claim(id));
create policy claims_finance_insert on public.claims for insert to authenticated
  with check (
    app_private.user_can_access_entity(entity_id)
    and app_private.current_user_can('can_manage_claims')
    and (not app_private.current_user_is_data_entry() or status = 'draft')
    and created_by = auth.uid()
  );
create policy claims_finance_update on public.claims for update to authenticated
  using (
    app_private.user_can_access_claim(id)
    and (
      app_private.current_user_can('can_manage_claims')
      or app_private.current_user_can('can_review_claims')
      or app_private.current_user_can('can_approve_claims')
    )
  )
  with check (
    app_private.user_can_access_claim(id)
    and (
      app_private.current_user_can('can_manage_claims')
      or app_private.current_user_can('can_review_claims')
      or app_private.current_user_can('can_approve_claims')
    )
  );
create policy claims_draft_delete on public.claims for delete to authenticated
  using (
    status = 'draft'
    and app_private.user_can_access_entity(entity_id)
    and app_private.current_user_can('can_delete_drafts')
  );

drop policy if exists claim_lines_select on public.claim_lines;
drop policy if exists claim_lines_manage on public.claim_lines;
create policy claim_lines_confidential_select on public.claim_lines for select to authenticated
  using (app_private.user_can_access_claim(claim_id));
create policy claim_lines_draft_insert on public.claim_lines for insert to authenticated
  with check (exists (
    select 1 from public.claims c where c.id = claim_id and c.status = 'draft'
      and app_private.user_can_access_claim(c.id)
      and app_private.current_user_can('can_manage_claims')
  ));
create policy claim_lines_draft_update on public.claim_lines for update to authenticated
  using (exists (
    select 1 from public.claims c where c.id = claim_id and c.status = 'draft'
      and app_private.user_can_access_claim(c.id)
      and app_private.current_user_can('can_manage_claims')
  ))
  with check (exists (
    select 1 from public.claims c where c.id = claim_id and c.status = 'draft'
      and app_private.user_can_access_claim(c.id)
      and app_private.current_user_can('can_manage_claims')
  ));
create policy claim_lines_draft_delete on public.claim_lines for delete to authenticated
  using (exists (
    select 1 from public.claims c where c.id = claim_id and c.status = 'draft'
      and app_private.user_can_access_claim(c.id)
      and app_private.current_user_can('can_manage_claims')
  ));

create or replace function public.enforce_claim_approval_controls()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  caller_role text;
begin
  select p.role into caller_role
  from public.app_profiles p where p.id = auth.uid() and p.active_status = true;

  if new.checked_by is not null and new.claimant_user_id is not null
     and new.checked_by = new.claimant_user_id then
    raise exception 'A claimant cannot check their own claim';
  end if;

  if new.approved_by is not null and new.claimant_user_id is not null
     and new.approved_by = new.claimant_user_id then
    raise exception 'A claimant cannot approve their own claim';
  end if;

  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if caller_role = 'data_entry' and new.status <> 'draft' then
      raise exception 'Data Entry users may only maintain claim drafts';
    elsif new.status = 'approved' and not app_private.current_user_can('can_approve_claims') then
      raise exception 'Not authorised to approve claims';
    elsif new.status in ('payment_prepared', 'reimbursed', 'entered_in_sql_accounting', 'archived')
          and not (
            app_private.current_user_is_owner()
            or app_private.current_user_is_finance_manager()
            or (new.status = 'payment_prepared'
                and app_private.current_user_can('can_prepare_claim_reimbursements'))
          ) then
      raise exception 'Not authorised for this claim transition';
    end if;
  end if;

  if caller_role = 'management'
     and tg_op = 'UPDATE'
     and (to_jsonb(new) - array['status','approved_by','approved_at','updated_by','updated_at'])
         is distinct from
         (to_jsonb(old) - array['status','approved_by','approved_at','updated_by','updated_at']) then
    raise exception 'Management approval access does not grant routine claim editing';
  end if;

  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

create or replace function public.enforce_finance_record_state()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  caller_role text;
begin
  select p.role into caller_role
  from public.app_profiles p where p.id = auth.uid() and p.active_status = true;

  if tg_table_name = 'supplier_bills' then
    if old.payment_status in ('paid', 'cancelled')
       and not (app_private.current_user_is_owner() or app_private.current_user_is_finance_manager()) then
      raise exception 'Finalized bills may only be changed by Owner or Finance Manager';
    end if;
    if new.payment_status in ('paid', 'cancelled')
       and not (app_private.current_user_is_owner() or app_private.current_user_is_finance_manager()) then
      raise exception 'Only Owner or Finance Manager may pay or cancel a bill';
    end if;
    if caller_role = 'data_entry' and new.payment_status <> 'draft' then
      raise exception 'Data Entry users may only maintain bill drafts';
    end if;
  elsif tg_table_name = 'payment_vouchers' then
    if old.status <> 'draft'
       and not (app_private.current_user_is_owner() or app_private.current_user_is_finance_manager()) then
      raise exception 'Issued or finalized vouchers are not editable';
    end if;
    if new.status = 'issued' and not app_private.current_user_can('can_issue_vouchers') then
      raise exception 'Not authorised to issue vouchers';
    end if;
    if new.status = 'paid'
       and not (app_private.current_user_is_owner() or app_private.current_user_is_finance_manager()) then
      raise exception 'Only Owner or Finance Manager may mark a voucher paid';
    end if;
    if new.status = 'cancelled' then
      if not app_private.current_user_can('can_void_vouchers') then
        raise exception 'Not authorised to void or cancel vouchers';
      end if;
      if nullif(pg_catalog.btrim(new.cancellation_reason), '') is null then
        raise exception 'A cancellation reason is required';
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_supplier_bill_state_trigger on public.supplier_bills;
create trigger enforce_supplier_bill_state_trigger
before update on public.supplier_bills
for each row execute function public.enforce_finance_record_state();

drop trigger if exists enforce_payment_voucher_state_trigger on public.payment_vouchers;
create trigger enforce_payment_voucher_state_trigger
before update on public.payment_vouchers
for each row execute function public.enforce_finance_record_state();

revoke all on function public.enforce_finance_record_state() from public, anon, authenticated;
revoke all on function public.enforce_claim_approval_controls() from public, anon, authenticated;

-- Remove legacy self/counsellor fallbacks that bypass the private-app gate.
drop policy if exists students_scoped_select on public.students;
create policy students_scoped_select on public.students for select to authenticated
  using (
    app_private.current_user_can('can_manage_students')
    and (
      app_private.current_user_is_owner()
      or app_private.user_can_access_branch(entity_id, home_branch_id)
      or exists (
        select 1 from public.enrolments en
        where en.student_id = students.id
          and app_private.user_can_access_branch(en.entity_id, en.branch_id)
      )
    )
  );

drop policy if exists enrolments_scoped_select on public.enrolments;
create policy enrolments_scoped_select on public.enrolments for select to authenticated
  using (
    app_private.current_user_can('can_manage_enrolments')
    and app_private.user_can_access_branch(entity_id, branch_id)
  );

drop policy if exists enrolment_counsellor_history_select on public.enrolment_counsellor_history;
create policy enrolment_counsellor_history_select on public.enrolment_counsellor_history for select to authenticated
  using (exists (
    select 1 from public.enrolments en
    where en.id = enrolment_id
      and app_private.current_user_can('can_manage_enrolments')
      and app_private.user_can_access_branch(en.entity_id, en.branch_id)
  ));

drop policy if exists enrolment_counsellor_history_insert on public.enrolment_counsellor_history;
create policy enrolment_counsellor_history_insert on public.enrolment_counsellor_history for insert to authenticated
  with check (exists (
    select 1 from public.enrolments en
    where en.id = enrolment_id
      and app_private.current_user_can('can_manage_enrolments')
      and app_private.user_can_access_branch(en.entity_id, en.branch_id)
  ));

drop policy if exists claim_advances_select on public.claim_advances;
drop policy if exists claim_advances_manage on public.claim_advances;
create policy claim_advances_confidential_select on public.claim_advances for select to authenticated
  using (app_private.user_can_access_claim(claim_id));
create policy claim_advances_draft_manage on public.claim_advances for all to authenticated
  using (exists (
    select 1 from public.claims c where c.id = claim_id and c.status = 'draft'
      and app_private.user_can_access_claim(c.id)
      and app_private.current_user_can('can_manage_claims')
  ))
  with check (exists (
    select 1 from public.claims c where c.id = claim_id and c.status = 'draft'
      and app_private.user_can_access_claim(c.id)
      and app_private.current_user_can('can_manage_claims')
  ));

drop policy if exists claim_reimbursements_select on public.claim_reimbursements;
drop policy if exists claim_reimbursements_manage on public.claim_reimbursements;
create policy claim_reimbursements_confidential_select on public.claim_reimbursements for select to authenticated
  using (app_private.user_can_access_claim(claim_id));
create policy claim_reimbursements_finance_insert on public.claim_reimbursements for insert to authenticated
  with check (
    app_private.user_can_access_claim(claim_id)
    and app_private.current_user_can('can_prepare_claim_reimbursements')
  );
create policy claim_reimbursements_manager_update on public.claim_reimbursements for update to authenticated
  using (
    app_private.user_can_access_claim(claim_id)
    and (app_private.current_user_is_owner() or app_private.current_user_is_finance_manager())
  )
  with check (
    app_private.user_can_access_claim(claim_id)
    and (app_private.current_user_is_owner() or app_private.current_user_is_finance_manager())
  );

drop policy if exists claim_status_history_select on public.claim_status_history;
drop policy if exists claim_status_history_insert on public.claim_status_history;
create policy claim_status_history_confidential_select on public.claim_status_history for select to authenticated
  using (app_private.user_can_access_claim(claim_id));
create policy claim_status_history_authorised_insert on public.claim_status_history for insert to authenticated
  with check (
    changed_by = auth.uid()
    and app_private.user_can_access_claim(claim_id)
    and (
      app_private.current_user_can('can_review_claims')
      or app_private.current_user_can('can_approve_claims')
      or app_private.current_user_can('can_prepare_claim_reimbursements')
    )
  );

drop policy if exists claim_review_actions_select on public.claim_review_actions;
drop policy if exists claim_review_actions_insert on public.claim_review_actions;
create policy claim_review_actions_confidential_select on public.claim_review_actions for select to authenticated
  using (app_private.user_can_access_claim(claim_id));
create policy claim_review_actions_authorised_insert on public.claim_review_actions for insert to authenticated
  with check (
    actor_user_id = auth.uid()
    and app_private.user_can_access_claim(claim_id)
    and (
      app_private.current_user_can('can_review_claims')
      or app_private.current_user_can('can_approve_claims')
    )
  );

-- General staff roles must not regain access through old broad reference-data
-- policies. These policies also make inactive/MFA-incomplete sessions fail shut.
drop policy if exists entities_authenticated_read_active on public.entities;
create policy entities_private_app_select on public.entities for select to authenticated
  using (
    app_private.current_user_has_app_access()
    and (app_private.current_user_is_owner() or app_private.user_can_access_entity(id))
  );

drop policy if exists suppliers_authenticated_read on public.suppliers;
create policy suppliers_finance_select on public.suppliers for select to authenticated
  using (
    app_private.current_user_can('can_view_sensitive_payments')
    and (
      app_private.current_user_is_owner()
      or exists (
        select 1 from public.supplier_entities se
        where se.supplier_id = suppliers.id
          and app_private.user_can_access_entity(se.entity_id)
      )
    )
  );

create or replace view public.suppliers_app_safe
with (security_barrier = true)
as
select
  s.id,
  s.supplier_name,
  s.registration_number,
  s.contact_person,
  s.email,
  s.phone,
  case
    when app_private.current_user_can('can_view_sensitive_payments') then s.bank_details
    else '{}'::jsonb
  end as bank_details,
  s.default_expense_category,
  s.account_code,
  s.remarks,
  s.active_status,
  s.data_origin,
  s.created_at,
  s.updated_at,
  s.default_description,
  s.is_demo,
  s.archived_at,
  s.source_import_batch_id,
  s.source_import_row_id
from public.suppliers s
where app_private.current_user_can('can_view_finance')
  and (
    app_private.current_user_is_owner()
    or exists (
      select 1 from public.supplier_entities se
      where se.supplier_id = s.id
        and app_private.user_can_access_entity(se.entity_id)
    )
  );

revoke all on public.suppliers_app_safe from public, anon;
grant select on public.suppliers_app_safe to authenticated, service_role;

create or replace view public.bank_accounts_staff_safe
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
from public.bank_accounts ba
join public.entities e on e.id = ba.entity_id
where app_private.current_user_can('can_view_sensitive_payments')
  and app_private.user_can_access_entity(ba.entity_id);

revoke all on public.bank_accounts_staff_safe from public, anon;
grant select on public.bank_accounts_staff_safe to authenticated, service_role;

drop policy if exists categories_entity_read on public.categories;
create policy categories_private_app_select on public.categories for select to authenticated
  using (
    app_private.current_user_has_app_access()
    and (entity_id is null or app_private.user_can_access_entity(entity_id))
  );

drop policy if exists app_profiles_read_self on public.app_profiles;
create policy app_profiles_private_read on public.app_profiles for select to authenticated
  using (
    app_private.current_user_has_eligible_role()
    and (id = auth.uid() or app_private.current_user_is_owner())
  );

drop policy if exists user_entity_access_read_self on public.user_entity_access;
create policy user_entity_access_private_read on public.user_entity_access for select to authenticated
  using (
    app_private.current_user_has_app_access()
    and (user_id = auth.uid() or app_private.current_user_is_owner())
  );

drop policy if exists operations_user_permissions_read_self on public.operations_user_permissions;
create policy operations_user_permissions_private_read on public.operations_user_permissions for select to authenticated
  using (
    app_private.current_user_has_app_access()
    and (user_id = auth.uid() or app_private.current_user_is_owner())
  );

drop policy if exists finance_user_permissions_read_self on public.finance_user_permissions;
create policy finance_user_permissions_private_read on public.finance_user_permissions for select to authenticated
  using (
    app_private.current_user_has_app_access()
    and (user_id = auth.uid() or app_private.current_user_is_owner())
  );

drop policy if exists organisations_active_select on public.organisations;
create policy organisations_private_app_select on public.organisations for select to authenticated
  using (app_private.current_user_has_app_access() and active_status = true);

drop policy if exists user_branch_access_read_self on public.user_branch_access;
create policy user_branch_access_private_read on public.user_branch_access for select to authenticated
  using (
    app_private.current_user_has_app_access()
    and (user_id = auth.uid() or app_private.current_user_is_owner())
  );

drop policy if exists audit_logs_auth_select on public.audit_logs;
create policy audit_logs_private_select on public.audit_logs for select to authenticated
  using (
    app_private.current_user_has_app_access()
    and (
      app_private.current_user_is_owner()
      or actor_user_id = auth.uid()
      or user_id = auth.uid()
      or app_private.user_can_access_entity(entity_id)
    )
  );

-- Atomic Finance workflow entry points. Every function validates the caller;
-- SECURITY DEFINER is used only to make all related writes one transaction.
create or replace function public.save_payment_voucher_draft(
  p_voucher jsonb,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  voucher_id uuid := nullif(p_voucher ->> 'id', '')::uuid;
  target_entity_id uuid := (p_voucher ->> 'entity_id')::uuid;
  target_supplier_id uuid := nullif(p_voucher ->> 'supplier_id', '')::uuid;
  target_recurring_id uuid := nullif(p_voucher ->> 'recurring_obligation_id', '')::uuid;
  target_bank_id uuid := nullif(p_voucher ->> 'paying_bank_account_id', '')::uuid;
  target_claim_id uuid := nullif(p_voucher ->> 'claim_id', '')::uuid;
  item jsonb;
begin
  if not app_private.current_user_can('can_prepare_vouchers')
     or not app_private.user_can_access_entity(target_entity_id) then
    raise exception 'Not authorised to prepare payment vouchers';
  end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then
    raise exception 'Voucher items must be a JSON array';
  end if;
  if target_supplier_id is not null and not exists (
    select 1 from public.supplier_entities se
    where se.supplier_id = target_supplier_id and se.entity_id = target_entity_id
  ) then
    raise exception 'Supplier is not assigned to the voucher entity';
  end if;
  if target_recurring_id is not null and not exists (
    select 1 from public.recurring_obligations ro
    where ro.id = target_recurring_id and ro.entity_id = target_entity_id
  ) then
    raise exception 'Recurring obligation is not assigned to the voucher entity';
  end if;
  if target_bank_id is not null and (
    not app_private.current_user_can('can_view_sensitive_payments')
    or not exists (
      select 1 from public.bank_accounts ba
      where ba.id = target_bank_id and ba.entity_id = target_entity_id
    )
  ) then
    raise exception 'Paying bank account is not accessible for the voucher entity';
  end if;
  if target_claim_id is not null and not exists (
    select 1 from public.claims c
    where c.id = target_claim_id and c.entity_id = target_entity_id
      and app_private.user_can_access_claim(c.id)
  ) then
    raise exception 'Claim is not accessible for the voucher entity';
  end if;

  if voucher_id is null then
    insert into public.payment_vouchers (
      entity_id, supplier_id, voucher_date, payee, payee_bank_details,
      purpose, voucher_source, recurring_obligation_id, paying_bank_account_id,
      payment_method, bank_reference, remarks, total_amount, claim_id,
      source_type, source_id, status, prepared_by, is_demo, data_origin
    ) values (
      target_entity_id,
      target_supplier_id,
      coalesce(nullif(p_voucher ->> 'voucher_date', '')::date, current_date),
      p_voucher ->> 'payee',
      coalesce(p_voucher -> 'payee_bank_details', '{}'::jsonb),
      p_voucher ->> 'purpose',
      coalesce(nullif(p_voucher ->> 'voucher_source', ''), 'manual'),
      target_recurring_id,
      target_bank_id,
      nullif(p_voucher ->> 'payment_method', ''),
      nullif(p_voucher ->> 'bank_reference', ''),
      nullif(p_voucher ->> 'remarks', ''),
      coalesce((p_voucher ->> 'total_amount')::numeric, 0),
      target_claim_id,
      nullif(p_voucher ->> 'source_type', ''),
      nullif(p_voucher ->> 'source_id', '')::uuid,
      'draft', auth.uid(), false, 'manual'
    ) returning id into voucher_id;
  else
    perform 1 from public.payment_vouchers v
    where v.id = voucher_id and v.entity_id = target_entity_id and v.status = 'draft'
    for update;
    if not found then
      raise exception 'Editable draft voucher not found';
    end if;

    update public.payment_vouchers set
      supplier_id = target_supplier_id,
      voucher_date = coalesce(nullif(p_voucher ->> 'voucher_date', '')::date, voucher_date),
      payee = p_voucher ->> 'payee',
      payee_bank_details = coalesce(p_voucher -> 'payee_bank_details', '{}'::jsonb),
      purpose = p_voucher ->> 'purpose',
      voucher_source = coalesce(nullif(p_voucher ->> 'voucher_source', ''), voucher_source),
      recurring_obligation_id = target_recurring_id,
      paying_bank_account_id = target_bank_id,
      payment_method = nullif(p_voucher ->> 'payment_method', ''),
      bank_reference = nullif(p_voucher ->> 'bank_reference', ''),
      remarks = nullif(p_voucher ->> 'remarks', ''),
      total_amount = coalesce((p_voucher ->> 'total_amount')::numeric, 0),
      updated_at = pg_catalog.now()
    where id = voucher_id;

    delete from public.payment_voucher_items where payment_voucher_id = voucher_id;
  end if;

  for item in select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    if nullif(pg_catalog.btrim(item ->> 'description'), '') is null
       or (item ->> 'amount')::numeric < 0 then
      raise exception 'Voucher items require a description and non-negative amount';
    end if;
    if nullif(item ->> 'supplier_bill_id', '') is not null and not exists (
      select 1 from public.supplier_bills b
      where b.id = nullif(item ->> 'supplier_bill_id', '')::uuid
        and b.entity_id = target_entity_id
    ) then
      raise exception 'Voucher item supplier bill belongs to another entity or is unavailable';
    end if;
    if nullif(item ->> 'recurring_obligation_id', '') is not null and not exists (
      select 1 from public.recurring_obligations ro
      where ro.id = nullif(item ->> 'recurring_obligation_id', '')::uuid
        and ro.entity_id = target_entity_id
    ) then
      raise exception 'Voucher item recurring obligation belongs to another entity or is unavailable';
    end if;
    if nullif(item ->> 'expense_category_id', '') is not null and not exists (
      select 1 from public.categories c
      where c.id = nullif(item ->> 'expense_category_id', '')::uuid
        and (c.entity_id is null or c.entity_id = target_entity_id)
    ) then
      raise exception 'Voucher item expense category belongs to another entity or is unavailable';
    end if;
    if nullif(item ->> 'claim_id', '') is not null and not exists (
      select 1 from public.claims c
      where c.id = nullif(item ->> 'claim_id', '')::uuid
        and c.entity_id = target_entity_id
        and app_private.user_can_access_claim(c.id)
    ) then
      raise exception 'Voucher item claim belongs to another entity or is unavailable';
    end if;
    if nullif(item ->> 'claim_line_id', '') is not null and not exists (
      select 1 from public.claim_lines cl
      join public.claims c on c.id = cl.claim_id
      where cl.id = nullif(item ->> 'claim_line_id', '')::uuid
        and c.entity_id = target_entity_id
        and app_private.user_can_access_claim(c.id)
        and (
          nullif(item ->> 'claim_id', '') is null
          or c.id = nullif(item ->> 'claim_id', '')::uuid
        )
    ) then
      raise exception 'Voucher item claim line belongs to another claim or entity';
    end if;

    insert into public.payment_voucher_items (
      payment_voucher_id, supplier_bill_id, recurring_obligation_id,
      expense_category_id, claim_id, claim_line_id, description, amount,
      sort_order, is_demo, data_origin
    ) values (
      voucher_id,
      nullif(item ->> 'supplier_bill_id', '')::uuid,
      nullif(item ->> 'recurring_obligation_id', '')::uuid,
      nullif(item ->> 'expense_category_id', '')::uuid,
      nullif(item ->> 'claim_id', '')::uuid,
      nullif(item ->> 'claim_line_id', '')::uuid,
      item ->> 'description',
      (item ->> 'amount')::numeric,
      coalesce((item ->> 'sort_order')::integer, 1),
      false, 'manual'
    );
  end loop;

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, payload, data_origin
  ) values (
    auth.uid(), 'payment_voucher_draft_saved', 'payment_voucher', target_entity_id,
    jsonb_build_object('voucher_id', voucher_id, 'item_count', jsonb_array_length(coalesce(p_items, '[]'::jsonb))),
    'manual'
  );

  return voucher_id;
end;
$$;

create or replace function public.prepare_claim_payment_voucher(p_claim_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  claim_row public.claims%rowtype;
  voucher_id uuid;
begin
  select * into claim_row from public.claims where id = p_claim_id for update;
  if not found then raise exception 'Claim not found'; end if;
  if not app_private.current_user_can('can_prepare_claim_reimbursements')
     or not app_private.user_can_access_claim(claim_row.id) then
    raise exception 'Not authorised to prepare this claim reimbursement';
  end if;
  if claim_row.status <> 'approved' then raise exception 'Only approved claims can create reimbursement vouchers'; end if;
  if claim_row.payment_voucher_id is not null then raise exception 'This claim already has a payment voucher'; end if;
  if claim_row.net_payable_amount <= 0 then raise exception 'No net payable amount is due'; end if;
  if not exists (select 1 from public.claim_lines l where l.claim_id = p_claim_id and not l.is_excluded) then
    raise exception 'Claim has no payable lines';
  end if;

  insert into public.payment_vouchers (
    entity_id, claim_id, source_type, source_id, voucher_date, payee,
    purpose, total_amount, currency, payment_method, status, prepared_by,
    voucher_source, remarks, is_demo, data_origin
  ) values (
    claim_row.entity_id, claim_row.id, 'claim', claim_row.id, current_date,
    claim_row.claimant_name,
    'Reimbursement for ' || coalesce(claim_row.claim_number, 'claim') || ' - '
      || coalesce(claim_row.trip_or_business_purpose, claim_row.claim_type),
    claim_row.net_payable_amount, claim_row.currency, 'bank_transfer', 'draft',
    auth.uid(), 'claim', 'Generated from Staff & Director Claims module.', false, 'manual'
  ) returning id into voucher_id;

  insert into public.payment_voucher_items (
    payment_voucher_id, claim_id, claim_line_id, expense_category_id,
    description, amount, sort_order, is_demo, data_origin
  )
  select voucher_id, l.claim_id, l.id, l.expense_category_id, l.description,
    coalesce(l.myr_converted_amount, l.amount, 0), l.sort_order, false, 'manual'
  from public.claim_lines l
  where l.claim_id = p_claim_id and not l.is_excluded
  order by l.sort_order;

  insert into public.claim_reimbursements (
    claim_id, entity_id, payment_voucher_id, amount, status, created_by
  ) values (
    claim_row.id, claim_row.entity_id, voucher_id,
    claim_row.net_payable_amount, 'prepared', auth.uid()
  );

  update public.claims set
    payment_voucher_id = voucher_id,
    reimbursement_status = 'voucher_draft',
    status = 'payment_prepared',
    updated_by = auth.uid(), updated_at = pg_catalog.now()
  where id = claim_row.id;

  insert into public.claim_status_history (
    claim_id, from_status, to_status, changed_by, reason, metadata
  ) values (
    claim_row.id, claim_row.status, 'payment_prepared', auth.uid(),
    'Reimbursement voucher draft created', jsonb_build_object('payment_voucher_id', voucher_id)
  );

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, payload, data_origin
  ) values (
    auth.uid(), 'claim_reimbursement_voucher_created', 'claim', claim_row.entity_id,
    jsonb_build_object('claim_id', claim_row.id, 'payment_voucher_id', voucher_id), 'manual'
  );

  return jsonb_build_object('claim_id', claim_row.id, 'payment_voucher_id', voucher_id);
end;
$$;

create or replace function public.issue_payment_voucher(p_voucher_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  voucher_row public.payment_vouchers%rowtype;
  generated_number text;
begin
  select * into voucher_row from public.payment_vouchers where id = p_voucher_id for update;
  if not found then raise exception 'Voucher not found'; end if;
  if not app_private.current_user_can('can_issue_vouchers')
     or not app_private.user_can_access_entity(voucher_row.entity_id) then
    raise exception 'Not authorised to issue payment vouchers';
  end if;
  if voucher_row.status <> 'draft' or voucher_row.voucher_number is not null then
    raise exception 'Only an unnumbered draft voucher can be issued';
  end if;
  if not exists (select 1 from public.payment_voucher_items i where i.payment_voucher_id = p_voucher_id) then
    raise exception 'Add at least one voucher item before issuing';
  end if;

  generated_number := public.generate_payment_voucher_number(voucher_row.entity_id);
  update public.payment_vouchers set
    voucher_number = generated_number, status = 'issued',
    issued_at = pg_catalog.now(), prepared_by = coalesce(prepared_by, auth.uid())
  where id = p_voucher_id;

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, payload, data_origin
  ) values (
    auth.uid(), 'payment_voucher_issued', 'payment_voucher', voucher_row.entity_id,
    jsonb_build_object('voucher_id', p_voucher_id, 'voucher_number', generated_number), 'manual'
  );

  return jsonb_build_object('id', p_voucher_id, 'voucher_number', generated_number);
end;
$$;

revoke all on function public.save_payment_voucher_draft(jsonb, jsonb) from public, anon;
revoke all on function public.prepare_claim_payment_voucher(uuid) from public, anon;
revoke all on function public.issue_payment_voucher(uuid) from public, anon;
grant execute on function public.save_payment_voucher_draft(jsonb, jsonb) to authenticated;
grant execute on function public.prepare_claim_payment_voucher(uuid) to authenticated;
grant execute on function public.issue_payment_voucher(uuid) to authenticated;

create or replace function public.delete_payment_voucher_draft(
  p_voucher_id uuid,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  voucher_row public.payment_vouchers%rowtype;
begin
  if not app_private.current_user_can('can_delete_drafts') then
    raise exception 'Not authorised to permanently delete draft vouchers';
  end if;
  if nullif(pg_catalog.btrim(p_reason), '') is null then
    raise exception 'Deletion reason is required';
  end if;
  select * into voucher_row from public.payment_vouchers where id = p_voucher_id for update;
  if not found or voucher_row.status <> 'draft'
     or not app_private.user_can_access_entity(voucher_row.entity_id) then
    raise exception 'Eligible draft voucher not found';
  end if;
  if exists (
    select 1 from public.document_links dl
    where dl.linked_record_type = 'payment_voucher' and dl.linked_record_id = p_voucher_id
  ) then
    raise exception 'Delete linked documents before deleting this draft voucher';
  end if;
  perform set_config('app.deletion_reason', pg_catalog.btrim(p_reason), true);
  delete from public.payment_vouchers where id = p_voucher_id;
  return true;
end;
$$;

revoke all on function public.delete_payment_voucher_draft(uuid, text) from public, anon;
grant execute on function public.delete_payment_voucher_draft(uuid, text) to authenticated;

-- Hard deletion is available only through reason-requiring audited RPCs.
drop policy if exists supplier_bills_draft_delete on public.supplier_bills;
drop policy if exists payment_vouchers_draft_delete on public.payment_vouchers;
drop policy if exists claims_draft_delete on public.claims;
revoke delete on public.supplier_bills, public.payment_vouchers, public.claims from authenticated, anon;

-- Controlled document deletion returns the Storage path to the server route.
-- The server removes the object first and restores it if this transaction fails.
create or replace function public.delete_document_metadata(
  p_document_id uuid,
  p_reason text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  document_row public.documents%rowtype;
begin
  if not app_private.current_user_can('can_delete_documents') then
    raise exception 'Not authorised to delete documents';
  end if;
  if nullif(pg_catalog.btrim(p_reason), '') is null then
    raise exception 'Deletion reason is required';
  end if;

  select * into document_row from public.documents where id = p_document_id for update;
  if not found or not app_private.user_can_access_document(document_row.id) then
    raise exception 'Document not found or not accessible';
  end if;

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, payload, before_data, data_origin
  ) values (
    auth.uid(), 'document_permanently_deleted', 'document', document_row.entity_id,
    jsonb_build_object('document_id', document_row.id, 'reason', pg_catalog.btrim(p_reason)),
    jsonb_build_object(
      'original_filename', document_row.original_filename,
      'storage_path', document_row.storage_path,
      'file_hash', document_row.file_hash
    ),
    'manual'
  );

  delete from public.documents where id = document_row.id;
  return document_row.storage_path;
end;
$$;

revoke all on function public.delete_document_metadata(uuid, text) from public, anon;
grant execute on function public.delete_document_metadata(uuid, text) to authenticated;

create or replace function public.discard_unlinked_document(p_document_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  document_row public.documents%rowtype;
begin
  if not app_private.current_user_has_app_access()
     or not app_private.current_user_can('can_upload_documents') then
    raise exception 'Not authorised to compensate document uploads';
  end if;
  select * into document_row from public.documents where id = p_document_id for update;
  if not found then return true; end if;
  if document_row.uploaded_by <> auth.uid() then
    raise exception 'Only the uploader may compensate an incomplete upload';
  end if;
  if exists (select 1 from public.document_links dl where dl.document_id = p_document_id) then
    raise exception 'Linked documents cannot be discarded as incomplete uploads';
  end if;
  delete from public.documents where id = p_document_id;
  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, payload, data_origin
  ) values (
    auth.uid(), 'incomplete_document_upload_compensated', 'document', document_row.entity_id,
    jsonb_build_object('document_id', p_document_id, 'storage_path', document_row.storage_path), 'manual'
  );
  return true;
end;
$$;

revoke all on function public.discard_unlinked_document(uuid) from public, anon;
grant execute on function public.discard_unlinked_document(uuid) to authenticated;

alter table public.student_merge_events alter column source_student_id drop not null;
alter table public.student_merge_events drop constraint if exists student_merge_events_source_student_id_fkey;
alter table public.student_merge_events add constraint student_merge_events_source_student_id_fkey
  foreign key (source_student_id) references public.students(id) on delete set null;

create or replace function public.delete_duplicate_student(
  p_student_id uuid,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  student_row public.students%rowtype;
begin
  if not (app_private.current_user_is_owner() or app_private.current_user_is_finance_manager()) then
    raise exception 'Only Owner or Finance Manager may permanently delete duplicate students';
  end if;
  if nullif(pg_catalog.btrim(p_reason), '') is null then
    raise exception 'Deletion reason is required';
  end if;

  select * into student_row from public.students where id = p_student_id for update;
  if not found or not app_private.user_can_access_branch(student_row.entity_id, student_row.home_branch_id) then
    raise exception 'Student not found or not accessible';
  end if;

  if exists (select 1 from public.enrolments e where e.student_id = p_student_id)
     or exists (select 1 from public.document_links d where d.linked_record_type = 'student' and d.linked_record_id = p_student_id)
     or exists (select 1 from public.student_legacy_records l where l.student_id = p_student_id)
     or exists (select 1 from public.student_import_rows r where r.matched_student_id = p_student_id or r.created_student_id = p_student_id)
     or exists (select 1 from public.student_duplicate_reviews r where r.student_id = p_student_id or r.possible_duplicate_student_id = p_student_id)
     or exists (select 1 from public.student_merge_events e where e.target_student_id = p_student_id) then
    raise exception 'Student has dependent records; use the controlled merge workflow';
  end if;

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, payload, before_data, data_origin
  ) values (
    auth.uid(), 'duplicate_student_permanently_deleted', 'student', student_row.entity_id,
    jsonb_build_object('student_id', p_student_id, 'reason', pg_catalog.btrim(p_reason)),
    jsonb_build_object('student_number', student_row.student_number, 'home_branch_id', student_row.home_branch_id),
    'manual'
  );

  delete from public.students where id = p_student_id;
  return true;
end;
$$;

create or replace function public.merge_students(
  p_source_student_id uuid,
  p_target_student_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_row public.students%rowtype;
  target_row public.students%rowtype;
  moved_enrolments integer := 0;
  moved_documents integer := 0;
  moved_legacy integer := 0;
  moved_duplicate_reviews integer := 0;
begin
  if not (app_private.current_user_is_owner() or app_private.current_user_is_finance_manager()) then
    raise exception 'Only Owner or Finance Manager may merge students';
  end if;
  if p_source_student_id = p_target_student_id then
    raise exception 'Source and target student must be different';
  end if;
  if nullif(pg_catalog.btrim(p_reason), '') is null then
    raise exception 'Merge reason is required';
  end if;

  select * into source_row from public.students where id = p_source_student_id for update;
  if not found then raise exception 'Source student not found'; end if;
  select * into target_row from public.students where id = p_target_student_id for update;
  if not found then raise exception 'Target student not found'; end if;

  if source_row.entity_id <> target_row.entity_id then
    raise exception 'Students from different entities cannot be merged';
  end if;
  if not app_private.user_can_access_branch(source_row.entity_id, source_row.home_branch_id)
     or not app_private.user_can_access_branch(target_row.entity_id, target_row.home_branch_id) then
    raise exception 'Not authorised to merge one or both student records';
  end if;

  update public.enrolments set
    student_id = p_target_student_id, updated_by = auth.uid(), updated_at = pg_catalog.now()
  where student_id = p_source_student_id;
  get diagnostics moved_enrolments = row_count;

  update public.document_links set linked_record_id = p_target_student_id
  where linked_record_type = 'student' and linked_record_id = p_source_student_id;
  get diagnostics moved_documents = row_count;

  update public.student_legacy_records set student_id = p_target_student_id, updated_at = pg_catalog.now()
  where student_id = p_source_student_id;
  get diagnostics moved_legacy = row_count;

  update public.student_import_rows set matched_student_id = p_target_student_id
  where matched_student_id = p_source_student_id;
  update public.student_import_rows set created_student_id = p_target_student_id
  where created_student_id = p_source_student_id;

  insert into public.student_duplicate_reviews (
    student_id, possible_duplicate_student_id, match_reason, match_strength,
    status, reviewed_by, reviewed_at, remarks, created_at
  )
  select
    case when review.student_id = p_source_student_id then p_target_student_id else review.student_id end,
    case when review.possible_duplicate_student_id = p_source_student_id then p_target_student_id else review.possible_duplicate_student_id end,
    review.match_reason,
    review.match_strength,
    review.status,
    review.reviewed_by,
    review.reviewed_at,
    review.remarks,
    review.created_at
  from public.student_duplicate_reviews review
  where (review.student_id = p_source_student_id or review.possible_duplicate_student_id = p_source_student_id)
    and case when review.student_id = p_source_student_id then p_target_student_id else review.student_id end
        is distinct from
        case when review.possible_duplicate_student_id = p_source_student_id then p_target_student_id else review.possible_duplicate_student_id end
  on conflict (student_id, possible_duplicate_student_id, match_reason) do nothing;
  get diagnostics moved_duplicate_reviews = row_count;

  delete from public.student_duplicate_reviews
  where student_id = p_source_student_id or possible_duplicate_student_id = p_source_student_id;

  insert into public.student_merge_events (
    source_student_id, target_student_id, merged_by, merge_reason, preserved_summary
  ) values (
    p_source_student_id, p_target_student_id, auth.uid(), pg_catalog.btrim(p_reason),
    jsonb_build_object(
      'source_student_number', source_row.student_number,
      'source_full_name', source_row.full_name,
      'moved_enrolments', moved_enrolments,
      'moved_document_links', moved_documents,
      'moved_legacy_records', moved_legacy,
      'moved_duplicate_reviews', moved_duplicate_reviews
    )
  );

  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, payload, before_data, data_origin
  ) values (
    auth.uid(), 'students_merged_and_duplicate_deleted', 'student', target_row.entity_id,
    jsonb_build_object(
      'source_student_id', p_source_student_id,
      'target_student_id', p_target_student_id,
      'reason', pg_catalog.btrim(p_reason),
      'moved_enrolments', moved_enrolments,
      'moved_document_links', moved_documents,
      'moved_legacy_records', moved_legacy,
      'moved_duplicate_reviews', moved_duplicate_reviews
    ),
    jsonb_build_object('source_student_number', source_row.student_number), 'manual'
  );

  delete from public.students where id = p_source_student_id;

  return jsonb_build_object(
    'source_deleted', true,
    'moved_enrolments', moved_enrolments,
    'moved_document_links', moved_documents,
    'moved_legacy_records', moved_legacy,
    'moved_duplicate_reviews', moved_duplicate_reviews
  );
end;
$$;

revoke all on function public.delete_duplicate_student(uuid, text) from public, anon;
revoke all on function public.merge_students(uuid, uuid, text) from public, anon;
grant execute on function public.delete_duplicate_student(uuid, text) to authenticated;
grant execute on function public.merge_students(uuid, uuid, text) to authenticated;

create or replace function public.audit_finance_lifecycle_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  action_name text;
  target_entity_id uuid;
  reason_text text;
  old_data jsonb;
  new_data jsonb;
begin
  if tg_op = 'DELETE' then
    action_name := tg_table_name || '_permanently_deleted';
    target_entity_id := old.entity_id;
    reason_text := coalesce(current_setting('app.deletion_reason', true), 'eligible draft deletion');
    insert into public.audit_logs (
      actor_user_id, action, entity_type, entity_id, payload, before_data, data_origin
    ) values (
      auth.uid(), action_name, tg_table_name, target_entity_id,
      jsonb_build_object('record_id', old.id, 'reason', reason_text), to_jsonb(old), 'manual'
    );
    return old;
  end if;

  old_data := to_jsonb(old);
  new_data := to_jsonb(new);

  if tg_table_name = 'supplier_bills'
     and new_data ->> 'payment_status' = 'cancelled'
     and old_data ->> 'payment_status' is distinct from new_data ->> 'payment_status' then
    action_name := 'supplier_bill_cancelled';
    reason_text := coalesce(nullif(new_data ->> 'remarks', ''), 'No reason recorded');
  elsif tg_table_name = 'payment_vouchers'
        and new_data ->> 'status' = 'cancelled'
        and old_data ->> 'status' is distinct from new_data ->> 'status' then
    action_name := 'payment_voucher_voided';
    reason_text := new_data ->> 'cancellation_reason';
  elsif tg_table_name = 'claims'
        and new_data ->> 'status' in ('rejected', 'archived')
        and old_data ->> 'status' is distinct from new_data ->> 'status' then
    action_name := 'claim_' || (new_data ->> 'status');
    reason_text := coalesce(nullif(new_data ->> 'remarks', ''), 'No reason recorded');
  else
    return new;
  end if;

  target_entity_id := (new_data ->> 'entity_id')::uuid;
  insert into public.audit_logs (
    actor_user_id, action, entity_type, entity_id, payload, before_data, after_data, data_origin
  ) values (
    auth.uid(), action_name, tg_table_name, target_entity_id,
    jsonb_build_object('record_id', new_data ->> 'id', 'reason', reason_text),
    old_data, new_data, 'manual'
  );
  return new;
end;
$$;

drop trigger if exists audit_supplier_bill_lifecycle_trigger on public.supplier_bills;
create trigger audit_supplier_bill_lifecycle_trigger
after update or delete on public.supplier_bills
for each row execute function public.audit_finance_lifecycle_change();
drop trigger if exists audit_payment_voucher_lifecycle_trigger on public.payment_vouchers;
create trigger audit_payment_voucher_lifecycle_trigger
after update or delete on public.payment_vouchers
for each row execute function public.audit_finance_lifecycle_change();
drop trigger if exists audit_claim_lifecycle_trigger on public.claims;
create trigger audit_claim_lifecycle_trigger
after update or delete on public.claims
for each row execute function public.audit_finance_lifecycle_change();

revoke all on function public.audit_finance_lifecycle_change() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
