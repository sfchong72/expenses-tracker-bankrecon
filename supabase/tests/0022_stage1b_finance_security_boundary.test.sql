-- Disposable/local database only. Exercises the private Finance/Management
-- boundary, owner-approved MFA scope, and soft-merge behavior added by 0022.
begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(70);

select extensions.ok(
  to_regprocedure('app_private.current_user_has_app_access()') is not null,
  'private application-access helper exists'
);
select extensions.ok(
  to_regprocedure('app_private.current_user_has_aal2()') is not null
  and to_regprocedure('app_private.current_user_can_high_risk(text)') is not null,
  'explicit AAL2 and high-risk authorization helpers exist'
);
select extensions.ok(
  to_regprocedure('app_private.user_can_access_document(uuid)') is not null,
  'linked-record document access helper exists'
);
select extensions.ok(
  to_regprocedure('public.save_payment_voucher_draft(jsonb,jsonb)') is not null
  and to_regprocedure('public.prepare_claim_payment_voucher(uuid)') is not null
  and to_regprocedure('public.issue_payment_voucher(uuid)') is not null,
  'atomic Finance workflow RPCs exist'
);
select extensions.ok(
  to_regprocedure('public.delete_document_metadata(uuid,text)') is not null
  and to_regprocedure('public.delete_payment_voucher_draft(uuid,text)') is not null
  and to_regprocedure('public.delete_duplicate_student(uuid,text)') is null,
  'controlled Finance deletion RPCs exist and Student hard-delete is absent'
);
select extensions.ok(
  not has_table_privilege('authenticated', 'public.documents', 'DELETE')
  and not has_table_privilege('authenticated', 'public.supplier_bills', 'DELETE')
  and not has_table_privilege('authenticated', 'public.payment_vouchers', 'DELETE')
  and not has_table_privilege('authenticated', 'public.claims', 'DELETE')
  and not has_table_privilege('authenticated', 'public.bank_import_rows', 'DELETE'),
  'direct client hard-delete privileges are absent'
);
select extensions.ok(
  not has_function_privilege('anon', 'public.save_payment_voucher_draft(jsonb,jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.issue_payment_voucher(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.delete_document_metadata(uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.confirm_bank_reconciliation_allocation(uuid,text)', 'EXECUTE'),
  'anonymous has no privileged Finance RPC execution'
);
select extensions.is(
  (select count(*)::integer from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname in (
       'bill_documents_storage_scoped_read',
       'bill_documents_storage_scoped_insert',
       'bill_documents_storage_scoped_update',
       'bill_documents_storage_scoped_delete'
     )),
  4,
  'four operation-specific private Storage policies exist'
);
select extensions.ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bank_accounts_staff_safe'
      and column_name in ('opening_balance', 'closing_balance', 'current_balance', 'running_balance')
  ),
  'staff-safe bank view exposes no balance-equivalent column'
);
select extensions.ok(
  exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'payment_vouchers'
      and t.tgname = 'audit_payment_voucher_lifecycle_trigger' and not t.tgisinternal
  ),
  'voucher lifecycle audit trigger exists'
);
select extensions.ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.app_profiles'::regclass
      and pg_get_constraintdef(oid) like '%management%'
  ),
  'management is an explicit application role'
);
select extensions.ok(
  (select c.reloptions @> array['security_invoker=true']
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'suppliers_app_safe')
  and
  (select c.reloptions @> array['security_invoker=true']
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'bank_accounts_staff_safe')
  and not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in (
        'bank_transactions_staff_safe',
        'bank_import_batches_staff_safe',
        'bank_import_rows_staff_safe'
      )
      and not (c.reloptions @> array['security_invoker=true'])
  ),
  'staff-safe Finance views run with invoker security'
);
select extensions.ok(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'confirm_bank_reconciliation_allocation',
        'reverse_bank_reconciliation_allocation',
        'discard_bank_import_batch',
        'archive_bank_import_batch'
      )
      and (
        not p.prosecdef
        or coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path=""%'
        or pg_get_functiondef(p.oid) not like '%current_user_has_aal2()%'
      )
  ),
  'privileged bank RPCs use safe definer settings and enforce AAL2 at runtime'
);

create schema stage1b_finance_test;
revoke all on schema stage1b_finance_test from public;
grant usage on schema stage1b_finance_test to authenticated, anon;

