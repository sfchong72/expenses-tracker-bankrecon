-- FinanceOps application integration fixtures. DISPOSABLE LOCAL SUPABASE ONLY (never a hosted project).
-- Fictional users on the reserved .invalid domain. The password is passed in at run time (psql -v pw=...) and is
-- never stored in the repository. Requires migrations 0001-0018, 0020-0023 to have been applied.
-- Run as the local `postgres` role:  psql -v ON_ERROR_STOP=1 -v pw="$IT_PASSWORD" -f local-fixtures.sql
begin;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                        created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
select '00000000-0000-0000-0000-000000000000', v.id::uuid, 'authenticated', 'authenticated', v.email,
       extensions.crypt(:'pw', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
       now(), now(), '', '', '', ''
from (values
  ('a0000000-0000-4000-8000-000000000001', 'owner@it.invalid'),
  ('a0000000-0000-4000-8000-000000000002', 'manager@it.invalid'),
  ('a0000000-0000-4000-8000-000000000003', 'staff@it.invalid'),
  ('a0000000-0000-4000-8000-000000000004', 'intern@it.invalid'),
  ('a0000000-0000-4000-8000-000000000005', 'financeops@it.invalid'),
  ('a0000000-0000-4000-8000-000000000006', 'management@it.invalid'),
  ('a0000000-0000-4000-8000-000000000007', 'staff-iea-only@it.invalid')
) v(id, email);

insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select u.id::text, u.id, jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true), 'email', now(), now(), now()
from auth.users u where u.email like '%@it.invalid';

update public.app_profiles p set role = v.role, active_status = true, display_name = 'IT ' || v.role
from (values
  ('a0000000-0000-4000-8000-000000000001'::uuid, 'owner'),
  ('a0000000-0000-4000-8000-000000000002'::uuid, 'finance_manager'),
  ('a0000000-0000-4000-8000-000000000003'::uuid, 'finance_staff'),
  ('a0000000-0000-4000-8000-000000000004'::uuid, 'data_entry'),
  ('a0000000-0000-4000-8000-000000000005'::uuid, 'data_entry'),
  ('a0000000-0000-4000-8000-000000000006'::uuid, 'management'),
  ('a0000000-0000-4000-8000-000000000007'::uuid, 'finance_staff')
) v(id, role) where p.id = v.id;

-- entity access (owner sees everything without rows)
insert into public.user_entity_access (user_id, entity_id, role, active_status)
select v.u::uuid, e.id, v.r, true
from (values
  ('a0000000-0000-4000-8000-000000000002', 'IEA', 'finance_manager'), ('a0000000-0000-4000-8000-000000000002', 'IETA', 'finance_manager'),
  ('a0000000-0000-4000-8000-000000000002', 'PLC', 'finance_manager'), ('a0000000-0000-4000-8000-000000000002', 'KALER', 'finance_manager'),
  ('a0000000-0000-4000-8000-000000000003', 'IEA', 'finance_staff'), ('a0000000-0000-4000-8000-000000000003', 'PLC', 'finance_staff'),
  ('a0000000-0000-4000-8000-000000000004', 'IEA', 'data_entry'), ('a0000000-0000-4000-8000-000000000004', 'PLC', 'data_entry'),
  ('a0000000-0000-4000-8000-000000000005', 'IEA', 'data_entry'), ('a0000000-0000-4000-8000-000000000005', 'IETA', 'data_entry'),
  ('a0000000-0000-4000-8000-000000000005', 'PLC', 'data_entry'), ('a0000000-0000-4000-8000-000000000005', 'KALER', 'data_entry'),
  ('a0000000-0000-4000-8000-000000000006', 'IEA', 'read_only'),
  ('a0000000-0000-4000-8000-000000000007', 'IEA', 'finance_staff')
) v(u, code, r) join public.entities e on e.short_code = v.code;

-- the FinanceOps registry identity (data_entry, all four entities); the owner registers it (AAL2 in the app; direct here)
insert into public.finance_integration_identities (user_id, integration, active_status, allowed_entity_ids, note, created_by)
select 'a0000000-0000-4000-8000-000000000005', 'financeops', true, array_agg(e.id), 'integration test identity', 'a0000000-0000-4000-8000-000000000001'
from public.entities e where e.short_code in ('IEA', 'IETA', 'PLC', 'KALER');

-- reference data: one supplier on IEA, one expense category
insert into public.suppliers (id, supplier_name, registration_number, active_status)
values ('b0000000-0000-4000-8000-000000000001', 'Mega Supplies Sdn Bhd', '201901012345', true);
insert into public.supplier_entities (supplier_id, entity_id) select 'b0000000-0000-4000-8000-000000000001', id from public.entities where short_code in ('IEA', 'PLC');
insert into public.categories (id, entity_id, category_type, name, active_status)
values ('c0000000-0000-4000-8000-000000000001', null, 'expense', 'Office supplies', true);

commit;
