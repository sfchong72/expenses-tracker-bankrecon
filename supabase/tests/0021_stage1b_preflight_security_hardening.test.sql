-- Run only against a disposable Supabase database after migrations 0001-0021.
-- Example: supabase test db

begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(34);

select extensions.ok(
  current_setting('server_version_num')::integer >= 150000,
  'PostgreSQL supports security_invoker views'
);

select extensions.ok(
  exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'student_duplicate_warning_view'
      and c.reloptions @> array['security_invoker=true']
  ),
  'student_duplicate_warning_view is security-invoker'
);

select extensions.ok(
  has_table_privilege('authenticated', 'public.student_duplicate_warning_view', 'SELECT'),
  'authenticated can select the duplicate-warning view'
);

select extensions.ok(
  not has_table_privilege('anon', 'public.student_duplicate_warning_view', 'SELECT'),
  'anonymous cannot select the duplicate-warning view'
);

select extensions.ok(
  has_function_privilege('authenticated', 'app_private.student_duplicate_warning_rows()', 'EXECUTE'),
  'authenticated can execute the private duplicate-warning helper through the view'
);

select extensions.ok(
  not has_function_privilege('anon', 'app_private.student_duplicate_warning_rows()', 'EXECUTE'),
  'anonymous cannot execute the private duplicate-warning helper'
);

select extensions.ok(
  (select bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE'))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'generate_student_number',
       'find_student_duplicate_warnings',
       'merge_students',
       'get_student_sensitive_identity'
     )),
  'authenticated can execute required privileged Student RPCs'
);

select extensions.ok(
  (select bool_and(not has_function_privilege('anon', p.oid, 'EXECUTE'))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'generate_student_number',
       'find_student_duplicate_warnings',
       'merge_students',
       'get_student_sensitive_identity'
     )),
  'anonymous cannot execute privileged Student RPCs'
);

select extensions.ok(
  (select bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE'))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'normalise_student_identity',
       'mask_student_identity',
       'student_identity_fingerprint'
     )),
  'authenticated retains identity-helper execution needed by Stage 1A triggers'
);

select extensions.ok(
  (select bool_and(not has_function_privilege('anon', p.oid, 'EXECUTE'))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'normalise_student_identity',
       'mask_student_identity',
       'student_identity_fingerprint'
     )),
  'anonymous cannot execute identity helpers'
);

select extensions.ok(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where ((n.nspname = 'public' and p.proname in (
             'normalise_student_identity',
             'mask_student_identity',
             'student_identity_fingerprint',
             'generate_student_number',
             'find_student_duplicate_warnings',
             'merge_students',
             'get_student_sensitive_identity'
           ))
           or (n.nspname = 'app_private' and p.proname = 'student_duplicate_warning_rows'))
      and (p.proconfig is null
           or exists (
             select 1 from unnest(p.proconfig) setting
             where setting like 'search_path=%public%'
                or setting like 'search_path=%auth%'
                or setting like 'search_path=%extensions%'
           ))
  ),
  'hardened functions do not use mutable application schemas in search_path'
);

select extensions.ok(
  (select c.relrowsecurity
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'app_private'
     and c.relname = 'student_enrolment_number_sequences'),
  'private enrolment-number counter has RLS enabled'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'app_private.student_enrolment_number_sequences', 'SELECT'),
  'authenticated cannot read the private enrolment-number counter'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'app_private.student_enrolment_number_sequences', 'INSERT'),
  'authenticated cannot insert into the private enrolment-number counter'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'app_private.student_enrolment_number_sequences', 'UPDATE'),
  'authenticated cannot update the private enrolment-number counter'
);

select extensions.ok(
  not exists (
    select 1
    from information_schema.role_table_grants
    where grantee = 'authenticated'
      and table_schema = 'public'
      and table_name in (
        'programmes', 'programme_intakes', 'enrolments',
        'student_import_batches', 'student_import_rows', 'student_legacy_records'
      )
      and privilege_type = 'TRUNCATE'
  ),
  'authenticated has no TRUNCATE on hardened Student tables'
);

select extensions.ok(
  not exists (
    select 1
    from information_schema.role_table_grants
    where grantee = 'authenticated'
      and table_schema = 'public'
      and table_name in (
        'programmes', 'programme_intakes', 'enrolments',
        'student_import_batches', 'student_import_rows', 'student_legacy_records'
      )
      and privilege_type = 'TRIGGER'
  ),
  'authenticated has no TRIGGER on hardened Student tables'
);

select extensions.ok(
  not exists (
    select 1
    from information_schema.role_table_grants
    where grantee = 'authenticated'
      and table_schema = 'public'
      and table_name in (
        'programmes', 'programme_intakes', 'enrolments',
        'student_import_batches', 'student_import_rows', 'student_legacy_records'
      )
      and privilege_type = 'REFERENCES'
  ),
  'authenticated has no REFERENCES on hardened Student tables'
);

select extensions.ok(
  has_table_privilege('authenticated', 'public.student_import_rows', 'DELETE'),
  'Student Import retains controlled delete of preview rows'
);

