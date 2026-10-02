-- Migration A (FinanceOps Phase 1A) pgTAP suite. DISPOSABLE LOCAL DATABASE ONLY.
-- Generated from a readable template. All fixtures are fictional and created inside the transaction,
-- which is rolled back. Not a Production artefact. Requires 0001-0018, 0020, 0021, 0022 and Migration A.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

create schema fo_t;
revoke all on schema fo_t from public;
grant usage on schema fo_t to authenticated, anon;
create function fo_t.claim(p_user uuid, p_aal text default 'aal1') returns void language plpgsql security invoker set search_path = '' as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', case when p_user is null then 'anon' else 'authenticated' end, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', case when p_user is null then 'anon' else 'authenticated' end, 'aal', p_aal)::text, true);
end $$;
create function fo_t.err(q text) returns text language plpgsql security invoker set search_path = '' as $$
begin
  begin execute q; raise exception using errcode = 'PT001', message = '__rolled_back__';
  exception when sqlstate 'PT001' then return 'OK'; when others then return sqlerrm; end;
end $$;
create function fo_t.scalar(q text) returns text language plpgsql security invoker set search_path = '' as $$
declare r text; begin execute q into r; return r; end $$;
create function fo_t.exec(q text) returns void language plpgsql security invoker set search_path = '' as $$
begin execute q; end $$;
create function fo_t.upd(q text) returns bigint language plpgsql security invoker set search_path = '' as $$
declare n bigint; begin execute q; get diagnostics n = row_count; return n; end $$;
create function fo_t.eid(c text) returns uuid language sql stable security definer set search_path = '' as $$
select id from public.entities where short_code = c $$;
create function fo_t.ins(p_intake text, p_code text, p_sha text, p_sup text default null, p_by uuid default null) returns void language plpgsql security invoker set search_path = '' as $$
begin
  insert into public.finance_intake_submissions (intake_id, payload_hash, source, payload, entity_code_declared, entity_id,
    document_sha256, document_mime_type, document_filename, document_size_bytes, created_by, supersedes_intake_id)
  values (p_intake, repeat('f', 64), '{"channel":"telegram"}'::jsonb, '{"fictional":true}'::jsonb, p_code,
    (select id from public.entities where short_code = p_code), p_sha, 'application/pdf', 'fictional.pdf', 1234,
    coalesce(p_by, auth.uid()), p_sup);
end $$;
grant execute on all functions in schema fo_t to authenticated, anon;

