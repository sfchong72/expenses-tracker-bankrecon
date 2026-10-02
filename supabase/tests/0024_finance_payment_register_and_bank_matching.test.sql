-- 0024 (Payment Register, bank import, matching) focused pgTAP suite. DISPOSABLE LOCAL DATABASE ONLY.
-- All fixtures are fictional and created inside the transaction, which is rolled back.
-- Requires 0001-0018, 0020, 0021, 0022, 0023 and 0024.
-- Convention: pt.err(q) runs q; a SUCCESS persists (returns 'OK'), a failure is undone and returns the message.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

create schema pt;
revoke all on schema pt from public;
grant usage on schema pt to authenticated, anon;
create function pt.claim(p_user uuid, p_aal text default 'aal1') returns void language plpgsql security invoker set search_path = '' as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', case when p_user is null then 'anon' else 'authenticated' end, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', case when p_user is null then 'anon' else 'authenticated' end, 'aal', p_aal)::text, true);
end $$;
create function pt.err(q text) returns text language plpgsql security invoker set search_path = '' as $$
begin
  begin execute q; return 'OK';
  exception when others then return sqlerrm; end;
end $$;
create function pt.scalar(q text) returns text language plpgsql security invoker set search_path = '' as $$
declare r text; begin execute q into r; return r; end $$;
create function pt.exec(q text) returns void language plpgsql security invoker set search_path = '' as $$
begin execute q; end $$;
create function pt.upd(q text) returns bigint language plpgsql security invoker set search_path = '' as $$
declare n bigint; begin execute q; get diagnostics n = row_count; return n; end $$;
create function pt.eid(c text) returns uuid language sql stable security definer set search_path = '' as $$ select id from public.entities where short_code = c $$;
create function pt.uid(tag text) returns uuid language sql immutable set search_path = '' as $$ select ('00000000-0000-4000-8000-' || substr(md5(tag), 1, 12))::uuid $$;
create function pt.req(t text) returns text[] language sql immutable set search_path = '' as $$
  select case t when 'supplier_expense' then array['invoice', 'payment_evidence'] when 'intern_wage' then array['wage_schedule', 'payment_evidence']
    when 'staff_claim' then array['claim_support', 'payment_evidence'] when 'rent_deposit' then array['agreement', 'payment_evidence'] else array['payment_evidence'] end $$;
-- insert a payment as the CURRENT user (the trigger and RLS see the real actor)
create function pt.mk(p_tag text, p_type text, p_status text, p_code text, p_amount numeric default 100, p_source text default 'manual', p_intake text default null,
                      p_sqlref text default null, p_bill uuid default null, p_method text default 'bank_transfer', p_na boolean default false, p_na_note text default null)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  insert into public.finance_payment_register (id, entity_id, source_type, intake_id, payload_hash, payment_type, supplier_bill_id, payment_instruction_date, payment_method,
    beneficiary_name, beneficiary_account_no, amount, required_documents, status, sql_reference, bank_match_not_applicable, bank_match_na_note, created_by)
  values (pt.uid(p_tag), pt.eid(p_code), p_source, p_intake, case when p_intake is null then null else repeat('a', 64) end, p_type, p_bill, current_date, p_method,
    'Fictional Payee ' || p_tag, '1234567890', p_amount, pt.req(p_type), p_status, p_sqlref, p_na, p_na_note, auth.uid());
end $$;
create function pt.doc(p_tag text, p_pay text, p_code text, p_role text) returns void language plpgsql security invoker set search_path = '' as $$
begin
  insert into public.finance_payment_documents (id, payment_register_id, entity_id, doc_role, storage_path, original_filename, mime_type, file_size, file_hash, uploaded_by)
  values (pt.uid('doc-' || p_tag), pt.uid(p_pay), pt.eid(p_code), p_role, pt.eid(p_code)::text || '/' || p_tag, p_tag || '.pdf', 'application/pdf', 100, md5(p_tag) || md5(p_tag || 'x'), auth.uid());
end $$;
create function pt.batch(p_tag text, p_code text, p_acct text default 'PBB-1234') returns void language plpgsql security invoker set search_path = '' as $$
begin
  insert into public.finance_bank_import_batches (id, entity_id, company_account_ref, filename, file_type, file_hash, total_rows, imported_rows, imported_by)
  values (pt.uid(p_tag), pt.eid(p_code), p_acct, p_tag || '.csv', 'csv', md5(p_tag) || md5(p_tag || 'y'), 10, 10, auth.uid());
end $$;
create function pt.tx(p_tag text, p_batch text, p_code text, p_amount numeric, p_dir text default 'debit', p_n integer default 1, p_acct text default 'PBB-1234') returns void language plpgsql security invoker set search_path = '' as $$
begin
  insert into public.finance_bank_statement_transactions (id, batch_id, entity_id, company_account_ref, row_number, transaction_date, direction, amount, payee_name, fingerprint)
  values (pt.uid(p_tag), pt.uid(p_batch), pt.eid(p_code), p_acct, p_n, current_date, p_dir, p_amount, 'Fictional Payee', md5(p_tag) || md5(p_tag || 'z'));
end $$;
create function pt.match(p_tag text, p_pay text, p_tx text, p_code text, p_status text default 'suggested') returns void language plpgsql security invoker set search_path = '' as $$
begin
  insert into public.finance_payment_bank_matches (id, entity_id, payment_register_id, bank_transaction_id, status, score, reasons)
  values (pt.uid(p_tag), pt.eid(p_code), pt.uid(p_pay), pt.uid(p_tx), p_status, 90, '["exact amount"]'::jsonb);
end $$;
grant execute on all functions in schema pt to authenticated, anon;

