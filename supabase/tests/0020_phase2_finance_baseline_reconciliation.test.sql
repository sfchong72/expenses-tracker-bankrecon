-- Run only against a disposable Supabase database after migration 0020.
-- Catalog/security verification for the Phase 2 Finance reconciliation.

begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(66);

-- Force creation of the session-local schema used by the catalog helpers.
create temporary table finance_reconciliation_test_bootstrap (id integer);

create function pg_temp.fk_matches(
  source_table regclass,
  constraint_name text,
  source_column text,
  referenced_table regclass,
  referenced_column text,
  delete_code text
)
returns boolean
language sql
stable
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from pg_constraint c
    join pg_attribute source_attribute
      on source_attribute.attrelid = c.conrelid
     and source_attribute.attnum = c.conkey[1]
    join pg_attribute referenced_attribute
      on referenced_attribute.attrelid = c.confrelid
     and referenced_attribute.attnum = c.confkey[1]
    where c.conrelid = source_table
      and c.conname = constraint_name
      and c.contype = 'f'
      and cardinality(c.conkey) = 1
      and cardinality(c.confkey) = 1
      and source_attribute.attname = source_column
      and c.confrelid = referenced_table
      and referenced_attribute.attname = referenced_column
      and c.confdeltype::text = delete_code
      and c.confupdtype::text = 'a'
      and not c.condeferrable
      and not c.condeferred
      and c.convalidated
  );
$$;

create function pg_temp.policy_matches(
  relation_name text,
  policy_name text,
  policy_command text,
  using_expression text,
  check_expression text
)
returns boolean
language sql
stable
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from pg_policies p
    where p.schemaname = 'public'
      and p.tablename = relation_name
      and p.policyname = policy_name
      and p.cmd = policy_command
      and p.permissive = 'PERMISSIVE'
      and p.roles = '{authenticated}'::name[]
      and coalesce(p.qual, '') = coalesce(using_expression, '')
      and coalesce(p.with_check, '') = coalesce(check_expression, '')
  );
$$;

create function pg_temp.trigger_matches(
  relation_name text,
  trigger_name text,
  function_name text,
  expected_type integer
)
returns boolean
language sql
stable
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    join pg_namespace pn on pn.oid = p.pronamespace
    where n.nspname = 'public'
      and c.relname = relation_name
      and t.tgname = trigger_name
      and not t.tgisinternal
      and t.tgenabled = 'O'
      and t.tgtype::integer = expected_type
      and pn.nspname = 'public'
      and p.proname = function_name
      and pg_get_function_identity_arguments(p.oid) = ''
  );
$$;

select extensions.ok(
  current_setting('server_version_num')::integer >= 150000,
  'PostgreSQL version satisfies the reconciliation preflight'
);

select extensions.ok(
  (select bool_and(c.relrowsecurity)
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in (
       'bill_payments', 'supplier_bills', 'document_links',
       'payment_voucher_sequences', 'documents'
     ))
  and
  (select count(*) = 5
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in (
       'bill_payments', 'supplier_bills', 'document_links',
       'payment_voucher_sequences', 'documents'
     )),
  'RLS remains enabled on all reconciled Finance tables'
);

select extensions.ok(
  not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'documents'
      and cmd in ('DELETE', 'ALL')
  ),
  'documents has no direct physical DELETE policy'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.documents', 'DELETE')
  and not has_table_privilege('service_role', 'public.documents', 'DELETE'),
  'authenticated and service_role have no direct DELETE privilege on documents'
);

select extensions.ok(
  not has_table_privilege('anon', 'public.documents', 'DELETE'),
  'anonymous has no direct DELETE privilege on documents'
);

select extensions.has_function(
  'public', 'recalculate_document_link_status', array[]::text[],
  'document-link recalculation trigger helper exists'
);

select extensions.has_function(
  'public', 'set_phase2_updated_at', array[]::text[],
  'Phase 2 updated-at trigger helper exists'
);

select extensions.ok(
  (select p.prosecdef
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'recalculate_document_link_status'
     and pg_get_function_identity_arguments(p.oid) = ''),
  'document-link recalculation helper is security-definer'
);

select extensions.ok(
  not (select p.prosecdef
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname = 'set_phase2_updated_at'
         and pg_get_function_identity_arguments(p.oid) = ''),
  'updated-at helper is security-invoker'
);

