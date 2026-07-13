create extension if not exists pgcrypto;

alter table bank_transactions
  alter column statement_month type date
  using case
    when statement_month is null or trim(statement_month::text) = '' then null
    when statement_month::text ~ '^\d{4}-\d{2}$' then to_date(statement_month::text || '-01', 'YYYY-MM-DD')
    when statement_month::text ~ '^\d{4}-\d{2}-\d{2}$' then date_trunc('month', statement_month::date)::date
    else null
  end;

alter table bank_transactions add column if not exists transaction_time time;
alter table bank_transactions add column if not exists value_date date;
alter table bank_transactions add column if not exists additional_description text;
alter table bank_transactions add column if not exists reference_number text;
alter table bank_transactions add column if not exists debit_amount numeric(14,2);
alter table bank_transactions add column if not exists credit_amount numeric(14,2);
alter table bank_transactions add column if not exists running_balance numeric(14,2);
alter table bank_transactions add column if not exists source_import_batch_id uuid;
alter table bank_transactions add column if not exists source_import_row_id uuid;
alter table bank_transactions add column if not exists reconciliation_status text not null default 'unmatched';
alter table bank_transactions add column if not exists is_reversal boolean not null default false;
alter table bank_transactions add column if not exists duplicate_fingerprint text;
alter table bank_transactions add column if not exists legacy_review_required boolean not null default false;
alter table bank_transactions add column if not exists legacy_review_reason text;
alter table bank_transactions add column if not exists manual_entry_reason text;
alter table bank_transactions add column if not exists updated_at timestamptz not null default now();

update bank_transactions
set legacy_review_required = true,
    legacy_review_reason = 'Existing bank transaction has unknown origin and should be reviewed before Phase 3A reporting.'
where coalesce(data_origin, '') not in ('demo', 'production', 'imported', 'manual')
   or data_origin is null;

update bank_transactions
set debit_amount = case when direction = 'debit' then abs(amount) else debit_amount end,
    credit_amount = case when direction = 'credit' then abs(amount) else credit_amount end,
    reference_number = coalesce(reference_number, bank_reference),
    statement_month = coalesce(statement_month, date_trunc('month', transaction_date)::date)