-- ==========================================================================================
-- FIXTURES (as postgres): users, roles, entity access, bills, documents
-- ==========================================================================================
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values
  ('10000000-0000-4000-8000-000000000001', 'own@migration-a.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('10000000-0000-4000-8000-000000000002', 'fm@migration-a.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('10000000-0000-4000-8000-000000000003', 'fs@migration-a.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('10000000-0000-4000-8000-000000000004', 'fs2@migration-a.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('10000000-0000-4000-8000-000000000005', 'int@migration-a.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('10000000-0000-4000-8000-000000000006', 'fo@migration-a.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('10000000-0000-4000-8000-000000000007', 'fo2@migration-a.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('10000000-0000-4000-8000-000000000008', 'mgt@migration-a.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('10000000-0000-4000-8000-000000000009', 'ro@migration-a.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('10000000-0000-4000-8000-00000000000a', 'trn@migration-a.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('10000000-0000-4000-8000-00000000000b', 'inact@migration-a.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('10000000-0000-4000-8000-00000000000c', 'inde@migration-a.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('10000000-0000-4000-8000-00000000000d', 'tmp@migration-a.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('10000000-0000-4000-8000-00000000000e', 'fo3@migration-a.invalid', 'authenticated', 'authenticated', '{}', '{}');
update public.app_profiles p set role = v.role, active_status = v.active_status, display_name = 'Fictional ' || v.role from (values
  ('10000000-0000-4000-8000-000000000001'::uuid, 'owner', true),
  ('10000000-0000-4000-8000-000000000002'::uuid, 'finance_manager', true),
  ('10000000-0000-4000-8000-000000000003'::uuid, 'finance_staff', true),
  ('10000000-0000-4000-8000-000000000004'::uuid, 'finance_staff', true),
  ('10000000-0000-4000-8000-000000000005'::uuid, 'data_entry', true),
  ('10000000-0000-4000-8000-000000000006'::uuid, 'data_entry', true),
  ('10000000-0000-4000-8000-000000000007'::uuid, 'data_entry', true),
  ('10000000-0000-4000-8000-000000000008'::uuid, 'management', true),
  ('10000000-0000-4000-8000-000000000009'::uuid, 'read_only', true),
  ('10000000-0000-4000-8000-00000000000a'::uuid, 'trainer', true),
  ('10000000-0000-4000-8000-00000000000b'::uuid, 'finance_staff', false),
  ('10000000-0000-4000-8000-00000000000c'::uuid, 'data_entry', false),
  ('10000000-0000-4000-8000-00000000000d'::uuid, 'data_entry', true),
  ('10000000-0000-4000-8000-00000000000e'::uuid, 'data_entry', true)
) v(id, role, active_status) where p.id = v.id;
insert into public.user_entity_access (user_id, entity_id, role, active_status) select v.u, e.id, v.r, true from (values
  ('10000000-0000-4000-8000-000000000002'::uuid, 'IEA', 'finance_manager'),
  ('10000000-0000-4000-8000-000000000002'::uuid, 'IETA', 'finance_manager'),
  ('10000000-0000-4000-8000-000000000002'::uuid, 'PLC', 'finance_manager'),
  ('10000000-0000-4000-8000-000000000002'::uuid, 'KALER', 'finance_manager'),
  ('10000000-0000-4000-8000-000000000003'::uuid, 'IEA', 'finance_staff'),
  ('10000000-0000-4000-8000-000000000004'::uuid, 'IEA', 'finance_staff'),
  ('10000000-0000-4000-8000-000000000004'::uuid, 'KALER', 'finance_staff'),
  ('10000000-0000-4000-8000-000000000005'::uuid, 'IEA', 'data_entry'),
  ('10000000-0000-4000-8000-000000000005'::uuid, 'PLC', 'data_entry'),
  ('10000000-0000-4000-8000-000000000006'::uuid, 'IEA', 'data_entry'),
  ('10000000-0000-4000-8000-000000000006'::uuid, 'PLC', 'data_entry'),
  ('10000000-0000-4000-8000-000000000006'::uuid, 'KALER', 'data_entry'),
  ('10000000-0000-4000-8000-000000000007'::uuid, 'IEA', 'data_entry'),
  ('10000000-0000-4000-8000-000000000008'::uuid, 'IEA', 'management'),
  ('10000000-0000-4000-8000-000000000009'::uuid, 'IEA', 'read_only'),
  ('10000000-0000-4000-8000-00000000000a'::uuid, 'IEA', 'trainer'),
  ('10000000-0000-4000-8000-00000000000b'::uuid, 'IEA', 'finance_staff'),
  ('10000000-0000-4000-8000-00000000000c'::uuid, 'IEA', 'data_entry'),
  ('10000000-0000-4000-8000-00000000000d'::uuid, 'IEA', 'data_entry'),
  ('10000000-0000-4000-8000-00000000000e'::uuid, 'IEA', 'data_entry')
) v(u, c, r) join public.entities e on e.short_code = v.c;
insert into public.entities (legal_name, display_name, short_code) values ('Fictional Disallowed Entity', 'ZZZ', 'ZZZ');
insert into public.supplier_bills (id, entity_id, description, due_date, total_amount, outstanding_amount, payment_status)
select v.id, e.id, v.descr, current_date, 100, 100, v.status from (values
  ('91000000-0000-4000-8000-000000000001'::uuid, 'IEA', 'Fictional bill b_link1', 'draft'),
  ('91000000-0000-4000-8000-000000000002'::uuid, 'IEA', 'Fictional bill b_link2', 'draft'),
  ('91000000-0000-4000-8000-000000000003'::uuid, 'PLC', 'Fictional bill b_plc', 'draft'),
  ('91000000-0000-4000-8000-000000000004'::uuid, 'IEA', 'Fictional bill b_unpaid', 'unpaid'),
  ('91000000-0000-4000-8000-000000000005'::uuid, 'IEA', 'Fictional bill b_rev', 'draft'),
  ('91000000-0000-4000-8000-000000000006'::uuid, 'IEA', 'Fictional bill b_rev2', 'draft'),
  ('91000000-0000-4000-8000-000000000007'::uuid, 'IEA', 'Fictional bill b_cas1', 'draft'),
  ('91000000-0000-4000-8000-000000000008'::uuid, 'IEA', 'Fictional bill b_cas2', 'draft'),
  ('91000000-0000-4000-8000-000000000009'::uuid, 'IEA', 'Fictional bill b_cas3', 'draft'),
  ('91000000-0000-4000-8000-000000000010'::uuid, 'IEA', 'Fictional bill b_g1', 'draft'),
  ('91000000-0000-4000-8000-000000000011'::uuid, 'IEA', 'Fictional bill b_lnk3', 'draft')
) v(id, code, descr, status) join public.entities e on e.short_code = v.code;
insert into public.documents (id, entity_id, document_type, original_filename, storage_path, mime_type, file_size, file_hash)
select v.id, e.id, 'supplier_invoice', v.name || '.pdf', e.id::text || '/migration-a/' || v.name, 'application/pdf', 12, v.hash from (values
  ('92000000-0000-4000-8000-000000000001'::uuid, 'IEA', 'd_link1', '1111111111111111111111111111111111111111111111111111111111111111'),
  ('92000000-0000-4000-8000-000000000002'::uuid, 'IEA', 'd_bad', '9999999999999999999999999999999999999999999999999999999999999999'),
  ('92000000-0000-4000-8000-000000000003'::uuid, 'PLC', 'd_plc', '1111111111111111111111111111111111111111111111111111111111111111'),
  ('92000000-0000-4000-8000-000000000004'::uuid, 'IEA', 'd_rev', '2222222222222222222222222222222222222222222222222222222222222222'),
  ('92000000-0000-4000-8000-000000000005'::uuid, 'IEA', 'd_rev2', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'),
  ('92000000-0000-4000-8000-000000000006'::uuid, 'IEA', 'd_cas1', '3333333333333333333333333333333333333333333333333333333333333333'),
  ('92000000-0000-4000-8000-000000000007'::uuid, 'IEA', 'd_cas2', '4444444444444444444444444444444444444444444444444444444444444444'),
  ('92000000-0000-4000-8000-000000000008'::uuid, 'IEA', 'd_cas3', '5555555555555555555555555555555555555555555555555555555555555555'),
  ('92000000-0000-4000-8000-000000000009'::uuid, 'IEA', 'd_lnk3', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
) v(id, code, name, hash) join public.entities e on e.short_code = v.code;
-- As in the real Hub flow, every document is linked to a bill of its own entity BEFORE an intake references it
-- (documents RLS only exposes a document through a document_links row; the supported deletion RPC authorises the same way).
insert into public.document_links (document_id, entity_id, linked_record_type, linked_record_id) select v.d::uuid, e.id, 'supplier_bill', v.b::uuid from (values
  ('92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'IEA'),
  ('92000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000002', 'IEA'),
  ('92000000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-000000000003', 'PLC'),
  ('92000000-0000-4000-8000-000000000004', '91000000-0000-4000-8000-000000000005', 'IEA'),
  ('92000000-0000-4000-8000-000000000005', '91000000-0000-4000-8000-000000000006', 'IEA'),
  ('92000000-0000-4000-8000-000000000006', '91000000-0000-4000-8000-000000000007', 'IEA'),
  ('92000000-0000-4000-8000-000000000007', '91000000-0000-4000-8000-000000000008', 'IEA'),
  ('92000000-0000-4000-8000-000000000008', '91000000-0000-4000-8000-000000000009', 'IEA'),
  ('92000000-0000-4000-8000-000000000009', '91000000-0000-4000-8000-000000000011', 'IEA')
) v(d, b, c) join public.entities e on e.short_code = v.c;
create temp table pre_snapshot as select count(*) as n from public.audit_logs;

-- ==========================================================================================
-- 1. REGISTRY: only Owner+AAL2 administers; identity must be an active data_entry user; approved entities only
-- ==========================================================================================
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000001', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$insert into public.finance_integration_identities (user_id, allowed_entity_ids) values ('10000000-0000-4000-8000-000000000007', array[fo_t.eid('IEA')])$q$), 'row-level security', 'Owner WITHOUT AAL2 cannot designate an identity');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000002', 'aal2'); set local role authenticated;
select extensions.matches(fo_t.err($q$insert into public.finance_integration_identities (user_id, allowed_entity_ids) values ('10000000-0000-4000-8000-000000000007', array[fo_t.eid('IEA')])$q$), 'row-level security|active data_entry', 'Finance Manager (even AAL2) cannot designate an identity');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000005', 'aal2'); set local role authenticated;
select extensions.matches(fo_t.err($q$insert into public.finance_integration_identities (user_id, allowed_entity_ids) values ('10000000-0000-4000-8000-000000000005', array[fo_t.eid('IEA')])$q$), 'row-level security', 'data_entry cannot designate an identity');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal2'); set local role authenticated;
select extensions.matches(fo_t.err($q$insert into public.finance_integration_identities (user_id, allowed_entity_ids) values ('10000000-0000-4000-8000-000000000006', array[fo_t.eid('IEA')])$q$), 'row-level security', 'The FinanceOps identity cannot designate itself');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000001', 'aal2'); set local role authenticated;
select extensions.matches(fo_t.err($q$insert into public.finance_integration_identities (user_id, allowed_entity_ids) values ('10000000-0000-4000-8000-000000000003', array[fo_t.eid('IEA')])$q$), 'active data_entry', 'finance_staff designation is REJECTED');
select extensions.matches(fo_t.err($q$insert into public.finance_integration_identities (user_id, allowed_entity_ids) values ('10000000-0000-4000-8000-00000000000b', array[fo_t.eid('IEA')])$q$), 'active data_entry', 'inactive finance_staff designation is rejected');
select extensions.matches(fo_t.err($q$insert into public.finance_integration_identities (user_id, allowed_entity_ids) values ('10000000-0000-4000-8000-00000000000c', array[fo_t.eid('IEA')])$q$), 'active data_entry', 'inactive data_entry designation is rejected');
select extensions.matches(fo_t.err($q$insert into public.finance_integration_identities (user_id, allowed_entity_ids) values ('10000000-0000-4000-8000-000000000001', array[fo_t.eid('IEA')])$q$), 'active data_entry', 'owner designation is rejected');
select extensions.matches(fo_t.err($q$insert into public.finance_integration_identities (user_id, allowed_entity_ids) values ('10000000-0000-4000-8000-000000000008', array[fo_t.eid('IEA')])$q$), 'active data_entry', 'management designation is rejected');
select extensions.matches(fo_t.err($q$insert into public.finance_integration_identities (user_id, allowed_entity_ids) values ('10000000-0000-4000-8000-000000000007', array[fo_t.eid('ZZZ')])$q$), 'approved entities', 'a non-approved existing entity (ZZZ) is rejected');
select extensions.matches(fo_t.err($q$insert into public.finance_integration_identities (user_id, allowed_entity_ids) values ('10000000-0000-4000-8000-000000000007', array[fo_t.eid('IEA'), fo_t.eid('ZZZ')])$q$), 'approved entities', 'a mix of approved and non-approved entities is rejected');
select extensions.matches(fo_t.err($q$insert into public.finance_integration_identities (user_id, allowed_entity_ids) values ('10000000-0000-4000-8000-000000000007', array[gen_random_uuid()])$q$), 'approved entities', 'a non-existent entity id is rejected');
select extensions.matches(fo_t.err($q$insert into public.finance_integration_identities (user_id, allowed_entity_ids) values ('10000000-0000-4000-8000-000000000007', '{}'::uuid[])$q$), 'fii_entities_count', 'an empty entity list is rejected');
select extensions.matches(fo_t.err($q$insert into public.finance_integration_identities (user_id, allowed_entity_ids) values ('10000000-0000-4000-8000-000000000007', array[fo_t.eid('IEA'), fo_t.eid('IEA')])$q$), 'duplicates', 'duplicate entities are rejected');
select extensions.matches(fo_t.err($q$insert into public.finance_integration_identities (user_id, integration, allowed_entity_ids) values ('10000000-0000-4000-8000-000000000007', 'other', array[fo_t.eid('IEA')])$q$), 'fii_integration_known', 'integration name is fixed to financeops');
select fo_t.exec($q$insert into public.finance_integration_identities (user_id, allowed_entity_ids) values ('10000000-0000-4000-8000-000000000006', array[fo_t.eid('IEA'), fo_t.eid('PLC')])$q$);
select fo_t.exec($q$insert into public.finance_integration_identities (user_id, allowed_entity_ids) values ('10000000-0000-4000-8000-000000000007', array[fo_t.eid('IEA')])$q$);
select fo_t.exec($q$insert into public.finance_integration_identities (user_id, allowed_entity_ids) values ('10000000-0000-4000-8000-00000000000e', array[fo_t.eid('IEA')])$q$);
select extensions.is((fo_t.scalar($q$select count(*) from public.finance_integration_identities$q$))::text, '3', 'Owner+AAL2 designated three active data_entry identities');
select extensions.matches(fo_t.err($q$update public.finance_integration_identities set allowed_entity_ids = array[fo_t.eid('ZZZ')] where user_id = '10000000-0000-4000-8000-000000000006'$q$), 'approved entities', 'registry entities cannot later be changed to a non-approved entity');
select extensions.ok(fo_t.scalar($q$select count(*) from public.app_profiles where id = '10000000-0000-4000-8000-000000000006'$q$)::int = 1, 'Owner can read the target user''s app_profiles row through RLS (registry trigger works as INVOKER)');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000002', 'aal2'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.app_profiles where id = '10000000-0000-4000-8000-000000000006'$q$)::int = 0, 'Finance Manager CANNOT read another user''s profile (so the INVOKER trigger relies on the Owner, which is the only registry writer)');
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_integration_identities$q$)::int = 0, 'Finance Manager sees no registry rows');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000005', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_integration_identities$q$)::int = 0, 'Intern sees no registry rows');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_integration_identities$q$)::int = 1, 'The FinanceOps identity sees only its own registry row');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000001', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.upd($q$update public.finance_integration_identities set active_status = false where user_id = '10000000-0000-4000-8000-000000000007'$q$) = 0, 'Owner without AAL2 updates 0 registry rows');
select extensions.ok(fo_t.upd($q$delete from public.finance_integration_identities where user_id = '10000000-0000-4000-8000-000000000007'$q$) = 0, 'Owner without AAL2 deletes 0 registry rows');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000002', 'aal2'); set local role authenticated;
select extensions.ok(fo_t.upd($q$update public.finance_integration_identities set active_status = false where user_id = '10000000-0000-4000-8000-000000000007'$q$) = 0, 'Finance Manager updates 0 registry rows');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000001', 'aal2'); set local role authenticated;
select extensions.ok(fo_t.upd($q$update public.finance_integration_identities set active_status = false where user_id = '10000000-0000-4000-8000-000000000007'$q$) = 1, 'Owner+AAL2 can flip the kill switch off');
select extensions.ok(fo_t.upd($q$update public.finance_integration_identities set active_status = true where user_id = '10000000-0000-4000-8000-000000000007'$q$) = 1, 'Owner+AAL2 can flip the kill switch back on');

-- ==========================================================================================
-- 2. INSERT / IDEMPOTENCY: only the registry identity; allowed entities; provenance rules
-- ==========================================================================================
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal1'); set local role authenticated;
select fo_t.ins('ti_ins_iea_01', 'IEA', '6666666666666666666666666666666666666666666666666666666666666666', null, null);
select fo_t.ins('ti_ins_nul_01', null, '7777777777777777777777777777777777777777777777777777777777777777', null, null);
select fo_t.ins('ti_ins_plc_01', 'PLC', '8888888888888888888888888888888888888888888888888888888888888888', null, null);
reset role;
select extensions.is((fo_t.scalar($q$select process_state from public.finance_intake_submissions where intake_id = 'ti_ins_iea_01'$q$))::text, 'received', 'resolved IEA intake accepted, state ''received''');
select extensions.is((fo_t.scalar($q$select (entity_id = fo_t.eid('IEA'))::text from public.finance_intake_submissions where intake_id = 'ti_ins_iea_01'$q$))::text, 'true', 'resolved intake carries the entity id');
select extensions.is((fo_t.scalar($q$select process_state from public.finance_intake_submissions where intake_id = 'ti_ins_nul_01'$q$))::text, 'awaiting_entity', 'unresolved (NULL entity) intake accepted, state ''awaiting_entity''');
select extensions.is((fo_t.scalar($q$select (entity_id is null)::text from public.finance_intake_submissions where intake_id = 'ti_ins_nul_01'$q$))::text, 'true', 'unresolved intake has NULL entity');
select extensions.is((fo_t.scalar($q$select created_by from public.finance_intake_submissions where intake_id = 'ti_ins_iea_01'$q$))::text, '10000000-0000-4000-8000-000000000006', 'created_by is the authenticated FinanceOps identity');
select extensions.is((fo_t.scalar($q$select review_status from public.finance_intake_submissions where intake_id = 'ti_ins_iea_01'$q$))::text, 'pending_review', 'review_status starts pending_review');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$select fo_t.ins('ti_ins_kal_01', 'KALER', '6666666666666666666666666666666666666666666666666666666666666666', null, null)$q$), 'row-level security', 'KALER is in the identity''s access but NOT in its registry allow-list: rejected');
select extensions.matches(fo_t.err($q$select fo_t.ins('ti_ins_iet_01', 'IETA', '6666666666666666666666666666666666666666666666666666666666666666', null, null)$q$), 'declared entity code requires a resolved entity|row-level security', 'IETA (no access) cannot be used');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000005', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$select fo_t.ins('ti_ins_int_01', 'IEA', '6666666666666666666666666666666666666666666666666666666666666666', null, null)$q$), 'designated FinanceOps|row-level security', 'an unregistered data_entry user cannot insert an intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000003', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$select fo_t.ins('ti_ins_fs_01', 'IEA', '6666666666666666666666666666666666666666666666666666666666666666', null, null)$q$), 'designated FinanceOps|row-level security', 'Finance Staff cannot insert an intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000001', 'aal2'); set local role authenticated;
select extensions.matches(fo_t.err($q$select fo_t.ins('ti_ins_own_01', 'IEA', '6666666666666666666666666666666666666666666666666666666666666666', null, null)$q$), 'designated FinanceOps|row-level security', 'Owner cannot insert an intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$select fo_t.ins('ti_ins_cb_001', 'IEA', '6666666666666666666666666666666666666666666666666666666666666666', null, '10000000-0000-4000-8000-000000000005'::uuid)$q$), 'created_by must be the authenticated', 'created_by mismatch is rejected');
select extensions.matches(fo_t.err($q$select fo_t.ins('ti_ins_iea_01', 'IEA', '6666666666666666666666666666666666666666666666666666666666666666', null, null)$q$), 'duplicate key|fis_intake_id_key', 'duplicate intake_id is a unique violation');
select extensions.is(fo_t.err($q$insert into public.finance_intake_submissions (intake_id, payload_hash, source, payload, document_sha256, document_mime_type, document_filename, document_size_bytes, created_by) values ('ti_ins_iea_01', repeat('f',64), '{}', '{}', '6666666666666666666666666666666666666666666666666666666666666666', 'application/pdf', 'x.pdf', 1, auth.uid()) on conflict (intake_id) do nothing$q$), 'OK', 'INSERT ... ON CONFLICT (intake_id) DO NOTHING is a clean idempotent no-op');
select extensions.is((fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_ins_iea_01'$q$))::text, '1', 'idempotent retry leaves exactly one row');
select extensions.matches(fo_t.err($q$insert into public.finance_intake_submissions (intake_id, payload_hash, source, payload, document_sha256, document_mime_type, document_filename, document_size_bytes, created_by, reviewed_by) values ('ti_ins_rv_001', repeat('f',64), '{}', '{}', '6666666666666666666666666666666666666666666666666666666666666666', 'application/pdf', 'x.pdf', 1, auth.uid(), auth.uid())$q$), 'cannot carry', 'a new intake cannot carry review fields');
select extensions.matches(fo_t.err($q$insert into public.finance_intake_submissions (intake_id, payload_hash, source, payload, document_sha256, document_mime_type, document_filename, document_size_bytes, created_by, supplier_bill_id) values ('ti_ins_bl_001', repeat('f',64), '{}', '{}', '6666666666666666666666666666666666666666666666666666666666666666', 'application/pdf', 'x.pdf', 1, auth.uid(), '91000000-0000-4000-8000-000000000001')$q$), 'cannot carry', 'a new intake cannot carry a bill link');
select extensions.matches(fo_t.err($q$insert into public.finance_intake_submissions (intake_id, payload_hash, source, payload, document_sha256, document_mime_type, document_filename, document_size_bytes, created_by, review_status) values ('ti_ins_dv_001', repeat('f',64), '{}', '{}', '6666666666666666666666666666666666666666666666666666666666666666', 'application/pdf', 'x.pdf', 1, auth.uid(), 'data_verified')$q$), 'starts as pending_review', 'a new intake cannot start as data_verified');
select extensions.matches(fo_t.err($q$insert into public.finance_intake_submissions (intake_id, payload_hash, source, payload, entity_code_declared, entity_id, document_sha256, document_mime_type, document_filename, document_size_bytes, created_by) values ('ti_ins_mm_001', repeat('f',64), '{}', '{}', 'IEA', fo_t.eid('PLC'), '6666666666666666666666666666666666666666666666666666666666666666', 'application/pdf', 'x.pdf', 1, auth.uid())$q$), 'matching the declared entity code', 'a resolved intake must match its declared entity code');
select extensions.matches(fo_t.err($q$select fo_t.ins('short', 'IEA', '6666666666666666666666666666666666666666666666666666666666666666', null, null)$q$), 'fis_intake_id_format', 'intake_id format is enforced');
select extensions.matches(fo_t.err($q$select fo_t.ins('ti_ins_bad_01', 'IEA', 'xyz', null, null)$q$), 'fis_document_sha256_format', 'document hash format is enforced');
select extensions.matches(fo_t.err($q$insert into public.finance_intake_submissions (intake_id, payload_hash, source, payload, document_sha256, document_mime_type, document_filename, document_size_bytes, created_by) values ('ti_ins_mt_001', repeat('f',64), '{}', '{}', '6666666666666666666666666666666666666666666666666666666666666666', 'image/gif', 'x.gif', 1, auth.uid())$q$), 'fis_document_mime', 'mime type is restricted to pdf/jpeg/png');
select extensions.matches(fo_t.err($q$insert into public.finance_intake_submissions (intake_id, payload_hash, source, payload, document_sha256, document_mime_type, document_filename, document_size_bytes, created_by) values ('ti_ins_sz_001', repeat('f',64), '{}', '{}', '6666666666666666666666666666666666666666666666666666666666666666', 'application/pdf', 'x.pdf', 4194305, auth.uid())$q$), 'fis_document_size', '4 MB size limit is enforced');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set intake_id = 'ti_ins_other1' where intake_id = 'ti_ins_iea_01'$q$), 'immutable', 'provenance column is immutable: intake_id');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set payload_hash = repeat('e',64) where intake_id = 'ti_ins_iea_01'$q$), 'immutable', 'provenance column is immutable: payload_hash');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set source = '{"x":1}' where intake_id = 'ti_ins_iea_01'$q$), 'immutable', 'provenance column is immutable: source');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set payload = '{"x":1}' where intake_id = 'ti_ins_iea_01'$q$), 'immutable', 'provenance column is immutable: payload');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set document_sha256 = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' where intake_id = 'ti_ins_iea_01'$q$), 'immutable', 'provenance column is immutable: document hash');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set document_filename = 'x.pdf' where intake_id = 'ti_ins_iea_01'$q$), 'immutable', 'provenance column is immutable: document filename');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set created_by = '10000000-0000-4000-8000-000000000005' where intake_id = 'ti_ins_iea_01'$q$), 'immutable', 'provenance column is immutable: created_by');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set entity_code_declared = 'PLC' where intake_id = 'ti_ins_iea_01'$q$), 'immutable', 'provenance column is immutable: declared code');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set integration_key_id = 'other' where intake_id = 'ti_ins_iea_01'$q$), 'immutable', 'provenance column is immutable: key id');
reset role;
update public.app_profiles set role = 'finance_staff' where id = '10000000-0000-4000-8000-000000000007';
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000007', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$select fo_t.ins('ti_ins_pro_01', 'IEA', '6666666666666666666666666666666666666666666666666666666666666666', null, null)$q$), 'row-level security', 'a registered identity promoted away from data_entry can no longer insert');
reset role;
update public.app_profiles set role = 'data_entry' where id = '10000000-0000-4000-8000-000000000007';
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000001', 'aal2'); set local role authenticated;
select fo_t.exec($q$update public.finance_integration_identities set active_status = false where user_id = '10000000-0000-4000-8000-000000000007'$q$);
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000007', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$select fo_t.ins('ti_ins_ks_001', 'IEA', '6666666666666666666666666666666666666666666666666666666666666666', null, null)$q$), 'designated FinanceOps|row-level security', 'a kill-switched identity cannot insert');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000001', 'aal2'); set local role authenticated;
select fo_t.exec($q$update public.finance_integration_identities set active_status = true where user_id = '10000000-0000-4000-8000-000000000007'$q$);
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000007', 'aal1'); set local role authenticated;
select extensions.is(fo_t.err($q$select fo_t.ins('ti_ins_fo2_01', 'IEA', '6666666666666666666666666666666666666666666666666666666666666666', null, null)$q$), 'OK', 'the re-enabled second identity can insert for its own allowed entity');
select extensions.matches(fo_t.err($q$select fo_t.ins('ti_ins_fo2_02', 'PLC', '6666666666666666666666666666666666666666666666666666666666666666', null, null)$q$), 'row-level security|declared entity code requires', 'the second identity cannot submit for an entity outside its registry/access (PLC rejected)');