select extensions.ok(
  (select p.proconfig @> array['search_path=public']
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'recalculate_document_link_status'
     and pg_get_function_identity_arguments(p.oid) = ''),
  'document-link recalculation helper has a fixed search_path'
);

select extensions.ok(
  (select p.proconfig @> array['search_path=public']
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'set_phase2_updated_at'
     and pg_get_function_identity_arguments(p.oid) = ''),
  'updated-at helper has a fixed search_path'
);

select extensions.ok(
  not has_function_privilege('anon', 'public.recalculate_document_link_status()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.recalculate_document_link_status()', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.recalculate_document_link_status()', 'EXECUTE'),
  'client roles cannot execute the security-definer trigger helper directly'
);

select extensions.ok(
  not has_function_privilege('anon', 'public.set_phase2_updated_at()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.set_phase2_updated_at()', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.set_phase2_updated_at()', 'EXECUTE'),
  'client roles cannot execute the updated-at trigger helper directly'
);

select extensions.ok(
  has_function_privilege('postgres', 'public.recalculate_document_link_status()', 'EXECUTE'),
  'database owner retains trigger-helper execution'
);

select extensions.ok(
  has_function_privilege('postgres', 'public.set_phase2_updated_at()', 'EXECUTE'),
  'database owner retains updated-at helper execution'
);

select extensions.ok(pg_temp.fk_matches('public.bill_payments','bill_payments_bank_account_id_fkey','bank_account_id','public.bank_accounts','id','n'),'bill_payments bank account FK uses SET NULL');
select extensions.ok(pg_temp.fk_matches('public.bill_payments','bill_payments_bank_transaction_id_fkey','bank_transaction_id','public.bank_transactions','id','n'),'bill_payments bank transaction FK uses SET NULL');
select extensions.ok(pg_temp.fk_matches('public.bill_payments','bill_payments_created_by_fkey','created_by','auth.users','id','n'),'bill_payments creator FK uses SET NULL');
select extensions.ok(pg_temp.fk_matches('public.bill_payments','bill_payments_entity_id_fkey','entity_id','public.entities','id','r'),'bill_payments entity FK uses RESTRICT');
select extensions.ok(pg_temp.fk_matches('public.bill_payments','bill_payments_payment_voucher_id_fkey','payment_voucher_id','public.payment_vouchers','id','n'),'bill_payments voucher FK uses SET NULL');
select extensions.ok(pg_temp.fk_matches('public.document_links','document_links_created_by_fkey','created_by','auth.users','id','n'),'document_links creator FK uses SET NULL');
select extensions.ok(pg_temp.fk_matches('public.document_links','document_links_entity_id_fkey','entity_id','public.entities','id','r'),'document_links entity FK uses RESTRICT');
select extensions.ok(pg_temp.fk_matches('public.documents','documents_archived_by_fkey','archived_by','auth.users','id','n'),'documents archived-by FK uses SET NULL');
select extensions.ok(pg_temp.fk_matches('public.documents','documents_deleted_by_fkey','deleted_by','auth.users','id','n'),'documents deleted-by FK uses SET NULL');
select extensions.ok(pg_temp.fk_matches('public.documents','documents_entity_id_fkey','entity_id','public.entities','id','r'),'documents entity FK uses RESTRICT');
select extensions.ok(pg_temp.fk_matches('public.documents','documents_replaces_document_id_fkey','replaces_document_id','public.documents','id','n'),'documents replacement FK uses SET NULL');
select extensions.ok(pg_temp.fk_matches('public.documents','documents_uploaded_by_fkey','uploaded_by','auth.users','id','n'),'documents uploader FK uses SET NULL');
select extensions.ok(pg_temp.fk_matches('public.payment_voucher_items','payment_voucher_items_supplier_bill_id_fkey','supplier_bill_id','public.supplier_bills','id','n'),'voucher item supplier-bill FK uses SET NULL');
select extensions.ok(pg_temp.fk_matches('public.payment_voucher_sequences','payment_voucher_sequences_entity_id_fkey','entity_id','public.entities','id','c'),'voucher sequence entity FK uses CASCADE');
select extensions.ok(pg_temp.fk_matches('public.payment_vouchers','payment_vouchers_cancelled_by_fkey','cancelled_by','auth.users','id','n'),'voucher cancelled-by FK uses SET NULL');
select extensions.ok(pg_temp.fk_matches('public.payment_vouchers','payment_vouchers_entity_id_fkey','entity_id','public.entities','id','r'),'voucher entity FK uses RESTRICT');
select extensions.ok(pg_temp.fk_matches('public.payment_vouchers','payment_vouchers_prepared_by_fkey','prepared_by','auth.users','id','n'),'voucher prepared-by FK uses SET NULL');
select extensions.ok(pg_temp.fk_matches('public.payment_vouchers','payment_vouchers_supplier_id_fkey','supplier_id','public.suppliers','id','n'),'voucher supplier FK uses SET NULL');
select extensions.ok(pg_temp.fk_matches('public.recurring_obligations','recurring_obligations_created_by_fkey','created_by','auth.users','id','n'),'recurring obligation creator FK uses SET NULL');
select extensions.ok(pg_temp.fk_matches('public.recurring_obligations','recurring_obligations_entity_id_fkey','entity_id','public.entities','id','r'),'recurring obligation entity FK uses RESTRICT');
select extensions.ok(pg_temp.fk_matches('public.recurring_obligations','recurring_obligations_supplier_id_fkey','supplier_id','public.suppliers','id','n'),'recurring obligation supplier FK uses SET NULL');
select extensions.ok(pg_temp.fk_matches('public.supplier_bills','supplier_bills_created_by_fkey','created_by','auth.users','id','n'),'supplier bill creator FK uses SET NULL');
select extensions.ok(pg_temp.fk_matches('public.supplier_bills','supplier_bills_entity_id_fkey','entity_id','public.entities','id','r'),'supplier bill entity FK uses RESTRICT');
select extensions.ok(pg_temp.fk_matches('public.supplier_bills','supplier_bills_expense_category_id_fkey','expense_category_id','public.categories','id','n'),'supplier bill category FK uses SET NULL');
select extensions.ok(pg_temp.fk_matches('public.supplier_bills','supplier_bills_recurring_obligation_id_fkey','recurring_obligation_id','public.recurring_obligations','id','n'),'supplier bill recurring-obligation FK uses SET NULL');
select extensions.ok(pg_temp.fk_matches('public.supplier_bills','supplier_bills_supplier_id_fkey','supplier_id','public.suppliers','id','n'),'supplier bill supplier FK uses SET NULL');

select extensions.ok(
  exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.recurring_obligations'::regclass
      and c.conname = 'recurring_obligations_reminder_days_check'
      and c.contype = 'c'
      and c.convalidated
      and pg_get_constraintdef(c.oid, true) = 'CHECK (reminder_days >= 0 AND reminder_days <= 31)'
  ),
  'reminder_days is constrained to 0..31 and validated'
);

select extensions.ok(
  exists (
    select 1 from pg_index i
    where i.indexrelid = 'public.documents_uploaded_by_idx'::regclass
      and i.indrelid = 'public.documents'::regclass
      and i.indisvalid and i.indisready and not i.indisunique
      and i.indpred is null
      and pg_get_indexdef(i.indexrelid, 1, true) = 'uploaded_by'
  ),
  'documents uploader index is valid'
);

select extensions.ok(
  exists (
    select 1 from pg_index i
    where i.indexrelid = 'public.supplier_bills_document_status_idx'::regclass
      and i.indrelid = 'public.supplier_bills'::regclass
      and i.indisvalid and i.indisready and not i.indisunique
      and i.indpred is null
      and pg_get_indexdef(i.indexrelid, 1, true) = 'supporting_document_status'
  ),
  'supplier-bill document-status index is valid'
);

select extensions.ok(pg_temp.policy_matches('bill_payments','bill_payments_entity_select','SELECT','app_private.user_can_access_entity(entity_id)',null),'bill_payments SELECT is entity-scoped');
select extensions.ok(pg_temp.policy_matches('bill_payments','bill_payments_entity_insert','INSERT',null,'app_private.user_can_access_entity(entity_id)'),'bill_payments INSERT is entity-scoped');
select extensions.ok(pg_temp.policy_matches('bill_payments','bill_payments_entity_update','UPDATE','app_private.user_can_access_entity(entity_id)','app_private.user_can_access_entity(entity_id)'),'bill_payments UPDATE has USING and WITH CHECK');
select extensions.ok(not exists(select 1 from pg_policies where schemaname='public' and tablename='bill_payments' and (policyname='bill_payments_entity_all' or cmd in ('DELETE','ALL'))),'bill_payments has no broad or DELETE policy');

select extensions.ok(pg_temp.policy_matches('supplier_bills','supplier_bills_entity_select','SELECT','app_private.user_can_access_entity(entity_id)',null),'supplier_bills SELECT is entity-scoped');
select extensions.ok(pg_temp.policy_matches('supplier_bills','supplier_bills_entity_insert','INSERT',null,'app_private.user_can_access_entity(entity_id)'),'supplier_bills INSERT is entity-scoped');
select extensions.ok(pg_temp.policy_matches('supplier_bills','supplier_bills_entity_update','UPDATE','app_private.user_can_access_entity(entity_id)','app_private.user_can_access_entity(entity_id)'),'supplier_bills UPDATE has USING and WITH CHECK');
select extensions.ok(not exists(select 1 from pg_policies where schemaname='public' and tablename='supplier_bills' and (policyname='supplier_bills_entity_all' or cmd in ('DELETE','ALL'))),'supplier_bills has no broad or DELETE policy');

select extensions.ok(
  pg_temp.policy_matches(
    'document_links','document_links_manage','UPDATE',
    '(app_private.current_user_can(''can_manage_documents''::text) OR app_private.current_user_is_owner())',
    '(app_private.current_user_can(''can_manage_documents''::text) OR app_private.current_user_is_owner())'
  ),
  'document_links manage policy is UPDATE-only with USING and WITH CHECK'
);
select extensions.ok(
  pg_temp.policy_matches(
    'document_links','document_links_delete','DELETE',
    '(app_private.current_user_can(''can_manage_documents''::text) OR app_private.current_user_is_owner())',
    null
  ),
  'document_links DELETE remains restricted to document managers or owner'
);
select extensions.ok(
  not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='document_links'
      and policyname='document_links_manage' and cmd='ALL'
  ),
  'document_links manage policy is not FOR ALL'
);

