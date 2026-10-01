DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='lab_test') THEN
    RAISE EXCEPTION 'Stale fixture schema lab_test exists before fixture insertion';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users WHERE id IN ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555')) THEN
    RAISE EXCEPTION 'Stale fictional auth.users fixture IDs exist before fixture insertion';
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_profiles WHERE id IN ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555')) THEN
    RAISE EXCEPTION 'Stale fictional app_profiles fixture IDs exist before fixture insertion';
  END IF;
  IF EXISTS (SELECT 1 FROM public.students WHERE id IN ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5')) THEN
    RAISE EXCEPTION 'Stale fictional student fixture IDs exist before fixture insertion';
  END IF;
  IF EXISTS (SELECT 1 FROM public.programmes WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') THEN
    RAISE EXCEPTION 'Stale fictional programme fixture ID exists before fixture insertion';
  END IF;
  IF EXISTS (SELECT 1 FROM public.programme_intakes WHERE id IN ('cccccccc-cccc-4ccc-8ccc-ccccccccccc1','cccccccc-cccc-4ccc-8ccc-ccccccccccc2')) THEN
    RAISE EXCEPTION 'Stale fictional intake fixture IDs exist before fixture insertion';
  END IF;
  IF EXISTS (SELECT 1 FROM public.enrolments WHERE id='dddddddd-dddd-4ddd-8ddd-dddddddddddd') THEN
    RAISE EXCEPTION 'Stale fictional enrolment fixture ID exists before fixture insertion';
  END IF;
  IF EXISTS (SELECT 1 FROM public.student_import_batches WHERE id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') THEN
    RAISE EXCEPTION 'Stale fictional import batch fixture ID exists before fixture insertion';
  END IF;
  IF EXISTS (SELECT 1 FROM public.student_import_rows WHERE id='ffffffff-ffff-4fff-8fff-ffffffffffff') THEN
    RAISE EXCEPTION 'Stale fictional import row fixture ID exists before fixture insertion';
  END IF;
  IF EXISTS (SELECT 1 FROM public.student_legacy_records WHERE id='99999999-9999-4999-8999-999999999999') THEN
    RAISE EXCEPTION 'Stale fictional legacy fixture ID exists before fixture insertion';
  END IF;
END $$;