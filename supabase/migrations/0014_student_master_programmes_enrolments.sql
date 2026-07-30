create extension if not exists pgcrypto;

create table if not exists student_number_sequences (
  entity_id uuid not null references entities(id) on delete cascade,
  sequence_year integer not null,
  last_number integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (entity_id, sequence_year)
);

create table if not exists enrolment_number_sequences (
  entity_id uuid not null references entities(id) on delete cascade,
  branch_id uuid not null references branches(id) on delete cascade,
  intake_id uuid not null,
  sequence_year integer not null,
  last_number integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (entity_id, branch_id, intake_id, sequence_year)
);

create table if not exists students (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references entities(id) on delete restrict,
  student_number text,
  full_name text not null,
  preferred_name text,
  identity_document_type text check (identity_document_type is null or identity_document_type in ('ic', 'passport', 'other')),
  identity_number_protected text,
  identity_number_last_four text,
  identity_number_masked text,
  identity_number_fingerprint text,
  nationality text,
  date_of_birth date,
  gender text check (gender is null or gender in ('female', 'male', 'other', 'prefer_not_to_say')),
  phone text,
  phone_normalised text,
  email text,
  email_normalised text,
  address text,
  emergency_contact jsonb not null default '{}'::jsonb,
  previous_school text,
  education_level text,
  home_branch_id uuid references branches(id) on delete set null,
  active_status boolean not null default true,
  lifecycle_status text not null default 'active' check (lifecycle_status in ('active', 'inactive', 'merged', 'archived')),
  merged_into_student_id uuid references students(id) on delete set null,
  duplicate_review_status text not null default 'not_reviewed' check (duplicate_review_status in ('not_reviewed', 'possible_duplicate', 'reviewed_unique', 'merged')),
  remarks text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_demo boolean not null default false,
  data_origin text not null default 'manual' check (data_origin in ('demo', 'production', 'imported', 'manual')),
  unique (entity_id, student_number),
  check (student_number is null or length(student_number) > 0),
  check (merged_into_student_id is null or merged_into_student_id <> id)
);

create table if not exists programmes (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references entities(id) on delete restrict,
  programme_code text not null,
  programme_name text not null,
  description text,
  programme_type text,
  duration_text text,
  indicative_standard_fee numeric(14,2),
  active_status boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_demo boolean not null default false,
  data_origin text not null default 'manual' check (data_origin in ('demo', 'production', 'imported', 'manual')),
  unique (entity_id, programme_code)
);

create table if not exists programme_intakes (
  id uuid primary key default gen_random_uuid(),
  programme_id uuid not null references programmes(id) on delete cascade,
  entity_id uuid not null references entities(id) on delete restrict,
  branch_id uuid not null references branches(id) on delete restrict,
  intake_code text not null,
  intake_name text,
  start_date date not null,
  expected_completion_date date,
  application_closing_date date,
  capacity integer check (capacity is null or capacity >= 0),
  status text not null default 'open' check (status in ('planning', 'open', 'closed', 'in_progress', 'completed', 'cancelled', 'inactive')),
  remarks text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_demo boolean not null default false,
  data_origin text not null default 'manual' check (data_origin in ('demo', 'production', 'imported', 'manual')),
  unique (entity_id, branch_id, intake_code),
  check (expected_completion_date is null or expected_completion_date >= start_date),
  check (application_closing_date is null or application_closing_date <= start_date)
);

create table if not exists enrolments (
  id uuid primary key default gen_random_uuid(),
  enrolment_number text,
  student_id uuid not null references students(id) on delete restrict,
  programme_id uuid not null references programmes(id) on delete restrict,
  intake_id uuid not null references programme_intakes(id) on delete restrict,
  entity_id uuid not null references entities(id) on delete restrict,
  branch_id uuid not null references branches(id) on delete restrict,
  counsellor_user_id uuid references auth.users(id) on delete set null,
  enrolment_date date not null default current_date,
  expected_completion_date date,
  status text not null default 'enrolled' check (status in ('draft', 'applied', 'enrolled', 'active', 'deferred', 'transferred', 'completed', 'withdrawn', 'cancelled', 'inactive')),
  referral_source text,
  remarks text,
  agreed_fee_snapshot jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_demo boolean not null default false,
  data_origin text not null default 'manual' check (data_origin in ('demo', 'production', 'imported', 'manual')),
  unique (entity_id, enrolment_number),
  check (enrolment_number is null or length(enrolment_number) > 0)
);

