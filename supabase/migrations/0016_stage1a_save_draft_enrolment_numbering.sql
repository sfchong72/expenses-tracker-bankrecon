begin;

create or replace function public.student_identity_fingerprint(identity_type text, identity_value text)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select case
    when public.normalise_student_identity(identity_value) is null then null
    else encode(
      extensions.digest(
        lower(coalesce(identity_type, 'unknown')) || ':' || public.normalise_student_identity(identity_value),
        'sha256'
      ),
      'hex'
    )
  end;
$$;

alter table students
  add column if not exists missing_recommended_fields text[] not null default '{}'::text[];

alter table students
  alter column lifecycle_status set default 'draft',
  drop constraint if exists students_lifecycle_status_check;

alter table students
  add constraint students_lifecycle_status_check
  check (lifecycle_status in ('draft', 'active', 'incomplete', 'inactive', 'archived', 'merged'));

alter table programmes
  add column if not exists record_status text not null default 'draft';

update programmes
set record_status = case when active_status then 'active' else 'inactive' end
where record_status = 'draft';

alter table programmes
  add constraint programmes_record_status_check
  check (record_status in ('draft', 'active', 'incomplete', 'inactive', 'archived'));

alter table programme_intakes
  alter column start_date drop not null;

alter table enrolments
  add column if not exists counsellor_name_snapshot text,
  add column if not exists registration_fee_amount numeric(14,2),
  add column if not exists registration_fee_paid_amount numeric(14,2),
  add column if not exists registration_payment_date date,
  add column if not exists registration_payment_method text,
  add column if not exists registration_payment_reference text,
  add column if not exists registration_payment_remarks text,
  add column if not exists registration_payment_status text not null default 'not_paid';

alter table enrolments
  add constraint enrolments_registration_fee_amount_check
  check (registration_fee_amount is null or registration_fee_amount >= 0),
  add constraint enrolments_registration_fee_paid_amount_check
  check (registration_fee_paid_amount is null or registration_fee_paid_amount >= 0),
  add constraint enrolments_registration_fee_balance_check
  check (
    registration_fee_amount is null
    or registration_fee_paid_amount is null
    or registration_fee_paid_amount <= registration_fee_amount
  ),
  add constraint enrolments_registration_payment_status_check
  check (
    registration_payment_status in (
      'not_paid',
      'partially_paid',
      'paid',
      'waived',
      'pending_confirmation'
    )
  );

