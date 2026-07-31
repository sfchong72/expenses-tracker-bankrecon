begin;

-- Fix the live Stage 1A enrolment-number failure. The previous function used
-- sequence_year as both a PL/pgSQL variable and a table column.
create or replace function public.generate_enrolment_number(
  p_entity_id uuid,
  p_branch_id uuid,
  p_intake_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, auth, extensions, app_private
as $$
declare
  v_sequence_year integer;
  v_yy integer;
  v_sequence integer;
  v_entity_code text;
  v_branch_code text;
  v_number_code text;
begin
  if not app_private.current_user_can('can_manage_enrolments')
     or not app_private.user_can_access_branch(p_entity_id, p_branch_id) then
    raise exception 'Not authorised to generate enrolment numbers';
  end if;

  select
    e.short_code,
    b.branch_code,
    extract(year from coalesce(pi.start_date, current_date))::integer,
    case
      when upper(trim(coalesce(pi.intake_name, ''))) ~ '^[A-Z]{1,4}[0-9]{0,3}$'
        then upper(trim(pi.intake_name))
      else regexp_replace(
        regexp_replace(upper(coalesce(nullif(p.programme_code, ''), nullif(pi.intake_code, ''))), '^[0-9]+[-_ ]*', ''),
        '[^A-Z0-9]',
        '',
        'g'
      )
    end
  into v_entity_code, v_branch_code, v_sequence_year, v_number_code
  from public.programme_intakes pi
  join public.programmes p on p.id = pi.programme_id
  join public.entities e on e.id = pi.entity_id
  join public.branches b on b.id = pi.branch_id
  where pi.id = p_intake_id
    and pi.entity_id = p_entity_id
    and pi.branch_id = p_branch_id;

  if v_entity_code is null or v_branch_code is null or v_number_code is null or v_number_code = '' then
    raise exception 'Unknown entity, branch, programme or intake';
  end if;

  insert into app_private.student_enrolment_number_sequences (
    entity_id,
    branch_id,
    sequence_year,
    number_code,
    last_number
  )
  values (p_entity_id, p_branch_id, v_sequence_year, v_number_code, 1)
  on conflict (entity_id, branch_id, sequence_year, number_code)
  do update
  set last_number = app_private.student_enrolment_number_sequences.last_number + 1,
      updated_at = now()
  returning last_number into v_sequence;

  v_yy := v_sequence_year % 100;

  return v_entity_code
    || '-'
    || v_branch_code
    || lpad(v_yy::text, 2, '0')
    || '/'
    || v_number_code
    || '-'
    || lpad(v_sequence::text, 3, '0');
end;
$$;

create table if not exists student_import_batches (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references entities(id) on delete restrict,
  default_branch_id uuid not null references branches(id) on delete restrict,
  filename text not null,
  file_type text not null check (file_type in ('csv', 'xlsx')),
  worksheet_name text,
  import_mode text not null default 'standard' check (import_mode in ('standard', 'legacy')),
  status text not null default 'mapping'
    check (status in ('mapping', 'ready', 'processing', 'completed', 'completed_with_errors', 'failed', 'reverted')),
  mapping_config jsonb not null default '{}'::jsonb,
  total_rows integer not null default 0,
  successful_rows integer not null default 0,
  skipped_rows integer not null default 0,
  failed_rows integer not null default 0,
  uploaded_by uuid references auth.users(id) on delete set null,
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamptz,
  reverted_by uuid references auth.users(id) on delete set null,
  reverted_at timestamptz,
  result_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists student_import_rows (
  id uuid primary key default gen_random_uuid(),
  student_import_batch_id uuid not null references student_import_batches(id) on delete cascade,
  row_number integer not null,
  original_data jsonb not null default '{}'::jsonb,
  mapped_data jsonb not null default '{}'::jsonb,
  validation_errors text[] not null default '{}'::text[],
  duplicate_warnings jsonb not null default '[]'::jsonb,
  duplicate_decision text not null default 'pending'
    check (duplicate_decision in ('pending', 'import_as_new', 'link_existing', 'skip')),
  matched_student_id uuid references students(id) on delete set null,
  created_student_id uuid references students(id) on delete set null,
  row_status text not null default 'pending'
    check (row_status in ('pending', 'imported', 'linked', 'skipped', 'failed', 'reverted', 'revert_blocked')),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_import_batch_id, row_number)
);

create table if not exists student_legacy_records (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references students(id) on delete cascade,
  source_import_batch_id uuid references student_import_batches(id) on delete set null,
  source_import_row_id uuid references student_import_rows(id) on delete set null,
  source_student_number text,
  programme_id uuid references programmes(id) on delete set null,
  intake_id uuid references programme_intakes(id) on delete set null,
  programme_text text,
  intake_text text,
  enrolment_year integer,
  completion_year integer,
  legacy_status text,
  course_arrangement text,
  counsellor_name text,
  remarks text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (enrolment_year is null or enrolment_year between 1900 and 2100),
  check (completion_year is null or completion_year between 1900 and 2100)
);

create index if not exists student_import_batches_scope_idx
  on student_import_batches(entity_id, default_branch_id, created_at desc);
create index if not exists student_import_rows_batch_idx
  on student_import_rows(student_import_batch_id, row_number);
create index if not exists student_import_rows_created_student_idx
  on student_import_rows(created_student_id) where created_student_id is not null;
create index if not exists student_legacy_records_student_idx
  on student_legacy_records(student_id, completion_year);
create index if not exists student_legacy_records_batch_idx
  on student_legacy_records(source_import_batch_id);

drop trigger if exists set_student_import_batches_updated_at on student_import_batches;
create trigger set_student_import_batches_updated_at
before update on student_import_batches
for each row execute function public.set_updated_at();

drop trigger if exists set_student_import_rows_updated_at on student_import_rows;
create trigger set_student_import_rows_updated_at
before update on student_import_rows
for each row execute function public.set_updated_at();

drop trigger if exists set_student_legacy_records_updated_at on student_legacy_records;
create trigger set_student_legacy_records_updated_at
before update on student_legacy_records
for each row execute function public.set_updated_at();

alter table student_import_batches enable row level security;
alter table student_import_rows enable row level security;
alter table student_legacy_records enable row level security;

drop policy if exists "student_import_batches_select" on student_import_batches;
create policy "student_import_batches_select" on student_import_batches
for select to authenticated
using (
  app_private.current_user_can('can_manage_students')
  and app_private.user_can_access_branch(entity_id, default_branch_id)
);

drop policy if exists "student_import_batches_manage" on student_import_batches;
create policy "student_import_batches_manage" on student_import_batches
for all to authenticated
using (
  app_private.current_user_can('can_manage_students')
  and app_private.user_can_access_branch(entity_id, default_branch_id)
)
with check (
  app_private.current_user_can('can_manage_students')
  and app_private.user_can_access_branch(entity_id, default_branch_id)
);

drop policy if exists "student_import_rows_select" on student_import_rows;
create policy "student_import_rows_select" on student_import_rows
for select to authenticated
using (
  exists (
    select 1
    from student_import_batches b
    where b.id = student_import_batch_id
      and app_private.current_user_can('can_manage_students')
      and app_private.user_can_access_branch(b.entity_id, b.default_branch_id)
  )
);

drop policy if exists "student_import_rows_manage" on student_import_rows;
create policy "student_import_rows_manage" on student_import_rows
for all to authenticated
using (
  exists (
    select 1
    from student_import_batches b
    where b.id = student_import_batch_id
      and app_private.current_user_can('can_manage_students')
      and app_private.user_can_access_branch(b.entity_id, b.default_branch_id)
  )
)
with check (
  exists (
    select 1
    from student_import_batches b
    where b.id = student_import_batch_id
      and app_private.current_user_can('can_manage_students')
      and app_private.user_can_access_branch(b.entity_id, b.default_branch_id)
  )
);

drop policy if exists "student_legacy_records_select" on student_legacy_records;
create policy "student_legacy_records_select" on student_legacy_records
for select to authenticated
using (
  exists (
    select 1
    from students s
    where s.id = student_id
      and (
        app_private.current_user_is_owner()
        or app_private.user_can_access_branch(s.entity_id, s.home_branch_id)
      )
  )
);

drop policy if exists "student_legacy_records_manage" on student_legacy_records;
create policy "student_legacy_records_manage" on student_legacy_records
for all to authenticated
using (
  app_private.current_user_can('can_manage_students')
  and exists (
    select 1
    from students s
    where s.id = student_id
      and app_private.user_can_access_branch(s.entity_id, s.home_branch_id)
  )
)
with check (
  app_private.current_user_can('can_manage_students')
  and exists (
    select 1
    from students s
    where s.id = student_id
      and app_private.user_can_access_branch(s.entity_id, s.home_branch_id)
  )
);

create or replace function public.confirm_student_import_row(
  p_row_id uuid,
  p_mapped_data jsonb,
  p_duplicate_decision text,
  p_matched_student_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, app_private
as $$
declare
  v_row student_import_rows%rowtype;
  v_batch student_import_batches%rowtype;
  v_student_id uuid;
  v_student_number text;
  v_full_name text;
  v_identity_type text;
  v_identity_number text;
  v_missing_fields text[];
  v_legacy_id uuid;
begin
  select * into v_row
  from student_import_rows
  where id = p_row_id
  for update;

  if not found then
    raise exception 'Import row not found';
  end if;

  select * into v_batch
  from student_import_batches
  where id = v_row.student_import_batch_id
  for update;

  if not app_private.current_user_can('can_manage_students')
     or not app_private.user_can_access_branch(v_batch.entity_id, v_batch.default_branch_id) then
    raise exception 'Not authorised to import students';
  end if;

  if v_batch.status not in ('mapping', 'ready', 'processing') then
    raise exception 'This import batch can no longer be confirmed';
  end if;

  if p_duplicate_decision = 'skip' then
    update student_import_rows
    set mapped_data = p_mapped_data,
        duplicate_decision = 'skip',
        row_status = 'skipped',
        error_message = null
    where id = p_row_id;
    return jsonb_build_object('row_id', p_row_id, 'status', 'skipped');
  end if;

  v_full_name := nullif(trim(coalesce(p_mapped_data->>'full_name', '')), '');
  if v_full_name is null then
    raise exception 'Full name is required';
  end if;

  if p_duplicate_decision = 'link_existing' then
    if p_matched_student_id is null then
      raise exception 'Select the existing student to link';
    end if;

    select s.id into v_student_id
    from students s
    where s.id = p_matched_student_id
      and s.entity_id = v_batch.entity_id
      and app_private.user_can_access_branch(s.entity_id, s.home_branch_id)
      and s.lifecycle_status <> 'merged';

    if v_student_id is null then
      raise exception 'The selected existing student is not available';
    end if;
  elsif p_duplicate_decision = 'import_as_new' then
    v_identity_number := nullif(trim(coalesce(p_mapped_data->>'identity_number', '')), '');
    v_identity_type := nullif(lower(trim(coalesce(p_mapped_data->>'identity_document_type', ''))), '');
    if v_identity_number is not null and v_identity_type is null then
      v_identity_type := 'other';
    end if;
    if v_identity_type is not null and v_identity_type not in ('ic', 'passport', 'other') then
      raise exception 'Identity document type must be IC, passport or other';
    end if;

    v_missing_fields := array_remove(array[
      case when nullif(trim(coalesce(p_mapped_data->>'preferred_name', '')), '') is null then 'Preferred name' end,
      case when v_identity_number is null then 'IC/passport number' end,
      case when nullif(trim(coalesce(p_mapped_data->>'date_of_birth', '')), '') is null then 'Date of birth' end,
      case when nullif(trim(coalesce(p_mapped_data->>'gender', '')), '') is null then 'Gender' end,
      case when nullif(trim(coalesce(p_mapped_data->>'phone', '')), '') is null then 'Phone' end,
      case when nullif(trim(coalesce(p_mapped_data->>'email', '')), '') is null then 'Email' end,
      case when nullif(trim(coalesce(p_mapped_data->>'education_level', '')), '') is null
             and nullif(trim(coalesce(p_mapped_data->>'qualification_details', '')), '') is null then 'Education' end,
      case when nullif(trim(coalesce(p_mapped_data->>'address', '')), '') is null then 'Address' end
    ], null);

    v_student_id := gen_random_uuid();
    v_student_number := public.generate_student_number(v_batch.entity_id);

    insert into students (
      id,
      entity_id,
      student_number,
      full_name,
      preferred_name,
      identity_document_type,
      identity_number_protected,
      nationality,
      date_of_birth,
      gender,
      phone,
      email,
      address,
      city,
      state,
      postcode,
      country,
      previous_school,
      education_level,
      qualification_details,
      education_institution,
      field_of_study,
      graduation_year,
      home_branch_id,
      lifecycle_status,
      active_status,
      missing_recommended_fields,
      remarks,
      created_by,
      updated_by,
      data_origin
    )
    values (
      v_student_id,
      v_batch.entity_id,
      v_student_number,
      v_full_name,
      nullif(trim(coalesce(p_mapped_data->>'preferred_name', '')), ''),
      v_identity_type,
      v_identity_number,
      coalesce(nullif(trim(coalesce(p_mapped_data->>'nationality', '')), ''), 'Malaysian'),
      nullif(trim(coalesce(p_mapped_data->>'date_of_birth', '')), '')::date,
      nullif(lower(trim(coalesce(p_mapped_data->>'gender', ''))), ''),
      nullif(trim(coalesce(p_mapped_data->>'phone', '')), ''),
      nullif(lower(trim(coalesce(p_mapped_data->>'email', ''))), ''),
      nullif(trim(coalesce(p_mapped_data->>'address', '')), ''),
      nullif(trim(coalesce(p_mapped_data->>'city', '')), ''),
      nullif(trim(coalesce(p_mapped_data->>'state', '')), ''),
      nullif(trim(coalesce(p_mapped_data->>'postcode', '')), ''),
      coalesce(nullif(trim(coalesce(p_mapped_data->>'country', '')), ''), 'Malaysia'),
      nullif(trim(coalesce(p_mapped_data->>'previous_school', '')), ''),
      nullif(trim(coalesce(p_mapped_data->>'education_level', '')), ''),
      nullif(trim(coalesce(p_mapped_data->>'qualification_details', '')), ''),
      nullif(trim(coalesce(p_mapped_data->>'education_institution', '')), ''),
      nullif(trim(coalesce(p_mapped_data->>'field_of_study', '')), ''),
      nullif(trim(coalesce(p_mapped_data->>'graduation_year', '')), '')::integer,
      v_batch.default_branch_id,
      'draft',
      true,
      v_missing_fields,
      nullif(trim(coalesce(p_mapped_data->>'remarks', '')), ''),
      auth.uid(),
      auth.uid(),
      'imported'
    );
  else
    raise exception 'Resolve duplicates by choosing import as new, link existing or skip';
  end if;

  if v_batch.import_mode = 'legacy' then
    if nullif(trim(coalesce(p_mapped_data->>'programme_id', '')), '') is not null
       and not exists (
         select 1
         from programmes p
         where p.id = (p_mapped_data->>'programme_id')::uuid
           and p.entity_id = v_batch.entity_id
       ) then
      raise exception 'The selected programme is outside this import entity';
    end if;

    if nullif(trim(coalesce(p_mapped_data->>'intake_id', '')), '') is not null
       and not exists (
         select 1
         from programme_intakes pi
         where pi.id = (p_mapped_data->>'intake_id')::uuid
           and pi.entity_id = v_batch.entity_id
           and app_private.user_can_access_branch(pi.entity_id, pi.branch_id)
           and (
             nullif(trim(coalesce(p_mapped_data->>'programme_id', '')), '') is null
             or pi.programme_id = (p_mapped_data->>'programme_id')::uuid
           )
       ) then
      raise exception 'The selected intake is outside this import entity, branch or programme';
    end if;

    insert into student_legacy_records (
      student_id,
      source_import_batch_id,
      source_import_row_id,
      source_student_number,
      programme_id,
      intake_id,
      programme_text,
      intake_text,
      enrolment_year,
      completion_year,
      legacy_status,
      course_arrangement,
      counsellor_name,
      remarks,
      created_by
    )
    values (
      v_student_id,
      v_batch.id,
      v_row.id,
      nullif(trim(coalesce(p_mapped_data->>'student_number', '')), ''),
      nullif(trim(coalesce(p_mapped_data->>'programme_id', '')), '')::uuid,
      nullif(trim(coalesce(p_mapped_data->>'intake_id', '')), '')::uuid,
      nullif(trim(coalesce(p_mapped_data->>'programme', '')), ''),
      nullif(trim(coalesce(p_mapped_data->>'intake', '')), ''),
      nullif(trim(coalesce(p_mapped_data->>'enrolment_year', '')), '')::integer,
      nullif(trim(coalesce(p_mapped_data->>'completion_year', '')), '')::integer,
      nullif(trim(coalesce(p_mapped_data->>'status', '')), ''),
      nullif(trim(coalesce(p_mapped_data->>'course_arrangement', '')), ''),
      nullif(trim(coalesce(p_mapped_data->>'counsellor_name', '')), ''),
      nullif(trim(coalesce(p_mapped_data->>'remarks', '')), ''),
      auth.uid()
    )
    returning id into v_legacy_id;
  end if;

  update student_import_rows
  set mapped_data = p_mapped_data,
      duplicate_decision = p_duplicate_decision,
      matched_student_id = case when p_duplicate_decision = 'link_existing' then v_student_id else null end,
      created_student_id = case when p_duplicate_decision = 'import_as_new' then v_student_id else null end,
      row_status = case when p_duplicate_decision = 'link_existing' then 'linked' else 'imported' end,
      validation_errors = '{}'::text[],
      error_message = null
  where id = p_row_id;

  insert into audit_logs (actor_user_id, action, entity_type, entity_id, payload, data_origin)
  values (
    auth.uid(),
    case when p_duplicate_decision = 'link_existing' then 'legacy_student_linked' else 'student_imported' end,
    'student',
    v_student_id,
    jsonb_build_object(
      'student_import_batch_id', v_batch.id,
      'student_import_row_id', v_row.id,
      'import_mode', v_batch.import_mode,
      'legacy_record_id', v_legacy_id
    ),
    'imported'
  );

  return jsonb_build_object(
    'row_id', p_row_id,
    'status', case when p_duplicate_decision = 'link_existing' then 'linked' else 'imported' end,
    'student_id', v_student_id,
    'student_number', v_student_number,
    'legacy_record_id', v_legacy_id
  );
end;
$$;

create or replace function public.revert_student_import_batch(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, app_private
as $$
declare
  v_batch student_import_batches%rowtype;
  v_removed_legacy integer := 0;
  v_removed_students integer := 0;
  v_blocked_students integer := 0;
begin
  select * into v_batch
  from student_import_batches
  where id = p_batch_id
  for update;

  if not found then
    raise exception 'Import batch not found';
  end if;

  if not app_private.current_user_can('can_manage_students')
     or not app_private.user_can_access_branch(v_batch.entity_id, v_batch.default_branch_id) then
    raise exception 'Not authorised to revert student imports';
  end if;

  if v_batch.status not in ('completed', 'completed_with_errors') then
    raise exception 'Only completed import batches can be reverted';
  end if;

  delete from student_legacy_records
  where source_import_batch_id = p_batch_id;
  get diagnostics v_removed_legacy = row_count;

  with candidates as (
    select r.id as row_id, r.created_student_id as student_id
    from student_import_rows r
    where r.student_import_batch_id = p_batch_id
      and r.created_student_id is not null
  ),
  blocked as (
    select c.student_id
    from candidates c
    join students s on s.id = c.student_id
    where exists (select 1 from enrolments e where e.student_id = c.student_id)
       or exists (
         select 1 from document_links dl
         where dl.linked_record_type = 'student' and dl.linked_record_id = c.student_id
       )
       or exists (
         select 1 from student_legacy_records lr
         where lr.student_id = c.student_id
       )
       or s.updated_at > s.created_at + interval '5 seconds'
  )
  update student_import_rows r
  set row_status = 'revert_blocked',
      error_message = 'Student has later activity or was updated and was not removed.'
  where r.student_import_batch_id = p_batch_id
    and r.created_student_id in (select student_id from blocked);

  get diagnostics v_blocked_students = row_count;

  with removable as (
    select r.created_student_id as student_id
    from student_import_rows r
    where r.student_import_batch_id = p_batch_id
      and r.created_student_id is not null
      and r.row_status <> 'revert_blocked'
  ),
  deleted as (
    delete from students s
    using removable x
    where s.id = x.student_id
    returning s.id
  )
  select count(*) into v_removed_students from deleted;

  update student_import_rows
  set row_status = case
        when row_status = 'revert_blocked' then row_status
        else 'reverted'
      end,
      error_message = case
        when row_status = 'revert_blocked' then error_message
        else null
      end
  where student_import_batch_id = p_batch_id
    and row_status in ('imported', 'linked', 'skipped', 'failed', 'revert_blocked');

  update student_import_batches
  set status = 'reverted',
      reverted_by = auth.uid(),
      reverted_at = now(),
      result_summary = coalesce(result_summary, '{}'::jsonb) || jsonb_build_object(
        'reverted_legacy_records', v_removed_legacy,
        'reverted_students', v_removed_students,
        'blocked_students', v_blocked_students
      )
  where id = p_batch_id;

  insert into audit_logs (actor_user_id, action, entity_type, entity_id, payload, data_origin)
  values (
    auth.uid(),
    'student_import_reverted',
    'student_import_batch',
    p_batch_id,
    jsonb_build_object(
      'removed_legacy_records', v_removed_legacy,
      'removed_students', v_removed_students,
      'blocked_students', v_blocked_students
    ),
    'imported'
  );

  return jsonb_build_object(
    'removed_legacy_records', v_removed_legacy,
    'removed_students', v_removed_students,
    'blocked_students', v_blocked_students
  );
end;
$$;

grant select, insert, update, delete on student_import_batches, student_import_rows, student_legacy_records to authenticated;
revoke all on student_import_batches, student_import_rows, student_legacy_records from anon;

revoke all on function public.generate_enrolment_number(uuid, uuid, uuid) from public, anon;
grant execute on function public.generate_enrolment_number(uuid, uuid, uuid) to authenticated;
revoke all on function public.confirm_student_import_row(uuid, jsonb, text, uuid) from public, anon;
grant execute on function public.confirm_student_import_row(uuid, jsonb, text, uuid) to authenticated;
revoke all on function public.revert_student_import_batch(uuid) from public, anon;
grant execute on function public.revert_student_import_batch(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
