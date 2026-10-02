-- ============================================================================================
-- 0024 - Finance Payment Register, bank-statement import and payment <-> bank matching.
--
-- STATUS: LOCAL CANDIDATE. NOT APPLIED TO PRODUCTION. Validated only on a disposable local stack.
--   * Adds ONLY new objects. Does not modify 0001-0023, any existing table, policy, trigger or function.
--   * Existing bank_transactions / bank_import_* / reconciliation tables are NOT reused: they are owner/AAL2 +
--     can_view_bank_balances scoped and carry running_balance. This feature needs finance reviewers to read
--     transaction rows WITHOUT balances, so a narrow operational import is added instead (no balance column).
--   * No grant on bill_payments, vouchers, bank accounts, balances or reconciliation tables is changed.
--
-- Principles (all enforced here, not only in the UI):
--   * A Payment Register row is an OPERATIONAL record. It is not bank-cleared, posted or reconciled by itself.
--   * FinanceOps (the registry data_entry identity) may capture and attach evidence. It can never confirm a bank
--     match, mark finance_review / ready_for_sql / posted_to_sql / reconciled, approve a document exception, or
--     set any human-only field.
--   * Bank-statement rows, import batches and matches are readable/writable only by Owner / Finance Manager /
--     Finance Staff, with entity access, and AAL2 (the same bar Stage 1B sets for bank data). Statement rows are
--     insert-only: never updated, never deleted.
--   * Human-stamped columns (reviewed_by, ready_for_sql_by, sql_posted_by, reconciled_by, exception approver, ...)
--     are written by the trigger from auth.uid(), never trusted from the client.
--
-- New objects:
--   tables     finance_payment_register, finance_payment_documents, finance_bank_import_batches,
--              finance_bank_statement_transactions, finance_payment_bank_matches
--   functions  app_private.current_user_is_finance_reviewer()          [SECURITY DEFINER]
--              app_private.current_user_is_financeops_identity()       [SECURITY DEFINER]
--              app_private.finance_payment_has_confirmed_match(uuid)   [SECURITY DEFINER, boolean only]
--              app_private.user_can_access_payment_document_object(text) [SECURITY DEFINER]
--              app_private.finance_payment_missing_documents(...)      [INVOKER]
--              public.enforce_finance_payment_rules(), public.audit_finance_payment_change(),
--              public.enforce_finance_payment_document_rules(), public.enforce_finance_bank_rows(),
--              public.enforce_finance_bank_match_rules(), public.audit_finance_bank_match_change()   [triggers, INVOKER]
--   storage    private bucket finance-payment-documents (+ 2 policies on storage.objects)
-- ============================================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

-- --------------------------------------------------------------------------------------------
-- 0. Preflight
-- --------------------------------------------------------------------------------------------
do $preflight$
begin
  if current_setting('server_version_num')::integer < 150000 then
    raise exception '0024 requires PostgreSQL 15 or newer';
  end if;

  if to_regclass('public.entities') is null
     or to_regclass('public.app_profiles') is null
     or to_regclass('public.supplier_bills') is null
     or to_regclass('public.documents') is null
     or to_regclass('public.audit_logs') is null
     or to_regclass('public.user_entity_access') is null
     or to_regclass('public.finance_intake_submissions') is null
     or to_regclass('public.finance_integration_identities') is null then
    raise exception '0024 preflight failed: expected Finance / 0023 tables are missing';
  end if;

  if to_regprocedure('app_private.current_user_has_app_access()') is null
     or to_regprocedure('app_private.current_user_can(text)') is null
     or to_regprocedure('app_private.user_can_access_entity(uuid)') is null
     or to_regprocedure('app_private.current_user_is_owner()') is null
     or to_regprocedure('app_private.current_user_is_finance_manager()') is null
     or to_regprocedure('app_private.current_user_has_aal2()') is null
     or to_regprocedure('app_private.current_user_is_data_entry()') is null then
    raise exception '0024 preflight failed: Stage 1B (0022) security helpers are missing';
  end if;

  if to_regclass('public.finance_payment_register') is not null
     or to_regclass('public.finance_payment_documents') is not null
     or to_regclass('public.finance_bank_import_batches') is not null
     or to_regclass('public.finance_bank_statement_transactions') is not null
     or to_regclass('public.finance_payment_bank_matches') is not null
     or to_regprocedure('app_private.current_user_is_finance_reviewer()') is not null
     or to_regprocedure('app_private.current_user_is_financeops_identity()') is not null
     or to_regprocedure('app_private.finance_payment_has_confirmed_match(uuid)') is not null
     or to_regprocedure('app_private.finance_payment_missing_documents(uuid,text[],text[],uuid)') is not null then
    raise exception '0024 preflight failed: an object it creates already exists';
  end if;
end
$preflight$;

-- --------------------------------------------------------------------------------------------
-- 1. Role helpers (the only new SECURITY DEFINER surface besides the storage helper)
-- --------------------------------------------------------------------------------------------
create function app_private.current_user_is_finance_reviewer()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.current_user_has_app_access()
    and exists (
      select 1 from public.app_profiles p
      where p.id = auth.uid() and p.active_status = true
        and p.role in ('owner', 'finance_manager', 'finance_staff')
    );
$$;

create function app_private.current_user_is_financeops_identity()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.finance_integration_identities i
    where i.user_id = auth.uid() and i.active_status = true and i.integration = 'financeops'
  );
$$;