-- ==========================================================================================
-- 3. VISIBILITY: unresolved central rule (D11 / Q4); resolved entity scope
-- ==========================================================================================
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_ins_nul_01'$q$)::int = 1, 'fo SEES an unresolved intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000001', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_ins_nul_01'$q$)::int = 1, 'own SEES an unresolved intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000002', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_ins_nul_01'$q$)::int = 1, 'fm SEES an unresolved intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000003', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_ins_nul_01'$q$)::int = 1, 'fs SEES an unresolved intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000004', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_ins_nul_01'$q$)::int = 1, 'fs2 SEES an unresolved intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000005', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_ins_nul_01'$q$)::int = 0, 'int does NOT see an unresolved intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000008', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_ins_nul_01'$q$)::int = 0, 'mgt does NOT see an unresolved intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000009', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_ins_nul_01'$q$)::int = 0, 'ro does NOT see an unresolved intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-00000000000a', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_ins_nul_01'$q$)::int = 0, 'trn does NOT see an unresolved intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000007', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_ins_nul_01'$q$)::int = 0, 'fo2 does NOT see an unresolved intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-00000000000b', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_ins_nul_01'$q$)::int = 0, 'inact does NOT see an unresolved intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-00000000000c', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_ins_nul_01'$q$)::int = 0, 'inde does NOT see an unresolved intake');
reset role; select fo_t.claim(null, 'aal1'); set local role anon;
select extensions.matches(fo_t.err($q$select count(*) from public.finance_intake_submissions$q$), 'permission denied', 'anonymous has no access to intakes');
select extensions.matches(fo_t.err($q$select count(*) from public.finance_integration_identities$q$), 'permission denied', 'anonymous has no access to the registry');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000005', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_ins_iea_01'$q$)::int = 1, 'int sees resolved ti_ins_iea_01');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000003', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_ins_iea_01'$q$)::int = 1, 'fs sees resolved ti_ins_iea_01');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000008', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_ins_iea_01'$q$)::int = 1, 'mgt sees resolved ti_ins_iea_01');
reset role; select fo_t.claim('10000000-0000-4000-8000-00000000000a', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_ins_iea_01'$q$)::int = 0, 'trn does NOT see resolved ti_ins_iea_01');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000009', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_ins_iea_01'$q$)::int = 0, 'ro does NOT see resolved ti_ins_iea_01');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000007', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_ins_iea_01'$q$)::int = 1, 'fo2 sees resolved ti_ins_iea_01');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000003', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_ins_plc_01'$q$)::int = 0, 'fs does NOT see resolved ti_ins_plc_01');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000004', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_ins_plc_01'$q$)::int = 0, 'fs2 does NOT see resolved ti_ins_plc_01');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000005', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_ins_plc_01'$q$)::int = 1, 'int sees resolved ti_ins_plc_01');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000002', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_ins_plc_01'$q$)::int = 1, 'fm sees resolved ti_ins_plc_01');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000001', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_ins_plc_01'$q$)::int = 1, 'own sees resolved ti_ins_plc_01');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000003', 'aal1'); set local role authenticated;
select extensions.is((fo_t.scalar($q$select is_unresolved::text || '/' || is_superseded::text from public.finance_intake_queue where intake_id = 'ti_ins_nul_01'$q$))::text, 'true/false', 'queue view marks the unresolved intake');