select extensions.ok(pg_temp.policy_matches('payment_voucher_sequences','payment_voucher_sequences_owner_select','SELECT','app_private.current_user_is_owner()',null),'voucher sequences retain owner SELECT');
select extensions.ok(pg_temp.policy_matches('payment_voucher_sequences','payment_voucher_sequences_owner_update','ALL','app_private.current_user_is_owner()','app_private.current_user_is_owner()'),'voucher sequences retain the approved owner-only ALL policy');
select extensions.ok(not exists(select 1 from pg_policies where schemaname='public' and tablename='payment_voucher_sequences' and policyname='payment_voucher_sequences_owner'),'legacy voucher-sequence policy name is absent');

select extensions.ok(pg_temp.trigger_matches('bill_payments','set_bill_payments_updated_at','set_phase2_updated_at',19),'bill_payments updated_at trigger is enabled');
select extensions.ok(pg_temp.trigger_matches('document_links','recalculate_document_link_status_trigger','recalculate_document_link_status',29),'document-link recalculation trigger covers insert/update/delete');
select extensions.ok(pg_temp.trigger_matches('documents','set_documents_updated_at','set_phase2_updated_at',19),'documents updated_at trigger is enabled');
select extensions.ok(pg_temp.trigger_matches('finance_user_permissions','set_finance_user_permissions_updated_at','set_phase2_updated_at',19),'finance permission updated_at trigger is enabled');
select extensions.ok(pg_temp.trigger_matches('payment_vouchers','set_payment_vouchers_updated_at','set_phase2_updated_at',19),'payment voucher updated_at trigger is enabled');
select extensions.ok(pg_temp.trigger_matches('recurring_obligations','set_recurring_obligations_updated_at','set_phase2_updated_at',19),'recurring obligation updated_at trigger is enabled');
select extensions.ok(pg_temp.trigger_matches('supplier_bills','set_supplier_bills_updated_at','set_phase2_updated_at',19),'supplier bill updated_at trigger is enabled');

select extensions.ok(
  exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'generate_payment_voucher_number'
      and pg_get_function_identity_arguments(p.oid) = 'p_entity_id uuid'
      and p.prosecdef
      and p.proconfig @> array['search_path=public, auth']
      and pg_get_functiondef(p.oid) like '%current_user_can(''can_generate_payment_vouchers'')%'
      and pg_get_functiondef(p.oid) like '%on conflict%payment_voucher_sequences.last_number + 1%'
      and pg_get_functiondef(p.oid) like '%/PV%'
  ),
  'payment voucher numbering remains permission-checked and database-atomic'
);

select * from extensions.finish();

rollback;