create table if not exists enrolment_counsellor_history (
  id uuid primary key default gen_random_uuid(),
  enrolment_id uuid not null references enrolments(id) on delete cascade,
  from_counsellor_user_id uuid references auth.users(id) on delete set null,
  to_counsellor_user_id uuid references auth.users(id) on delete set null,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now(),
  reason text
);

create table if not exists student_duplicate_reviews (
  id uuid primary key default gen_random_uuid(),
  student_id uuid references students(id) on delete cascade,
  possible_duplicate_student_id uuid references students(id) on delete cascade,
  match_reason text not null,
  match_strength text not null default 'possible' check (match_strength in ('strong', 'possible', 'weak')),
  status text not null default 'open' check (status in ('open', 'dismissed', 'merged', 'reviewed')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  remarks text,
  created_at timestamptz not null default now(),
  unique (student_id, possible_duplicate_student_id, match_reason),
  check (student_id is null or possible_duplicate_student_id is null or student_id <> possible_duplicate_student_id)
);

create table if not exists student_merge_events (
  id uuid primary key default gen_random_uuid(),
  source_student_id uuid not null references students(id) on delete restrict,
  target_student_id uuid not null references students(id) on delete restrict,
  merged_by uuid references auth.users(id) on delete set null,
  merged_at timestamptz not null default now(),
  merge_reason text not null,
  preserved_summary jsonb not null default '{}'::jsonb,
  check (source_student_id <> target_student_id)
);

create or replace function public.normalise_student_identity(value text)
returns text
language sql
immutable
as $$
  select nullif(regexp_replace(lower(coalesce(value, '')), '[^a-z0-9]', '', 'g'), '');
$$;

create or replace function public.student_identity_fingerprint(identity_type text, identity_value text)
returns text
language sql
immutable
as $$
  select case
    when public.normalise_student_identity(identity_value) is null then null
    else encode(digest(lower(coalesce(identity_type, 'unknown')) || ':' || public.normalise_student_identity(identity_value), 'sha256'), 'hex')
  end;
$$;

create or replace function public.mask_student_identity(identity_value text)
returns text
language plpgsql
immutable
as $$
declare
  clean text := public.normalise_student_identity(identity_value);
begin
  if clean is null then
    return null;
  end if;
  if length(clean) <= 4 then
    return repeat('*', length(clean));
  end if;
  return repeat('*', greatest(length(clean) - 4, 0)) || right(clean, 4);
end;
$$;

create or replace function public.set_student_protected_fields()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.email_normalised = nullif(lower(trim(coalesce(new.email, ''))), '');
  new.phone_normalised = nullif(regexp_replace(coalesce(new.phone, ''), '[^0-9+]', '', 'g'), '');
  new.identity_number_fingerprint = public.student_identity_fingerprint(new.identity_document_type, new.identity_number_protected);
  new.identity_number_masked = public.mask_student_identity(new.identity_number_protected);
  new.identity_number_last_four = case
    when public.normalise_student_identity(new.identity_number_protected) is null then null
    else right(public.normalise_student_identity(new.identity_number_protected), 4)
  end;
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.audit_student_sensitive_changes()
returns trigger
language plpgsql
security invoker
set search_path = public, auth
as $$
begin
  if tg_op = 'UPDATE' and (
    old.identity_number_fingerprint is distinct from new.identity_number_fingerprint
    or old.identity_document_type is distinct from new.identity_document_type
    or old.date_of_birth is distinct from new.date_of_birth
    or old.full_name is distinct from new.full_name
  ) then
    insert into audit_logs (actor_user_id, action, entity_type, entity_id, before_data, after_data, data_origin)
    values (
      auth.uid(),
      'student_sensitive_fields_updated',
      'student',
      new.id,
      jsonb_build_object('identity_last_four', old.identity_number_last_four, 'identity_type', old.identity_document_type, 'date_of_birth', old.date_of_birth, 'full_name', old.full_name),
      jsonb_build_object('identity_last_four', new.identity_number_last_four, 'identity_type', new.identity_document_type, 'date_of_birth', new.date_of_birth, 'full_name', new.full_name),
      'manual'
    );
  end if;
  return new;
end;
$$;

create or replace function public.generate_student_number(p_entity_id uuid)
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  yy integer := extract(year from current_date)::integer % 100;
  seq integer;
  entity_code text;
begin
  if not app_private.current_user_can('can_manage_students') then
    raise exception 'Not authorised to generate student numbers';
  end if;

  select short_code into entity_code from entities where id = p_entity_id;
  if entity_code is null then
    raise exception 'Unknown entity';
  end if;

  insert into student_number_sequences (entity_id, sequence_year, last_number)
  values (p_entity_id, yy, 1)
  on conflict (entity_id, sequence_year)
  do update set last_number = student_number_sequences.last_number + 1,
                updated_at = now()
  returning last_number into seq;

  return entity_code || '-STU-' || lpad(yy::text, 2, '0') || '-' || lpad(seq::text, 4, '0');
end;
$$;

create or replace function public.generate_enrolment_number(p_entity_id uuid, p_branch_id uuid, p_intake_id uuid)
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  yy integer := extract(year from current_date)::integer % 100;
  seq integer;
  entity_code text;
  branch_code text;
  intake_code text;
begin
  if not app_private.current_user_can('can_manage_enrolments') then
    raise exception 'Not authorised to generate enrolment numbers';
  end if;

  select short_code into entity_code from entities where id = p_entity_id;
  select b.branch_code into branch_code from branches b where b.id = p_branch_id;
  select pi.intake_code into intake_code from programme_intakes pi where pi.id = p_intake_id;

  if entity_code is null or branch_code is null or intake_code is null then
    raise exception 'Unknown entity, branch or intake';
  end if;

  insert into enrolment_number_sequences (entity_id, branch_id, intake_id, sequence_year, last_number)
  values (p_entity_id, p_branch_id, p_intake_id, yy, 1)
  on conflict (entity_id, branch_id, intake_id, sequence_year)
  do update set last_number = enrolment_number_sequences.last_number + 1,
                updated_at = now()
  returning last_number into seq;

  return entity_code || '-' || branch_code || '-' || intake_code || '-' || lpad(yy::text, 2, '0') || '-' || lpad(seq::text, 3, '0');
end;
$$;

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
security definer
set search_path = public, auth
as $$
  with incoming as (
    select
      public.student_identity_fingerprint(p_identity_document_type, p_identity_number) as fp,
      nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '') as phone_norm,
      nullif(lower(trim(coalesce(p_email, ''))), '') as email_norm,
      nullif(lower(trim(coalesce(p_full_name, ''))), '') as name_norm
  )
  select s.id, s.student_number, s.full_name, 'IC/passport fingerprint'::text, 'strong'::text
  from students s, incoming i
  where app_private.current_user_can('can_manage_students') and app_private.user_can_access_entity(p_entity_id) and s.entity_id = p_entity_id and s.id is distinct from p_student_id and i.fp is not null and s.identity_number_fingerprint = i.fp
  union
  select s.id, s.student_number, s.full_name, 'Phone number'::text, 'possible'::text
  from students s, incoming i
  where app_private.current_user_can('can_manage_students') and app_private.user_can_access_entity(p_entity_id) and s.entity_id = p_entity_id and s.id is distinct from p_student_id and i.phone_norm is not null and s.phone_normalised = i.phone_norm
  union
  select s.id, s.student_number, s.full_name, 'Email address'::text, 'possible'::text
  from students s, incoming i
  where app_private.current_user_can('can_manage_students') and app_private.user_can_access_entity(p_entity_id) and s.entity_id = p_entity_id and s.id is distinct from p_student_id and i.email_norm is not null and s.email_normalised = i.email_norm
  union
  select s.id, s.student_number, s.full_name, 'Name and date of birth'::text, 'possible'::text
  from students s, incoming i
  where app_private.current_user_can('can_manage_students') and app_private.user_can_access_entity(p_entity_id) and s.entity_id = p_entity_id and s.id is distinct from p_student_id and i.name_norm is not null and p_date_of_birth is not null and lower(trim(s.full_name)) = i.name_norm and s.date_of_birth = p_date_of_birth;