-- ==========================================================================================
-- 4. ENTITY RESOLUTION (D10 path 1, D11, Q6, Q7)
-- ==========================================================================================
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal1'); set local role authenticated;
select fo_t.ins('ti_res_u1', null, '6666666666666666666666666666666666666666666666666666666666666666', null, null);
select fo_t.ins('ti_res_u2', null, '6666666666666666666666666666666666666666666666666666666666666666', null, null);
select fo_t.ins('ti_res_u3', null, '6666666666666666666666666666666666666666666666666666666666666666', null, null);
select fo_t.ins('ti_res_u4', null, '6666666666666666666666666666666666666666666666666666666666666666', null, null);
select fo_t.ins('ti_res_u5', null, '6666666666666666666666666666666666666666666666666666666666666666', null, null);
select fo_t.ins('ti_res_u6', null, '6666666666666666666666666666666666666666666666666666666666666666', null, null);
select fo_t.ins('ti_res_u7', null, '6666666666666666666666666666666666666666666666666666666666666666', null, null);
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000005', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.upd($q$update public.finance_intake_submissions set review_status = 'rejected' where intake_id = 'ti_res_u1'$q$) = 0, 'intern cannot update an unresolved intake (0 rows visible)');
select extensions.ok(fo_t.upd($q$update public.finance_intake_submissions set entity_id = fo_t.eid('IEA'), entity_resolution_note = 'intern attempt' where intake_id = 'ti_res_u1'$q$) = 0, 'intern cannot resolve an unresolved intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000008', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.upd($q$update public.finance_intake_submissions set entity_id = fo_t.eid('IEA'), entity_resolution_note = 'management attempt' where intake_id = 'ti_res_u1'$q$) = 0, 'management cannot resolve an unresolved intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set entity_id = fo_t.eid('IEA'), entity_resolution_note = 'self resolve' where intake_id = 'ti_res_u1'$q$), 'Only Owner, Finance Manager or Finance Staff', 'the FinanceOps identity cannot resolve its own unresolved intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000003', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set entity_id = fo_t.eid('IEA') where intake_id = 'ti_res_u1'$q$), 'resolution note is required|fis_resolution_note', 'a resolution note is required');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set entity_id = fo_t.eid('KALER'), entity_resolution_note = 'wrong company' where intake_id = 'ti_res_u1'$q$), 'row-level security|approved entities', 'Finance Staff cannot resolve to an entity they cannot access (KALER)');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set entity_id = fo_t.eid('IEA'), entity_resolution_note = 'ok note', review_status = 'rejected' where intake_id = 'ti_res_u1'$q$), 'standalone', 'resolution must be standalone (cannot also reject)');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set entity_id = fo_t.eid('IEA'), entity_resolution_note = 'ok note', supplier_bill_id = '91000000-0000-4000-8000-000000000001' where intake_id = 'ti_res_u1'$q$), 'standalone|row-level security', 'resolution must be standalone (cannot also link a bill)');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set entity_id = fo_t.eid('IEA'), entity_resolution_note = 'x' where intake_id = 'ti_res_u1'$q$), 'resolution note is required|fis_resolution_note', 'a too-short note is rejected');
select fo_t.exec($q$update public.finance_intake_submissions set entity_id = fo_t.eid('IEA'), entity_resolution_note = 'Confirmed from invoice letterhead', entity_resolved_by = '10000000-0000-4000-8000-000000000005', entity_resolved_at = '2000-01-01' where intake_id = 'ti_res_u1'$q$);
reset role;
select extensions.is((fo_t.scalar($q$select (entity_id = fo_t.eid('IEA'))::text from public.finance_intake_submissions where intake_id = 'ti_res_u1'$q$))::text, 'true', 'Finance Staff resolved to an accessible approved entity');
select extensions.is((fo_t.scalar($q$select entity_resolved_by from public.finance_intake_submissions where intake_id = 'ti_res_u1'$q$))::text, '10000000-0000-4000-8000-000000000003', 'resolver is the authenticated user (client-supplied value overwritten)');
select extensions.ok((fo_t.scalar($q$select entity_resolved_at > now() - interval '1 hour' from public.finance_intake_submissions where intake_id = 'ti_res_u1'$q$))::boolean, 'resolution time is server time (client-supplied value overwritten)');
select extensions.is((fo_t.scalar($q$select process_state from public.finance_intake_submissions where intake_id = 'ti_res_u1'$q$))::text, 'received', 'state moves to ''received'' after resolution');
select extensions.is((fo_t.scalar($q$select intake_id || '/' || payload_hash from public.finance_intake_submissions where intake_id = 'ti_res_u1'$q$))::text, 'ti_res_u1/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'the original intake_id and hash are untouched');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000002', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set entity_id = fo_t.eid('PLC') where intake_id = 'ti_res_u1'$q$), 'cannot be changed once set', 'entity resolution is set-once (cannot be changed afterwards)');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set entity_resolution_note = 'rewritten history' where intake_id = 'ti_res_u1'$q$), 'cannot be changed once set', 'resolution trail is immutable');
select fo_t.exec($q$update public.finance_intake_submissions set entity_id = fo_t.eid('KALER'), entity_resolution_note = 'Finance Manager resolution (no AAL2 needed)' where intake_id = 'ti_res_u2'$q$);
reset role;
select extensions.is((fo_t.scalar($q$select (entity_id = fo_t.eid('KALER'))::text from public.finance_intake_submissions where intake_id = 'ti_res_u2'$q$))::text, 'true', 'Finance Manager resolved WITHOUT AAL2 (Q6)');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000004', 'aal1'); set local role authenticated;
select fo_t.exec($q$update public.finance_intake_submissions set entity_id = fo_t.eid('KALER'), entity_resolution_note = 'Finance Staff with KALER access' where intake_id = 'ti_res_u3'$q$);
reset role;
select extensions.is((fo_t.scalar($q$select (entity_id = fo_t.eid('KALER'))::text from public.finance_intake_submissions where intake_id = 'ti_res_u3'$q$))::text, 'true', 'Finance Staff resolves to an entity they DO have access to');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000001', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set entity_id = fo_t.eid('ZZZ'), entity_resolution_note = 'not approved' where intake_id = 'ti_res_u5'$q$), 'approved entities', 'Owner cannot resolve to a non-approved entity (ZZZ)');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000003', 'aal1'); set local role authenticated;
select fo_t.exec($q$update public.finance_intake_submissions set review_status = 'rejected', review_note = 'Not one of our invoices' where intake_id = 'ti_res_u4'$q$);
reset role;
select extensions.is((fo_t.scalar($q$select review_status from public.finance_intake_submissions where intake_id = 'ti_res_u4'$q$))::text, 'rejected', 'Q7: an invalid unresolved intake can be rejected without assigning an entity');
select extensions.is((fo_t.scalar($q$select (entity_id is null)::text from public.finance_intake_submissions where intake_id = 'ti_res_u4'$q$))::text, 'true', 'rejected unresolved intake keeps a NULL entity');
select extensions.is((fo_t.scalar($q$select reviewed_by from public.finance_intake_submissions where intake_id = 'ti_res_u4'$q$))::text, '10000000-0000-4000-8000-000000000003', 'reviewer is recorded server-side');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000002', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set entity_id = fo_t.eid('IEA'), entity_resolution_note = 'too late' where intake_id = 'ti_res_u4'$q$), 'cannot be changed', 'a rejected unresolved intake cannot be resolved afterwards (terminal)');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set review_status = 'rejected' where intake_id = 'ti_res_u6'$q$), 'can only flag|cannot', 'the FinanceOps identity cannot reject an intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000003', 'aal1'); set local role authenticated;
select extensions.ok(fo_t.upd($q$update public.finance_intake_submissions set review_status = 'needs_attention' where intake_id = 'ti_res_u6'$q$) = 1, 'reject of an unresolved intake does not require entity access');

