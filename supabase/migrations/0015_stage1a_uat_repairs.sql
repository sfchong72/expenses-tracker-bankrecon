begin;

alter table students
  add column if not exists qualification_details text,
  add column if not exists education_institution text,
  add column if not exists field_of_study text,
  add column if not exists graduation_year integer,
  add column if not exists city text,
  add column if not exists state text,
  add column if not exists postcode text,
  add column if not exists country text default 'Malaysia',
  add column if not exists height_cm numeric(5,2),
  add column if not exists weight_kg numeric(5,2),
  add column if not exists uniform_size text,
  add column if not exists measurement_date date,
  add column if not exists measurement_remarks text;

update students
set gender = null
where gender is not null
  and gender not in ('female', 'male');

alter table students
  drop constraint if exists students_gender_check;

alter table students
  add constraint students_gender_check
  check (gender is null or gender in ('female', 'male')),
  add constraint students_graduation_year_check
  check (graduation_year is null or graduation_year between 1900 and 2100),
  add constraint students_height_cm_check
  check (height_cm is null or height_cm > 0),
  add constraint students_weight_kg_check
  check (weight_kg is null or weight_kg > 0);

alter table programmes
  add column if not exists duration_value numeric(8,2),
  add column if not exists duration_min_value numeric(8,2),
  add column if not exists duration_max_value numeric(8,2),
  add column if not exists duration_unit text;

alter table programmes
  add constraint programmes_duration_value_check
  check (duration_value is null or duration_value > 0),
  add constraint programmes_duration_min_value_check
  check (duration_min_value is null or duration_min_value > 0),
  add constraint programmes_duration_max_value_check
  check (duration_max_value is null or duration_max_value > 0),
  add constraint programmes_duration_range_check
  check (
    duration_max_value is null
    or (duration_min_value is not null and duration_max_value >= duration_min_value)
  ),
  add constraint programmes_duration_unit_check
  check (duration_unit is null or duration_unit in ('days', 'weeks', 'months', 'years'));

alter table programme_intakes
  add column if not exists completion_timing text not null default 'not_applicable',
  add column if not exists original_expected_completion_date date,
  add column if not exists actual_completion_date date,
  add column if not exists completion_reason text,
  add column if not exists revised_by uuid references auth.users(id) on delete set null,
  add column if not exists revised_at timestamptz;

update programme_intakes
set original_expected_completion_date = expected_completion_date
where original_expected_completion_date is null
  and expected_completion_date is not null;

alter table programme_intakes
  add constraint programme_intakes_completion_timing_check
  check (
    completion_timing in (
      'not_applicable',
      'on_time',
      'prolonged',
      'shortened',
      'partially_completed',
      'discontinued'
    )
  ),
  add constraint programme_intakes_actual_completion_date_check
  check (actual_completion_date is null or actual_completion_date >= start_date);

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
  s.measurement_remarks
from students s
join entities e on e.id = s.entity_id
left join branches b on b.id = s.home_branch_id
where s.lifecycle_status <> 'merged';

grant select (
  qualification_details,
  education_institution,
  field_of_study,
  graduation_year,
  city,
  state,
  postcode,
  country,
  height_cm,
  weight_kg,
  uniform_size,
  measurement_date,
  measurement_remarks
) on students to authenticated;

grant select on students_staff_safe to authenticated;
revoke all on students_staff_safe from anon;

notify pgrst, 'reload schema';

commit;
