-- Stage 1A follow-up: keep enrolment numbering RPCs available only to signed-in staff.
-- This is separate from 0016 because that migration has already been applied.

revoke all on function public.generate_enrolment_number(uuid, uuid, uuid) from anon;
revoke all on function public.create_enrolment_with_number(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, date, date, text, text, text,
  numeric, numeric, date, text, text, text, text
) from anon;

grant execute on function public.generate_enrolment_number(uuid, uuid, uuid) to authenticated;
grant execute on function public.create_enrolment_with_number(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, date, date, text, text, text,
  numeric, numeric, date, text, text, text, text
) to authenticated;