-- ==========================================================================================
-- FIXTURES (as postgres)
-- ==========================================================================================
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values
  ('20000000-0000-4000-8000-000000000001', 'own@pay.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('20000000-0000-4000-8000-000000000002', 'fm@pay.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('20000000-0000-4000-8000-000000000003', 'fs@pay.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('20000000-0000-4000-8000-000000000004', 'fs2@pay.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('20000000-0000-4000-8000-000000000005', 'int@pay.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('20000000-0000-4000-8000-000000000006', 'fo@pay.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('20000000-0000-4000-8000-000000000007', 'fo2@pay.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('20000000-0000-4000-8000-000000000008', 'mgt@pay.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('20000000-0000-4000-8000-000000000009', 'ro@pay.invalid', 'authenticated', 'authenticated', '{}', '{}');
update public.app_profiles p set role = v.role, active_status = true, display_name = 'Fictional ' || v.role from (values
  ('20000000-0000-4000-8000-000000000001'::uuid, 'owner'), ('20000000-0000-4000-8000-000000000002'::uuid, 'finance_manager'),
  ('20000000-0000-4000-8000-000000000003'::uuid, 'finance_staff'), ('20000000-0000-4000-8000-000000000004'::uuid, 'finance_staff'),
  ('20000000-0000-4000-8000-000000000005'::uuid, 'data_entry'), ('20000000-0000-4000-8000-000000000006'::uuid, 'data_entry'),
  ('20000000-0000-4000-8000-000000000007'::uuid, 'data_entry'), ('20000000-0000-4000-8000-000000000008'::uuid, 'management'),
  ('20000000-0000-4000-8000-000000000009'::uuid, 'read_only')) v(id, role) where p.id = v.id;
insert into public.user_entity_access (user_id, entity_id, role, active_status) select v.u, e.id, v.r, true from (values
  ('20000000-0000-4000-8000-000000000002'::uuid, 'IEA', 'finance_manager'), ('20000000-0000-4000-8000-000000000002'::uuid, 'PLC', 'finance_manager'), ('20000000-0000-4000-8000-000000000002'::uuid, 'IETA', 'finance_manager'),
  ('20000000-0000-4000-8000-000000000003'::uuid, 'IEA', 'finance_staff'), ('20000000-0000-4000-8000-000000000003'::uuid, 'PLC', 'finance_staff'),
  ('20000000-0000-4000-8000-000000000004'::uuid, 'IEA', 'finance_staff'),
  ('20000000-0000-4000-8000-000000000005'::uuid, 'IEA', 'data_entry'), ('20000000-0000-4000-8000-000000000005'::uuid, 'PLC', 'data_entry'),
  ('20000000-0000-4000-8000-000000000006'::uuid, 'IEA', 'data_entry'), ('20000000-0000-4000-8000-000000000006'::uuid, 'PLC', 'data_entry'),
  ('20000000-0000-4000-8000-000000000007'::uuid, 'IEA', 'data_entry'), ('20000000-0000-4000-8000-000000000007'::uuid, 'PLC', 'data_entry'),
  ('20000000-0000-4000-8000-000000000008'::uuid, 'IEA', 'read_only'), ('20000000-0000-4000-8000-000000000009'::uuid, 'IEA', 'read_only')
) v(u, c, r) join public.entities e on e.short_code = v.c;
-- registry: fo may act for IEA+PLC; fo2 only for IEA (it also has user_entity_access to PLC, so the registry is what limits it)
insert into public.finance_integration_identities (user_id, allowed_entity_ids) values
  ('20000000-0000-4000-8000-000000000006', array[pt.eid('IEA'), pt.eid('PLC')]),
  ('20000000-0000-4000-8000-000000000007', array[pt.eid('IEA')]);
insert into public.supplier_bills (id, entity_id, description, due_date, total_amount, outstanding_amount, payment_status, supporting_document_status)
values ('93000000-0000-4000-8000-000000000001', pt.eid('IEA'), 'Fictional bill with invoice', current_date, 100, 100, 'draft', 'invoice_uploaded');
create temp table pre_snapshot as select count(*) as n from public.audit_logs;

-- ==========================================================================================
-- 1. STRUCTURE: RLS on, least privilege, no balance column, search_path fixed
-- ==========================================================================================
select extensions.ok((select bool_and(relrowsecurity) from pg_class where oid in ('public.finance_payment_register'::regclass, 'public.finance_payment_documents'::regclass,
  'public.finance_bank_import_batches'::regclass, 'public.finance_bank_statement_transactions'::regclass, 'public.finance_payment_bank_matches'::regclass)), 'RLS is enabled on all five tables');
select extensions.ok(not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name like 'finance_%' and grantee in ('anon', 'public')
  and table_name in ('finance_payment_register', 'finance_payment_documents', 'finance_bank_import_batches', 'finance_bank_statement_transactions', 'finance_payment_bank_matches')), 'anon/public hold no privilege on the new tables');
select extensions.ok(not exists (select 1 from information_schema.role_table_grants where grantee = 'authenticated' and privilege_type = 'DELETE'
  and table_name in ('finance_payment_register', 'finance_payment_documents', 'finance_bank_import_batches', 'finance_bank_statement_transactions', 'finance_payment_bank_matches')), 'authenticated has no DELETE on any new table');
select extensions.ok(not exists (select 1 from information_schema.role_table_grants where grantee = 'authenticated' and privilege_type = 'UPDATE'
  and table_name in ('finance_bank_import_batches', 'finance_bank_statement_transactions')), 'bank statement batches and rows are insert-only (no UPDATE grant)');
select extensions.ok(not exists (select 1 from information_schema.columns where table_name in ('finance_bank_statement_transactions', 'finance_bank_import_batches') and column_name ~* 'balance'), 'the bank import tables have no balance column');
select extensions.ok((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'app_private')
  and p.proname in ('enforce_finance_payment_rules', 'audit_finance_payment_change', 'enforce_finance_payment_document_rules', 'audit_finance_payment_document_change', 'enforce_finance_bank_rows',
    'audit_finance_bank_batch', 'enforce_finance_bank_match_rules', 'audit_finance_bank_match_change', 'current_user_is_finance_reviewer', 'current_user_is_financeops_identity',
    'user_can_access_payment_document_object', 'finance_payment_missing_documents', 'finance_payment_has_confirmed_match')
  and array_to_string(p.proconfig, ',') like '%search_path=%') = 13, 'all thirteen new functions pin search_path');
select extensions.is((select count(*)::text from pg_policies where schemaname = 'public' and tablename in ('finance_payment_register', 'finance_payment_documents', 'finance_bank_import_batches', 'finance_bank_statement_transactions', 'finance_payment_bank_matches')), '13', 'thirteen RLS policies on the new tables');
select extensions.ok(exists (select 1 from storage.buckets where id = 'finance-payment-documents' and public = false), 'the payment-evidence bucket is private');
select extensions.is((select count(*)::text from pg_policies where schemaname = 'storage' and policyname like 'finance_payment_documents_storage_%'), '2', 'two storage policies (read, insert); no update/delete');

-- ==========================================================================================
-- 2. CREATION: FinanceOps captures; it cannot create anything human-only
-- ==========================================================================================
reset role; select pt.claim('20000000-0000-4000-8000-000000000006'); set local role authenticated;
select extensions.is(pt.err($q$select pt.mk('fo_ok', 'supplier_expense', 'captured', 'IEA', 100, 'financeops', 'fo_intake_0001')$q$), 'OK', 'FinanceOps captures a payment (captured)');
select extensions.is(pt.err($q$select pt.mk('fo_ok2', 'intern_wage', 'ready_for_bank_match', 'PLC', 1250, 'financeops', 'fo_intake_0002')$q$), 'OK', 'FinanceOps captures at ready_for_bank_match for an allowed entity');
select extensions.matches(pt.err($q$select pt.mk('fo_bad1', 'supplier_expense', 'bank_matched', 'IEA', 100, 'financeops', 'fo_intake_0003')$q$), 'may only capture', 'FinanceOps cannot create a payment as bank_matched');
select extensions.matches(pt.err($q$select pt.mk('fo_bad2', 'supplier_expense', 'ready_for_sql', 'IEA', 100, 'financeops', 'fo_intake_0004')$q$), 'may only capture', 'FinanceOps cannot create a payment as ready_for_sql');
select extensions.matches(pt.err($q$select pt.mk('fo_bad3', 'supplier_expense', 'captured', 'IEA', 100, 'manual')$q$), 'financeops-sourced', 'FinanceOps cannot create a manual-sourced record');
select extensions.matches(pt.err($q$select pt.mk('fo_bad4', 'supplier_expense', 'captured', 'IEA', 100, 'financeops', 'fo_intake_0005', 'SQL-1')$q$), 'cannot carry', 'FinanceOps cannot supply an SQL reference');
select extensions.matches(pt.err($q$select pt.mk('fo_bad5', 'supplier_expense', 'captured', 'IEA', 100, 'financeops', 'fo_intake_0006', null, '93000000-0000-4000-8000-000000000001')$q$), 'supplier bill link', 'FinanceOps cannot set the supplier bill link (it may only suggest)');
select extensions.matches(pt.err($q$select pt.mk('fo_bad6', 'supplier_expense', 'captured', 'IEA', 100, 'financeops', 'fo_intake_0007', null, null, 'cash', true, 'cash payment')$q$), 'cannot carry', 'FinanceOps cannot mark bank match not applicable');
select extensions.matches(pt.err($q$select pt.mk('fo_bad7', 'supplier_expense', 'captured', 'IEA', 100, 'financeops')$q$), 'fpr_financeops_has_intake', 'a financeops record needs its intake_id');
select extensions.matches(pt.err($q$select pt.mk('fo_dupe', 'supplier_expense', 'captured', 'IEA', 100, 'financeops', 'fo_intake_0001')$q$), 'fpr_intake_id_uidx|duplicate key', 'intake_id is unique (insert-first idempotency)');
reset role; select pt.claim('20000000-0000-4000-8000-000000000007'); set local role authenticated;
select extensions.matches(pt.err($q$select pt.mk('fo2_plc', 'supplier_expense', 'captured', 'PLC', 100, 'financeops', 'fo2_intake_001')$q$), 'may not capture payments for this entity', 'a registry identity cannot capture for an entity outside its registry list (even with entity access)');
select extensions.is(pt.err($q$select pt.mk('fo2_iea', 'supplier_expense', 'captured', 'IEA', 100, 'financeops', 'fo2_intake_002')$q$), 'OK', '... but can for its allowed entity');

reset role; select pt.claim('20000000-0000-4000-8000-000000000005'); set local role authenticated;
select extensions.is(pt.err($q$select pt.mk('int_ok', 'supplier_expense', 'captured', 'IEA', 55.5)$q$), 'OK', 'the data_entry intern can capture a manual payment');
select extensions.matches(pt.err($q$select pt.mk('int_fo', 'supplier_expense', 'captured', 'IEA', 55.5, 'financeops', 'int_intake_001')$q$), 'Only the FinanceOps', 'a non-registry user cannot create financeops-sourced records');
select extensions.matches(pt.err($q$select pt.mk('int_bad', 'supplier_expense', 'finance_review', 'IEA', 55.5)$q$), 'captured, documents_pending or ready_for_bank_match', 'the intern cannot create a payment at a later status');
select extensions.matches(pt.err($q$select pt.mk('int_bad2', 'supplier_expense', 'captured', 'IEA', 55.5, 'excel_import', null, 'SQL-9')$q$), 'cannot carry', 'the intern cannot supply SQL fields');
select extensions.matches(pt.err($q$select pt.mk('int_bad3', 'supplier_expense', 'captured', 'IEA', 0)$q$), 'fpr_amount', 'a zero amount is refused');
select extensions.matches(pt.err($q$select pt.mk('int_bad4', 'supplier_expense', 'captured', 'KALER', 10)$q$), 'row-level security', 'no entity access: refused');
reset role; select pt.claim('20000000-0000-4000-8000-000000000003'); set local role authenticated;
select extensions.is(pt.err($q$select pt.mk('fs_ok', 'supplier_expense', 'captured', 'IEA', 200)$q$), 'OK', 'Finance Staff can capture a manual payment');
select extensions.matches(pt.err($q$select pt.mk('fs_hist', 'supplier_expense', 'reconciled', 'IEA', 200, 'excel_import')$q$), 'Owner or a Finance Manager', 'Finance Staff cannot import a historical payment at a later status');
reset role; select pt.claim('20000000-0000-4000-8000-000000000002'); set local role authenticated;
select extensions.is(pt.err($q$select pt.mk('fm_hist', 'supplier_expense', 'reconciled', 'IEA', 200, 'excel_import', null, 'SQL-LEGACY')$q$), 'OK', 'a Finance Manager can import a closed historical payment (one-time Excel transition)');
reset role; select pt.claim('20000000-0000-4000-8000-000000000008'); set local role authenticated;
select extensions.matches(pt.err($q$select pt.mk('mgt_bad', 'supplier_expense', 'captured', 'IEA', 10)$q$), 'row-level security', 'management cannot create payments');
select extensions.is(pt.scalar($q$select count(*) from public.finance_payment_register$q$), '5', 'management can read the IEA register rows (read-only)');
reset role; select pt.claim('20000000-0000-4000-8000-000000000009'); set local role authenticated;
select extensions.is(pt.scalar($q$select count(*) from public.finance_payment_register$q$), '0', 'read_only sees nothing');

-- cross-entity: fs2 (IEA only) cannot see PLC rows
reset role; select pt.claim('20000000-0000-4000-8000-000000000004'); set local role authenticated;
select extensions.is(pt.scalar($q$select count(*) from public.finance_payment_register where entity_id = pt.eid('PLC')$q$), '0', 'cross-entity: a Finance Staff user without PLC access sees no PLC payments');
select extensions.matches(pt.err($q$select pt.mk('fs2_plc', 'supplier_expense', 'captured', 'PLC', 10)$q$), 'row-level security', 'cross-entity: and cannot create one');

-- ==========================================================================================
-- 3. FinanceOps updates: mechanical columns only, own rows only
-- ==========================================================================================
reset role; select pt.claim('20000000-0000-4000-8000-000000000006'); set local role authenticated;
select extensions.is(pt.upd($q$update public.finance_payment_register set status = 'documents_pending' where id = pt.uid('fo_ok')$q$)::text, '1', 'FinanceOps moves its payment captured -> documents_pending');
select extensions.is(pt.upd($q$update public.finance_payment_register set status = 'ready_for_bank_match', needs_attention = true, attention_reasons = array['invoice_missing'] where id = pt.uid('fo_ok')$q$)::text, '1', '... and flags needs_attention');
select extensions.matches(pt.err($q$update public.finance_payment_register set status = 'bank_matched' where id = pt.uid('fo_ok')$q$), 'only move its own payment', 'FinanceOps cannot set bank_matched');
select extensions.matches(pt.err($q$update public.finance_payment_register set status = 'finance_review' where id = pt.uid('fo_ok')$q$), 'only move its own payment', 'FinanceOps cannot set finance_review');
select extensions.matches(pt.err($q$update public.finance_payment_register set status = 'ready_for_sql' where id = pt.uid('fo_ok')$q$), 'only move its own payment', 'FinanceOps cannot set ready_for_sql');
select extensions.matches(pt.err($q$update public.finance_payment_register set status = 'posted_to_sql', sql_reference = 'X', sql_posting_date = current_date where id = pt.uid('fo_ok')$q$), 'cannot edit payment details or human-only|only move its own', 'FinanceOps cannot mark posted_to_sql');
select extensions.matches(pt.err($q$update public.finance_payment_register set status = 'reconciled' where id = pt.uid('fo_ok')$q$), 'only move its own payment', 'FinanceOps cannot mark reconciled');
select extensions.matches(pt.err($q$update public.finance_payment_register set amount = 1 where id = pt.uid('fo_ok')$q$), 'cannot edit payment details', 'FinanceOps cannot edit amounts');
select extensions.matches(pt.err($q$update public.finance_payment_register set beneficiary_name = 'X' where id = pt.uid('fo_ok')$q$), 'cannot edit payment details', 'FinanceOps cannot edit the beneficiary');
select extensions.matches(pt.err($q$update public.finance_payment_register set document_exception_note = 'approved by bot' where id = pt.uid('fo_ok')$q$), 'cannot edit payment details or human-only', 'FinanceOps cannot approve a document exception');
select extensions.matches(pt.err($q$update public.finance_payment_register set bank_match_not_applicable = true, bank_match_na_note = 'robot says so' where id = pt.uid('fo_ok')$q$), 'cannot edit payment details or human-only', 'FinanceOps cannot mark a bank match not applicable');
select extensions.matches(pt.err($q$update public.finance_payment_register set notes = 'looks fine' where id = pt.uid('fo_ok')$q$), 'cannot write review notes', 'FinanceOps cannot write review notes');
select extensions.matches(pt.err($q$update public.finance_payment_register set intake_id = 'fo_intake_hack1' where id = pt.uid('fo_ok')$q$), 'immutable', 'provenance is immutable');
select extensions.matches(pt.err($q$update public.finance_payment_register set status = 'documents_pending' where id = pt.uid('int_ok')$q$), 'only update the payments it captured', 'FinanceOps cannot update a human-created payment');

-- ==========================================================================================
-- 4. Intern: details while early, never review fields
-- ==========================================================================================
reset role; select pt.claim('20000000-0000-4000-8000-000000000005'); set local role authenticated;
select extensions.is(pt.upd($q$update public.finance_payment_register set beneficiary_name = 'Corrected Payee', notes = 'typed from slip' where id = pt.uid('int_ok')$q$)::text, '1', 'the intern can correct details and add notes while the payment is early');
select extensions.is(pt.upd($q$update public.finance_payment_register set status = 'ready_for_bank_match' where id = pt.uid('int_ok')$q$)::text, '1', '... and move it up to ready_for_bank_match');
select extensions.matches(pt.err($q$update public.finance_payment_register set status = 'finance_review' where id = pt.uid('int_ok')$q$), 'Only Owner, Finance Manager or Finance Staff', 'the intern cannot move a payment to finance_review');
select extensions.matches(pt.err($q$update public.finance_payment_register set status = 'ready_for_sql' where id = pt.uid('int_ok')$q$), 'Only Owner, Finance Manager or Finance Staff', 'the intern cannot mark ready_for_sql');
select extensions.matches(pt.err($q$update public.finance_payment_register set document_exception_note = 'ok by intern' where id = pt.uid('int_ok')$q$), 'Only Owner, Finance Manager or Finance Staff', 'the intern cannot approve a document exception');
select extensions.matches(pt.err($q$update public.finance_payment_register set not_applicable_documents = array['invoice'], not_applicable_note = 'n/a' where id = pt.uid('int_ok')$q$), 'Only Owner, Finance Manager or Finance Staff', 'the intern cannot mark a document not applicable');
select extensions.matches(pt.err($q$update public.finance_payment_register set sql_reference = 'SQL-1' where id = pt.uid('int_ok')$q$), 'Only Owner, Finance Manager or Finance Staff', 'the intern cannot set an SQL reference');
select extensions.is(pt.upd($q$update public.finance_payment_register set supplier_bill_id = '93000000-0000-4000-8000-000000000001' where id = pt.uid('int_ok')$q$)::text, '1', 'the intern can link a supplier bill (data entry)');

-- ==========================================================================================
-- 5. Documents: attach, requirements, removal
-- ==========================================================================================
reset role; select pt.claim('20000000-0000-4000-8000-000000000006'); set local role authenticated;
select extensions.is(pt.err($q$select pt.doc('fo-evidence', 'fo_ok', 'IEA', 'payment_evidence')$q$), 'OK', 'FinanceOps attaches payment evidence to its own payment');
select extensions.matches(pt.err($q$select pt.doc('fo-on-human', 'int_ok', 'IEA', 'payment_evidence')$q$), 'only attach documents to payments it captured', 'FinanceOps cannot attach to a human-created payment');
select extensions.matches(pt.err($q$insert into public.finance_payment_documents (payment_register_id, entity_id, doc_role, storage_path, original_filename, mime_type, file_size, file_hash, uploaded_by)
  values (pt.uid('fo_ok'), pt.eid('IEA'), 'payment_evidence', pt.eid('PLC')::text || '/wrong', 'a.pdf', 'application/pdf', 5, repeat('b', 64), auth.uid())$q$), 'must belong to the payment|storage path', 'a document must carry the payment''s entity and path');
select extensions.matches(pt.err($q$select pt.doc('fo-evidence-dupe', 'fo_ok', 'IEA', 'payment_evidence')$q$), 'OK|fpd_live_hash_uidx', 'a second payment-evidence document is allowed (different file)');
select extensions.is(pt.scalar($q$select array_to_string(app_private.finance_payment_missing_documents(pt.uid('fo_ok'), (select required_documents from public.finance_payment_register where id = pt.uid('fo_ok')), '{}', null), ',')$q$), 'invoice', 'supplier expense with evidence but no invoice: missing = invoice');
select extensions.is(pt.scalar($q$select array_to_string(app_private.finance_payment_missing_documents(pt.uid('int_ok'), (select required_documents from public.finance_payment_register where id = pt.uid('int_ok')), '{}', (select supplier_bill_id from public.finance_payment_register where id = pt.uid('int_ok'))), ',')$q$), 'payment_evidence', 'a linked supplier bill that already has its invoice satisfies the invoice requirement');
select extensions.is(pt.scalar($q$select array_to_string(app_private.finance_payment_missing_documents(pt.uid('fo_ok2'), pt.req('intern_wage'), array['wage_schedule'], null), ',')$q$), 'payment_evidence', 'a not-applicable document is not missing');
reset role; select pt.claim('20000000-0000-4000-8000-000000000005'); set local role authenticated;
select extensions.is(pt.err($q$select pt.doc('int-invoice', 'int_ok', 'IEA', 'invoice')$q$), 'OK', 'the intern attaches a supporting document');
select extensions.is(pt.upd($q$update public.finance_payment_documents set removed_at = now(), removal_reason = 'oops' where id = pt.uid('doc-int-invoice')$q$)::text, '0', 'the intern cannot remove a document (RLS update policy: reviewers only; 0 rows)');
reset role; select pt.claim('20000000-0000-4000-8000-000000000003'); set local role authenticated;
select extensions.matches(pt.err($q$update public.finance_payment_documents set removal_reason = 'x' where id = pt.uid('doc-int-invoice')$q$), 'fpd_removal_pair', 'removal needs both time and reason');
select extensions.matches(pt.err($q$update public.finance_payment_documents set original_filename = 'tampered.pdf' where id = pt.uid('doc-int-invoice')$q$), 'immutable', 'document facts are immutable');
select extensions.is(pt.upd($q$update public.finance_payment_documents set removed_at = now(), removal_reason = 'wrong file' where id = pt.uid('doc-int-invoice')$q$)::text, '1', 'Finance Staff can remove (soft) a document with a reason');
select extensions.is(pt.scalar($q$select count(*) from public.finance_payment_documents where id = pt.uid('doc-int-invoice') and removed_by = auth.uid()$q$), '1', 'the removal is stamped from auth.uid()');
select extensions.is(pt.scalar($q$select count(*) from public.finance_payment_documents$q$), '3', 'removed documents remain (history kept)');

-- ==========================================================================================
-- 6. Bank import: reviewers + AAL2 only; insert-only
-- ==========================================================================================
reset role; select pt.claim('20000000-0000-4000-8000-000000000003', 'aal1'); set local role authenticated;
select extensions.matches(pt.err($q$select pt.batch('b_aal1', 'IEA')$q$), 'row-level security', 'bank import needs AAL2 (Finance Staff at AAL1 is refused)');
select extensions.is(pt.scalar($q$select count(*) from public.finance_bank_statement_transactions$q$), '0', '... and sees no bank rows at AAL1');
reset role; select pt.claim('20000000-0000-4000-8000-000000000003', 'aal2'); set local role authenticated;
select extensions.is(pt.err($q$select pt.batch('b1', 'IEA')$q$), 'OK', 'Finance Staff at AAL2 imports a batch (no balance column needed)');
select extensions.is(pt.err($q$select pt.tx('t1', 'b1', 'IEA', 1250, 'debit', 1)$q$), 'OK', 'and its statement rows');
select extensions.is(pt.err($q$select pt.tx('t2', 'b1', 'IEA', 400, 'debit', 2)$q$), 'OK', 'second row');
select extensions.is(pt.err($q$select pt.tx('t3', 'b1', 'IEA', 400, 'credit', 3)$q$), 'OK', 'a credit row');
select extensions.is(pt.err($q$select pt.tx('t4', 'b1', 'IEA', 100, 'debit', 4)$q$), 'OK', 'fourth row');
select extensions.matches(pt.err($q$select pt.batch('b1dupe', 'IEA')$q$), 'OK|fbb_file_uidx', 'a batch with a different file hash is a new batch');
select extensions.matches(pt.err($q$insert into public.finance_bank_import_batches (entity_id, company_account_ref, filename, file_type, file_hash, imported_by) values (pt.eid('IEA'), 'PBB-1234', 'again.csv', 'csv', md5('b1') || md5('b1y'), auth.uid())$q$), 'fbb_file_uidx|duplicate key', 'the same file for the same account cannot be imported twice');
select extensions.matches(pt.err($q$select pt.tx('t_bad', 'b1', 'PLC', 10, 'debit', 9)$q$), 'agree with its batch', 'a row must agree with its batch entity');
select extensions.matches(pt.err($q$select pt.tx('t_bad2', 'b1', 'IEA', 10, 'debit', 9, 'OTHER-ACCT')$q$), 'agree with its batch', 'a row must agree with its batch account');
select extensions.matches(pt.err($q$update public.finance_bank_statement_transactions set amount = 1 where id = pt.uid('t1')$q$), 'permission denied', 'statement rows cannot be updated');
select extensions.matches(pt.err($q$delete from public.finance_bank_statement_transactions where id = pt.uid('t1')$q$), 'permission denied', 'statement rows cannot be deleted');
select extensions.matches(pt.err($q$select pt.batch('b_plc', 'KALER')$q$), 'row-level security', 'no entity access: refused');
reset role; select pt.claim('20000000-0000-4000-8000-000000000005', 'aal2'); set local role authenticated;
select extensions.is(pt.scalar($q$select count(*) from public.finance_bank_statement_transactions$q$), '0', 'the intern cannot read bank statement rows (even at AAL2)');
select extensions.matches(pt.err($q$select pt.batch('b_int', 'IEA')$q$), 'row-level security', 'the intern cannot import bank rows');
reset role; select pt.claim('20000000-0000-4000-8000-000000000006', 'aal2'); set local role authenticated;
select extensions.is(pt.scalar($q$select count(*) from public.finance_bank_statement_transactions$q$), '0', 'FinanceOps cannot read bank statement rows');
select extensions.matches(pt.err($q$select pt.batch('b_fo', 'IEA')$q$), 'row-level security', 'FinanceOps cannot import bank rows');
select extensions.is(pt.scalar($q$select count(*) from public.finance_bank_import_batches$q$), '0', 'FinanceOps cannot read import batches');
reset role; select pt.claim('20000000-0000-4000-8000-000000000008', 'aal2'); set local role authenticated;
select extensions.is(pt.scalar($q$select count(*) from public.finance_bank_statement_transactions$q$), '0', 'management cannot read bank statement rows');
reset role; select pt.claim('20000000-0000-4000-8000-000000000004', 'aal2'); set local role authenticated;
select extensions.is(pt.scalar($q$select count(*) from public.finance_bank_statement_transactions$q$), '4', 'a Finance Staff user with IEA access reads the IEA bank rows');

-- ==========================================================================================
-- 7. Matching: humans suggest/confirm; FinanceOps and the intern cannot
-- ==========================================================================================
reset role; select pt.claim('20000000-0000-4000-8000-000000000003', 'aal2'); set local role authenticated;
select extensions.is(pt.err($q$select pt.mk('m_pay1', 'intern_wage', 'ready_for_bank_match', 'IEA', 1250)$q$), 'OK', 'fixture payments for matching (1250)');
select extensions.is(pt.err($q$select pt.mk('m_pay2', 'intern_wage', 'ready_for_bank_match', 'IEA', 400)$q$), 'OK', '(400)');
select extensions.is(pt.err($q$select pt.mk('m_pay3', 'intern_wage', 'ready_for_bank_match', 'IEA', 400)$q$), 'OK', '(second 400: ambiguous amount)');
select extensions.is(pt.err($q$select pt.match('mt1', 'm_pay1', 't1', 'IEA')$q$), 'OK', 'Finance Staff (AAL2) records a suggested match');
select extensions.matches(pt.err($q$select pt.match('mt_credit', 'm_pay2', 't3', 'IEA')$q$), 'Only a bank debit', 'a bank credit cannot be matched to a payment');
select extensions.matches(pt.err($q$select pt.match('mt_x', 'm_pay1', 't1', 'IEA')$q$), 'fbm_pair_key|duplicate key', 'the same pair is never suggested twice');
select extensions.matches(pt.err($q$select pt.match('mt_plc', 'fo_ok2', 't1', 'IEA')$q$), 'must stay within one entity|not found|row-level', 'a match must stay within one entity');
select extensions.matches(pt.err($q$update public.finance_payment_register set status = 'bank_matched' where id = pt.uid('m_pay1')$q$), 'confirmed a bank match', 'a payment cannot become bank_matched without a confirmed match');
select extensions.is(pt.upd($q$update public.finance_payment_bank_matches set status = 'confirmed' where id = pt.uid('mt1')$q$)::text, '1', 'Finance Staff confirms the suggested match');
select extensions.is(pt.scalar($q$select match_method || '/' || (confirmed_by = auth.uid())::text from public.finance_payment_bank_matches where id = pt.uid('mt1')$q$), 'suggested_confirmed/true', 'method and confirmer are stamped by the trigger');
select extensions.is(pt.err($q$select pt.match('mt2', 'm_pay2', 't1', 'IEA')$q$), 'OK', 'a second suggestion for the same bank row is allowed as a suggestion');
select extensions.matches(pt.err($q$update public.finance_payment_bank_matches set status = 'confirmed' where id = pt.uid('mt2')$q$), 'fbm_one_confirmed_per_bank_row|duplicate key', 'one bank row cannot be confirmed to two payments');
select extensions.is(pt.upd($q$update public.finance_payment_bank_matches set status = 'rejected' where id = pt.uid('mt2')$q$)::text, '1', 'Not Match rejects a suggestion');
select extensions.is(pt.upd($q$update public.finance_payment_register set status = 'bank_matched' where id = pt.uid('m_pay1')$q$)::text, '1', 'with a confirmed match the payment can become bank_matched');
select extensions.matches(pt.err($q$update public.finance_payment_bank_matches set score = 5 where id = pt.uid('mt1')$q$), 'immutable', 'a match''s score and reasons are immutable');
select extensions.is(pt.err($q$select pt.match('mt3', 'm_pay3', 't2', 'IEA')$q$), 'OK', 'ambiguous 400: both payments get a suggestion for the same row');
select extensions.is(pt.err($q$select pt.match('mt4', 'm_pay2', 't2', 'IEA')$q$), 'OK', '(second candidate)');
select extensions.is(pt.upd($q$update public.finance_payment_bank_matches set review_later = true where id = pt.uid('mt4')$q$)::text, '1', 'Review Later flags without deciding');
reset role; select pt.claim('20000000-0000-4000-8000-000000000005', 'aal2'); set local role authenticated;
select extensions.matches(pt.err($q$select pt.match('mt_int', 'm_pay2', 't4', 'IEA')$q$), 'Only Owner, Finance Manager or Finance Staff|row-level security', 'the intern cannot suggest or confirm matches');
reset role; select pt.claim('20000000-0000-4000-8000-000000000006', 'aal2'); set local role authenticated;
select extensions.matches(pt.err($q$select pt.match('mt_fo', 'fo_ok', 't4', 'IEA')$q$), 'Only Owner, Finance Manager or Finance Staff|row-level security', 'FinanceOps cannot suggest or confirm matches');
select extensions.is(pt.scalar($q$select count(*) from public.finance_payment_bank_matches$q$), '0', 'FinanceOps cannot read matches');
select extensions.matches(pt.err($q$update public.finance_payment_register set status = 'bank_matched' where id = pt.uid('fo_ok')$q$), 'only move its own payment', 'FinanceOps cannot mark bank_matched');
reset role; select pt.claim('20000000-0000-4000-8000-000000000003', 'aal1'); set local role authenticated;
select extensions.is(pt.scalar($q$select count(*) from public.finance_payment_bank_matches$q$), '0', 'a reviewer at AAL1 cannot read matches');
select extensions.matches(pt.err($q$update public.finance_payment_register set status = 'ready_for_bank_match' where id = pt.uid('m_pay1')$q$), 'Reject the confirmed bank match', 'a payment with a confirmed match cannot be returned without unmatching it - even for a reviewer at AAL1 who cannot read the match (boolean-only definer helper)');
reset role; select pt.claim('20000000-0000-4000-8000-000000000003', 'aal2'); set local role authenticated;
select extensions.is(pt.upd($q$update public.finance_payment_bank_matches set status = 'rejected' where id = pt.uid('mt1')$q$)::text, '1', 'a confirmed match can be unmatched by a reviewer');
select extensions.is(pt.upd($q$update public.finance_payment_register set status = 'ready_for_bank_match' where id = pt.uid('m_pay1')$q$)::text, '1', '... and the payment returns to ready_for_bank_match');
select extensions.is(pt.upd($q$update public.finance_payment_bank_matches set status = 'suggested' where id = pt.uid('mt1')$q$)::text, '1', 'a rejected suggestion can be reopened');
select extensions.is(pt.upd($q$update public.finance_payment_bank_matches set status = 'confirmed' where id = pt.uid('mt1')$q$)::text, '1', 'and confirmed again');
select extensions.is(pt.upd($q$update public.finance_payment_register set status = 'bank_matched' where id = pt.uid('m_pay1')$q$)::text, '1', 'bank_matched again');

-- ==========================================================================================
-- 8. Finance review / Ready for SQL / Posted / Reconciled
-- ==========================================================================================
select extensions.matches(pt.err($q$update public.finance_payment_register set status = 'finance_review' where id = pt.uid('m_pay1')$q$), 'Required documents are missing \(payment_evidence, wage_schedule\)', 'finance_review is refused while required documents are missing');
select extensions.is(pt.err($q$select pt.doc('m1-ev', 'm_pay1', 'IEA', 'payment_evidence')$q$), 'OK', 'attach payment evidence');
select extensions.matches(pt.err($q$update public.finance_payment_register set status = 'finance_review' where id = pt.uid('m_pay1')$q$), 'wage_schedule', 'still missing the wage schedule');
select extensions.is(pt.upd($q$update public.finance_payment_register set document_exception_note = 'Wage sheet to follow; approved by finance' where id = pt.uid('m_pay1')$q$)::text, '1', 'a reviewer approves a document exception');
select extensions.is(pt.scalar($q$select (document_exception_approved_by = auth.uid())::text || (document_exception_approved_at is not null)::text from public.finance_payment_register where id = pt.uid('m_pay1')$q$), 'truetrue', 'the approver and time are stamped by the trigger');
select extensions.is(pt.upd($q$update public.finance_payment_register set status = 'finance_review' where id = pt.uid('m_pay1')$q$)::text, '1', 'with the exception approved the payment can enter finance_review');
select extensions.is(pt.scalar($q$select (reviewed_by = auth.uid())::text from public.finance_payment_register where id = pt.uid('m_pay1')$q$), 'true', 'reviewed_by is stamped');
select extensions.matches(pt.err($q$update public.finance_payment_register set amount = 1 where id = pt.uid('m_pay1')$q$), 'locked', 'details are locked in finance_review');
select extensions.is(pt.upd($q$update public.finance_payment_register set notes = 'checked coding' where id = pt.uid('m_pay1')$q$)::text, '1', 'notes remain editable');
reset role; select pt.claim('20000000-0000-4000-8000-000000000005', 'aal2'); set local role authenticated;
select extensions.matches(pt.err($q$update public.finance_payment_register set status = 'ready_for_sql' where id = pt.uid('m_pay1')$q$), 'Only Owner, Finance Manager or Finance Staff|Payment details', 'the intern cannot mark ready_for_sql');
reset role; select pt.claim('20000000-0000-4000-8000-000000000006', 'aal2'); set local role authenticated;
select extensions.matches(pt.err($q$update public.finance_payment_register set status = 'ready_for_sql' where id = pt.uid('m_pay1')$q$), 'only update the payments it captured', 'FinanceOps cannot mark ready_for_sql (nor touch a human-created row)');
reset role; select pt.claim('20000000-0000-4000-8000-000000000003', 'aal2'); set local role authenticated;
select extensions.is(pt.upd($q$update public.finance_payment_register set status = 'ready_for_sql' where id = pt.uid('m_pay1')$q$)::text, '1', 'Finance Staff marks ready_for_sql');
select extensions.is(pt.scalar($q$select (ready_for_sql_by = auth.uid())::text from public.finance_payment_register where id = pt.uid('m_pay1')$q$), 'true', 'ready_for_sql_by is stamped');
select extensions.matches(pt.err($q$update public.finance_payment_register set status = 'posted_to_sql' where id = pt.uid('m_pay1')$q$), 'SQL reference and the SQL posting date', 'posted_to_sql needs the SQL reference and posting date');
select extensions.matches(pt.err($q$update public.finance_payment_register set status = 'posted_to_sql', sql_reference = '   ', sql_posting_date = current_date where id = pt.uid('m_pay1')$q$), 'SQL reference and the SQL posting date', 'a blank SQL reference is refused');
select extensions.is(pt.upd($q$update public.finance_payment_register set status = 'posted_to_sql', sql_reference = 'PV-2026-00123', sql_posting_date = current_date, sql_note = 'posted by accounts' where id = pt.uid('m_pay1')$q$)::text, '1', 'Finance Staff records the SQL reference and Posted to SQL');
select extensions.is(pt.scalar($q$select (sql_posted_by = auth.uid())::text from public.finance_payment_register where id = pt.uid('m_pay1')$q$), 'true', 'sql_posted_by is stamped');
select extensions.matches(pt.err($q$update public.finance_payment_register set status = 'reconciled' where id = pt.uid('m_pay1')$q$), 'reconciliation date', 'reconciled needs a reconciliation date');
select extensions.is(pt.upd($q$update public.finance_payment_register set status = 'reconciled', reconciled_date = current_date where id = pt.uid('m_pay1')$q$)::text, '1', 'Finance Staff tracks Reconciled');
select extensions.matches(pt.err($q$update public.finance_payment_register set status = 'posted_to_sql' where id = pt.uid('m_pay1')$q$), 'Owner or a Finance Manager', 'Finance Staff cannot reverse a reconciliation');
select extensions.matches(pt.err($q$update public.finance_payment_register set sql_reference = 'CHANGED' where id = pt.uid('m_pay1')$q$), 'Owner or a Finance Manager', 'Finance Staff cannot silently change a recorded SQL reference');
reset role; select pt.claim('20000000-0000-4000-8000-000000000002', 'aal2'); set local role authenticated;
select extensions.is(pt.upd($q$update public.finance_payment_register set status = 'posted_to_sql' where id = pt.uid('m_pay1')$q$)::text, '1', 'a Finance Manager can reverse a reconciliation');
select extensions.is(pt.upd($q$update public.finance_payment_register set status = 'ready_for_sql' where id = pt.uid('m_pay1')$q$)::text, '1', '... and a posting');
select extensions.matches(pt.err($q$update public.finance_payment_register set status = 'reconciled' where id = pt.uid('m_pay1')$q$), 'Invalid payment status transition', 'no skipping from ready_for_sql to reconciled');

-- bank match not applicable (cash): a human decision
reset role; select pt.claim('20000000-0000-4000-8000-000000000003', 'aal1'); set local role authenticated;
select extensions.is(pt.err($q$select pt.mk('cash1', 'staff_claim', 'ready_for_bank_match', 'IEA', 30, 'manual', null, null, null, 'cash')$q$), 'OK', 'a cash payment is captured');
select extensions.matches(pt.err($q$update public.finance_payment_register set status = 'finance_review' where id = pt.uid('cash1')$q$), 'bank match', 'finance_review needs a bank match or a not-applicable decision');
select extensions.matches(pt.err($q$update public.finance_payment_register set bank_match_not_applicable = true where id = pt.uid('cash1')$q$), 'note is required', 'not-applicable needs a note');
select extensions.is(pt.upd($q$update public.finance_payment_register set bank_match_not_applicable = true, bank_match_na_note = 'petty cash, no bank movement', document_exception_note = 'cash receipt on file' where id = pt.uid('cash1')$q$)::text, '1', 'a reviewer marks the bank match not applicable (and approves the missing-document exception)');
select extensions.is(pt.upd($q$update public.finance_payment_register set status = 'finance_review' where id = pt.uid('cash1')$q$)::text, '1', 'a not-applicable payment can enter finance_review without a bank match');

-- historical Excel import by a Finance Manager: stamps are server-side, never client-supplied
reset role; select pt.claim('20000000-0000-4000-8000-000000000002', 'aal1'); set local role authenticated;
select extensions.is(pt.err($q$insert into public.finance_payment_register (id, entity_id, source_type, payment_type, payment_instruction_date, amount, required_documents, status, document_exception_note, reviewed_by, created_by)
  values (pt.uid('fm_hist2'), pt.eid('IEA'), 'excel_import', 'intern_wage', current_date, 10, pt.req('intern_wage'), 'documents_pending', 'documents held outside the Hub', '20000000-0000-4000-8000-000000000009', auth.uid())$q$), 'OK', 'a Finance Manager imports a historical row with a documents-held-elsewhere exception');
select extensions.is(pt.scalar($q$select (document_exception_approved_by = auth.uid())::text || (reviewed_by is null)::text from public.finance_payment_register where id = pt.uid('fm_hist2')$q$), 'truetrue', 'the exception approver is stamped from auth.uid() and a client-supplied reviewed_by is discarded');
select extensions.is(pt.scalar($q$select array_to_string(app_private.finance_payment_missing_documents(pt.uid('fm_hist2'), pt.req('intern_wage'), '{}', null), ',')$q$), 'payment_evidence,wage_schedule', 'and the documents are still reported missing (the exception approves moving on; it does not fake attachments)');

-- ==========================================================================================
-- 9. Audit and scope
-- ==========================================================================================
reset role; select pt.claim('20000000-0000-4000-8000-000000000001', 'aal2'); set local role authenticated;
select extensions.ok((select count(*) from public.audit_logs where action = 'finance_payment_captured') >= 6, 'captures are audited');
select extensions.ok((select count(*) from public.audit_logs where action = 'finance_payment_ready_for_sql') >= 1, 'ready_for_sql is audited');
select extensions.ok((select count(*) from public.audit_logs where action = 'finance_payment_posted_to_sql') >= 1, 'posted_to_sql is audited');
select extensions.ok((select count(*) from public.audit_logs where action = 'finance_payment_reconciled') >= 1, 'reconciled is audited');
select extensions.ok((select count(*) from public.audit_logs where action = 'finance_payment_document_exception_approved') >= 1, 'a document exception approval is audited');
select extensions.ok((select count(*) from public.audit_logs where action = 'finance_bank_match_confirmed') >= 1, 'a confirmed match is audited');
select extensions.ok((select count(*) from public.audit_logs where action = 'finance_bank_match_rejected') >= 1, 'a rejected match is audited');
select extensions.ok((select count(*) from public.audit_logs where action = 'finance_bank_import_batch_created') >= 1, 'a bank import batch is audited');
select extensions.ok((select count(*) from public.audit_logs where action = 'finance_payment_bank_match_not_applicable') >= 1, 'a bank-match-not-applicable decision is audited');
select extensions.ok((select count(*) from public.audit_logs where action = 'finance_payment_document_attached') >= 1, 'a document attachment is audited');
select extensions.ok(not exists (select 1 from public.audit_logs where action like 'finance_payment_%' and actor_user_id is null), 'every audit row has an actor');
reset role;
select extensions.ok(exists (select 1 from public.finance_payment_register where id = pt.uid('m_pay1')) and not exists (select 1 from public.bill_payments), 'no official bill_payments row was ever created by this feature');
select extensions.ok(not exists (select 1 from public.payment_vouchers), 'no payment voucher was created');
select extensions.ok(not exists (select 1 from public.bank_transactions where description like 'Fictional%'), 'the legacy bank_transactions table was never touched');

select * from extensions.finish();
rollback;