-- ==========================================================================================
-- 5. SUPERSESSION (D10 path 2): lineage, one successor, race-safe rules
-- ==========================================================================================
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal1'); set local role authenticated;
select fo_t.ins('ti_sup_u5', null, '6666666666666666666666666666666666666666666666666666666666666666', null, null);
select fo_t.ins('ti_sup_u6', null, '6666666666666666666666666666666666666666666666666666666666666666', null, null);
select fo_t.ins('ti_sup_u8', null, '6666666666666666666666666666666666666666666666666666666666666666', null, null);
select fo_t.ins('ti_sup_u9', null, '6666666666666666666666666666666666666666666666666666666666666666', null, null);
select fo_t.ins('ti_sup_u10', null, '6666666666666666666666666666666666666666666666666666666666666666', null, null);
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000003', 'aal1'); set local role authenticated;
select fo_t.exec($q$update public.finance_intake_submissions set review_status = 'rejected', review_note = 'junk' where intake_id = 'ti_sup_u6'$q$);
select fo_t.exec($q$update public.finance_intake_submissions set entity_id = fo_t.eid('IEA'), entity_resolution_note = 'resolved by reviewer first' where intake_id = 'ti_sup_u8'$q$);
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal1'); set local role authenticated;
select fo_t.ins('ti_sup_s5', 'IEA', '6666666666666666666666666666666666666666666666666666666666666666', 'ti_sup_u5', null);
reset role;
select extensions.is((fo_t.scalar($q$select supersedes_intake_id from public.finance_intake_submissions where intake_id = 'ti_sup_s5'$q$))::text, 'ti_sup_u5', 'a new resolved intake supersedes the unresolved original');
select extensions.is((fo_t.scalar($q$select (entity_id is null)::text || '/' || process_state || '/' || review_status from public.finance_intake_submissions where intake_id = 'ti_sup_u5'$q$))::text, 'true/awaiting_entity/pending_review', 'the original row is untouched (still unresolved, same state)');
select extensions.ok((fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id in ('ti_sup_u5','ti_sup_s5')$q$))::int = 2, 'lineage retained: both rows exist');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$select fo_t.ins('ti_sup_s5b', 'IEA', '6666666666666666666666666666666666666666666666666666666666666666', 'ti_sup_u5', null)$q$), 'fis_supersedes_uidx|duplicate key', 'only ONE successor per original (unique index)');
select extensions.matches(fo_t.err($q$select fo_t.ins('ti_sup_s9n', null, '6666666666666666666666666666666666666666666666666666666666666666', 'ti_sup_u9', null)$q$), 'fis_supersede_has_entity', 'a superseding intake must carry its entity');
select extensions.matches(fo_t.err($q$select fo_t.ins('ti_sup_s8', 'IEA', '6666666666666666666666666666666666666666666666666666666666666666', 'ti_sup_u8', null)$q$), 'intake_already_resolved', 'a resolved original cannot be superseded');
select extensions.matches(fo_t.err($q$select fo_t.ins('ti_sup_s6', 'IEA', '6666666666666666666666666666666666666666666666666666666666666666', 'ti_sup_u6', null)$q$), 'rejected intake cannot be superseded', 'a rejected original cannot be superseded');
select extensions.matches(fo_t.err($q$select fo_t.ins('ti_sup_sx1', 'IEA', '6666666666666666666666666666666666666666666666666666666666666666', 'does_not_exist', null)$q$), 'was not found|violates foreign key', 'superseding a non-existent intake is rejected');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000007', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$select fo_t.ins('ti_sup_s9o', 'IEA', '6666666666666666666666666666666666666666666666666666666666666666', 'ti_sup_u9', null)$q$), 'Only the originating FinanceOps identity|was not found', 'a different FinanceOps identity cannot supersede someone else''s intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal1'); set local role authenticated;
select fo_t.ins('ti_sup_s10', 'PLC', '6666666666666666666666666666666666666666666666666666666666666666', 'ti_sup_u10', null);
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000003', 'aal1'); set local role authenticated;
select extensions.ok((fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_sup_s10'$q$))::int = 0, 'Finance Staff (no PLC access) cannot see the PLC successor');
select extensions.is((fo_t.scalar($q$select is_superseded::text from public.finance_intake_queue where intake_id = 'ti_sup_u10'$q$))::text, 'true', '...yet the original shows as superseded (definer helper, not RLS-hidden)');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set entity_id = fo_t.eid('IEA'), entity_resolution_note = 'attempt after supersede' where intake_id = 'ti_sup_u10'$q$), 'intake_already_resolved', 'a superseded intake cannot then be resolved by a reviewer');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000005', 'aal1'); set local role authenticated;
select extensions.ok(app_private.intake_is_superseded('ti_sup_u10'), 'helper intake_is_superseded works for finance roles (intern)');
reset role; select fo_t.claim('10000000-0000-4000-8000-00000000000a', 'aal1'); set local role authenticated;
select extensions.ok(not app_private.intake_is_superseded('ti_sup_u10'), 'helper intake_is_superseded answers FALSE to non-finance roles (no existence oracle)');
reset role; select fo_t.claim(null, 'aal1'); set local role anon;
select extensions.matches(fo_t.err($q$select app_private.intake_is_superseded('ti_sup_u10')$q$), 'permission denied', 'anonymous cannot execute the superseded helper');
reset role;
select extensions.ok((fo_t.scalar($q$select count(*) from public.audit_logs where action = 'financeops_intake_superseded' and payload->>'new_intake_id' = 'ti_sup_s5'$q$))::int = 1, 'audit: superseded event exists');
select extensions.ok((fo_t.scalar($q$select count(*) from public.audit_logs where action = 'financeops_intake_superseded_by' and payload->>'intake_id' = 'ti_sup_u5'$q$))::int = 1, 'audit: superseded_by event exists on the original');

-- ==========================================================================================
-- 6. RECORD LINKS: same entity, draft only, original file, set once, forward-only state
-- ==========================================================================================
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal1'); set local role authenticated;
select fo_t.ins('ti_lnk_01', 'IEA', '1111111111111111111111111111111111111111111111111111111111111111', null, null);
select fo_t.ins('ti_lnk_02', 'IEA', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', null, null);
select fo_t.ins('ti_lnk_03', 'IEA', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', null, null);
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set supplier_bill_id = '91000000-0000-4000-8000-000000000003' where intake_id = 'ti_lnk_01'$q$), 'different entity', 'cross-entity bill is rejected');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set supplier_bill_id = '91000000-0000-4000-8000-000000000004' where intake_id = 'ti_lnk_01'$q$), 'draft supplier bill', 'non-draft bill is rejected');
select fo_t.exec($q$update public.finance_intake_submissions set supplier_bill_id = '91000000-0000-4000-8000-000000000001', process_state = 'bill_created' where intake_id = 'ti_lnk_01'$q$);
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set supplier_bill_id = '91000000-0000-4000-8000-000000000002' where intake_id = 'ti_lnk_01'$q$), 'set once', 'a bill link can only be set once (relink)');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set supplier_bill_id = null where intake_id = 'ti_lnk_01'$q$), 'set once', 'a bill link cannot be cleared by the client');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set document_id = '92000000-0000-4000-8000-000000000002' where intake_id = 'ti_lnk_01'$q$), 'original file', 'wrong document hash is rejected');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set document_id = '92000000-0000-4000-8000-000000000003' where intake_id = 'ti_lnk_01'$q$), 'original file', 'cross-entity document with the right hash is rejected');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set process_state = 'complete' where intake_id = 'ti_lnk_01'$q$), 'requires a linked document', 'process_state cannot jump to complete without a document');
select fo_t.exec($q$update public.finance_intake_submissions set document_id = '92000000-0000-4000-8000-000000000001', process_state = 'complete' where intake_id = 'ti_lnk_01'$q$);
reset role;
select extensions.is((fo_t.scalar($q$select process_state || '/' || (supplier_bill_id is not null)::text || '/' || (document_id is not null)::text from public.finance_intake_submissions where intake_id = 'ti_lnk_01'$q$))::text, 'complete/true/true', 'valid links accepted; state complete');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set document_id = '92000000-0000-4000-8000-000000000002' where intake_id = 'ti_lnk_01'$q$), 'set once|original file', 'a document link can only be set once');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set process_state = 'received' where intake_id = 'ti_lnk_01'$q$), 'only move forward', 'process_state cannot move backwards');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set process_state = 'awaiting_entity' where intake_id = 'ti_lnk_01'$q$), 'only move forward|fis_awaiting_entity_state', 'process_state cannot return to awaiting_entity');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set supplier_bill_id = '91000000-0000-4000-8000-000000000001' where intake_id = 'ti_lnk_02'$q$), 'fis_supplier_bill_uidx|duplicate key', 'one bill cannot be linked to two intakes (unique)');
select fo_t.exec($q$update public.finance_intake_submissions set supplier_bill_id = '91000000-0000-4000-8000-000000000011', process_state = 'bill_created' where intake_id = 'ti_lnk_03'$q$);
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set process_state = 'complete' where intake_id = 'ti_lnk_03'$q$), 'requires a linked document', 'complete requires the document link');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set document_id = '92000000-0000-4000-8000-000000000001' where intake_id = 'ti_lnk_02'$q$), 'original file|fis_document_uidx|duplicate key', 'one document cannot be linked to two intakes (unique)');