-- Existence only (never the match itself): lets the register trigger keep status and matches consistent for a reviewer
-- who is not at AAL2 and therefore cannot read bank rows or matches. Returns false for anyone who is not a reviewer.
create function app_private.finance_payment_has_confirmed_match(p_payment_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- plpgsql so the table (created below) need not exist when this function is created
  return app_private.current_user_is_finance_reviewer()
    and exists (select 1 from public.finance_payment_bank_matches m where m.payment_register_id = p_payment_id and m.status = 'confirmed');
end;
$$;

revoke all on function app_private.current_user_is_finance_reviewer() from public, anon;
revoke all on function app_private.finance_payment_has_confirmed_match(uuid) from public, anon;
grant execute on function app_private.finance_payment_has_confirmed_match(uuid) to authenticated, service_role;
revoke all on function app_private.current_user_is_financeops_identity() from public, anon;
grant execute on function app_private.current_user_is_finance_reviewer() to authenticated, service_role;
grant execute on function app_private.current_user_is_financeops_identity() to authenticated, service_role;

-- --------------------------------------------------------------------------------------------
-- 2. Payment Register
-- --------------------------------------------------------------------------------------------
create table public.finance_payment_register (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete restrict,

  -- provenance / idempotency (intake_id only for FinanceOps captures)
  source_type text not null default 'manual',
  intake_id text,
  payload_hash text,
  integration_key_id text,
  request_id text,
  source jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  suggested_links jsonb not null default '{}'::jsonb,

  -- what it is
  payment_type text not null,
  supplier_bill_id uuid references public.supplier_bills(id) on delete set null,
  claim_ref text,
  payroll_ref text,
  account_code text,

  -- payment details
  payment_instruction_date date not null,
  payment_instruction_time time,
  payment_method text not null default 'bank_transfer',
  pay_from_account_ref text,
  beneficiary_name text,
  beneficiary_account_no text,
  beneficiary_bank text,
  amount numeric(14,2) not null,
  currency text not null default 'MYR',
  bank_reference text,
  purpose text,

  -- documents (requirements are a snapshot from the rules; humans may adjust)
  required_documents text[] not null default '{}',
  not_applicable_documents text[] not null default '{}',
  not_applicable_note text,
  document_exception_note text,
  document_exception_approved_by uuid references auth.users(id) on delete set null,
  document_exception_approved_at timestamptz,

  -- bank match not applicable (e.g. cash): a human decision
  bank_match_not_applicable boolean not null default false,
  bank_match_na_note text,
  bank_match_na_by uuid references auth.users(id) on delete set null,
  bank_match_na_at timestamptz,

  -- lifecycle (one linear status + an orthogonal exception flag)
  status text not null default 'captured',
  needs_attention boolean not null default false,
  attention_reasons text[] not null default '{}',
  notes text,
  followup_note text,

  -- human review / SQL tracking (stamped by the trigger)
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  ready_for_sql_by uuid references auth.users(id) on delete set null,
  ready_for_sql_at timestamptz,
  sql_posting_date date,
  sql_reference text,
  sql_note text,
  sql_posted_by uuid references auth.users(id) on delete set null,
  sql_posted_at timestamptz,
  reconciled_date date,
  reconciled_by uuid references auth.users(id) on delete set null,
  reconciled_at timestamptz,

  -- one-time Excel transition: what the old register said (informational)
  legacy_state jsonb,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint fpr_source_type check (source_type in ('manual', 'financeops', 'excel_import')),
  constraint fpr_payment_type check (payment_type in ('supplier_expense', 'intern_wage', 'staff_claim', 'rent_deposit', 'other')),
  constraint fpr_payment_method check (payment_method in ('bank_transfer', 'duitnow', 'ibg', 'cheque', 'cash', 'card', 'other')),
  constraint fpr_status check (status in ('captured', 'documents_pending', 'ready_for_bank_match', 'bank_match_suggested', 'bank_matched', 'finance_review', 'ready_for_sql', 'posted_to_sql', 'reconciled')),
  constraint fpr_amount check (amount > 0 and amount <= 999999999.99),
  constraint fpr_currency check (currency ~ '^[A-Z]{3}$'),
  constraint fpr_required_docs check (required_documents <@ array['payment_evidence', 'invoice', 'wage_schedule', 'claim_support', 'agreement', 'other_support']::text[]),
  constraint fpr_na_docs check (not_applicable_documents <@ array['payment_evidence', 'invoice', 'wage_schedule', 'claim_support', 'agreement', 'other_support']::text[]),
  constraint fpr_financeops_has_intake check ((source_type = 'financeops') = (intake_id is not null)),
  constraint fpr_intake_id_format check (intake_id is null or intake_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  constraint fpr_payload_hash_format check (payload_hash is null or payload_hash ~ '^[0-9a-f]{64}$'),
  constraint fpr_payload_size check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 65536),
  constraint fpr_source_is_object check (jsonb_typeof(source) = 'object' and jsonb_typeof(suggested_links) = 'object'),
  constraint fpr_text_sizes check (
    coalesce(length(beneficiary_name), 0) <= 200 and coalesce(length(beneficiary_account_no), 0) <= 64
    and coalesce(length(beneficiary_bank), 0) <= 120 and coalesce(length(bank_reference), 0) <= 120
    and coalesce(length(purpose), 0) <= 500 and coalesce(length(notes), 0) <= 2000 and coalesce(length(followup_note), 0) <= 2000
    and coalesce(length(sql_reference), 0) <= 120 and coalesce(length(sql_note), 0) <= 1000 and coalesce(length(pay_from_account_ref), 0) <= 120
    and coalesce(length(document_exception_note), 0) <= 1000 and coalesce(length(not_applicable_note), 0) <= 1000
    and coalesce(length(bank_match_na_note), 0) <= 1000 and coalesce(length(claim_ref), 0) <= 120 and coalesce(length(payroll_ref), 0) <= 120
    and coalesce(length(account_code), 0) <= 60
  ),
  constraint fpr_attention_size check (cardinality(attention_reasons) <= 32)
);

create unique index fpr_intake_id_uidx on public.finance_payment_register (intake_id) where intake_id is not null;
create index fpr_entity_status_idx on public.finance_payment_register (entity_id, status, payment_instruction_date desc);
create index fpr_attention_idx on public.finance_payment_register (entity_id) where needs_attention;
create index fpr_supplier_bill_idx on public.finance_payment_register (supplier_bill_id) where supplier_bill_id is not null;
create index fpr_created_by_idx on public.finance_payment_register (created_by);

-- --------------------------------------------------------------------------------------------
-- 3. Payment documents (own table + own private bucket; does not touch documents / document_links)
-- --------------------------------------------------------------------------------------------
create table public.finance_payment_documents (
  id uuid primary key default gen_random_uuid(),
  payment_register_id uuid not null references public.finance_payment_register(id) on delete restrict,
  entity_id uuid not null references public.entities(id) on delete restrict,
  doc_role text not null,
  storage_path text not null,
  original_filename text not null,
  mime_type text not null,
  file_size integer not null,
  file_hash text not null,
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references auth.users(id) on delete set null,
  removal_reason text,
  constraint fpd_role check (doc_role in ('payment_evidence', 'invoice', 'wage_schedule', 'claim_support', 'agreement', 'other_support')),
  constraint fpd_mime check (mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
  constraint fpd_size check (file_size between 1 and 10485760),
  constraint fpd_hash check (file_hash ~ '^[0-9a-f]{64}$'),
  -- one stored file may support several payments (e.g. one wage schedule for ten intern payments): unique per payment, not globally
  constraint fpd_storage_path_key unique (payment_register_id, storage_path),
  constraint fpd_removal_pair check ((removed_at is null) = (removal_reason is null)),
  constraint fpd_filename_len check (length(original_filename) between 1 and 255)
);
create unique index fpd_live_hash_uidx on public.finance_payment_documents (payment_register_id, file_hash) where removed_at is null;
create index fpd_payment_idx on public.finance_payment_documents (payment_register_id, doc_role) where removed_at is null;

-- --------------------------------------------------------------------------------------------
-- 4. Bank-statement import (operational; NO balance column) and matches
-- --------------------------------------------------------------------------------------------
create table public.finance_bank_import_batches (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete restrict,
  company_account_ref text not null,
  bank_name text,
  filename text not null,
  file_type text not null,
  file_hash text not null,
  total_rows integer not null default 0,
  imported_rows integer not null default 0,
  skipped_rows integer not null default 0,
  mapping jsonb not null default '{}'::jsonb,
  summary jsonb not null default '{}'::jsonb,
  imported_by uuid references auth.users(id) on delete set null,
  imported_at timestamptz not null default now(),
  constraint fbb_file_type check (file_type in ('csv', 'xlsx', 'pasted', 'pdf_listing')),
  constraint fbb_file_hash check (file_hash ~ '^[0-9a-f]{64}$'),
  constraint fbb_account_ref_len check (length(btrim(company_account_ref)) between 1 and 120),
  constraint fbb_counts check (total_rows >= 0 and imported_rows >= 0 and skipped_rows >= 0 and imported_rows + skipped_rows <= total_rows)
);
create unique index fbb_file_uidx on public.finance_bank_import_batches (entity_id, company_account_ref, file_hash);

create table public.finance_bank_statement_transactions (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.finance_bank_import_batches(id) on delete restrict,
  entity_id uuid not null references public.entities(id) on delete restrict,
  company_account_ref text not null,
  row_number integer not null,
  transaction_date date not null,
  transaction_time time,
  direction text not null,
  amount numeric(14,2) not null,
  currency text not null default 'MYR',
  bank_reference text,
  description text,
  payee_name text,
  beneficiary_account_no text,
  beneficiary_bank text,
  fingerprint text not null,
  created_at timestamptz not null default now(),
  constraint fbt_direction check (direction in ('debit', 'credit')),
  constraint fbt_amount check (amount > 0 and amount <= 999999999.99),
  constraint fbt_currency check (currency ~ '^[A-Z]{3}$'),
  constraint fbt_fingerprint check (fingerprint ~ '^[0-9a-f]{64}$'),
  constraint fbt_text_sizes check (
    coalesce(length(description), 0) <= 1000 and coalesce(length(payee_name), 0) <= 200
    and coalesce(length(bank_reference), 0) <= 120 and coalesce(length(beneficiary_account_no), 0) <= 64 and coalesce(length(beneficiary_bank), 0) <= 120
  ),
  constraint fbt_batch_row_key unique (batch_id, row_number)
);
create index fbt_entity_date_idx on public.finance_bank_statement_transactions (entity_id, transaction_date desc);
create index fbt_fingerprint_idx on public.finance_bank_statement_transactions (entity_id, company_account_ref, fingerprint);

create table public.finance_payment_bank_matches (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete restrict,
  payment_register_id uuid not null references public.finance_payment_register(id) on delete restrict,
  bank_transaction_id uuid not null references public.finance_bank_statement_transactions(id) on delete restrict,
  status text not null default 'suggested',
  score integer not null default 0,
  reasons jsonb not null default '[]'::jsonb,
  match_method text,
  review_later boolean not null default false,
  suggested_by uuid references auth.users(id) on delete set null,
  suggested_at timestamptz not null default now(),
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamptz,
  rejected_by uuid references auth.users(id) on delete set null,
  rejected_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fbm_status check (status in ('suggested', 'confirmed', 'rejected')),
  constraint fbm_score check (score between 0 and 100),
  constraint fbm_reasons_array check (jsonb_typeof(reasons) = 'array'),
  constraint fbm_method check (match_method is null or match_method in ('manual', 'suggested_confirmed')),
  constraint fbm_confirmed_has_method check (status <> 'confirmed' or (match_method is not null and confirmed_by is not null and confirmed_at is not null)),
  constraint fbm_pair_key unique (payment_register_id, bank_transaction_id),
  constraint fbm_note_len check (coalesce(length(note), 0) <= 1000)
);
-- one-to-one first: a payment has at most one confirmed match, and a bank row is confirmed to at most one payment
create unique index fbm_one_confirmed_per_payment on public.finance_payment_bank_matches (payment_register_id) where status = 'confirmed';
create unique index fbm_one_confirmed_per_bank_row on public.finance_payment_bank_matches (bank_transaction_id) where status = 'confirmed';
create index fbm_open_idx on public.finance_payment_bank_matches (entity_id, status);

-- --------------------------------------------------------------------------------------------
-- 5. Missing documents (INVOKER: runs under the caller's own RLS)
-- --------------------------------------------------------------------------------------------
create function app_private.finance_payment_missing_documents(
  p_payment_id uuid, p_required text[], p_not_applicable text[], p_supplier_bill_id uuid
)
returns text[]
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(array_agg(r.role order by r.role), '{}'::text[])
  from unnest(coalesce(p_required, '{}'::text[])) as r(role)
  where r.role <> all (coalesce(p_not_applicable, '{}'::text[]))
    and not exists (
      select 1 from public.finance_payment_documents d
      where d.payment_register_id = p_payment_id and d.doc_role = r.role and d.removed_at is null
    )
    and not (
      r.role = 'invoice' and p_supplier_bill_id is not null and exists (
        select 1 from public.supplier_bills b
        where b.id = p_supplier_bill_id and b.supporting_document_status in ('invoice_uploaded', 'complete')
      )
    );
$$;
revoke all on function app_private.finance_payment_missing_documents(uuid, text[], text[], uuid) from public, anon;
grant execute on function app_private.finance_payment_missing_documents(uuid, text[], text[], uuid) to authenticated, service_role;

-- --------------------------------------------------------------------------------------------
-- 6. Payment Register row rules (SECURITY INVOKER: every read is under the caller's own RLS)
-- --------------------------------------------------------------------------------------------
create function public.enforce_finance_payment_rules()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  is_fo boolean;
  is_reviewer boolean;
  is_owner_fm boolean;
  early text[] := array['captured', 'documents_pending', 'ready_for_bank_match', 'bank_match_suggested'];
  fo_early text[] := array['captured', 'documents_pending', 'ready_for_bank_match'];
  has_confirmed boolean;
  missing text[];
  registry_ids uuid[];
  detail_changed boolean;
  human_only_changed boolean;
begin
  -- Referential SET NULL actions (a draft bill or an auth user was deleted) run as nested triggers (depth > 1).
  -- They may only null the supplier-bill link and the actor references; nothing else may change.
  if tg_op = 'UPDATE' and pg_catalog.pg_trigger_depth() > 1 then
    if (new.supplier_bill_id is not null and new.supplier_bill_id is distinct from old.supplier_bill_id)
       or (pg_catalog.to_jsonb(new) - array['supplier_bill_id', 'created_by', 'reviewed_by', 'ready_for_sql_by', 'sql_posted_by', 'reconciled_by',
            'document_exception_approved_by', 'bank_match_na_by', 'updated_at']::text[])
          is distinct from
          (pg_catalog.to_jsonb(old) - array['supplier_bill_id', 'created_by', 'reviewed_by', 'ready_for_sql_by', 'sql_posted_by', 'reconciled_by',
            'document_exception_approved_by', 'bank_match_na_by', 'updated_at']::text[]) then
      raise exception 'Nested updates may only clear the supplier-bill link and actor references';
    end if;
    new.updated_at := now();
    return new;
  end if;

  if actor is null then
    raise exception 'Payment register changes require an authenticated user';
  end if;

  is_fo := app_private.current_user_is_financeops_identity();
  is_reviewer := app_private.current_user_is_finance_reviewer();
  is_owner_fm := app_private.current_user_is_owner() or app_private.current_user_is_finance_manager();

  ---------------------------------------------------------------- INSERT
  if tg_op = 'INSERT' then
    if new.created_by is distinct from actor then
      raise exception 'created_by must be the authenticated user';
    end if;
    new.created_at := now();
    new.updated_at := now();

    if is_fo then
      if not app_private.current_user_is_data_entry() then
        raise exception 'The FinanceOps integration identity must be a data_entry user';
      end if;
      select i.allowed_entity_ids into registry_ids from public.finance_integration_identities i
        where i.user_id = actor and i.active_status = true and i.integration = 'financeops';
      if not (new.entity_id = any (coalesce(registry_ids, '{}'::uuid[]))) then
        raise exception 'The FinanceOps identity may not capture payments for this entity';
      end if;
      if new.source_type <> 'financeops' then
        raise exception 'The FinanceOps identity creates financeops-sourced records only';
      end if;
      if new.status <> all (fo_early) then
        raise exception 'FinanceOps may only capture a payment as captured, documents_pending or ready_for_bank_match';
      end if;
    else
      if new.source_type = 'financeops' then
        raise exception 'Only the FinanceOps integration identity may create financeops-sourced records';
      end if;
      if new.source_type = 'excel_import' then
        -- One-time transition of the old Excel register: a closed historical row may carry its later status, but only
        -- when imported by the Owner or a Finance Manager. Everyone else imports as an early status.
        if new.status <> all (early) and not is_owner_fm then
          raise exception 'Only the Owner or a Finance Manager may import historical payments at a later status';
        end if;
        if not (is_reviewer or app_private.current_user_is_data_entry()) then
          raise exception 'Not permitted to import payments';
        end if;
      else
        if new.status <> all (fo_early) then
          raise exception 'A payment is captured as captured, documents_pending or ready_for_bank_match';
        end if;
      end if;
    end if;

    -- Human-only fields cannot be supplied at creation (except the historical Excel import by Owner / Finance Manager).
    if not (new.source_type = 'excel_import' and is_owner_fm) then
      if new.supplier_bill_id is not null and (is_fo) then raise exception 'FinanceOps cannot set the supplier bill link'; end if;
      if new.reviewed_by is not null or new.reviewed_at is not null or new.ready_for_sql_by is not null or new.ready_for_sql_at is not null
         or new.sql_posting_date is not null or new.sql_reference is not null or new.sql_note is not null or new.sql_posted_by is not null or new.sql_posted_at is not null
         or new.reconciled_date is not null or new.reconciled_by is not null or new.reconciled_at is not null
         or new.document_exception_note is not null or new.document_exception_approved_by is not null or new.document_exception_approved_at is not null
         or new.bank_match_not_applicable or new.bank_match_na_note is not null or new.bank_match_na_by is not null or new.bank_match_na_at is not null
         or cardinality(new.not_applicable_documents) > 0 or new.not_applicable_note is not null then
        raise exception 'A new payment cannot carry review, exception, not-applicable or SQL posting fields';
      end if;
    else
      -- Historical import by the Owner / a Finance Manager: dates, references and the status may be supplied, but the
      -- actor stamps never are. An exception note (e.g. "documents are held outside the Hub") is stamped as approved by the importer.
      new.reviewed_by := null; new.reviewed_at := null; new.ready_for_sql_by := null; new.ready_for_sql_at := null;
      new.sql_posted_by := null; new.sql_posted_at := null; new.reconciled_by := null; new.reconciled_at := null;
      new.bank_match_na_by := null; new.bank_match_na_at := null;
      if new.document_exception_note is not null and btrim(new.document_exception_note) <> '' then
        new.document_exception_approved_by := actor; new.document_exception_approved_at := now();
      else
        new.document_exception_note := null; new.document_exception_approved_by := null; new.document_exception_approved_at := null;
      end if;
    end if;
    return new;
  end if;

  ---------------------------------------------------------------- UPDATE: immutable provenance
  if new.id is distinct from old.id
     or new.entity_id is distinct from old.entity_id
     or new.source_type is distinct from old.source_type
     or new.intake_id is distinct from old.intake_id
     or new.payload_hash is distinct from old.payload_hash
     or new.integration_key_id is distinct from old.integration_key_id
     or new.request_id is distinct from old.request_id
     or new.source is distinct from old.source
     or new.payload is distinct from old.payload
     or new.legacy_state is distinct from old.legacy_state
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Payment register provenance columns are immutable';
  end if;
  new.updated_at := now();

  detail_changed :=
       new.payment_type is distinct from old.payment_type
    or new.supplier_bill_id is distinct from old.supplier_bill_id
    or new.claim_ref is distinct from old.claim_ref or new.payroll_ref is distinct from old.payroll_ref or new.account_code is distinct from old.account_code
    or new.payment_instruction_date is distinct from old.payment_instruction_date or new.payment_instruction_time is distinct from old.payment_instruction_time
    or new.payment_method is distinct from old.payment_method or new.pay_from_account_ref is distinct from old.pay_from_account_ref
    or new.beneficiary_name is distinct from old.beneficiary_name or new.beneficiary_account_no is distinct from old.beneficiary_account_no
    or new.beneficiary_bank is distinct from old.beneficiary_bank or new.amount is distinct from old.amount or new.currency is distinct from old.currency
    or new.bank_reference is distinct from old.bank_reference or new.purpose is distinct from old.purpose
    or new.required_documents is distinct from old.required_documents;

  human_only_changed :=
       new.not_applicable_documents is distinct from old.not_applicable_documents or new.not_applicable_note is distinct from old.not_applicable_note
    or new.document_exception_note is distinct from old.document_exception_note
    or new.bank_match_not_applicable is distinct from old.bank_match_not_applicable or new.bank_match_na_note is distinct from old.bank_match_na_note
    or new.sql_posting_date is distinct from old.sql_posting_date or new.sql_reference is distinct from old.sql_reference or new.sql_note is distinct from old.sql_note
    or new.reconciled_date is distinct from old.reconciled_date;

  -- Stamps are never written by clients: restore them, then re-apply below on the transitions that own them.
  new.reviewed_by := old.reviewed_by; new.reviewed_at := old.reviewed_at;
  new.ready_for_sql_by := old.ready_for_sql_by; new.ready_for_sql_at := old.ready_for_sql_at;
  new.sql_posted_by := old.sql_posted_by; new.sql_posted_at := old.sql_posted_at;
  new.reconciled_by := old.reconciled_by; new.reconciled_at := old.reconciled_at;
  new.document_exception_approved_by := old.document_exception_approved_by; new.document_exception_approved_at := old.document_exception_approved_at;
  new.bank_match_na_by := old.bank_match_na_by; new.bank_match_na_at := old.bank_match_na_at;

  ---------------------------------------------------------------- FinanceOps: mechanical columns only, own rows only
  if is_fo then
    if old.created_by is distinct from actor or old.source_type <> 'financeops' then
      raise exception 'The FinanceOps identity may only update the payments it captured itself';
    end if;
    if detail_changed or human_only_changed then
      raise exception 'The FinanceOps identity cannot edit payment details or human-only fields';
    end if;
    if new.status is distinct from old.status and (new.status <> all (fo_early) or old.status <> all (early)) then
      raise exception 'The FinanceOps identity can only move its own payment between captured, documents_pending and ready_for_bank_match';
    end if;
    if new.notes is distinct from old.notes or new.followup_note is distinct from old.followup_note then
      raise exception 'The FinanceOps identity cannot write review notes';
    end if;
    return new;
  end if;

  ---------------------------------------------------------------- Humans
  if old.status in ('finance_review', 'ready_for_sql', 'posted_to_sql', 'reconciled') and detail_changed then
    raise exception 'Payment details are locked once the payment is in finance review; return it to bank_matched to edit';
  end if;

  if not is_reviewer then
    -- the data_entry intern: details and notes while the payment is still early; never the human-only fields
    if human_only_changed then
      raise exception 'Only Owner, Finance Manager or Finance Staff may set exception, not-applicable or SQL fields';
    end if;
    if new.status is distinct from old.status then
      if new.status <> all (fo_early) or old.status <> all (early) then
        raise exception 'Only Owner, Finance Manager or Finance Staff may move a payment past ready_for_bank_match';
      end if;
    end if;
    if old.status <> all (early) and detail_changed then
      raise exception 'Payment details can no longer be edited at this stage';
    end if;
    return new;
  end if;

  -- reviewer stamps for human decisions
  if new.document_exception_note is distinct from old.document_exception_note then
    if new.document_exception_note is null or btrim(new.document_exception_note) = '' then
      new.document_exception_note := null; new.document_exception_approved_by := null; new.document_exception_approved_at := null;
    else
      new.document_exception_approved_by := actor; new.document_exception_approved_at := now();
    end if;
  end if;
  if new.bank_match_not_applicable is distinct from old.bank_match_not_applicable or new.bank_match_na_note is distinct from old.bank_match_na_note then
    if new.bank_match_not_applicable then
      if new.bank_match_na_note is null or length(btrim(new.bank_match_na_note)) < 3 then
        raise exception 'A note is required when a bank match is marked not applicable';
      end if;
      new.bank_match_na_by := actor; new.bank_match_na_at := now();
    else
      new.bank_match_na_note := null; new.bank_match_na_by := null; new.bank_match_na_at := null;
    end if;
  end if;

  if new.status is not distinct from old.status then
    if old.status in ('posted_to_sql', 'reconciled') and (human_only_changed and (new.sql_reference is distinct from old.sql_reference or new.sql_posting_date is distinct from old.sql_posting_date)) and not is_owner_fm then
      raise exception 'Only the Owner or a Finance Manager may change a recorded SQL reference or posting date';
    end if;
    return new;
  end if;

  ---------------------------------------------------------------- Status transitions by a reviewer
  has_confirmed := app_private.finance_payment_has_confirmed_match(new.id);

  if new.status = 'finance_review' and old.status = any (early) and not new.bank_match_not_applicable then
    raise exception 'Finance review needs a confirmed bank match or a bank-match-not-applicable decision';
  end if;

  if old.status = any (early) and new.status = any (early) then
    return new;

  elsif old.status = any (early) and new.status = 'bank_matched' then
    if not has_confirmed then
      raise exception 'A payment can only be bank_matched once a human has confirmed a bank match';
    end if;
    return new;

  elsif old.status = 'bank_matched' and new.status = 'ready_for_bank_match' then
    if has_confirmed then
      raise exception 'Reject the confirmed bank match before returning the payment to ready_for_bank_match';
    end if;
    return new;

  elsif new.status = 'finance_review' and (old.status = 'bank_matched' or (old.status = any (early) and new.bank_match_not_applicable)) then
    if not (has_confirmed or new.bank_match_not_applicable) then
      raise exception 'Finance review needs a confirmed bank match or a bank-match-not-applicable decision';
    end if;
    missing := app_private.finance_payment_missing_documents(new.id, new.required_documents, new.not_applicable_documents, new.supplier_bill_id);
    if cardinality(missing) > 0 and new.document_exception_approved_at is null then
      raise exception 'Required documents are missing (%): attach them or approve an exception', array_to_string(missing, ', ');
    end if;
    new.reviewed_by := actor; new.reviewed_at := now();
    return new;

  elsif old.status = 'finance_review' and new.status in ('bank_matched', 'ready_for_bank_match') then
    if new.status = 'bank_matched' and not has_confirmed then
      raise exception 'There is no confirmed bank match to return to bank_matched';
    end if;
    if new.status = 'ready_for_bank_match' and has_confirmed then
      raise exception 'Reject the confirmed bank match first';
    end if;
    return new;

  elsif old.status = 'finance_review' and new.status = 'ready_for_sql' then
    if not (has_confirmed or new.bank_match_not_applicable) then
      raise exception 'Ready for SQL needs a confirmed bank match or a bank-match-not-applicable decision';
    end if;
    missing := app_private.finance_payment_missing_documents(new.id, new.required_documents, new.not_applicable_documents, new.supplier_bill_id);
    if cardinality(missing) > 0 and new.document_exception_approved_at is null then
      raise exception 'Required documents are missing (%): attach them or approve an exception', array_to_string(missing, ', ');
    end if;
    new.ready_for_sql_by := actor; new.ready_for_sql_at := now();
    return new;

  elsif old.status = 'ready_for_sql' and new.status = 'finance_review' then
    return new;

  elsif old.status = 'ready_for_sql' and new.status = 'posted_to_sql' then
    if new.sql_reference is null or btrim(new.sql_reference) = '' or new.sql_posting_date is null then
      raise exception 'Posted to SQL needs the SQL reference and the SQL posting date';
    end if;
    new.sql_posted_by := actor; new.sql_posted_at := now();
    return new;

  elsif old.status = 'posted_to_sql' and new.status = 'reconciled' then
    if new.reconciled_date is null then
      raise exception 'Reconciled needs the reconciliation date';
    end if;
    new.reconciled_by := actor; new.reconciled_at := now();
    return new;

  elsif old.status = 'posted_to_sql' and new.status = 'ready_for_sql' then
    if not is_owner_fm then raise exception 'Only the Owner or a Finance Manager may reverse a posting'; end if;
    new.sql_posted_by := null; new.sql_posted_at := null;
    return new;

  elsif old.status = 'reconciled' and new.status = 'posted_to_sql' then
    if not is_owner_fm then raise exception 'Only the Owner or a Finance Manager may reverse a reconciliation'; end if;
    new.reconciled_by := null; new.reconciled_at := null; new.reconciled_date := null;
    return new;
  end if;

  raise exception 'Invalid payment status transition % -> %', old.status, new.status;
end;
$$;

create trigger fpr_enforce_rules
before insert or update on public.finance_payment_register
for each row execute function public.enforce_finance_payment_rules();

create function public.audit_finance_payment_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.audit_logs (actor_user_id, action, entity_type, entity_id, payload, is_demo, data_origin)
    values (
      auth.uid(), 'finance_payment_captured', 'finance_payment', new.entity_id,
      pg_catalog.jsonb_build_object('payment_register_id', new.id, 'source_type', new.source_type, 'intake_id', new.intake_id,
        'payment_type', new.payment_type, 'amount', new.amount, 'currency', new.currency, 'status', new.status,
        'payload_hash', new.payload_hash, 'request_id', new.request_id),
      false, case when new.source_type = 'manual' then 'manual' else 'imported' end
    );
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.audit_logs (actor_user_id, action, entity_type, entity_id, payload, before_data, after_data, is_demo, data_origin)
    values (
      auth.uid(), 'finance_payment_' || new.status, 'finance_payment', new.entity_id,
      pg_catalog.jsonb_build_object('payment_register_id', new.id, 'sql_reference', new.sql_reference, 'sql_posting_date', new.sql_posting_date, 'reconciled_date', new.reconciled_date),
      pg_catalog.jsonb_build_object('status', old.status), pg_catalog.jsonb_build_object('status', new.status),
      false, 'manual'
    );
  end if;
  if new.document_exception_approved_at is distinct from old.document_exception_approved_at and new.document_exception_approved_at is not null then
    insert into public.audit_logs (actor_user_id, action, entity_type, entity_id, payload, is_demo, data_origin)
    values (auth.uid(), 'finance_payment_document_exception_approved', 'finance_payment', new.entity_id,
      pg_catalog.jsonb_build_object('payment_register_id', new.id, 'note', new.document_exception_note), false, 'manual');
  end if;
  if new.bank_match_not_applicable is distinct from old.bank_match_not_applicable then
    insert into public.audit_logs (actor_user_id, action, entity_type, entity_id, payload, is_demo, data_origin)
    values (auth.uid(), case when new.bank_match_not_applicable then 'finance_payment_bank_match_not_applicable' else 'finance_payment_bank_match_applicable_restored' end,
      'finance_payment', new.entity_id, pg_catalog.jsonb_build_object('payment_register_id', new.id, 'note', new.bank_match_na_note), false, 'manual');
  end if;
  return new;
end;
$$;

create trigger fpr_audit_changes
after insert or update on public.finance_payment_register
for each row execute function public.audit_finance_payment_change();

-- --------------------------------------------------------------------------------------------
-- 7. Payment document rules (+ audit)
-- --------------------------------------------------------------------------------------------
create function public.enforce_finance_payment_document_rules()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  reg public.finance_payment_register%rowtype;
begin
  if pg_catalog.pg_trigger_depth() > 1 and tg_op = 'UPDATE' then
    -- uploader reference nulled by a deleted auth user
    if (pg_catalog.to_jsonb(new) - array['uploaded_by', 'removed_by']::text[]) is distinct from (pg_catalog.to_jsonb(old) - array['uploaded_by', 'removed_by']::text[]) then
      raise exception 'Nested updates may only clear actor references';
    end if;
    return new;
  end if;
  if actor is null then raise exception 'Payment documents require an authenticated user'; end if;

  if tg_op = 'INSERT' then
    select * into reg from public.finance_payment_register r where r.id = new.payment_register_id;
    if not found then raise exception 'The payment was not found'; end if;
    if reg.entity_id is distinct from new.entity_id then raise exception 'The document must belong to the payment''s entity'; end if;
    if new.uploaded_by is distinct from actor then raise exception 'uploaded_by must be the authenticated user'; end if;
    if new.removed_at is not null or new.removed_by is not null or new.removal_reason is not null then
      raise exception 'A new document cannot be created as removed';
    end if;
    if app_private.current_user_is_financeops_identity() and reg.created_by is distinct from actor then
      raise exception 'The FinanceOps identity may only attach documents to payments it captured';
    end if;
    -- the object must live under the entity folder, so storage access follows the entity
    if split_part(new.storage_path, '/', 1) <> new.entity_id::text then
      raise exception 'The storage path must start with the entity id';
    end if;
    new.uploaded_at := now();
    return new;
  end if;

  -- UPDATE: soft removal only, by a reviewer, with a reason; nothing else may change
  if new.id is distinct from old.id or new.payment_register_id is distinct from old.payment_register_id or new.entity_id is distinct from old.entity_id
     or new.doc_role is distinct from old.doc_role or new.storage_path is distinct from old.storage_path or new.original_filename is distinct from old.original_filename
     or new.mime_type is distinct from old.mime_type or new.file_size is distinct from old.file_size or new.file_hash is distinct from old.file_hash
     or new.uploaded_by is distinct from old.uploaded_by or new.uploaded_at is distinct from old.uploaded_at then
    raise exception 'Payment document facts are immutable';
  end if;
  if old.removed_at is not null then raise exception 'A removed document cannot be changed'; end if;
  if new.removed_at is null then return new; end if;
  if not app_private.current_user_is_finance_reviewer() then
    raise exception 'Only Owner, Finance Manager or Finance Staff may remove a payment document';
  end if;
  new.removed_at := now(); new.removed_by := actor;
  return new;
end;
$$;
create trigger fpd_enforce_rules
before insert or update on public.finance_payment_documents
for each row execute function public.enforce_finance_payment_document_rules();

create function public.audit_finance_payment_document_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.audit_logs (actor_user_id, action, entity_type, entity_id, payload, is_demo, data_origin)
    values (auth.uid(), 'finance_payment_document_attached', 'finance_payment', new.entity_id,
      pg_catalog.jsonb_build_object('payment_register_id', new.payment_register_id, 'document_id', new.id, 'doc_role', new.doc_role, 'file_hash', new.file_hash), false, 'imported');
  elsif new.removed_at is not null and old.removed_at is null then
    insert into public.audit_logs (actor_user_id, action, entity_type, entity_id, payload, is_demo, data_origin)
    values (auth.uid(), 'finance_payment_document_removed', 'finance_payment', new.entity_id,
      pg_catalog.jsonb_build_object('payment_register_id', new.payment_register_id, 'document_id', new.id, 'reason', new.removal_reason), false, 'manual');
  end if;
  return new;
end;
$$;
create trigger fpd_audit_changes
after insert or update on public.finance_payment_documents
for each row execute function public.audit_finance_payment_document_change();

-- --------------------------------------------------------------------------------------------
-- 8. Bank import rows are insert-only and must agree with their batch
-- --------------------------------------------------------------------------------------------
create function public.enforce_finance_bank_rows()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  b public.finance_bank_import_batches%rowtype;
begin
  if actor is null then raise exception 'Bank import requires an authenticated user'; end if;
  if tg_op = 'INSERT' and tg_table_name = 'finance_bank_import_batches' then
    if new.imported_by is distinct from actor then raise exception 'imported_by must be the authenticated user'; end if;
    new.imported_at := now();
    return new;
  end if;
  if tg_op = 'INSERT' and tg_table_name = 'finance_bank_statement_transactions' then
    select * into b from public.finance_bank_import_batches x where x.id = new.batch_id;
    if not found then raise exception 'The import batch was not found'; end if;
    if b.entity_id is distinct from new.entity_id or b.company_account_ref is distinct from new.company_account_ref then
      raise exception 'A statement row must agree with its batch (entity and company account)';
    end if;
    new.created_at := now();
    return new;
  end if;
  raise exception 'Bank statement imports are insert-only';
end;
$$;
create trigger fbb_enforce_rows before insert or update on public.finance_bank_import_batches
for each row execute function public.enforce_finance_bank_rows();
create trigger fbt_enforce_rows before insert or update on public.finance_bank_statement_transactions
for each row execute function public.enforce_finance_bank_rows();

create function public.audit_finance_bank_batch()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.audit_logs (actor_user_id, action, entity_type, entity_id, payload, is_demo, data_origin)
  values (auth.uid(), 'finance_bank_import_batch_created', 'finance_bank_import', new.entity_id,
    pg_catalog.jsonb_build_object('batch_id', new.id, 'filename', new.filename, 'file_hash', new.file_hash, 'company_account_ref', new.company_account_ref,
      'total_rows', new.total_rows, 'imported_rows', new.imported_rows, 'skipped_rows', new.skipped_rows), false, 'imported');
  return new;
end;
$$;
create trigger fbb_audit after insert on public.finance_bank_import_batches
for each row execute function public.audit_finance_bank_batch();

-- --------------------------------------------------------------------------------------------
-- 9. Match rules: humans confirm; nobody else can
-- --------------------------------------------------------------------------------------------
create function public.enforce_finance_bank_match_rules()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  pay public.finance_payment_register%rowtype;
  tx public.finance_bank_statement_transactions%rowtype;
begin
  if actor is null then raise exception 'Bank matching requires an authenticated user'; end if;
  if not app_private.current_user_is_finance_reviewer() then
    raise exception 'Only Owner, Finance Manager or Finance Staff may suggest, confirm or reject bank matches';
  end if;

  if tg_op = 'INSERT' then
    select * into pay from public.finance_payment_register r where r.id = new.payment_register_id;
    if not found then raise exception 'The payment was not found'; end if;
    select * into tx from public.finance_bank_statement_transactions t where t.id = new.bank_transaction_id;
    if not found then raise exception 'The bank transaction was not found'; end if;
    if pay.entity_id is distinct from new.entity_id or tx.entity_id is distinct from new.entity_id then
      raise exception 'A match must stay within one entity';
    end if;
    if tx.direction <> 'debit' then raise exception 'Only a bank debit can be matched to a payment'; end if;
    if pay.status not in ('captured', 'documents_pending', 'ready_for_bank_match', 'bank_match_suggested') then
      raise exception 'Only a payment that is not yet bank_matched can receive a match';
    end if;
    if new.status not in ('suggested', 'confirmed') then raise exception 'A new match is suggested or confirmed'; end if;
    new.suggested_by := actor; new.suggested_at := now(); new.created_at := now(); new.updated_at := now();
    if new.status = 'confirmed' then
      new.match_method := 'manual'; new.confirmed_by := actor; new.confirmed_at := now();
    else
      new.match_method := null; new.confirmed_by := null; new.confirmed_at := null;
    end if;
    new.rejected_by := null; new.rejected_at := null;
    return new;
  end if;

  -- UPDATE
  if new.id is distinct from old.id or new.entity_id is distinct from old.entity_id or new.payment_register_id is distinct from old.payment_register_id
     or new.bank_transaction_id is distinct from old.bank_transaction_id or new.score is distinct from old.score or new.reasons is distinct from old.reasons
     or new.suggested_by is distinct from old.suggested_by or new.suggested_at is distinct from old.suggested_at or new.created_at is distinct from old.created_at then
    raise exception 'A match''s pair, score and reasons are immutable';
  end if;
  new.updated_at := now();
  new.confirmed_by := old.confirmed_by; new.confirmed_at := old.confirmed_at; new.rejected_by := old.rejected_by; new.rejected_at := old.rejected_at; new.match_method := old.match_method;

  if new.status is not distinct from old.status then
    if old.status = 'confirmed' and new.review_later then raise exception 'A confirmed match cannot be marked review-later'; end if;
    return new;
  end if;

  select * into pay from public.finance_payment_register r where r.id = new.payment_register_id;
  if old.status = 'suggested' and new.status = 'confirmed' then
    if pay.status not in ('captured', 'documents_pending', 'ready_for_bank_match', 'bank_match_suggested') then
      raise exception 'Only a payment that is not yet bank_matched can be confirmed';
    end if;
    new.match_method := 'suggested_confirmed'; new.confirmed_by := actor; new.confirmed_at := now(); new.review_later := false;
  elsif old.status in ('suggested', 'confirmed') and new.status = 'rejected' then
    if old.status = 'confirmed' and pay.status not in ('bank_matched', 'captured', 'documents_pending', 'ready_for_bank_match', 'bank_match_suggested') then
      raise exception 'Return the payment to bank_matched before unmatching it';
    end if;
    new.rejected_by := actor; new.rejected_at := now(); new.match_method := null; new.confirmed_by := null; new.confirmed_at := null; new.review_later := false;
  elsif old.status = 'rejected' and new.status = 'suggested' then
    new.rejected_by := null; new.rejected_at := null;
  else
    raise exception 'Invalid match status transition % -> %', old.status, new.status;
  end if;
  return new;
end;
$$;
create trigger fbm_enforce_rules before insert or update on public.finance_payment_bank_matches
for each row execute function public.enforce_finance_bank_match_rules();

create function public.audit_finance_bank_match_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and new.status = 'suggested' then
    return new; -- engine suggestions are not audited one by one (noise); decisions below are
  end if;
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.audit_logs (actor_user_id, action, entity_type, entity_id, payload, before_data, after_data, is_demo, data_origin)
    values (auth.uid(), 'finance_bank_match_' || new.status, 'finance_payment', new.entity_id,
      pg_catalog.jsonb_build_object('match_id', new.id, 'payment_register_id', new.payment_register_id, 'bank_transaction_id', new.bank_transaction_id,
        'score', new.score, 'method', new.match_method, 'note', new.note),
      case when tg_op = 'UPDATE' then pg_catalog.jsonb_build_object('status', old.status) else null end,
      pg_catalog.jsonb_build_object('status', new.status), false, 'manual');
  end if;
  return new;
end;
$$;
create trigger fbm_audit_changes after insert or update on public.finance_payment_bank_matches
for each row execute function public.audit_finance_bank_match_change();

revoke all on function public.enforce_finance_payment_rules() from public, anon, authenticated;
revoke all on function public.audit_finance_payment_change() from public, anon, authenticated;
revoke all on function public.enforce_finance_payment_document_rules() from public, anon, authenticated;
revoke all on function public.audit_finance_payment_document_change() from public, anon, authenticated;
revoke all on function public.enforce_finance_bank_rows() from public, anon, authenticated;
revoke all on function public.audit_finance_bank_batch() from public, anon, authenticated;
revoke all on function public.enforce_finance_bank_match_rules() from public, anon, authenticated;
revoke all on function public.audit_finance_bank_match_change() from public, anon, authenticated;

-- --------------------------------------------------------------------------------------------
-- 10. RLS
-- --------------------------------------------------------------------------------------------
alter table public.finance_payment_register enable row level security;
alter table public.finance_payment_documents enable row level security;
alter table public.finance_bank_import_batches enable row level security;
alter table public.finance_bank_statement_transactions enable row level security;
alter table public.finance_payment_bank_matches enable row level security;

revoke all on table public.finance_payment_register from public, anon, authenticated;
revoke all on table public.finance_payment_documents from public, anon, authenticated;
revoke all on table public.finance_bank_import_batches from public, anon, authenticated;
revoke all on table public.finance_bank_statement_transactions from public, anon, authenticated;
revoke all on table public.finance_payment_bank_matches from public, anon, authenticated;
-- No DELETE anywhere (history is kept); bank statement rows and batches are insert-only (no UPDATE grant).
grant select, insert, update on table public.finance_payment_register to authenticated;
grant select, insert, update on table public.finance_payment_documents to authenticated;
grant select, insert on table public.finance_bank_import_batches to authenticated;
grant select, insert on table public.finance_bank_statement_transactions to authenticated;
grant select, insert, update on table public.finance_payment_bank_matches to authenticated;

-- Payment Register: finance-visible per entity; created/edited by anyone who may manage bills (the trigger narrows by role).
create policy fpr_select on public.finance_payment_register for select to authenticated
  using (app_private.user_can_access_entity(entity_id) and app_private.current_user_can('can_view_finance'));
create policy fpr_insert on public.finance_payment_register for insert to authenticated
  with check (created_by = (select auth.uid()) and app_private.user_can_access_entity(entity_id) and app_private.current_user_can('can_manage_bills'));
create policy fpr_update on public.finance_payment_register for update to authenticated
  using (app_private.user_can_access_entity(entity_id) and app_private.current_user_can('can_manage_bills'))
  with check (app_private.user_can_access_entity(entity_id) and app_private.current_user_can('can_manage_bills'));

create policy fpd_select on public.finance_payment_documents for select to authenticated
  using (app_private.user_can_access_entity(entity_id) and app_private.current_user_can('can_view_finance'));
create policy fpd_insert on public.finance_payment_documents for insert to authenticated
  with check (uploaded_by = (select auth.uid()) and app_private.user_can_access_entity(entity_id) and app_private.current_user_can('can_upload_documents'));
create policy fpd_update on public.finance_payment_documents for update to authenticated
  using (app_private.current_user_is_finance_reviewer() and app_private.user_can_access_entity(entity_id))
  with check (app_private.current_user_is_finance_reviewer() and app_private.user_can_access_entity(entity_id));

-- Bank data: Owner / Finance Manager / Finance Staff with entity access AND AAL2 (the Stage 1B bar for bank data).
create policy fbb_select on public.finance_bank_import_batches for select to authenticated
  using (app_private.current_user_is_finance_reviewer() and app_private.current_user_has_aal2() and app_private.user_can_access_entity(entity_id));
create policy fbb_insert on public.finance_bank_import_batches for insert to authenticated
  with check (imported_by = (select auth.uid()) and app_private.current_user_is_finance_reviewer() and app_private.current_user_has_aal2() and app_private.user_can_access_entity(entity_id));
create policy fbt_select on public.finance_bank_statement_transactions for select to authenticated
  using (app_private.current_user_is_finance_reviewer() and app_private.current_user_has_aal2() and app_private.user_can_access_entity(entity_id));
create policy fbt_insert on public.finance_bank_statement_transactions for insert to authenticated
  with check (app_private.current_user_is_finance_reviewer() and app_private.current_user_has_aal2() and app_private.user_can_access_entity(entity_id));
create policy fbm_select on public.finance_payment_bank_matches for select to authenticated
  using (app_private.current_user_is_finance_reviewer() and app_private.current_user_has_aal2() and app_private.user_can_access_entity(entity_id));
create policy fbm_insert on public.finance_payment_bank_matches for insert to authenticated
  with check (app_private.current_user_is_finance_reviewer() and app_private.current_user_has_aal2() and app_private.user_can_access_entity(entity_id));
create policy fbm_update on public.finance_payment_bank_matches for update to authenticated
  using (app_private.current_user_is_finance_reviewer() and app_private.current_user_has_aal2() and app_private.user_can_access_entity(entity_id))
  with check (app_private.current_user_is_finance_reviewer() and app_private.current_user_has_aal2() and app_private.user_can_access_entity(entity_id));

-- --------------------------------------------------------------------------------------------
-- 11. Private storage bucket for payment evidence (no UPDATE / DELETE policy: objects are kept)
-- --------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('finance-payment-documents', 'finance-payment-documents', false, 10485760,
        array['application/pdf', 'image/jpeg', 'image/png', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do nothing;

create function app_private.user_can_access_payment_document_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.current_user_can('can_view_finance') and exists (
    select 1 from public.finance_payment_documents d
    where d.storage_path = p_name and app_private.user_can_access_entity(d.entity_id)
  );
$$;
revoke all on function app_private.user_can_access_payment_document_object(text) from public, anon;
grant execute on function app_private.user_can_access_payment_document_object(text) to authenticated, service_role;

create policy finance_payment_documents_storage_read on storage.objects for select to authenticated
  using (bucket_id = 'finance-payment-documents' and app_private.user_can_access_payment_document_object(name));
create policy finance_payment_documents_storage_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'finance-payment-documents'
    and app_private.current_user_can('can_upload_documents')
    and app_private.user_can_access_entity((storage.foldername(name))[1]::uuid)
  );

notify pgrst, 'reload schema';

commit;