select extensions.ok(
  not exists (
    select 1
    from information_schema.role_table_grants
    where grantee = 'authenticated'
      and table_schema = 'public'
      and table_name in (
        'programmes', 'programme_intakes', 'enrolments',
        'student_import_batches', 'student_legacy_records'
      )
      and privilege_type = 'DELETE'
  ),
  'authenticated has no unnecessary DELETE on other hardened Student tables'
);

select extensions.ok(
  has_table_privilege('authenticated', 'public.programmes', 'SELECT')
  and has_table_privilege('authenticated', 'public.programmes', 'INSERT')
  and has_table_privilege('authenticated', 'public.programmes', 'UPDATE'),
  'Programme create/edit workflow retains required privileges'
);

select extensions.ok(
  has_table_privilege('authenticated', 'public.programme_intakes', 'SELECT')
  and has_table_privilege('authenticated', 'public.programme_intakes', 'INSERT')
  and has_table_privilege('authenticated', 'public.programme_intakes', 'UPDATE'),
  'Intake create/edit workflow retains required privileges'
);

select extensions.ok(
  has_table_privilege('authenticated', 'public.enrolments', 'SELECT')
  and has_table_privilege('authenticated', 'public.enrolments', 'INSERT')
  and has_table_privilege('authenticated', 'public.enrolments', 'UPDATE'),
  'Enrolment create/edit workflow retains required privileges'
);

select extensions.ok(
  has_table_privilege('authenticated', 'public.student_import_batches', 'SELECT')
  and has_table_privilege('authenticated', 'public.student_import_batches', 'INSERT')
  and has_table_privilege('authenticated', 'public.student_import_batches', 'UPDATE'),
  'Student Import batch workflow retains required privileges'
);

select extensions.ok(
  has_table_privilege('authenticated', 'public.student_import_rows', 'SELECT')
  and has_table_privilege('authenticated', 'public.student_import_rows', 'INSERT')
  and has_table_privilege('authenticated', 'public.student_import_rows', 'UPDATE')
  and has_table_privilege('authenticated', 'public.student_import_rows', 'DELETE'),
  'Student Import row workflow retains required privileges'
);

select extensions.ok(
  has_table_privilege('authenticated', 'public.student_legacy_records', 'SELECT')
  and not has_table_privilege('authenticated', 'public.student_legacy_records', 'INSERT')
  and not has_table_privilege('authenticated', 'public.student_legacy_records', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.student_legacy_records', 'DELETE'),
  'legacy records are client read-only; writes remain inside privileged import RPCs'
);

select extensions.is(
  (select count(*)::integer
   from pg_policies
   where schemaname = 'public'
     and policyname in (
       'programmes_manage', 'programme_intakes_manage', 'enrolments_manage',
       'student_import_batches_manage', 'student_import_rows_manage',
       'student_legacy_records_manage'
     )),
  0,
  'broad FOR ALL manage policies were removed'
);

select extensions.is(
  (select count(*)::integer
   from pg_policies
   where schemaname = 'public'
     and policyname in (
       'programmes_insert', 'programmes_update',
       'programme_intakes_insert', 'programme_intakes_update',
       'enrolments_insert', 'enrolments_update',
       'student_import_batches_insert', 'student_import_batches_update',
       'student_import_rows_insert', 'student_import_rows_update',
       'student_import_rows_delete'
     )),
  11,
  'operation-specific write policies exist'
);

select extensions.is(
  (select count(*)::integer
   from pg_policies
   where schemaname = 'public'
     and policyname in (
       'programmes_scoped_select', 'programme_intakes_scoped_select',
       'enrolments_scoped_select', 'student_import_batches_select',
       'student_import_rows_select', 'student_legacy_records_select'
     )),
  6,
  'existing scoped SELECT policies remain present'
);

select extensions.ok(
  not exists (
    select 1
    from information_schema.role_table_grants
    where grantee = 'anon'
      and table_schema = 'public'
      and table_name in (
        'programmes', 'programme_intakes', 'enrolments',
        'student_import_batches', 'student_import_rows',
        'student_legacy_records', 'student_duplicate_warning_view'
      )
  ),
  'anonymous has no table/view privileges on hardened Student objects'
);

select extensions.ok(
  not has_column_privilege('authenticated', 'public.students', 'identity_number_fingerprint', 'SELECT'),
  'authenticated cannot select identity fingerprints directly'
);

select extensions.ok(
  not has_column_privilege('authenticated', 'public.students', 'email_normalised', 'SELECT')
  and not has_column_privilege('authenticated', 'public.students', 'phone_normalised', 'SELECT'),
  'authenticated cannot select normalised contact matching fields directly'
);

select extensions.ok(
  (select p.prosecdef
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app_private'
     and p.proname = 'student_duplicate_warning_rows'),
  'private duplicate-warning helper is security-definer'
);

select extensions.ok(
  (select bool_and(p.prosecdef)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'generate_student_number',
       'find_student_duplicate_warnings',
       'merge_students',
       'get_student_sensitive_identity'
     )),
  'privileged Student RPCs remain security-definer with explicit internal checks'
);

select * from extensions.finish();

rollback;