-- ==========================================================================================
-- 7. REVIEW: data_verified invariants, four-eyes, terminal states, Q5 (never changes the bill)
-- ==========================================================================================
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal1'); set local role authenticated;
select fo_t.ins('ti_rev_01', 'IEA', '2222222222222222222222222222222222222222222222222222222222222222', null, null);
select fo_t.exec($q$update public.finance_intake_submissions set supplier_bill_id = '91000000-0000-4000-8000-000000000005', process_state = 'bill_created' where intake_id = 'ti_rev_01'$q$);
select fo_t.exec($q$update public.finance_intake_submissions set document_id = '92000000-0000-4000-8000-000000000004', process_state = 'complete' where intake_id = 'ti_rev_01'$q$);
select fo_t.ins('ti_rev_02', 'IEA', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', null, null);
select fo_t.exec($q$update public.finance_intake_submissions set supplier_bill_id = '91000000-0000-4000-8000-000000000006', process_state = 'bill_created' where intake_id = 'ti_rev_02'$q$);
select fo_t.exec($q$update public.finance_intake_submissions set document_id = '92000000-0000-4000-8000-000000000005' where intake_id = 'ti_rev_02'$q$);
select fo_t.ins('ti_rev_03', 'IEA', '6666666666666666666666666666666666666666666666666666666666666666', null, null);
select fo_t.ins('ti_rev_04', 'IEA', '6666666666666666666666666666666666666666666666666666666666666666', null, null);
select fo_t.ins('ti_rev_05', 'IEA', '6666666666666666666666666666666666666666666666666666666666666666', null, null);
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set review_status = 'data_verified' where intake_id = 'ti_rev_01'$q$), 'can only flag', 'the FinanceOps identity cannot data-verify its own intake');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set review_status = 'rejected' where intake_id = 'ti_rev_01'$q$), 'can only flag', 'the FinanceOps identity cannot reject its own intake');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set review_note = 'self approval', reviewed_by = '10000000-0000-4000-8000-000000000006' where intake_id = 'ti_rev_01'$q$), 'cannot review its own', 'the FinanceOps identity cannot write review fields');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000007', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set review_status = 'data_verified' where intake_id = 'ti_rev_01'$q$), 'cannot perform human review', 'a SECOND FinanceOps identity cannot review the first one''s intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000005', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set review_status = 'data_verified' where intake_id = 'ti_rev_03'$q$), 'linked', 'data_verified needs the linked bill AND document');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set review_status = 'data_verified' where intake_id = 'ti_rev_02'$q$), 'process_state is complete', 'data_verified needs process_state = complete (trigger message)');
reset role;
select extensions.matches(fo_t.err($q$do $x$ begin alter table public.finance_intake_submissions disable trigger fis_enforce_rules; update public.finance_intake_submissions set review_status = 'data_verified', reviewed_at = now() where intake_id = 'ti_rev_02'; end $x$$q$), 'fis_data_verified_needs_complete', 'declarative CHECK: data_verified => process_state = ''complete'' (trigger disabled to prove the constraint itself)');
select extensions.matches(fo_t.err($q$do $x$ begin alter table public.finance_intake_submissions disable trigger fis_enforce_rules; update public.finance_intake_submissions set review_status = 'data_verified', reviewed_at = now(), process_state = 'complete' where intake_id = 'ti_res_u6'; end $x$$q$), 'fis_data_verified_needs_review|fis_awaiting_entity_state|fis_no_records_without_entity', 'declarative CHECK: data_verified requires an entity');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000005', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set flags = array['edited'] where intake_id = 'ti_rev_05'$q$), 'cannot be edited', 'flags are a record of what FinanceOps reported and cannot be edited by humans');
select extensions.matches(fo_t.err($q$do $x$ begin update public.finance_intake_submissions set review_status = 'needs_attention' where intake_id = 'ti_rev_04'; update public.finance_intake_submissions set review_status = 'duplicate_suspected' where intake_id = 'ti_rev_04'; end $x$$q$), 'Invalid review status transition', 'invalid transition rejected (pending_review -> pending_review no-op is fine; needs_attention -> duplicate_suspected is not)');
select fo_t.exec($q$update public.finance_intake_submissions set review_status = 'data_verified', review_note = 'Checked against the original invoice', reviewed_by = '10000000-0000-4000-8000-000000000001' where intake_id = 'ti_rev_01'$q$);
reset role;
select extensions.is((fo_t.scalar($q$select review_status from public.finance_intake_submissions where intake_id = 'ti_rev_01'$q$))::text, 'data_verified', 'the intern data-verified a complete intake');
select extensions.is((fo_t.scalar($q$select reviewed_by from public.finance_intake_submissions where intake_id = 'ti_rev_01'$q$))::text, '10000000-0000-4000-8000-000000000005', 'reviewed_by is the authenticated reviewer (client value overwritten)');
select extensions.ok((fo_t.scalar($q$select reviewed_at is not null from public.finance_intake_submissions where intake_id = 'ti_rev_01'$q$))::boolean, 'reviewed_at is set');
select extensions.is((fo_t.scalar($q$select payment_status from public.supplier_bills where id = '91000000-0000-4000-8000-000000000005'$q$))::text, 'draft', 'Q5: data_verified did NOT change the Supplier Bill payment status');
select extensions.ok((fo_t.scalar($q$select count(*) from public.audit_logs where action = 'financeops_intake_data_verified' and payload->>'intake_id' = 'ti_rev_01'$q$))::int = 1, 'audit: data_verified recorded');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000005', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set review_note = 'rewrite' where intake_id = 'ti_rev_01'$q$), 'cannot be changed', 'terminal: a data_verified intake cannot be edited');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000002', 'aal2'); set local role authenticated;
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set review_status = 'rejected' where intake_id = 'ti_rev_01'$q$), 'cannot be changed', 'terminal: not even a Finance Manager can reject a data_verified intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set process_state = 'complete' where intake_id = 'ti_rev_01'$q$), 'cannot be changed', 'terminal: the FinanceOps identity cannot touch a data_verified intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000005', 'aal1'); set local role authenticated;
select fo_t.exec($q$update public.finance_intake_submissions set review_status = 'rejected', review_note = 'Wrong supplier' where intake_id = 'ti_rev_03'$q$);
reset role;
select extensions.is((fo_t.scalar($q$select review_status from public.finance_intake_submissions where intake_id = 'ti_rev_03'$q$))::text, 'rejected', 'an intern can reject a resolved intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal1'); set local role authenticated;
select fo_t.exec($q$update public.finance_intake_submissions set review_status = 'needs_attention' where intake_id = 'ti_rev_04'$q$);
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000005', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set review_status = 'duplicate_suspected' where intake_id = 'ti_rev_04'$q$), 'Invalid review status transition', 'needs_attention -> duplicate_suspected is an invalid transition');

-- ==========================================================================================
-- 8. KILL SWITCH: a deactivated FinanceOps identity is frozen on its own rows
-- ==========================================================================================
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000007', 'aal1'); set local role authenticated;
select fo_t.ins('ti_ks_01', 'IEA', '6666666666666666666666666666666666666666666666666666666666666666', null, null);
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000001', 'aal2'); set local role authenticated;
select fo_t.exec($q$update public.finance_integration_identities set active_status = false where user_id = '10000000-0000-4000-8000-000000000007'$q$);
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000007', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set review_status = 'needs_attention' where intake_id = 'ti_ks_01'$q$), 'no longer active', 'a deactivated identity cannot advance its own intake');
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set review_status = 'rejected' where intake_id = 'ti_ks_01'$q$), 'no longer active', 'a deactivated identity cannot act through the human-review path either');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000001', 'aal2'); set local role authenticated;
select fo_t.exec($q$update public.finance_integration_identities set active_status = true where user_id = '10000000-0000-4000-8000-000000000007'$q$);

