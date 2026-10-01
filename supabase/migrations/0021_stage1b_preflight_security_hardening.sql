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
     or not app_private.user_can_access_branch(p_entity_id, null) then
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

notify pgrst, 'reload schema';

commit;