create function stage1b_finance_test.claim(p_user_id uuid, p_aal text default 'aal1')
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user_id::text, ''), true);
  perform set_config('request.jwt.claim.role', case when p_user_id is null then 'anon' else 'authenticated' end, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', p_user_id,
      'role', case when p_user_id is null then 'anon' else 'authenticated' end,
      'aal', p_aal
    )::text,
    true
  );
end;
$$;

create function stage1b_finance_test.probe(p_statement text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare succeeded boolean := false;
begin
  begin
    execute p_statement;
    succeeded := true;
    raise exception using errcode = 'PT001';
  exception
    when sqlstate 'PT001' then return succeeded;
    when others then return false;
  end;
end;
$$;

grant execute on function stage1b_finance_test.claim(uuid, text) to authenticated, anon;
grant execute on function stage1b_finance_test.probe(text) to authenticated, anon;

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values
  ('11000000-0000-4000-8000-000000000001', 'owner@security.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('22000000-0000-4000-8000-000000000002', 'manager@security.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('33000000-0000-4000-8000-000000000003', 'staff@security.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('44000000-0000-4000-8000-000000000004', 'management@security.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('55000000-0000-4000-8000-000000000005', 'entry@security.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('66000000-0000-4000-8000-000000000006', 'trainer@security.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('77000000-0000-4000-8000-000000000007', 'inactive@security.invalid', 'authenticated', 'authenticated', '{}', '{}'),
  ('88000000-0000-4000-8000-000000000008', 'branch@security.invalid', 'authenticated', 'authenticated', '{}', '{}');

update public.app_profiles p set
  role = v.role,
  active_status = v.active_status,
  display_name = v.display_name
from (values
  ('11000000-0000-4000-8000-000000000001'::uuid, 'owner', true, 'Fictional Owner'),
  ('22000000-0000-4000-8000-000000000002'::uuid, 'finance_manager', true, 'Fictional Finance Manager'),
  ('33000000-0000-4000-8000-000000000003'::uuid, 'finance_staff', true, 'Fictional Finance Staff'),
  ('44000000-0000-4000-8000-000000000004'::uuid, 'management', true, 'Fictional Management'),
  ('55000000-0000-4000-8000-000000000005'::uuid, 'data_entry', true, 'Fictional Data Entry'),
  ('66000000-0000-4000-8000-000000000006'::uuid, 'trainer', true, 'Fictional Trainer'),
  ('77000000-0000-4000-8000-000000000007'::uuid, 'finance_staff', false, 'Fictional Inactive'),
  ('88000000-0000-4000-8000-000000000008'::uuid, 'branch_manager', true, 'Fictional Branch Manager')
) v(id, role, active_status, display_name)
where p.id = v.id;

insert into public.user_entity_access (user_id, entity_id, role, active_status)
select v.user_id, e.id, v.role, true
from (values
  ('22000000-0000-4000-8000-000000000002'::uuid, 'finance_manager'),
  ('33000000-0000-4000-8000-000000000003'::uuid, 'finance_staff'),
  ('44000000-0000-4000-8000-000000000004'::uuid, 'management'),
  ('55000000-0000-4000-8000-000000000005'::uuid, 'data_entry'),
  ('66000000-0000-4000-8000-000000000006'::uuid, 'trainer'),
  ('77000000-0000-4000-8000-000000000007'::uuid, 'finance_staff'),
  ('88000000-0000-4000-8000-000000000008'::uuid, 'branch_manager')
) v(user_id, role)
join public.entities e on e.short_code = 'IETA';

insert into public.user_branch_access (
  user_id, entity_id, branch_id, access_role, active_status
)
select
  v.user_id, e.id, b.id, v.access_role, true
from (values
  ('55000000-0000-4000-8000-000000000005'::uuid, 'staff'),
  ('88000000-0000-4000-8000-000000000008'::uuid, 'branch_manager')
) v(user_id, access_role)
cross join public.entities e
join public.branches b on b.entity_id = e.id and b.branch_code = 'KL'
where e.short_code = 'IETA';

insert into public.finance_user_permissions (user_id, can_approve_claims)
values
  ('44000000-0000-4000-8000-000000000004', true),
  ('66000000-0000-4000-8000-000000000006', true);

insert into public.operations_user_permissions (user_id, can_manage_students, can_manage_enrolments)
values
  ('55000000-0000-4000-8000-000000000005', true, true),
  ('66000000-0000-4000-8000-000000000006', true, true);

insert into public.operations_user_permissions (
  user_id, can_view_student_pii, can_manage_students,
  can_manage_programmes, can_manage_enrolments
) values (
  '88000000-0000-4000-8000-000000000008', true, true, true, true
);

insert into public.supplier_bills (
  id, entity_id, description, due_date, total_amount, outstanding_amount,
  payment_status, created_by
)
select '90000000-0000-4000-8000-000000000001', id, 'IETA security fixture', current_date, 100, 100, 'draft',
  '33000000-0000-4000-8000-000000000003'
from public.entities where short_code = 'IETA';

insert into public.supplier_bills (
  id, entity_id, description, due_date, total_amount, outstanding_amount,
  payment_status, created_by
)
select '90000000-0000-4000-8000-000000000002', id, 'IEA security fixture', current_date, 200, 200, 'draft',
  '11000000-0000-4000-8000-000000000001'
from public.entities where short_code = 'IEA';

insert into public.payment_vouchers (
  id, entity_id, payee, purpose, total_amount, status, prepared_by
)
select '90000000-0000-4000-8000-000000000003', id, 'Fictional Payee', 'Security test', 100, 'draft',
  '33000000-0000-4000-8000-000000000003'
from public.entities where short_code = 'IETA';

insert into public.payment_voucher_items (
  id, payment_voucher_id, description, amount
) values (
  '90000000-0000-4000-8000-000000000004',
  '90000000-0000-4000-8000-000000000003', 'Fixture item', 100
);

insert into public.claims (
  id, entity_id, claim_mode, claim_type, claimant_user_id, claimant_name,
  status, net_payable_amount, created_by, updated_by
)
select '90000000-0000-4000-8000-000000000005', id, 'staff_cash_travel', 'staff_cash_claim',
  '33000000-0000-4000-8000-000000000003', 'Fictional Staff', 'checked', 50,
  '33000000-0000-4000-8000-000000000003', '33000000-0000-4000-8000-000000000003'
from public.entities where short_code = 'IETA';

insert into public.claims (
  id, entity_id, claim_mode, claim_type, claimant_user_id, claimant_name,
  status, net_payable_amount, created_by, updated_by
)
select '90000000-0000-4000-8000-000000000009', id, 'staff_cash_travel', 'staff_cash_claim',
  '44000000-0000-4000-8000-000000000004', 'Fictional Management', 'checked', 25,
  '44000000-0000-4000-8000-000000000004', '44000000-0000-4000-8000-000000000004'
from public.entities where short_code = 'IETA';

insert into public.claims (
  id, entity_id, claim_mode, claim_type, claimant_user_id, claimant_name,
  status, net_payable_amount, created_by, updated_by
)
select '90000000-0000-4000-8000-000000000006', id, 'credit_card', 'director_claim',
  '11000000-0000-4000-8000-000000000001', 'Fictional Director', 'draft', 75,
  '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001'
from public.entities where short_code = 'IETA';

insert into public.documents (
  id, entity_id, document_type, original_filename, storage_path, mime_type,
  file_size, uploaded_by
)
select '90000000-0000-4000-8000-000000000007', id, 'supplier_invoice',
  'fictional-invoice.pdf', id::text || '/2026/09/supplier_invoice/90000000-0000-4000-8000-000000000001/fixture.pdf',
  'application/pdf', 12, '33000000-0000-4000-8000-000000000003'
from public.entities where short_code = 'IETA';

insert into public.document_links (
  document_id, entity_id, linked_record_type, linked_record_id, created_by
)
select '90000000-0000-4000-8000-000000000007', id, 'supplier_bill',
  '90000000-0000-4000-8000-000000000001', '33000000-0000-4000-8000-000000000003'
from public.entities where short_code = 'IETA';

insert into public.students (
  id, entity_id, student_number, full_name, home_branch_id, created_by, updated_by
)
select fixture.id, e.id, fixture.student_number, fixture.full_name, b.id,
  '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001'
from public.entities e
join (values
  ('90000000-0000-4000-8000-000000000011'::uuid, 'IETA-TEST-KL-001', 'Fictional KL Student', 'KL'),
  ('90000000-0000-4000-8000-000000000012'::uuid, 'IETA-TEST-KL-002', 'Fictional KL Duplicate', 'KL'),
  ('90000000-0000-4000-8000-000000000013'::uuid, 'IETA-TEST-PG-001', 'Fictional PG Student', 'PG')
) fixture(id, student_number, full_name, branch_code) on true
join public.branches b on b.entity_id = e.id and b.branch_code = fixture.branch_code
where e.short_code = 'IETA';

insert into public.student_duplicate_reviews (
  student_id, possible_duplicate_student_id, match_reason, match_strength
) values (
  '90000000-0000-4000-8000-000000000012',
  '90000000-0000-4000-8000-000000000013',
  'fictional matching phone',
  'possible'
);

insert into public.programmes (id, entity_id, programme_code, programme_name)
select '90000000-0000-4000-8000-000000000020', id, 'MERGE-TST', 'Fictional Merge Programme'
from public.entities where short_code = 'IETA';

insert into public.programme_intakes (
  id, programme_id, entity_id, branch_id, intake_code, intake_name, start_date, status
)
select '90000000-0000-4000-8000-000000000021',
  '90000000-0000-4000-8000-000000000020', e.id, b.id,
  'MERGE-INTAKE', 'Fictional Merge Intake', current_date, 'open'
from public.entities e
join public.branches b on b.entity_id = e.id and b.branch_code = 'KL'
where e.short_code = 'IETA';

insert into public.enrolments (
  id, enrolment_number, student_id, programme_id, intake_id, entity_id, branch_id, status
)
select '90000000-0000-4000-8000-000000000022', 'MERGE-ENROLMENT',
  '90000000-0000-4000-8000-000000000012',
  '90000000-0000-4000-8000-000000000020',
  '90000000-0000-4000-8000-000000000021', e.id, b.id, 'draft'
from public.entities e
join public.branches b on b.entity_id = e.id and b.branch_code = 'KL'
where e.short_code = 'IETA';

insert into public.documents (
  id, entity_id, document_type, original_filename, storage_path, mime_type,
  file_size, uploaded_by
)
select '90000000-0000-4000-8000-000000000023', id, 'other',
  'fictional-student.pdf', id::text || '/student/merge-source.pdf',
  'application/pdf', 12, '11000000-0000-4000-8000-000000000001'
from public.entities where short_code = 'IETA';

insert into public.document_links (
  document_id, entity_id, linked_record_type, linked_record_id, created_by
)
select '90000000-0000-4000-8000-000000000023', id, 'student',
  '90000000-0000-4000-8000-000000000012', '11000000-0000-4000-8000-000000000001'
from public.entities where short_code = 'IETA';

insert into public.documents (
  id, entity_id, document_type, original_filename, storage_path, mime_type,
  file_size, uploaded_by
)
select '90000000-0000-4000-8000-000000000008', id, 'claim_receipt',
  'fictional-director-receipt.pdf', id::text || '/2026/09/claim_receipt/90000000-0000-4000-8000-000000000006/fixture.pdf',
  'application/pdf', 12, '11000000-0000-4000-8000-000000000001'
from public.entities where short_code = 'IETA';

insert into public.document_links (
  document_id, entity_id, linked_record_type, linked_record_id, created_by
)
select '90000000-0000-4000-8000-000000000008', id, 'claim',
  '90000000-0000-4000-8000-000000000006', '11000000-0000-4000-8000-000000000001'
from public.entities where short_code = 'IETA';

set local role authenticated;
select stage1b_finance_test.claim('11000000-0000-4000-8000-000000000001', 'aal1');
select extensions.ok(
  app_private.current_user_has_app_access()
  and not app_private.current_user_has_aal2(),
  'Owner retains routine application access at aal1'
);
select extensions.ok(
  not app_private.current_user_can('can_view_bank_balances'),
  'Owner cannot access high-risk bank data at aal1'
);
update public.app_profiles set display_name = 'Forbidden AAL1 admin change'
where id = '22000000-0000-4000-8000-000000000002';
select extensions.is(
  (select display_name from public.app_profiles where id = '22000000-0000-4000-8000-000000000002'),
  'Fictional Finance Manager'::text,
  'Owner cannot administer accounts at aal1'
);
select stage1b_finance_test.claim('11000000-0000-4000-8000-000000000001', 'aal2');
select extensions.ok(
  app_private.current_user_can('can_view_bank_balances'),
  'Owner may access high-risk bank data at aal2'
);
update public.app_profiles set display_name = 'AAL2 admin change'
where id = '22000000-0000-4000-8000-000000000002';
select extensions.is(
  (select display_name from public.app_profiles where id = '22000000-0000-4000-8000-000000000002'),
  'AAL2 admin change'::text,
  'Owner may administer accounts at aal2'
);
reset role;

set local role authenticated;
select stage1b_finance_test.claim('22000000-0000-4000-8000-000000000002', 'aal1');
select extensions.ok(
  app_private.current_user_has_app_access()
  and not app_private.current_user_can_high_risk('can_issue_vouchers'),
  'Finance Manager retains routine access but cannot authorize high-risk work at aal1'
);
select stage1b_finance_test.claim('22000000-0000-4000-8000-000000000002', 'aal2');
select extensions.ok(
  app_private.current_user_has_app_access()
  and app_private.current_user_can_high_risk('can_issue_vouchers'),
  'Finance Manager may authorize permitted high-risk work at aal2'
);
reset role;

set local role authenticated;
select stage1b_finance_test.claim('33000000-0000-4000-8000-000000000003');
select extensions.is((select count(*)::integer from public.supplier_bills), 1, 'Finance Staff sees assigned entity only');
select extensions.is((select count(*)::integer from public.documents), 1, 'Finance Staff sees linked ordinary document only');
select extensions.is((select count(*)::integer from public.claims where id = '90000000-0000-4000-8000-000000000006'), 0, 'Finance Staff cannot see confidential director claim');
select extensions.ok(not stage1b_finance_test.probe(
  $$select public.issue_payment_voucher('90000000-0000-4000-8000-000000000003')$$
), 'Finance Staff cannot issue a voucher');
select extensions.ok(stage1b_finance_test.probe(
  $$select public.save_payment_voucher_draft(
    '{"entity_id":"00000000-0000-0000-0000-000000000000","payee":"x","purpose":"x","total_amount":1}'::jsonb,
    '[{"description":"x","amount":1}]'::jsonb
  )$$
) is false, 'Finance Staff cannot prepare a voucher for an unassigned entity');
select extensions.ok(not stage1b_finance_test.probe(
  $$select public.save_payment_voucher_draft(
    (select jsonb_build_object('entity_id',id,'payee','Cross-entity','purpose','Cross-entity','total_amount',200)
     from public.entities where short_code='IETA'),
    '[{"description":"Cross-entity bill","amount":200,"supplier_bill_id":"90000000-0000-4000-8000-000000000002"}]'::jsonb
  )$$
), 'Finance Staff cannot link a voucher item to another entity bill');
reset role;

set local role authenticated;
select stage1b_finance_test.claim('44000000-0000-4000-8000-000000000004');
select extensions.is((select count(*)::integer from public.supplier_bills), 1, 'Management can read assigned Finance records');
update public.supplier_bills
set description = 'forbidden'
where id = '90000000-0000-4000-8000-000000000001';
select extensions.is(
  (select description from public.supplier_bills where id = '90000000-0000-4000-8000-000000000001'),
  'IETA security fixture'::text,
  'Management cannot routinely edit Finance records'
);
select extensions.ok(not stage1b_finance_test.probe(
  $$update public.claims set status='approved', approved_by='44000000-0000-4000-8000-000000000004', approved_at=now()
    where id='90000000-0000-4000-8000-000000000005'$$
), 'Management approval is denied at aal1');
select stage1b_finance_test.claim('44000000-0000-4000-8000-000000000004', 'aal2');
select extensions.ok(stage1b_finance_test.probe(
  $$update public.claims set status='approved', approved_by='44000000-0000-4000-8000-000000000004', approved_at=now()
    where id='90000000-0000-4000-8000-000000000005'$$
), 'Specifically appointed Management can approve another claimant claim at aal2');
reset role;

set local role authenticated;
select stage1b_finance_test.claim('55000000-0000-4000-8000-000000000005');
select extensions.ok(stage1b_finance_test.probe(
  $$insert into public.supplier_bills(entity_id,description,due_date,total_amount,payment_status,created_by)
    select id,'Data Entry draft',current_date,1,'draft',auth.uid() from public.entities where short_code='IETA'$$
), 'Data Entry may create a permitted bill draft');
select extensions.ok(not stage1b_finance_test.probe(
  $$insert into public.supplier_bills(entity_id,description,due_date,total_amount,payment_status,created_by)
    select id,'Forbidden final',current_date,1,'paid',auth.uid() from public.entities where short_code='IETA'$$
), 'Data Entry cannot create a finalized bill');
select extensions.ok(not stage1b_finance_test.probe(
  $$insert into public.claims(entity_id,claim_mode,claim_type,claimant_user_id,claimant_name,status,net_payable_amount,created_by,updated_by)
    select id,'staff_cash_travel','staff_cash_claim',auth.uid(),'Fictional Data Entry','approved',1,auth.uid(),auth.uid()
    from public.entities where short_code='IETA'$$
), 'Data Entry cannot create a finalized claim');
select extensions.is((select count(*)::integer from public.payment_vouchers), 0, 'Data Entry cannot read sensitive vouchers');
select extensions.is((select count(*)::integer from public.bank_accounts_staff_safe), 0, 'Data Entry cannot read bank account metadata');
select extensions.is(
  (select count(*)::integer from public.students),
  2,
  'Data Entry sees only students in the explicitly assigned KL branch'
);
select extensions.is(
  (select count(*)::integer from public.students where student_number = 'IETA-TEST-PG-001'),
  0,
  'Data Entry cannot see the unassigned PG branch student'
);
select extensions.ok(
  public.generate_student_number((select id from public.entities where short_code = 'IETA'))
    like 'IETA-STU-%',
  'Data Entry may allocate an entity-scoped student number through the protected function'
);
select extensions.ok(stage1b_finance_test.probe(
  $$insert into public.students(entity_id,student_number,full_name,home_branch_id,created_by,updated_by)
    select e.id,'IETA-TEST-KL-003','Fictional New KL Student',b.id,auth.uid(),auth.uid()
    from public.entities e join public.branches b on b.entity_id=e.id and b.branch_code='KL'
    where e.short_code='IETA'$$
), 'Data Entry may create a student in the assigned KL branch');
select extensions.ok(not stage1b_finance_test.probe(
  $$insert into public.students(entity_id,student_number,full_name,home_branch_id,created_by,updated_by)
    select e.id,'IETA-TEST-PG-002','Forbidden PG Student',b.id,auth.uid(),auth.uid()
    from public.entities e join public.branches b on b.entity_id=e.id and b.branch_code='PG'
    where e.short_code='IETA'$$
), 'Data Entry cannot create a student in the unassigned PG branch');
reset role;

set local role authenticated;
select stage1b_finance_test.claim('88000000-0000-4000-8000-000000000008', 'aal1');
select extensions.ok(
  app_private.current_user_has_app_access()
  and app_private.current_user_has_operations_permission('can_manage_students')
  and not app_private.current_user_can('can_view_finance'),
  'Branch Manager receives explicit Student Operations access without Finance access'
);
select extensions.ok(
  (select count(*) > 0 from public.students)
  and not exists (
    select 1 from public.students s
    join public.branches b on b.id = s.home_branch_id
    where b.branch_code = 'PG'
  ),
  'Branch Manager sees assigned KL students and no PG students'
);
select extensions.ok(
  public.generate_student_number((select id from public.entities where short_code = 'IETA'))
    like 'IETA-STU-%',
  'Branch Manager may allocate an entity-scoped student number at aal1'
);
select extensions.is(
  (select count(*)::integer from public.get_student_sensitive_identity('90000000-0000-4000-8000-000000000011')),
  0,
  'Branch Manager cannot reveal unmasked Student identity at aal1'
);
select stage1b_finance_test.claim('88000000-0000-4000-8000-000000000008', 'aal2');
select extensions.is(
  (select count(*)::integer from public.get_student_sensitive_identity('90000000-0000-4000-8000-000000000011')),
  1,
  'Branch Manager with explicit PII permission may reveal in-scope identity at aal2'
);
select extensions.is(
  (select count(*)::integer from public.get_student_sensitive_identity('90000000-0000-4000-8000-000000000013')),
  0,
  'Branch Manager cannot reveal cross-branch identity even at aal2'
);
reset role;

set local role authenticated;
select stage1b_finance_test.claim('66000000-0000-4000-8000-000000000006');
select extensions.ok(
  app_private.current_user_has_app_access()
  and app_private.current_user_has_operations_permission('can_manage_students')
  and not app_private.current_user_can('can_approve_claims')
  and (select count(*) = 0 from public.supplier_bills)
  and (select count(*) = 0 from public.documents),
  'Non-Finance operations user cannot inherit Finance access from a stale Finance permission row'
);
reset role;

set local role authenticated;
select stage1b_finance_test.claim('77000000-0000-4000-8000-000000000007');
select extensions.ok(
  not app_private.current_user_has_app_access()
  and (select count(*) = 0 from public.supplier_bills),
  'Inactive user has no access despite stale entity assignment'
);
reset role;

set local role anon;
select stage1b_finance_test.claim(null);
select extensions.ok(not stage1b_finance_test.probe('select * from public.suppliers_app_safe'), 'Anonymous cannot read safe Finance views');
reset role;

set local role authenticated;
select stage1b_finance_test.claim('44000000-0000-4000-8000-000000000004', 'aal2');
select extensions.ok(not stage1b_finance_test.probe(
  $$update public.claims set status='approved', approved_by='44000000-0000-4000-8000-000000000004', approved_at=now()
    where id='90000000-0000-4000-8000-000000000009'$$
), 'An appointed Management approver cannot approve their own claim');
reset role;

set local role authenticated;
select stage1b_finance_test.claim('33000000-0000-4000-8000-000000000003');
select extensions.is((select count(*)::integer from public.bank_accounts), 0, 'Finance Staff cannot read raw bank balance rows');
select extensions.ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='suppliers_app_safe' and column_name='bank_account_number'
  ),
  'safe supplier view has no standalone bank-account-number field'
);
reset role;

set local role authenticated;
select stage1b_finance_test.claim('22000000-0000-4000-8000-000000000002', 'aal1');
select extensions.ok(
  (select count(*) = 1 from public.supplier_bills)
  and (select count(*) = 0 from public.payment_vouchers),
  'Finance Manager may read routine scoped Finance data but not sensitive vouchers at aal1'
);
select extensions.ok(not stage1b_finance_test.probe(
  $$select public.issue_payment_voucher('90000000-0000-4000-8000-000000000003')$$
), 'Finance Manager cannot issue a voucher at aal1');
select extensions.ok(not stage1b_finance_test.probe(
  $$select public.save_payment_voucher_draft(
    (select jsonb_build_object('entity_id',id,'payee','AAL1 blocked','purpose','AAL1 blocked','total_amount',1)
     from public.entities where short_code='IETA'),
    '[{"description":"AAL1 blocked","amount":1}]'::jsonb
  )$$
), 'Finance Manager cannot prepare a payment voucher at aal1');
select stage1b_finance_test.claim('22000000-0000-4000-8000-000000000002', 'aal2');
select extensions.lives_ok(
  $$select public.issue_payment_voucher('90000000-0000-4000-8000-000000000003')$$,
  'Finance Manager may issue an eligible voucher atomically'
);
select extensions.lives_ok(
  $$update public.payment_vouchers set status='cancelled', cancelled_by=auth.uid(), cancelled_at=now(), cancellation_reason='Fictional void reason'
    where id='90000000-0000-4000-8000-000000000003'$$,
  'Finance Manager may void an issued voucher with a reason'
);
select extensions.lives_ok(
  $$select public.delete_payment_voucher_draft(
    public.save_payment_voucher_draft(
      (select jsonb_build_object('entity_id',id,'payee','Delete fixture','purpose','Delete fixture','total_amount',1)
       from public.entities where short_code='IETA'),
      '[{"description":"Delete fixture","amount":1}]'::jsonb
    ), 'Duplicate draft'
  )$$,
  'Finance Manager may delete an eligible draft through the reason-requiring RPC'
);
select extensions.ok(exists (
  select 1 from public.audit_logs where action='payment_vouchers_permanently_deleted'
), 'draft deletion creates immutable audit evidence');
reset role;

set local role authenticated;
select stage1b_finance_test.claim('55000000-0000-4000-8000-000000000005');
select extensions.ok(not stage1b_finance_test.probe(
  $$select public.merge_students('90000000-0000-4000-8000-000000000011','90000000-0000-4000-8000-000000000013','cross branch')$$
), 'Explicit Student permission never permits a cross-branch merge');
reset role;

set local role authenticated;
select stage1b_finance_test.claim('11000000-0000-4000-8000-000000000001', 'aal1');
select extensions.ok(
  exists (select 1 from public.enrolments where student_id='90000000-0000-4000-8000-000000000012')
  and exists (
    select 1 from public.document_links
    where linked_record_type='student' and linked_record_id='90000000-0000-4000-8000-000000000012'
  ),
  'soft-merge fixture begins with dependencies on the source Student'
);
select extensions.lives_ok(
  $$select public.merge_students('90000000-0000-4000-8000-000000000012','90000000-0000-4000-8000-000000000011','reviewed duplicate')$$,
  'Owner may use the historical soft-merge workflow at aal1'
);
select extensions.ok(exists (
  select 1 from public.students
  where id='90000000-0000-4000-8000-000000000012'
    and lifecycle_status='merged'
    and merged_into_student_id='90000000-0000-4000-8000-000000000011'
    and active_status=false
), 'soft merge retains the inactive source Student and merged-into link');
select extensions.ok(
  exists (select 1 from public.enrolments where id='90000000-0000-4000-8000-000000000022' and student_id='90000000-0000-4000-8000-000000000011')
  and exists (
    select 1 from public.document_links
    where document_id='90000000-0000-4000-8000-000000000023'
      and linked_record_type='student'
      and linked_record_id='90000000-0000-4000-8000-000000000011'
  ),
  'soft merge moves enrolment and document dependencies to the target Student'
);
select extensions.ok(
  exists (
    select 1 from public.student_merge_events
    where source_student_id='90000000-0000-4000-8000-000000000012'
      and target_student_id='90000000-0000-4000-8000-000000000011'
  )
  and exists (
    select 1 from public.audit_logs
    where action='students_merged'
      and payload ->> 'source_student_id'='90000000-0000-4000-8000-000000000012'
  ),
  'soft merge preserves merge-event and audit lineage'
);
update public.students
set active_status=true, preferred_name='Forbidden reactivation'
where id='90000000-0000-4000-8000-000000000012';
select extensions.ok(exists (
  select 1 from public.students
  where id='90000000-0000-4000-8000-000000000012'
    and active_status=false
    and preferred_name is distinct from 'Forbidden reactivation'
), 'merged source cannot be reactivated through ordinary Student update access');
select extensions.ok(not stage1b_finance_test.probe(
  $$insert into public.enrolments(
      enrolment_number,student_id,programme_id,intake_id,entity_id,branch_id,status
    )
    select 'FORBIDDEN-MERGED',
      '90000000-0000-4000-8000-000000000012',
      '90000000-0000-4000-8000-000000000020',
      '90000000-0000-4000-8000-000000000021', e.id, b.id, 'draft'
    from public.entities e
    join public.branches b on b.entity_id=e.id and b.branch_code='KL'
    where e.short_code='IETA'$$
), 'merged source cannot receive a new enrolment');
select extensions.ok(exists (
  select 1 from public.student_duplicate_reviews
  where student_id='90000000-0000-4000-8000-000000000011'
    and possible_duplicate_student_id='90000000-0000-4000-8000-000000000013'
    and match_reason='fictional matching phone'
), 'controlled merge preserves applicable duplicate-review history on the target student');
reset role;

set local role authenticated;
select stage1b_finance_test.claim('33000000-0000-4000-8000-000000000003', 'aal2');
select extensions.ok(not stage1b_finance_test.probe(
  $$select public.save_payment_voucher_draft(
    (select jsonb_build_object('entity_id',id,'payee','Rollback fixture','purpose','Rollback fixture','total_amount',1)
     from public.entities where short_code='IETA'),
    '[{"description":"Valid","amount":1},{"description":"Invalid","amount":-1}]'::jsonb
  )$$
), 'invalid voucher item aborts the atomic draft workflow');
select extensions.is(
  (select count(*)::integer from public.payment_vouchers where payee='Rollback fixture'),
  0,
  'failed atomic voucher workflow leaves no partial voucher'
);
reset role;

select * from extensions.finish();
rollback;