-- ==========================================================================================
-- 9. FK SET NULL CASCADES (Q8): supported deletions clear links only; the intake and lineage remain
-- ==========================================================================================
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal1'); set local role authenticated;
select fo_t.ins('ti_cas_01', 'IEA', '3333333333333333333333333333333333333333333333333333333333333333', null, null);
select fo_t.exec($q$update public.finance_intake_submissions set supplier_bill_id = '91000000-0000-4000-8000-000000000007', process_state = 'bill_created' where intake_id = 'ti_cas_01'$q$);
select fo_t.exec($q$update public.finance_intake_submissions set document_id = '92000000-0000-4000-8000-000000000006', process_state = 'complete' where intake_id = 'ti_cas_01'$q$);
select fo_t.ins('ti_cas_02', 'IEA', '4444444444444444444444444444444444444444444444444444444444444444', null, null);
select fo_t.exec($q$update public.finance_intake_submissions set supplier_bill_id = '91000000-0000-4000-8000-000000000008', process_state = 'bill_created' where intake_id = 'ti_cas_02'$q$);
select fo_t.exec($q$update public.finance_intake_submissions set document_id = '92000000-0000-4000-8000-000000000007', process_state = 'complete' where intake_id = 'ti_cas_02'$q$);
select fo_t.ins('ti_cas_03', 'IEA', '5555555555555555555555555555555555555555555555555555555555555555', null, null);
select fo_t.exec($q$update public.finance_intake_submissions set supplier_bill_id = '91000000-0000-4000-8000-000000000009', process_state = 'bill_created' where intake_id = 'ti_cas_03'$q$);
select fo_t.exec($q$update public.finance_intake_submissions set document_id = '92000000-0000-4000-8000-000000000008', process_state = 'complete' where intake_id = 'ti_cas_03'$q$);
reset role;
create temp table cas_before as select intake_id, md5(to_jsonb(s)::text) as full_md5, md5((to_jsonb(s) - array['supplier_bill_id','document_id','reviewed_by','entity_resolved_by','created_by','updated_at'])::text) as rest_md5 from public.finance_intake_submissions s where intake_id in ('ti_cas_01','ti_cas_03');
reset role;
select fo_t.exec($q$delete from public.supplier_bills where id = '91000000-0000-4000-8000-000000000007'$q$);
select extensions.ok((fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_cas_01'$q$))::int = 1, 'administrative deletion of the linked draft bill keeps the intake');
select extensions.is((fo_t.scalar($q$select (supplier_bill_id is null)::text || '/' || (document_id is not null)::text from public.finance_intake_submissions where intake_id = 'ti_cas_01'$q$))::text, 'true/true', '...and clears ONLY the bill link');
select extensions.ok((select rest_md5 from cas_before where intake_id = 'ti_cas_01') = fo_t.scalar($q$select md5((to_jsonb(s) - array['supplier_bill_id','document_id','reviewed_by','entity_resolved_by','created_by','updated_at'])::text) from public.finance_intake_submissions s where intake_id = 'ti_cas_01'$q$), '...changing nothing else on the row');
select extensions.ok((fo_t.scalar($q$select count(*) from public.audit_logs where action = 'financeops_intake_bill_link_cleared' and payload->>'intake_id' = 'ti_cas_01'$q$))::int = 1, 'audit: bill_link_cleared recorded');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000002', 'aal2'); set local role authenticated;
select fo_t.exec($q$select public.delete_document_metadata('92000000-0000-4000-8000-000000000008', 'Incorrectly uploaded file (test)')$q$);
reset role;
select extensions.ok((fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_cas_03'$q$))::int = 1, 'deleting the document (supported RPC, Finance Manager + AAL2) keeps the intake');
select extensions.is((fo_t.scalar($q$select (document_id is null)::text || '/' || (supplier_bill_id is not null)::text from public.finance_intake_submissions where intake_id = 'ti_cas_03'$q$))::text, 'true/true', '...and clears ONLY the document link');
select extensions.ok((select rest_md5 from cas_before where intake_id = 'ti_cas_03') = fo_t.scalar($q$select md5((to_jsonb(s) - array['supplier_bill_id','document_id','reviewed_by','entity_resolved_by','created_by','updated_at'])::text) from public.finance_intake_submissions s where intake_id = 'ti_cas_03'$q$), '...changing nothing else on the row');
select extensions.ok((fo_t.scalar($q$select count(*) from public.audit_logs where action = 'financeops_intake_document_link_cleared' and payload->>'intake_id' = 'ti_cas_03'$q$))::int = 1, 'audit: document_link_cleared recorded');
reset role; select fo_t.claim('10000000-0000-4000-8000-00000000000d', 'aal1'); set local role authenticated;
select fo_t.exec($q$update public.finance_intake_submissions set review_status = 'data_verified', review_note = 'verified by a temporary reviewer' where intake_id = 'ti_cas_02'$q$);
reset role;
select extensions.is((fo_t.scalar($q$select review_status from public.finance_intake_submissions where intake_id = 'ti_cas_02'$q$))::text, 'data_verified', 'setup: temporary reviewer data-verified an intake');
create temp table cas_actor_before as select md5((to_jsonb(s) - array['reviewed_by','updated_at'])::text) as m from public.finance_intake_submissions s where intake_id = 'ti_cas_02';
delete from auth.users where id = '10000000-0000-4000-8000-00000000000d';
select extensions.ok((fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_cas_02'$q$))::int = 1, 'deleting the reviewer''s auth user keeps the intake');
select extensions.is((fo_t.scalar($q$select (reviewed_by is null)::text || '/' || review_status || '/' || (reviewed_at is not null)::text from public.finance_intake_submissions where intake_id = 'ti_cas_02'$q$))::text, 'true/data_verified/true', '...clears ONLY the reviewed_by reference');
select extensions.ok((select m from cas_actor_before) = fo_t.scalar($q$select md5((to_jsonb(s) - array['reviewed_by','updated_at'])::text) from public.finance_intake_submissions s where intake_id = 'ti_cas_02'$q$), '...changing nothing else on the row');
reset role; select fo_t.claim('10000000-0000-4000-8000-00000000000e', 'aal1'); set local role authenticated;
select fo_t.ins('ti_cas_04', 'IEA', '6666666666666666666666666666666666666666666666666666666666666666', null, null);
reset role;
create temp table cas_fo3_before as select md5((to_jsonb(s) - array['created_by','updated_at'])::text) as m from public.finance_intake_submissions s where intake_id = 'ti_cas_04';
delete from auth.users where id = '10000000-0000-4000-8000-00000000000e';
select extensions.ok((fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_cas_04'$q$))::int = 1, 'deleting a FinanceOps identity''s auth user keeps its intakes');
select extensions.ok((fo_t.scalar($q$select created_by is null from public.finance_intake_submissions where intake_id = 'ti_cas_04'$q$))::boolean, '...clears ONLY created_by');
select extensions.ok((select m from cas_fo3_before) = fo_t.scalar($q$select md5((to_jsonb(s) - array['created_by','updated_at'])::text) from public.finance_intake_submissions s where intake_id = 'ti_cas_04'$q$), '...changing nothing else on the row');
select extensions.is((fo_t.scalar($q$select count(*) from public.finance_integration_identities where user_id = '10000000-0000-4000-8000-00000000000e'$q$))::text, '0', '...and its registry row is removed (cascade)');

-- ==========================================================================================
-- 10. AUDIT: events written by the database, actor from the authenticated user, fail-closed
-- ==========================================================================================
reset role;
select extensions.is((fo_t.scalar($q$select count(*) from public.audit_logs where action = 'financeops_intake_received' and payload->>'intake_id' = 'ti_ins_iea_01'$q$))::text, '1', 'audit: received event written for an insert');
select extensions.is((fo_t.scalar($q$select actor_user_id from public.audit_logs where action = 'financeops_intake_received' and payload->>'intake_id' = 'ti_ins_iea_01'$q$))::text, '10000000-0000-4000-8000-000000000006', 'audit: received event actor is the authenticated FinanceOps identity');
select extensions.is((fo_t.scalar($q$select count(*) from public.audit_logs where action = 'financeops_intake_entity_resolved' and payload->>'intake_id' = 'ti_res_u1'$q$))::text, '1', 'audit: entity_resolved event written');
select extensions.is((fo_t.scalar($q$select actor_user_id from public.audit_logs where action = 'financeops_intake_entity_resolved' and payload->>'intake_id' = 'ti_res_u1'$q$))::text, '10000000-0000-4000-8000-000000000003', 'audit: entity_resolved actor is the reviewer (not client input)');
select extensions.is((fo_t.scalar($q$select (before_data->>'entity_id' is null)::text || '/' || (after_data->>'entity_id' = fo_t.eid('IEA')::text)::text from public.audit_logs where action = 'financeops_intake_entity_resolved' and payload->>'intake_id' = 'ti_res_u1'$q$))::text, 'true/true', 'audit: entity_resolved carries before (null) and after (entity)');
select extensions.is((fo_t.scalar($q$select count(*) from public.audit_logs where action = 'financeops_intake_rejected' and payload->>'intake_id' = 'ti_res_u4'$q$))::text, '1', 'audit: rejected event for the unresolved junk intake');
select extensions.is((fo_t.scalar($q$select (entity_id is null)::text from public.audit_logs where action = 'financeops_intake_rejected' and payload->>'intake_id' = 'ti_res_u4'$q$))::text, 'true', 'audit: unresolved events carry a NULL entity_id');
select extensions.is((fo_t.scalar($q$select count(*) from public.audit_logs where action in ('financeops_intake_linked_bill','financeops_intake_linked_document') and payload->>'intake_id' = 'ti_lnk_01'$q$))::text, '2', 'audit: linked_bill and linked_document events exist');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000003', 'aal1'); set local role authenticated;
select extensions.is((fo_t.scalar($q$select count(*) from public.audit_logs where action = 'financeops_intake_received' and payload->>'intake_id' = 'ti_ins_nul_01'$q$))::text, '0', 'audit visibility: Finance Staff cannot read audit rows of an UNRESOLVED intake (entity_id NULL; only Owner/actor can)');
select extensions.is((fo_t.scalar($q$select count(*) from public.audit_logs where action = 'financeops_intake_received' and payload->>'intake_id' = 'ti_ins_iea_01'$q$))::text, '1', 'audit visibility: Finance Staff reads audit rows of an entity they can access');
select extensions.is((fo_t.scalar($q$select count(*) from public.audit_logs where action = 'financeops_intake_received' and payload->>'intake_id' = 'ti_ins_plc_01'$q$))::text, '0', 'audit visibility: ...but not another entity''s');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000001', 'aal1'); set local role authenticated;
select extensions.is((fo_t.scalar($q$select count(*) from public.audit_logs where action = 'financeops_intake_received' and payload->>'intake_id' = 'ti_ins_nul_01'$q$))::text, '1', 'audit visibility: Owner reads the unresolved intake''s audit row');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal1'); set local role authenticated;
select extensions.is((fo_t.scalar($q$select count(*) from public.audit_logs where action = 'financeops_intake_received' and payload->>'intake_id' = 'ti_ins_nul_01'$q$))::text, '1', 'audit visibility: the acting FinanceOps identity reads its own audit rows');
reset role;
create function fo_t.audit_blocker() returns trigger language plpgsql as $$ begin if new.action = current_setting('fo.block_action', true) then raise exception 'audit blocked for test'; end if; return new; end $$;
create trigger fo_t_block before insert on public.audit_logs for each row execute function fo_t.audit_blocker();
select set_config('fo.block_action', 'financeops_intake_received', true);
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$select fo_t.ins('ti_aud_f01', 'IEA', '6666666666666666666666666666666666666666666666666666666666666666', null, null)$q$), 'audit blocked for test', 'fail-closed: a failing audit insert aborts the intake INSERT');
reset role;
select extensions.is((fo_t.scalar($q$select count(*) from public.finance_intake_submissions where intake_id = 'ti_aud_f01'$q$))::text, '0', 'fail-closed: the intake row was not created');
select set_config('fo.block_action', 'financeops_intake_rejected', true);
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000003', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$update public.finance_intake_submissions set review_status = 'rejected' where intake_id = 'ti_res_u7'$q$), 'audit blocked for test', 'fail-closed: a failing audit insert aborts the review UPDATE');
reset role;
select extensions.is((fo_t.scalar($q$select review_status from public.finance_intake_submissions where intake_id = 'ti_res_u7'$q$))::text, 'pending_review', 'fail-closed: the review change was not applied');
select set_config('fo.block_action', '', true);
drop trigger fo_t_block on public.audit_logs;

-- ==========================================================================================
-- 11. NO DELETE PATH (Q9)
-- ==========================================================================================
reset role;
select extensions.ok(not has_table_privilege('authenticated', 'public.finance_intake_submissions', 'DELETE'), 'authenticated has no DELETE privilege on intakes');
select extensions.ok(not has_table_privilege('authenticated', 'public.finance_intake_submissions', 'TRUNCATE'), 'authenticated has no TRUNCATE privilege on intakes');
select extensions.ok(not has_table_privilege('anon', 'public.finance_intake_submissions', 'SELECT') and not has_table_privilege('anon', 'public.finance_integration_identities', 'SELECT'), 'anon has no privilege at all on intakes or the registry');
select extensions.is((fo_t.scalar($q$select count(*) from pg_policies where tablename = 'finance_intake_submissions' and cmd = 'DELETE'$q$))::text, '0', 'there is no DELETE policy on intakes');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000001', 'aal2'); set local role authenticated;
select extensions.matches(fo_t.err($q$delete from public.finance_intake_submissions where intake_id = 'ti_ins_iea_01'$q$), 'permission denied', 'even the Owner (AAL2) cannot delete an intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000002', 'aal2'); set local role authenticated;
select extensions.matches(fo_t.err($q$delete from public.finance_intake_submissions where true$q$), 'permission denied', 'a Finance Manager (AAL2) cannot delete an intake');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$delete from public.finance_intake_submissions where intake_id = 'ti_ins_iea_01'$q$), 'permission denied', 'the FinanceOps identity cannot delete an intake');
select extensions.matches(fo_t.err($q$truncate public.finance_intake_submissions$q$), 'permission denied', 'the FinanceOps identity cannot truncate');
select extensions.ok(fo_t.upd($q$delete from public.finance_integration_identities where user_id = '10000000-0000-4000-8000-000000000006'$q$) = 0, 'the FinanceOps identity cannot delete its registry row');
select extensions.ok((fo_t.scalar($q$select count(*) from public.finance_integration_identities$q$))::int = 1, 'the FinanceOps identity deleted no registry row');

-- ==========================================================================================
-- 12. STAGE 1B GUARD RAILS for the FinanceOps identity (data_entry, no AAL2) - including a forged aal2 claim
-- ==========================================================================================
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$update public.supplier_bills set payment_status = 'unpaid' where id = '91000000-0000-4000-8000-000000000010'$q$), 'only maintain bill drafts', 'FinanceOps cannot move a draft bill to unpaid');
select extensions.matches(fo_t.err($q$update public.supplier_bills set payment_status = 'paid' where id = '91000000-0000-4000-8000-000000000010'$q$), 'only maintain bill drafts|MFA assurance level 2|Only Owner or Finance Manager', 'FinanceOps cannot mark a bill paid');
select extensions.matches(fo_t.err($q$insert into public.supplier_bills (entity_id, description, due_date, total_amount, outstanding_amount, payment_status, created_by) values (fo_t.eid('IEA'), 'x', current_date, 5, 5, 'unpaid', auth.uid())$q$), 'row-level security', 'FinanceOps cannot insert a non-draft bill');
select extensions.matches(fo_t.err($q$insert into public.bill_payments (entity_id, supplier_bill_id, amount, created_by) values (fo_t.eid('IEA'), '91000000-0000-4000-8000-000000000010', 5, auth.uid())$q$), 'row-level security', 'FinanceOps cannot insert bill_payments');
select extensions.matches(fo_t.err($q$insert into public.payment_vouchers (entity_id, payee, purpose, total_amount, status, prepared_by) values (fo_t.eid('IEA'), 'x', 'x', 5, 'draft', auth.uid())$q$), 'row-level security', 'FinanceOps cannot create payment vouchers');
select extensions.is((fo_t.scalar($q$select count(*) from public.bank_accounts$q$))::text, '0', 'FinanceOps sees no bank accounts');
select extensions.is((fo_t.scalar($q$select count(*) from public.bank_transactions$q$))::text, '0', 'FinanceOps sees no bank transactions');
select extensions.ok(fo_t.err($q$select public.confirm_bank_reconciliation_allocation(gen_random_uuid(), 'x')$q$) <> 'OK', 'FinanceOps cannot run a reconciliation action');
select extensions.ok(fo_t.err($q$select public.issue_payment_voucher(gen_random_uuid())$q$) <> 'OK', 'FinanceOps cannot issue a voucher');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal2'); set local role authenticated;
select extensions.matches(fo_t.err($q$update public.supplier_bills set payment_status = 'unpaid' where id = '91000000-0000-4000-8000-000000000010'$q$), 'only maintain bill drafts', 'FinanceOps cannot move a draft bill to unpaid (even with an AAL2 claim)');
select extensions.matches(fo_t.err($q$update public.supplier_bills set payment_status = 'paid' where id = '91000000-0000-4000-8000-000000000010'$q$), 'only maintain bill drafts|MFA assurance level 2|Only Owner or Finance Manager', 'FinanceOps cannot mark a bill paid (even with an AAL2 claim)');
select extensions.matches(fo_t.err($q$insert into public.supplier_bills (entity_id, description, due_date, total_amount, outstanding_amount, payment_status, created_by) values (fo_t.eid('IEA'), 'x', current_date, 5, 5, 'unpaid', auth.uid())$q$), 'row-level security', 'FinanceOps cannot insert a non-draft bill (even with an AAL2 claim)');
select extensions.matches(fo_t.err($q$insert into public.bill_payments (entity_id, supplier_bill_id, amount, created_by) values (fo_t.eid('IEA'), '91000000-0000-4000-8000-000000000010', 5, auth.uid())$q$), 'row-level security', 'FinanceOps cannot insert bill_payments (even with an AAL2 claim)');
select extensions.matches(fo_t.err($q$insert into public.payment_vouchers (entity_id, payee, purpose, total_amount, status, prepared_by) values (fo_t.eid('IEA'), 'x', 'x', 5, 'draft', auth.uid())$q$), 'row-level security', 'FinanceOps cannot create payment vouchers (even with an AAL2 claim)');
select extensions.is((fo_t.scalar($q$select count(*) from public.bank_accounts$q$))::text, '0', 'FinanceOps sees no bank accounts (even with an AAL2 claim)');
select extensions.is((fo_t.scalar($q$select count(*) from public.bank_transactions$q$))::text, '0', 'FinanceOps sees no bank transactions (even with an AAL2 claim)');
select extensions.ok(fo_t.err($q$select public.confirm_bank_reconciliation_allocation(gen_random_uuid(), 'x')$q$) <> 'OK', 'FinanceOps cannot run a reconciliation action (even with an AAL2 claim)');
select extensions.ok(fo_t.err($q$select public.issue_payment_voucher(gen_random_uuid())$q$) <> 'OK', 'FinanceOps cannot issue a voucher (even with an AAL2 claim)');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000006', 'aal1'); set local role authenticated;
select extensions.is(fo_t.err($q$insert into public.supplier_bills (entity_id, description, due_date, total_amount, outstanding_amount, payment_status, created_by) values (fo_t.eid('IEA'), 'x', current_date, 5, 5, 'draft', auth.uid())$q$), 'OK', 'sanity: FinanceOps CAN still insert an ordinary DRAFT bill (Stage 1B behaviour unchanged)');
reset role; select fo_t.claim('10000000-0000-4000-8000-000000000005', 'aal1'); set local role authenticated;
select extensions.matches(fo_t.err($q$update public.supplier_bills set payment_status = 'unpaid' where id = '91000000-0000-4000-8000-000000000010'$q$), 'only maintain bill drafts', 'an ordinary intern still cannot move a draft bill to unpaid');

-- ==========================================================================================
-- 13. STRUCTURE: definer settings, privileges, policies, constraints, view
-- ==========================================================================================
reset role;
select extensions.ok((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app_private' and p.proname in ('current_user_can_review_unresolved_intakes','intake_is_superseded') and p.prosecdef and coalesce(array_to_string(p.proconfig, ','),'') like '%search_path=""%') = 2, 'exactly two SECURITY DEFINER functions, both with search_path=''''');
select extensions.ok((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('enforce_finance_intake_rules','audit_finance_intake_change','enforce_finance_integration_identity') and not p.prosecdef and coalesce(array_to_string(p.proconfig, ','),'') like '%search_path=""%') = 3, 'the three trigger functions are SECURITY INVOKER with search_path=''''');
select extensions.ok(not has_function_privilege('anon', 'app_private.current_user_can_review_unresolved_intakes()', 'EXECUTE') and not has_function_privilege('anon', 'app_private.intake_is_superseded(text)', 'EXECUTE'), 'anonymous cannot execute either helper');
select extensions.ok(has_function_privilege('authenticated', 'app_private.current_user_can_review_unresolved_intakes()', 'EXECUTE') and has_function_privilege('authenticated', 'app_private.intake_is_superseded(text)', 'EXECUTE'), 'authenticated can execute both helpers');
select extensions.ok(not has_function_privilege('authenticated', 'public.enforce_finance_intake_rules()', 'EXECUTE') and not has_function_privilege('anon', 'public.audit_finance_intake_change()', 'EXECUTE') and not has_function_privilege('authenticated', 'public.enforce_finance_integration_identity()', 'EXECUTE'), 'trigger functions are not executable by anon or authenticated');
select extensions.is((fo_t.scalar($q$select count(*) from pg_policies where tablename in ('finance_intake_submissions','finance_integration_identities')$q$))::text, '7', 'seven policies on the two new tables');
select extensions.ok((select count(*) from pg_class where relname in ('finance_intake_submissions','finance_integration_identities') and relrowsecurity) = 2, 'RLS enabled on both tables');
select extensions.ok((select coalesce(reloptions::text,'') like '%security_invoker=true%' from pg_class where relname = 'finance_intake_queue'), 'the queue view is security_invoker');
select extensions.ok((select count(*) from pg_constraint where conname in ('fis_data_verified_needs_complete','fis_data_verified_needs_review','fis_no_records_without_entity','fis_awaiting_entity_state','fis_supersede_has_entity','fis_intake_id_key','fii_entities_count','fii_integration_known')) = 8, 'key constraints exist');
select extensions.ok((select count(*) from pg_indexes where indexname in ('fis_supersedes_uidx','fis_supplier_bill_uidx','fis_document_uidx')) = 3, 'one-successor and one-link unique indexes exist');
reset role;
select * from extensions.finish();
rollback;