where debit_amount is null and credit_amount is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bank_transactions_direction_check') then
    alter table bank_transactions add constraint bank_transactions_direction_check check (direction in ('debit', 'credit'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bank_transactions_amount_positive_check') then
    alter table bank_transactions add constraint bank_transactions_amount_positive_check check (amount > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bank_transactions_amount_direction_consistency_check') then
    alter table bank_transactions add constraint bank_transactions_amount_direction_consistency_check check (
      (direction = 'debit' and debit_amount is not null and debit_amount > 0 and credit_amount is null and amount = debit_amount)
      or
      (direction = 'credit' and credit_amount is not null and credit_amount > 0 and debit_amount is null and amount = credit_amount)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bank_transactions_statement_month_first_day_check') then
    alter table bank_transactions add constraint bank_transactions_statement_month_first_day_check check (statement_month = date_trunc('month', statement_month)::date);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bank_transactions_reconciliation_status_check') then
    alter table bank_transactions add constraint bank_transactions_reconciliation_status_check check (reconciliation_status in ('unmatched', 'suggested_match', 'partially_matched', 'matched', 'manually_matched', 'exception', 'reversed'));
  end if;
end $$;

create or replace function public.set_phase3a_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_bank_transactions_updated_at on bank_transactions;
create trigger set_bank_transactions_updated_at before update on bank_transactions for each row execute function public.set_phase3a_updated_at();

create or replace function public.bank_normalise_text(value text)
returns text
language sql
immutable
as $$
  select trim(regexp_replace(lower(coalesce(value, '')), '[^a-z0-9]+', ' ', 'g'));
$$;

create or replace function public.bank_transaction_fingerprint(
  p_bank_account_id uuid,
  p_transaction_date date,
  p_transaction_time time,
  p_amount numeric,
  p_direction text,
  p_reference text,
  p_description text
)
returns text
language sql
immutable
as $$
  select encode(digest(
    coalesce(p_bank_account_id::text, '') || '|' ||
    coalesce(p_transaction_date::text, '') || '|' ||
    coalesce(to_char(p_transaction_time, 'HH24:MI:SS'), '') || '|' ||
    coalesce(round(p_amount, 2)::text, '') || '|' ||
    coalesce(p_direction, '') || '|' ||
    public.bank_normalise_text(p_reference) || '|' ||
    public.bank_normalise_text(p_description),
    'sha256'
  ), 'hex');
$$;

create table if not exists bank_import_batches (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references entities(id) on delete restrict,
  bank_account_id uuid not null references bank_accounts(id) on delete restrict,
  statement_month date not null,
  filename text not null,
  file_type text not null check (file_type in ('csv', 'xlsx', 'pasted_rows', 'manual')),
  file_hash text,
  storage_path text,
  worksheet_name text,
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_at timestamptz not null default now(),
  mapping_config jsonb not null default '{}'::jsonb,
  date_format text,
  direction_mode text,
  bank_preset text not null default 'generic' check (bank_preset in ('cimb', 'public_bank', 'generic')),
  total_rows integer not null default 0,
  successful_rows integer not null default 0,
  skipped_rows integer not null default 0,
  failed_rows integer not null default 0,
  status text not null default 'uploaded' check (status in ('uploaded', 'mapping', 'review', 'ready', 'processing', 'completed', 'completed_with_errors', 'failed', 'discarded', 'archived')),
  discarded_at timestamptz,
  discarded_by uuid references auth.users(id) on delete set null,
  discard_reason text,
  archived_at timestamptz,
  archived_by uuid references auth.users(id) on delete set null,
  archive_reason text,
  result_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (statement_month = date_trunc('month', statement_month)::date)
);

create unique index if not exists bank_import_batches_file_hash_unique
  on bank_import_batches(bank_account_id, statement_month, file_hash)
  where file_hash is not null and status not in ('discarded');
create index if not exists bank_import_batches_account_month_idx on bank_import_batches(bank_account_id, statement_month, status);
create index if not exists bank_import_batches_entity_idx on bank_import_batches(entity_id, uploaded_at desc);

create table if not exists bank_import_rows (
  id uuid primary key default gen_random_uuid(),
  bank_import_batch_id uuid not null references bank_import_batches(id) on delete cascade,
  row_number integer not null,
  original_data jsonb not null default '{}'::jsonb,
  original_data_sanitized jsonb not null default '{}'::jsonb,
  mapped_data jsonb not null default '{}'::jsonb,
  mapped_data_sanitized jsonb not null default '{}'::jsonb,
  validation_errors jsonb not null default '[]'::jsonb,
  duplicate_warnings jsonb not null default '[]'::jsonb,
  excluded boolean not null default false,
  duplicate_decision text not null default 'pending' check (duplicate_decision in ('pending', 'skip', 'import_as_new', 'review_manually')),
  result_status text not null default 'pending' check (result_status in ('pending', 'imported', 'skipped', 'failed')),
  result_message text,
  bank_transaction_id uuid references bank_transactions(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(bank_import_batch_id, row_number)
);

create index if not exists bank_import_rows_batch_idx on bank_import_rows(bank_import_batch_id, row_number);
create index if not exists bank_import_rows_transaction_idx on bank_import_rows(bank_transaction_id);

alter table bank_transactions
  drop constraint if exists bank_transactions_source_import_batch_id_fkey,
  add constraint bank_transactions_source_import_batch_id_fkey foreign key (source_import_batch_id) references bank_import_batches(id) on delete set null;
alter table bank_transactions
  drop constraint if exists bank_transactions_source_import_row_id_fkey,
  add constraint bank_transactions_source_import_row_id_fkey foreign key (source_import_row_id) references bank_import_rows(id) on delete set null;

create table if not exists bank_internal_transfers (
  id uuid primary key default gen_random_uuid(),
  outgoing_bank_transaction_id uuid not null references bank_transactions(id) on delete restrict,
  incoming_bank_transaction_id uuid references bank_transactions(id) on delete restrict,
  source_entity_id uuid not null references entities(id) on delete restrict,
  source_bank_account_id uuid not null references bank_accounts(id) on delete restrict,
  destination_entity_id uuid not null references entities(id) on delete restrict,
  destination_bank_account_id uuid not null references bank_accounts(id) on delete restrict,
  classification text not null check (classification in ('same_entity', 'intercompany')),
  amount numeric(14,2) not null check (amount > 0),
  transfer_date date not null,
  status text not null default 'proposed' check (status in ('proposed', 'confirmed', 'reversed', 'cancelled')),
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamptz,
  remarks text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (incoming_bank_transaction_id is null or incoming_bank_transaction_id <> outgoing_bank_transaction_id)
);

create index if not exists bank_internal_transfers_outgoing_idx on bank_internal_transfers(outgoing_bank_transaction_id);
create index if not exists bank_internal_transfers_incoming_idx on bank_internal_transfers(incoming_bank_transaction_id);

create table if not exists bank_manual_exceptions (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references entities(id) on delete restrict,
  bank_transaction_id uuid not null references bank_transactions(id) on delete cascade,
  exception_reason text not null,
  category text not null,
  remarks text not null,
  review_status text not null default 'open' check (review_status in ('open', 'under_review', 'resolved', 'rejected')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bank_reconciliation_allocations (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references entities(id) on delete restrict,
  bank_account_id uuid not null references bank_accounts(id) on delete restrict,
  bank_transaction_id uuid not null references bank_transactions(id) on delete cascade,
  linked_record_type text not null check (linked_record_type in ('supplier_bill', 'payment_voucher', 'bill_payment', 'recurring_obligation', 'statutory_payment', 'salary_payment_batch', 'refund', 'internal_transfer', 'bank_charge', 'invoice', 'receipt', 'manual_exception')),
  linked_record_id uuid,
  allocated_amount numeric(14,2) not null check (allocated_amount > 0),
  match_type text not null default 'manual' check (match_type in ('suggested', 'exact', 'manual', 'partial', 'reversal', 'bank_charge', 'internal_transfer', 'exception')),
  confidence_score numeric(5,2) check (confidence_score is null or (confidence_score >= 0 and confidence_score <= 100)),
  match_reason text,
  status text not null default 'suggested_match' check (status in ('suggested_match', 'confirmed', 'reversed')),
  exception_reason text,
  overpayment_override boolean not null default false,
  overpayment_reason text,
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamptz,
  reversed_by uuid references auth.users(id) on delete set null,
  reversed_at timestamptz,
  reversal_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'reversed' or nullif(reversal_reason, '') is not null),
  check (linked_record_type <> 'manual_exception' or (nullif(exception_reason, '') is not null and linked_record_id is not null))
);

create index if not exists bank_reconciliation_allocations_transaction_idx on bank_reconciliation_allocations(bank_transaction_id, status);
create index if not exists bank_reconciliation_allocations_linked_idx on bank_reconciliation_allocations(linked_record_type, linked_record_id);

create table if not exists bank_reconciliation_events (
  id uuid primary key default gen_random_uuid(),
  allocation_id uuid references bank_reconciliation_allocations(id) on delete set null,
  bank_transaction_id uuid references bank_transactions(id) on delete set null,
  action text not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Continued in local migration: functions, safe views, RLS policies, grants and revokes.