create table if not exists app_private.student_enrolment_number_sequences (
  entity_id uuid not null references public.entities(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  sequence_year integer not null,
  number_code text not null,
  last_number integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (entity_id, branch_id, sequence_year, number_code)
);

create index if not exists student_enrolment_number_sequences_branch_idx
  on app_private.student_enrolment_number_sequences(branch_id);

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
  sequence_year integer;
  yy integer;
  seq integer;
  entity_code text;
  branch_code text;
  number_code text;
begin
  if not app_private.current_user_can('can_manage_enrolments')
     or not app_private.user_can_access_branch(p_entity_id, p_branch_id) then
    raise exception 'Not authorised to generate enrolment numbers';
  end if;

  select
    e.short_code,
    b.branch_code,
    extract(year from coalesce(pi.start_date, current_date))::integer,
    regexp_replace(
      upper(coalesce(nullif(p.programme_code, ''), nullif(pi.intake_code, ''))),
      '[^A-Z0-9]',
      '',
      'g'
    )
  into entity_code, branch_code, sequence_year, number_code
  from public.programme_intakes pi
  join public.programmes p on p.id = pi.programme_id
  join public.entities e on e.id = pi.entity_id
  join public.branches b on b.id = pi.branch_id
  where pi.id = p_intake_id
    and pi.entity_id = p_entity_id
    and pi.branch_id = p_branch_id;

  if entity_code is null or branch_code is null or number_code is null or number_code = '' then
    raise exception 'Unknown entity, branch, programme or intake';
  end if;

  insert into app_private.student_enrolment_number_sequences (
    entity_id,
    branch_id,
    sequence_year,
    number_code,
    last_number
  )
  values (p_entity_id, p_branch_id, sequence_year, number_code, 1)
  on conflict (entity_id, branch_id, sequence_year, number_code)
  do update
  set last_number = app_private.student_enrolment_number_sequences.last_number + 1,
      updated_at = now()
  returning last_number into seq;

  yy := sequence_year % 100;

  return entity_code
    || '-'
    || branch_code
    || lpad(yy::text, 2, '0')
    || '/'
    || number_code
    || '-'
    || lpad(seq::text, 3, '0');
end;
$$;

create or replace function public.create_enrolment_with_number(
  p_enrolment_id uuid,
  p_student_id uuid,
  p_programme_id uuid,
  p_intake_id uuid,
  p_entity_id uuid,
  p_branch_id uuid,
  p_counsellor_user_id uuid,
  p_counsellor_name_snapshot text,
  p_enrolment_date date,
  p_expected_completion_date date,
  p_status text,
  p_referral_source text,
  p_remarks text,
  p_registration_fee_amount numeric,
  p_registration_fee_paid_amount numeric,
  p_registration_payment_date date,
  p_registration_payment_method text,
  p_registration_payment_reference text,
  p_registration_payment_remarks text,
  p_registration_payment_status text
)
returns table (id uuid, enrolment_number text)
language plpgsql
security invoker
set search_path = public, auth
as $$
declare
  generated_number text;
begin
  generated_number := public.generate_enrolment_number(p_entity_id, p_branch_id, p_intake_id);

  insert into public.enrolments (
    id,
    enrolment_number,
    student_id,
    programme_id,
    intake_id,
    entity_id,
    branch_id,
    counsellor_user_id,
    counsellor_name_snapshot,
    enrolment_date,
    expected_completion_date,
    status,
    referral_source,
    remarks,
    registration_fee_amount,
    registration_fee_paid_amount,
    registration_payment_date,
    registration_payment_method,
    registration_payment_reference,
    registration_payment_remarks,
    registration_payment_status,
    created_by,
    updated_by
  )
  values (
    p_enrolment_id,
    generated_number,
    p_student_id,
    p_programme_id,
    p_intake_id,
    p_entity_id,
    p_branch_id,
    p_counsellor_user_id,
    nullif(trim(p_counsellor_name_snapshot), ''),
    p_enrolment_date,
    p_expected_completion_date,
    p_status,
    nullif(trim(p_referral_source), ''),
    nullif(trim(p_remarks), ''),
    p_registration_fee_amount,
    p_registration_fee_paid_amount,
    p_registration_payment_date,
    nullif(trim(p_registration_payment_method), ''),
    nullif(trim(p_registration_payment_reference), ''),
    nullif(trim(p_registration_payment_remarks), ''),
    p_registration_payment_status,
    auth.uid(),
    auth.uid()
  );

  return query select p_enrolment_id, generated_number;
end;
$$;

create or replace view public.students_staff_safe
with (security_invoker = true)
as
select
  s.id,
  s.entity_id,
  e.short_code as entity_code,
  s.student_number,
  s.full_name,
  s.preferred_name,
  s.identity_document_type,
  s.identity_number_masked,
  s.identity_number_last_four,
  s.nationality,
  s.date_of_birth,
  s.gender,
  s.phone,
  s.email,
  s.address,
  s.emergency_contact,
  s.previous_school,
  s.education_level,
  s.home_branch_id,
  b.branch_code as home_branch_code,
  b.branch_name as home_branch_name,
  s.active_status,
  s.lifecycle_status,
  s.duplicate_review_status,
  s.remarks,
  s.created_by,
  s.updated_by,
  s.created_at,
  s.updated_at,
  s.is_demo,
  s.data_origin,
  s.qualification_details,
  s.education_institution,
  s.field_of_study,
  s.graduation_year,
  s.city,
  s.state,
  s.postcode,
  s.country,
  s.height_cm,
  s.weight_kg,
  s.uniform_size,
  s.measurement_date,
  s.measurement_remarks,
  s.missing_recommended_fields
from public.students s
join public.entities e on e.id = s.entity_id
left join public.branches b on b.id = s.home_branch_id
where s.lifecycle_status <> 'merged';

create or replace view public.enrolments_staff_safe
with (security_invoker = true)
as
select
  en.id,
  en.enrolment_number,
  en.student_id,
  s.student_number,
  s.full_name as student_name,
  en.programme_id,
  p.programme_code,
  p.programme_name,
  en.intake_id,
  pi.intake_code,
  en.entity_id,
  e.short_code as entity_code,
  en.branch_id,
  b.branch_code,
  b.branch_name,
  en.counsellor_user_id,
  coalesce(nullif(en.counsellor_name_snapshot, ''), ap.display_name) as counsellor_name,
  ap.email as counsellor_email,
  en.enrolment_date,
  en.expected_completion_date,
  en.status,
  en.referral_source,
  en.remarks,
  en.created_by,
  en.updated_by,
  en.created_at,
  en.updated_at,
  en.is_demo,
  en.data_origin,
  en.counsellor_name_snapshot,
  en.registration_fee_amount,
  en.registration_fee_paid_amount,
  en.registration_payment_date,
  en.registration_payment_method,
  en.registration_payment_reference,
  en.registration_payment_remarks,
  en.registration_payment_status
from public.enrolments en
join public.students s on s.id = en.student_id
join public.programmes p on p.id = en.programme_id
join public.programme_intakes pi on pi.id = en.intake_id
join public.entities e on e.id = en.entity_id
join public.branches b on b.id = en.branch_id
left join public.app_profiles ap on ap.id = en.counsellor_user_id;

grant select (missing_recommended_fields) on public.students to authenticated;
grant select on public.students_staff_safe, public.enrolments_staff_safe to authenticated;
revoke all on public.students_staff_safe, public.enrolments_staff_safe from anon;

revoke all on function public.generate_enrolment_number(uuid, uuid, uuid) from public;
grant execute on function public.generate_enrolment_number(uuid, uuid, uuid) to authenticated;

revoke all on function public.create_enrolment_with_number(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, date, date, text, text, text,
  numeric, numeric, date, text, text, text, text
) from public;
grant execute on function public.create_enrolment_with_number(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, date, date, text, text, text,
  numeric, numeric, date, text, text, text, text
) to authenticated;

notify pgrst, 'reload schema';

commit;