$$;

create or replace function public.merge_students(p_source_student_id uuid, p_target_student_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  moved_enrolments integer := 0;
  moved_documents integer := 0;
begin
  if not app_private.current_user_can('can_manage_students') then
    raise exception 'Not authorised to merge students';
  end if;
  if p_source_student_id = p_target_student_id then
    raise exception 'Source and target student must be different';
  end if;
  if nullif(p_reason, '') is null then
    raise exception 'Merge reason is required';
  end if;

  update enrolments
  set student_id = p_target_student_id,
      updated_by = auth.uid(),
      updated_at = now()
  where student_id = p_source_student_id;
  get diagnostics moved_enrolments = row_count;

  update document_links
  set linked_record_id = p_target_student_id
  where linked_record_type = 'student'
    and linked_record_id = p_source_student_id;
  get diagnostics moved_documents = row_count;

  update students
  set lifecycle_status = 'merged',
      active_status = false,
      duplicate_review_status = 'merged',
      merged_into_student_id = p_target_student_id,
      updated_by = auth.uid(),
      updated_at = now()
  where id = p_source_student_id;

  insert into student_merge_events (source_student_id, target_student_id, merged_by, merge_reason, preserved_summary)
  values (
    p_source_student_id,
    p_target_student_id,
    auth.uid(),
    p_reason,
    jsonb_build_object('moved_enrolments', moved_enrolments, 'moved_document_links', moved_documents)
  );

  insert into audit_logs (actor_user_id, action, entity_type, entity_id, payload, data_origin)
  values (
    auth.uid(),
    'students_merged',
    'student',
    p_target_student_id,
    jsonb_build_object('source_student_id', p_source_student_id, 'target_student_id', p_target_student_id, 'reason', p_reason, 'moved_enrolments', moved_enrolments, 'moved_document_links', moved_documents),
    'manual'
  );

  return jsonb_build_object('moved_enrolments', moved_enrolments, 'moved_document_links', moved_documents);
end;
$$;

create or replace function public.get_student_sensitive_identity(p_student_id uuid)
returns table (
  id uuid,
  identity_document_type text,
  identity_number_protected text
)
language sql
security definer
set search_path = public, auth
as $$
  select s.id, s.identity_document_type, s.identity_number_protected
  from students s
  where s.id = p_student_id
    and app_private.current_user_can('can_view_student_pii')
    and (
      app_private.current_user_is_owner()
      or app_private.user_can_access_branch(s.entity_id, s.home_branch_id)
      or exists (
        select 1
        from enrolments e
        where e.student_id = s.id
          and (app_private.user_can_access_branch(e.entity_id, e.branch_id) or e.counsellor_user_id = auth.uid())
      )
    );
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
  s.data_origin
from students s
join entities e on e.id = s.entity_id
left join branches b on b.id = s.home_branch_id
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
  ap.display_name as counsellor_name,
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
  en.data_origin
from enrolments en
join students s on s.id = en.student_id
join programmes p on p.id = en.programme_id
join programme_intakes pi on pi.id = en.intake_id
join entities e on e.id = en.entity_id
join branches b on b.id = en.branch_id
left join app_profiles ap on ap.id = en.counsellor_user_id;

create or replace view public.student_duplicate_warning_view
as
select
  s1.id as student_id,
  s2.id as possible_duplicate_student_id,
  s2.student_number as possible_duplicate_student_number,
  s2.full_name as possible_duplicate_name,
  case
    when s1.identity_number_fingerprint is not null and s1.identity_number_fingerprint = s2.identity_number_fingerprint then 'IC/passport fingerprint'
    when s1.email_normalised is not null and s1.email_normalised = s2.email_normalised then 'Email address'
    when s1.phone_normalised is not null and s1.phone_normalised = s2.phone_normalised then 'Phone number'
    when s1.date_of_birth is not null and lower(trim(s1.full_name)) = lower(trim(s2.full_name)) and s1.date_of_birth = s2.date_of_birth then 'Name and date of birth'
    else 'Possible duplicate'
  end as match_reason,
  case
    when s1.identity_number_fingerprint is not null and s1.identity_number_fingerprint = s2.identity_number_fingerprint then 'strong'
    else 'possible'
  end as match_strength
from students s1
join students s2 on s1.entity_id = s2.entity_id and s1.id < s2.id
where s1.lifecycle_status <> 'merged'
  and s2.lifecycle_status <> 'merged'
  and app_private.current_user_can('can_manage_students')
  and (
    app_private.user_can_access_branch(s1.entity_id, s1.home_branch_id)
    or exists (select 1 from enrolments en where en.student_id = s1.id and app_private.user_can_access_branch(en.entity_id, en.branch_id))
  )
  and (
    app_private.user_can_access_branch(s2.entity_id, s2.home_branch_id)
    or exists (select 1 from enrolments en where en.student_id = s2.id and app_private.user_can_access_branch(en.entity_id, en.branch_id))
  )
  and (
    (s1.identity_number_fingerprint is not null and s1.identity_number_fingerprint = s2.identity_number_fingerprint)
    or (s1.email_normalised is not null and s1.email_normalised = s2.email_normalised)
    or (s1.phone_normalised is not null and s1.phone_normalised = s2.phone_normalised)
    or (s1.date_of_birth is not null and lower(trim(s1.full_name)) = lower(trim(s2.full_name)) and s1.date_of_birth = s2.date_of_birth)
  );

drop trigger if exists set_students_protected_fields on students;
create trigger set_students_protected_fields before insert or update on students for each row execute function public.set_student_protected_fields();
drop trigger if exists audit_students_sensitive_changes on students;
create trigger audit_students_sensitive_changes after update on students for each row execute function public.audit_student_sensitive_changes();

drop trigger if exists set_programmes_updated_at on programmes;
create trigger set_programmes_updated_at before update on programmes for each row execute function public.set_updated_at();
drop trigger if exists set_programme_intakes_updated_at on programme_intakes;
create trigger set_programme_intakes_updated_at before update on programme_intakes for each row execute function public.set_updated_at();
drop trigger if exists set_enrolments_updated_at on enrolments;
create trigger set_enrolments_updated_at before update on enrolments for each row execute function public.set_updated_at();

create or replace function public.audit_enrolment_counsellor_change()
returns trigger
language plpgsql
security invoker
set search_path = public, auth
as $$
begin
  if tg_op = 'UPDATE' and old.counsellor_user_id is distinct from new.counsellor_user_id then
    insert into enrolment_counsellor_history (enrolment_id, from_counsellor_user_id, to_counsellor_user_id, changed_by, reason)
    values (new.id, old.counsellor_user_id, new.counsellor_user_id, auth.uid(), 'Counsellor reassigned');
  end if;
  return new;
end;
$$;

drop trigger if exists audit_enrolments_counsellor_change on enrolments;
create trigger audit_enrolments_counsellor_change after update on enrolments for each row execute function public.audit_enrolment_counsellor_change();

alter table document_links drop constraint if exists document_links_linked_record_type_check;
alter table document_links add constraint document_links_linked_record_type_check
  check (linked_record_type in ('supplier_bill', 'payment_voucher', 'bill_payment', 'bank_transaction', 'recurring_obligation', 'claim', 'claim_line', 'claim_reimbursement', 'student', 'programme', 'programme_intake', 'enrolment', 'other'));

create index if not exists students_entity_name_idx on students(entity_id, full_name);
create index if not exists students_entity_number_idx on students(entity_id, student_number);
create index if not exists students_identity_fp_idx on students(entity_id, identity_number_fingerprint) where identity_number_fingerprint is not null;
create index if not exists students_phone_idx on students(entity_id, phone_normalised) where phone_normalised is not null;
create index if not exists students_email_idx on students(entity_id, email_normalised) where email_normalised is not null;
create index if not exists programmes_entity_code_idx on programmes(entity_id, programme_code);
create index if not exists programme_intakes_branch_start_idx on programme_intakes(entity_id, branch_id, start_date);
create index if not exists enrolments_student_idx on enrolments(student_id, status);
create index if not exists enrolments_scope_idx on enrolments(entity_id, branch_id, status);
create index if not exists enrolments_counsellor_idx on enrolments(counsellor_user_id, status);

alter table student_number_sequences enable row level security;
alter table enrolment_number_sequences enable row level security;
alter table students enable row level security;
alter table programmes enable row level security;
alter table programme_intakes enable row level security;
alter table enrolments enable row level security;
alter table enrolment_counsellor_history enable row level security;
alter table student_duplicate_reviews enable row level security;
alter table student_merge_events enable row level security;

drop policy if exists "student_sequences_owner_select" on student_number_sequences;
create policy "student_sequences_owner_select" on student_number_sequences for select to authenticated
using (app_private.current_user_is_owner());
drop policy if exists "student_sequences_owner_manage" on student_number_sequences;
create policy "student_sequences_owner_manage" on student_number_sequences for all to authenticated
using (app_private.current_user_is_owner())
with check (app_private.current_user_is_owner());

drop policy if exists "enrolment_sequences_owner_select" on enrolment_number_sequences;
create policy "enrolment_sequences_owner_select" on enrolment_number_sequences for select to authenticated
using (app_private.current_user_is_owner());
drop policy if exists "enrolment_sequences_owner_manage" on enrolment_number_sequences;
create policy "enrolment_sequences_owner_manage" on enrolment_number_sequences for all to authenticated
using (app_private.current_user_is_owner())
with check (app_private.current_user_is_owner());

drop policy if exists "students_scoped_select" on students;
create policy "students_scoped_select" on students for select to authenticated
using (
  app_private.current_user_is_owner()
  or app_private.user_can_access_branch(entity_id, home_branch_id)
  or exists (
    select 1 from enrolments en
    where en.student_id = students.id
      and (app_private.user_can_access_branch(en.entity_id, en.branch_id) or en.counsellor_user_id = auth.uid())
  )
);
drop policy if exists "students_manage_insert" on students;
create policy "students_manage_insert" on students for insert to authenticated
with check (
  app_private.current_user_can('can_manage_students')
  and app_private.user_can_access_branch(entity_id, home_branch_id)
);
drop policy if exists "students_manage_update" on students;
create policy "students_manage_update" on students for update to authenticated
using (
  app_private.current_user_can('can_manage_students')
  and (
    app_private.current_user_is_owner()
    or app_private.user_can_access_branch(entity_id, home_branch_id)
    or exists (select 1 from enrolments en where en.student_id = students.id and app_private.user_can_access_branch(en.entity_id, en.branch_id))
  )
)
with check (
  app_private.current_user_can('can_manage_students')
  and app_private.user_can_access_branch(entity_id, home_branch_id)
);

drop policy if exists "programmes_scoped_select" on programmes;
create policy "programmes_scoped_select" on programmes for select to authenticated
using (app_private.user_can_access_entity(entity_id) or app_private.current_user_can('can_manage_programmes'));
drop policy if exists "programmes_manage" on programmes;
create policy "programmes_manage" on programmes for all to authenticated
using (app_private.current_user_can('can_manage_programmes') and app_private.user_can_access_entity(entity_id))
with check (app_private.current_user_can('can_manage_programmes') and app_private.user_can_access_entity(entity_id));

drop policy if exists "programme_intakes_scoped_select" on programme_intakes;
create policy "programme_intakes_scoped_select" on programme_intakes for select to authenticated
using (app_private.user_can_access_branch(entity_id, branch_id));
drop policy if exists "programme_intakes_manage" on programme_intakes;
create policy "programme_intakes_manage" on programme_intakes for all to authenticated
using (app_private.current_user_can('can_manage_programmes') and app_private.user_can_access_branch(entity_id, branch_id))
with check (app_private.current_user_can('can_manage_programmes') and app_private.user_can_access_branch(entity_id, branch_id));

drop policy if exists "enrolments_scoped_select" on enrolments;
create policy "enrolments_scoped_select" on enrolments for select to authenticated
using (app_private.user_can_access_branch(entity_id, branch_id) or counsellor_user_id = auth.uid());
drop policy if exists "enrolments_manage" on enrolments;
create policy "enrolments_manage" on enrolments for all to authenticated
using (app_private.current_user_can('can_manage_enrolments') and app_private.user_can_access_branch(entity_id, branch_id))
with check (app_private.current_user_can('can_manage_enrolments') and app_private.user_can_access_branch(entity_id, branch_id));

drop policy if exists "enrolment_counsellor_history_select" on enrolment_counsellor_history;
create policy "enrolment_counsellor_history_select" on enrolment_counsellor_history for select to authenticated
using (exists (select 1 from enrolments en where en.id = enrolment_id and (app_private.user_can_access_branch(en.entity_id, en.branch_id) or en.counsellor_user_id = auth.uid())));
drop policy if exists "enrolment_counsellor_history_insert" on enrolment_counsellor_history;
create policy "enrolment_counsellor_history_insert" on enrolment_counsellor_history for insert to authenticated
with check (app_private.current_user_can('can_manage_enrolments'));

drop policy if exists "student_duplicate_reviews_select" on student_duplicate_reviews;
create policy "student_duplicate_reviews_select" on student_duplicate_reviews for select to authenticated
using (app_private.current_user_can('can_manage_students'));
drop policy if exists "student_duplicate_reviews_manage" on student_duplicate_reviews;
create policy "student_duplicate_reviews_manage" on student_duplicate_reviews for all to authenticated
using (app_private.current_user_can('can_manage_students'))
with check (app_private.current_user_can('can_manage_students'));

drop policy if exists "student_merge_events_select" on student_merge_events;
create policy "student_merge_events_select" on student_merge_events for select to authenticated
using (app_private.current_user_can('can_manage_students'));
drop policy if exists "student_merge_events_insert" on student_merge_events;
create policy "student_merge_events_insert" on student_merge_events for insert to authenticated
with check (app_private.current_user_can('can_manage_students'));

revoke all on students from anon, authenticated;
grant select (id, entity_id, student_number, full_name, preferred_name, identity_document_type, identity_number_masked, identity_number_last_four, nationality, date_of_birth, gender, phone, email, address, emergency_contact, previous_school, education_level, home_branch_id, active_status, lifecycle_status, merged_into_student_id, duplicate_review_status, remarks, created_by, updated_by, created_at, updated_at, is_demo, data_origin) on students to authenticated;
grant insert, update on students to authenticated;

grant select, insert, update, delete on student_number_sequences, enrolment_number_sequences, programmes, programme_intakes, enrolments, enrolment_counsellor_history, student_duplicate_reviews, student_merge_events to authenticated;
grant select on students_staff_safe, enrolments_staff_safe, student_duplicate_warning_view to authenticated;
revoke all on student_number_sequences, enrolment_number_sequences, programmes, programme_intakes, enrolments, enrolment_counsellor_history, student_duplicate_reviews, student_merge_events, students_staff_safe, enrolments_staff_safe, student_duplicate_warning_view from anon;

revoke all on function public.generate_student_number(uuid) from public;
grant execute on function public.generate_student_number(uuid) to authenticated;
revoke all on function public.generate_enrolment_number(uuid, uuid, uuid) from public;
grant execute on function public.generate_enrolment_number(uuid, uuid, uuid) to authenticated;
revoke all on function public.find_student_duplicate_warnings(uuid, uuid, text, text, text, text, text, date) from public;
grant execute on function public.find_student_duplicate_warnings(uuid, uuid, text, text, text, text, text, date) to authenticated;
revoke all on function public.merge_students(uuid, uuid, text) from public;
grant execute on function public.merge_students(uuid, uuid, text) to authenticated;
revoke all on function public.get_student_sensitive_identity(uuid) from public;
grant execute on function public.get_student_sensitive_identity(uuid) to authenticated;

notify pgrst, 'reload schema';
