-- Committed fixtures for the concurrency (race) checks. DISPOSABLE LOCAL DATABASE ONLY.
-- pgTAP runs inside one rolled-back transaction, so races between two real sessions need committed rows.
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values
  ('20000000-0000-4000-8000-000000000001', 'race-fo@migration-a.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('20000000-0000-4000-8000-000000000002', 'race-fs@migration-a.invalid', 'authenticated', 'authenticated', '{}', '{}');
update public.app_profiles p set role = v.role, active_status = true
from (values ('20000000-0000-4000-8000-000000000001'::uuid, 'data_entry'), ('20000000-0000-4000-8000-000000000002', 'finance_staff')) v(id, role)
where p.id = v.id;
insert into public.user_entity_access (user_id, entity_id, role, active_status)
select v.u, e.id, v.r, true
from (values ('20000000-0000-4000-8000-000000000001'::uuid, 'data_entry'), ('20000000-0000-4000-8000-000000000002', 'finance_staff')) v(u, r)
join public.entities e on e.short_code = 'IEA';
insert into public.finance_integration_identities (user_id, allowed_entity_ids)
select '20000000-0000-4000-8000-000000000001', array[id] from public.entities where short_code = 'IEA';

-- three unresolved intakes created by the FinanceOps identity (as that identity, through RLS and the triggers)
begin;
select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"20000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
insert into public.finance_intake_submissions (intake_id, payload_hash, source, payload, document_sha256, document_mime_type, document_filename, document_size_bytes, created_by)
select i, repeat('f', 64), '{}', '{}', repeat('7', 64), 'application/pdf', 'x.pdf', 10, auth.uid()
from unnest(array['race_a_0001', 'race_b_0001', 'race_c_0001']) i;
commit;
