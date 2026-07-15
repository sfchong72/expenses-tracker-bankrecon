create extension if not exists pgcrypto;

alter table finance_user_permissions add column if not exists can_manage_claims boolean not null default false;
alter table finance_user_permissions add column if not exists can_review_claims boolean not null default false;
alter table finance_user_permissions add column if not exists can_check_claims boolean not null default false;
alter table finance_user_permissions add column if not exists can_approve_claims boolean not null default false;
alter table finance_user_permissions add column if not exists can_prepare_claim_reimbursements boolean not null default false;
alter table finance_user_permissions add column if not exists can_export_claims_sql boolean not null default false;

create or replace function app_private.current_user_can(permission_name text)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  profile_role text;
  is_active boolean;
  explicit_value boolean;
begin
  select role, active_status into profile_role, is_active
  from public.app_profiles
  where id = auth.uid();

  if coalesce(is_active, false) = false then
    return false;
  end if;

  if profile_role = 'owner' then
    return true;
  end if;

  execute format('select %I from public.finance_user_permissions where user_id = $1', permission_name)
  using auth.uid()
  into explicit_value;

  if explicit_value is not null then
    return explicit_value;
  end if;

  if permission_name = 'can_view_documents' then
    return profile_role in ('finance_manager', 'finance_staff', 'data_entry', 'read_only');
  elsif permission_name = 'can_upload_documents' then
    return profile_role in ('finance_manager', 'finance_staff', 'data_entry');
  elsif permission_name = 'can_manage_documents' then
    return profile_role = 'finance_manager';
  elsif permission_name = 'can_manage_recurring_bills' then
    return profile_role = 'finance_manager';
  elsif permission_name = 'can_generate_payment_vouchers' then
    return profile_role in ('finance_manager', 'finance_staff');
  elsif permission_name = 'can_manage_claims' then
    return profile_role in ('finance_manager', 'finance_staff', 'data_entry');
  elsif permission_name = 'can_review_claims' then
    return profile_role in ('finance_manager', 'finance_staff');
  elsif permission_name = 'can_check_claims' then
    return profile_role in ('finance_manager', 'finance_staff');
  elsif permission_name = 'can_approve_claims' then
    return profile_role = 'finance_manager';
  elsif permission_name = 'can_prepare_claim_reimbursements' then
    return profile_role in ('finance_manager', 'finance_staff');
  elsif permission_name = 'can_export_claims_sql' then
    return profile_role in ('finance_manager', 'finance_staff');
  elsif permission_name = 'can_view_bank_balances' then
    return false;
  end if;

  return false;
end;
$$;
revoke all on function app_private.current_user_can(text) from public;
grant execute on function app_private.current_user_can(text) to authenticated;

create table if not exists claim_number_sequences (
  entity_id uuid not null references entities(id) on delete cascade,
  claim_prefix text not null,
  sequence_year integer not null,
  sequence_month integer not null,
  last_number integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (entity_id, claim_prefix, sequence_year, sequence_month)
);

create table if not exists claims (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references entities(id) on delete restrict,
  claim_number text,
  claim_mode text not null check (claim_mode in ('staff_cash_travel', 'credit_card')),
  claim_type text not null check (claim_type in ('staff_cash_claim', 'travel_claim', 'personal_credit_card_claim', 'company_credit_card_claim', 'director_claim', 'staff_advance', 'director_advance', 'petty_cash', 'mileage_claim')),
  claimant_user_id uuid references auth.users(id) on delete set null,
  claimant_name text not null,
  designation text,
  department text,
  claim_period_start date,
  claim_period_end date,
  statement_date date,
  statement_month date,
  trip_or_business_purpose text,
  currency text not null default 'MYR',
  total_transport_amount numeric(14,2) not null default 0,
  total_accommodation_amount numeric(14,2) not null default 0,
  total_misc_amount numeric(14,2) not null default 0,
  tax_total_amount numeric(14,2) not null default 0,
  gross_claim_total numeric(14,2) not null default 0,
  advance_paid_amount numeric(14,2) not null default 0,
  advance_utilised_amount numeric(14,2) not null default 0,
  net_payable_amount numeric(14,2) not null default 0,
  refundable_to_company_amount numeric(14,2) not null default 0,
  evidence_status text not null default 'missing_evidence' check (evidence_status in ('complete', 'missing_evidence', 'partial_evidence', 'not_required')),
  status text not null default 'draft' check (status in ('draft', 'submitted', 'under_review', 'more_information_required', 'checked', 'approved', 'rejected', 'payment_prepared', 'reimbursed', 'entered_in_sql_accounting', 'archived')),
  submitted_by uuid references auth.users(id) on delete set null,
  submitted_at timestamptz,
  checked_by uuid references auth.users(id) on delete set null,
  checked_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  approval_exception_type text check (approval_exception_type is null or approval_exception_type in ('director_board_exception')),
  approval_exception_reason text,
  approval_exception_by uuid references auth.users(id) on delete set null,
  approval_exception_at timestamptz,
  payment_voucher_id uuid references payment_vouchers(id) on delete set null,
  reimbursement_status text not null default 'not_prepared' check (reimbursement_status in ('not_prepared', 'voucher_draft', 'payment_prepared', 'reimbursed')),
  reimbursement_date date,
  payment_reference text,
  sql_accounting_entry_status text not null default 'not_entered' check (sql_accounting_entry_status in ('not_entered', 'exported', 'entered')),
  sql_accounting_reference text,
  remarks text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  is_demo boolean not null default false,
  data_origin text not null default 'manual' check (data_origin in ('demo', 'production', 'imported', 'manual')),
  unique (entity_id, claim_number),
  check (claim_number is null or length(claim_number) > 0),
  check (statement_month is null or statement_month = date_trunc('month', statement_month)::date),
  check (claim_period_start is null or claim_period_end is null or claim_period_end >= claim_period_start),
  check (checked_by is null or claimant_user_id is null or checked_by <> claimant_user_id),
  check (
    approved_by is null
    or claimant_user_id is null
    or approved_by <> claimant_user_id
    or (
      approval_exception_type = 'director_board_exception'
      and nullif(approval_exception_reason, '') is not null
      and approval_exception_by is not null
      and approval_exception_by <> claimant_user_id
    )
  )
);

create table if not exists claim_lines (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references claims(id) on delete cascade,
  entity_id uuid not null references entities(id) on delete restrict,
  client_key text,
  line_type text not null check (line_type in ('transport', 'accommodation', 'miscellaneous', 'credit_card_transaction', 'mileage', 'petty_cash')),
  expense_date date,
  statement_date date,
  transaction_date date,
  from_location text,
  to_location text,
  transport_mode text,
  distance_km numeric(12,2),
  mileage_rate numeric(12,4),
  mileage_amount_calculated numeric(14,2),
  check_in_date date,
  check_out_date date,
  number_of_nights integer,
  hotel_name text,
  merchant_or_supplier text,
  invoice_or_receipt_number text,
  payment_method text,
  receipt_date date,
  cardholder_name text,
  card_last_four text,
  card_type text check (card_type is null or card_type in ('personal', 'company')),
  transaction_description text,
  business_purpose text,
  description text not null,
  expense_category_id uuid references categories(id) on delete set null,
  amount numeric(14,2) not null default 0 check (amount >= 0),
  tax_amount numeric(14,2) not null default 0 check (tax_amount >= 0),
  original_currency text not null default 'MYR',
  exchange_rate numeric(14,6) not null default 1 check (exchange_rate > 0),
  myr_converted_amount numeric(14,2) not null default 0 check (myr_converted_amount >= 0),
  receipt_status text not null default 'missing' check (receipt_status in ('missing', 'uploaded', 'not_required', 'redacted_statement_only')),
  document_status text not null default 'missing' check (document_status in ('missing', 'partial', 'complete', 'not_required')),
  missing_evidence_reason text,
  requires_receipt boolean not null default true,
  validation_warnings jsonb not null default '[]'::jsonb,
  duplicate_fingerprint text,
  sort_order integer not null default 1,
  is_excluded boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (check_in_date is null or check_out_date is null or check_out_date >= check_in_date),
  check (card_last_four is null or card_last_four ~ '^[0-9]{4}$')
);

create table if not exists claim_advances (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references claims(id) on delete cascade,
  entity_id uuid not null references entities(id) on delete restrict,
  advance_amount numeric(14,2) not null default 0 check (advance_amount >= 0),
  advance_date date,
  advance_reference text,
  amount_utilised numeric(14,2) not null default 0 check (amount_utilised >= 0),
  remarks text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists claim_reimbursements (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references claims(id) on delete cascade,
  entity_id uuid not null references entities(id) on delete restrict,
  payment_voucher_id uuid references payment_vouchers(id) on delete set null,
  reimbursement_date date,
  amount numeric(14,2) not null check (amount >= 0),
  payment_method text,
  payment_reference text,
  status text not null default 'prepared' check (status in ('prepared', 'paid', 'cancelled')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists claim_status_history (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references claims(id) on delete cascade,
  from_status text,
  to_status text not null,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now(),
  reason text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists claim_review_actions (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references claims(id) on delete cascade,
  action_type text not null check (action_type in ('submitted', 'under_review', 'checked', 'approved', 'rejected', 'more_information_requested', 'payment_prepared', 'reimbursed', 'entered_in_sql_accounting', 'owner_exception')),
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_role text,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists claim_evidence_requirements (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid references entities(id) on delete cascade,
  line_type text not null check (line_type in ('transport', 'accommodation', 'miscellaneous', 'credit_card_transaction', 'mileage', 'petty_cash')),
  expense_category_id uuid references categories(id) on delete cascade,
  required_document_type text not null,
  minimum_amount numeric(14,2) not null default 0,
  active_status boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists claim_import_batches (
  id uuid primary key default gen_random_uuid(),
  import_type text not null default 'credit_card_claim' check (import_type in ('credit_card_claim')),
  filename text not null,
  file_type text not null check (file_type in ('csv', 'xlsx')),
  worksheet_name text,
  entity_id uuid not null references entities(id) on delete restrict,
  statement_month date not null,
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_at timestamptz not null default now(),
  mapping_config jsonb not null default '{}'::jsonb,
  total_rows integer not null default 0,
  successful_rows integer not null default 0,
  skipped_rows integer not null default 0,
  failed_rows integer not null default 0,
  status text not null default 'mapping' check (status in ('uploaded', 'mapping', 'review', 'ready', 'processing', 'completed', 'completed_with_errors', 'failed', 'discarded', 'archived')),
  result_summary jsonb not null default '{}'::jsonb,
  created_claim_id uuid references claims(id) on delete set null,
  discarded_at timestamptz,
  archived_at timestamptz,
  is_demo boolean not null default false,
  data_origin text not null default 'manual' check (data_origin in ('demo', 'production', 'imported', 'manual')),
  check (statement_month = date_trunc('month', statement_month)::date)
);

create table if not exists claim_import_rows (
  id uuid primary key default gen_random_uuid(),
  claim_import_batch_id uuid not null references claim_import_batches(id) on delete cascade,
  row_number integer not null,
  original_data jsonb not null default '{}'::jsonb,
  mapped_data jsonb not null default '{}'::jsonb,
  validation_errors jsonb not null default '[]'::jsonb,
  duplicate_warnings jsonb not null default '[]'::jsonb,
  duplicate_decision text not null default 'pending' check (duplicate_decision in ('pending', 'skip', 'import_as_new')),
  excluded boolean not null default false,
  result_status text not null default 'pending' check (result_status in ('pending', 'imported_complete', 'imported_incomplete', 'skipped', 'failed')),
  result_message text,
  created_claim_line_id uuid references claim_lines(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (claim_import_batch_id, row_number)
);

alter table payment_vouchers add column if not exists claim_id uuid references claims(id) on delete set null;
alter table payment_vouchers add column if not exists source_type text;
alter table payment_vouchers add column if not exists source_id uuid;
alter table payment_voucher_items add column if not exists claim_id uuid references claims(id) on delete set null;
alter table payment_voucher_items add column if not exists claim_line_id uuid references claim_lines(id) on delete set null;

alter table payment_vouchers drop constraint if exists payment_vouchers_voucher_source_check;
alter table payment_vouchers add constraint payment_vouchers_voucher_source_check
  check (voucher_source in ('manual', 'supplier_bill', 'recurring_obligation', 'claim', 'demo'));

alter table document_links drop constraint if exists document_links_linked_record_type_check;
alter table document_links add constraint document_links_linked_record_type_check
  check (linked_record_type in ('supplier_bill', 'payment_voucher', 'bill_payment', 'bank_transaction', 'recurring_obligation', 'claim', 'claim_line', 'claim_reimbursement', 'other'));

alter table documents drop constraint if exists documents_document_type_check;
alter table documents add constraint documents_document_type_check
  check (document_type in ('supplier_invoice', 'receipt', 'payment_slip', 'payment_voucher', 'quotation', 'contract', 'payroll_support', 'claim_receipt', 'tax_invoice', 'ticket', 'booking_confirmation', 'mileage_route_screenshot', 'redacted_card_statement', 'claim_payment_proof', 'other'));

create index if not exists claims_entity_status_idx on claims(entity_id, status, claim_mode);
create index if not exists claims_claimant_idx on claims(claimant_user_id, status);
create index if not exists claim_lines_claim_idx on claim_lines(claim_id, line_type);
create index if not exists claim_lines_duplicate_idx on claim_lines(entity_id, duplicate_fingerprint) where duplicate_fingerprint is not null;
create index if not exists claim_advances_claim_idx on claim_advances(claim_id);
create index if not exists claim_reimbursements_claim_idx on claim_reimbursements(claim_id);
create index if not exists claim_import_batches_entity_month_idx on claim_import_batches(entity_id, statement_month, status);
create index if not exists claim_import_rows_batch_idx on claim_import_rows(claim_import_batch_id, row_number);
create index if not exists payment_vouchers_claim_idx on payment_vouchers(claim_id);
create index if not exists payment_voucher_items_claim_idx on payment_voucher_items(claim_id, claim_line_id);

create or replace function public.recalculate_claim_totals(p_claim_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  totals record;
  advance_totals record;
  missing_required integer;
  partial_required integer;
  required_total integer;
  next_evidence_status text;
  approved_total numeric(14,2);
  utilised numeric(14,2);
begin
  select
    coalesce(sum(case when line_type in ('transport', 'mileage') and not is_excluded then myr_converted_amount else 0 end), 0) as transport_total,
    coalesce(sum(case when line_type = 'accommodation' and not is_excluded then myr_converted_amount else 0 end), 0) as accommodation_total,
    coalesce(sum(case when line_type in ('miscellaneous', 'credit_card_transaction', 'petty_cash') and not is_excluded then myr_converted_amount else 0 end), 0) as misc_total,
    coalesce(sum(case when not is_excluded then tax_amount else 0 end), 0) as tax_total,
    coalesce(sum(case when not is_excluded then myr_converted_amount else 0 end), 0) as gross_total
  into totals
  from claim_lines
  where claim_id = p_claim_id;

  select
    coalesce(sum(advance_amount), 0) as advance_paid,
    coalesce(sum(case when amount_utilised > 0 then amount_utilised else advance_amount end), 0) as advance_utilised
  into advance_totals
  from claim_advances
  where claim_id = p_claim_id;

  approved_total := coalesce(totals.gross_total, 0);
  utilised := least(coalesce(advance_totals.advance_utilised, 0), greatest(coalesce(advance_totals.advance_paid, 0), coalesce(advance_totals.advance_utilised, 0)));

  select
    count(*) filter (where requires_receipt),
    count(*) filter (where requires_receipt and document_status = 'missing'),
    count(*) filter (where requires_receipt and document_status = 'partial')
  into required_total, missing_required, partial_required
  from claim_lines
  where claim_id = p_claim_id
    and not is_excluded;

  if coalesce(required_total, 0) = 0 then
    next_evidence_status := 'not_required';
  elsif coalesce(missing_required, 0) > 0 and coalesce(missing_required, 0) < coalesce(required_total, 0) then
    next_evidence_status := 'partial_evidence';
  elsif coalesce(missing_required, 0) > 0 then
    next_evidence_status := 'missing_evidence';
  elsif coalesce(partial_required, 0) > 0 then
    next_evidence_status := 'partial_evidence';
  else
    next_evidence_status := 'complete';
  end if;

  update claims
  set total_transport_amount = coalesce(totals.transport_total, 0),
      total_accommodation_amount = coalesce(totals.accommodation_total, 0),
      total_misc_amount = coalesce(totals.misc_total, 0),
      tax_total_amount = coalesce(totals.tax_total, 0),
      gross_claim_total = approved_total,
      advance_paid_amount = coalesce(advance_totals.advance_paid, 0),
      advance_utilised_amount = utilised,
      net_payable_amount = greatest(approved_total - utilised, 0),
      refundable_to_company_amount = greatest(utilised - approved_total, 0),
      evidence_status = next_evidence_status,
      updated_at = now()
  where id = p_claim_id;
end;
$$;
revoke all on function public.recalculate_claim_totals(uuid) from public;
grant execute on function public.recalculate_claim_totals(uuid) to authenticated;

create or replace function public.set_claim_line_calculated_amounts()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.entity_id is null then
    select entity_id into new.entity_id from claims where id = new.claim_id;
  end if;

  if new.exchange_rate is null or new.exchange_rate <= 0 then
    new.exchange_rate := 1;
  end if;

  if coalesce(new.myr_converted_amount, 0) = 0 then
    new.myr_converted_amount := round(coalesce(new.amount, 0) * new.exchange_rate, 2);
  end if;

  if new.line_type = 'mileage' and coalesce(new.mileage_amount_calculated, 0) = 0 then
    new.mileage_amount_calculated := round(coalesce(new.distance_km, 0) * coalesce(new.mileage_rate, 0), 2);
    if coalesce(new.amount, 0) = 0 then
      new.amount := new.mileage_amount_calculated;
      new.myr_converted_amount := new.mileage_amount_calculated;
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.set_claim_line_calculated_amounts() from public;

drop trigger if exists set_claim_line_calculated_amounts_trigger on claim_lines;
create trigger set_claim_line_calculated_amounts_trigger
before insert or update on claim_lines
for each row execute function public.set_claim_line_calculated_amounts();

create or replace function public.recalculate_claim_after_detail_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.recalculate_claim_totals(old.claim_id);
    return old;
  end if;
  perform public.recalculate_claim_totals(new.claim_id);
  return new;
end;
$$;
revoke all on function public.recalculate_claim_after_detail_change() from public;

drop trigger if exists recalculate_claim_after_lines_trigger on claim_lines;
create trigger recalculate_claim_after_lines_trigger
after insert or update or delete on claim_lines
for each row execute function public.recalculate_claim_after_detail_change();

drop trigger if exists recalculate_claim_after_advances_trigger on claim_advances;
create trigger recalculate_claim_after_advances_trigger
after insert or update or delete on claim_advances
for each row execute function public.recalculate_claim_after_detail_change();

create or replace function public.enforce_claim_approval_controls()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.checked_by is not null and new.claimant_user_id is not null and new.checked_by = new.claimant_user_id then
    raise exception 'A claimant cannot check their own claim';
  end if;

  if new.approved_by is not null and new.claimant_user_id is not null and new.approved_by = new.claimant_user_id then
    if not (
      new.approval_exception_type = 'director_board_exception'
      and nullif(new.approval_exception_reason, '') is not null
      and new.approval_exception_by is not null
      and new.approval_exception_by <> new.claimant_user_id
    ) then
      raise exception 'A claimant cannot approve their own claim without a separate director/board exception';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.enforce_claim_approval_controls() from public;

drop trigger if exists enforce_claim_approval_controls_trigger on claims;
create trigger enforce_claim_approval_controls_trigger
before insert or update on claims
for each row execute function public.enforce_claim_approval_controls();

create or replace function public.generate_claim_number(p_claim_id uuid)
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  claim_row claims%rowtype;
  yy integer := extract(year from current_date)::integer % 100;
  mm integer := extract(month from current_date)::integer;
  seq integer;
  entity_code text;
  prefix text;
  generated text;
begin
  select * into claim_row from claims where id = p_claim_id for update;
  if claim_row.id is null then
    raise exception 'Claim not found';
  end if;

  if not (app_private.current_user_is_owner() or (app_private.user_can_access_entity(claim_row.entity_id) and app_private.current_user_can('can_manage_claims'))) then
    raise exception 'Not authorised to number claims';
  end if;

  if claim_row.claim_number is not null then
    return claim_row.claim_number;
  end if;

  select short_code into entity_code from entities where id = claim_row.entity_id;
  if entity_code is null then
    raise exception 'Unknown entity';
  end if;

  prefix := case
    when claim_row.claim_type in ('personal_credit_card_claim', 'company_credit_card_claim') then 'CC'
    when claim_row.claim_type in ('staff_advance', 'director_advance') then 'ADV'
    else 'CLM'
  end;

  insert into claim_number_sequences (entity_id, claim_prefix, sequence_year, sequence_month, last_number)
  values (claim_row.entity_id, prefix, yy, mm, 1)
  on conflict (entity_id, claim_prefix, sequence_year, sequence_month)
  do update set last_number = claim_number_sequences.last_number + 1,
                updated_at = now()
  returning last_number into seq;

  generated := entity_code || '/' || prefix || lpad(yy::text, 2, '0') || '-' || lpad(mm::text, 2, '0') || '/' || lpad(seq::text, 3, '0');

  update claims set claim_number = generated, updated_at = now() where id = p_claim_id;
  return generated;
end;
$$;
revoke all on function public.generate_claim_number(uuid) from public;
grant execute on function public.generate_claim_number(uuid) to authenticated;

create or replace function public.recalculate_supporting_document_status(target_type text, target_id uuid)
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  has_invoice boolean;
  has_payment_slip boolean;
  has_any boolean;
  next_status text;
  target_claim_id uuid;
begin
  select
    bool_or(d.document_type in ('supplier_invoice', 'claim_receipt', 'tax_invoice', 'receipt')),
    bool_or(d.document_type in ('payment_slip', 'claim_payment_proof')),
    count(*) > 0
  into has_invoice, has_payment_slip, has_any
  from document_links dl
  join documents d on d.id = dl.document_id
  where dl.linked_record_type = target_type
    and dl.linked_record_id = target_id
    and d.is_archived = false
    and d.deleted_at is null
    and d.status in ('active', 'replaced');

  if coalesce(has_invoice, false) and coalesce(has_payment_slip, false) then
    next_status := 'complete';
  elsif coalesce(has_invoice, false) then
    next_status := 'invoice_uploaded';
  elsif coalesce(has_payment_slip, false) then
    next_status := 'payment_slip_uploaded';
  elsif coalesce(has_any, false) then
    next_status := 'partial_evidence';
  else
    next_status := 'no_document';
  end if;

  if target_type = 'supplier_bill' then
    update supplier_bills
    set supporting_document_status = next_status,
        not_applicable_reason = case when next_status = 'not_applicable' then not_applicable_reason else null end
    where id = target_id
      and supporting_document_status <> 'not_applicable';
  elsif target_type = 'bill_payment' then
    update bill_payments
    set supporting_document_status = next_status,
        not_applicable_reason = case when next_status = 'not_applicable' then not_applicable_reason else null end
    where id = target_id
      and supporting_document_status <> 'not_applicable';
  elsif target_type = 'claim_line' then
    update claim_lines
    set document_status = case
        when requires_receipt = false then 'not_required'
        when coalesce(has_any, false) then 'complete'
        else 'missing'
      end,
      receipt_status = case
        when requires_receipt = false then 'not_required'
        when coalesce(has_any, false) then 'uploaded'
        else 'missing'
      end
    where id = target_id
    returning claim_id into target_claim_id;
    if target_claim_id is not null then
      perform public.recalculate_claim_totals(target_claim_id);
    end if;
  elsif target_type = 'claim' then
    perform public.recalculate_claim_totals(target_id);
  end if;

  return next_status;
end;
$$;
revoke all on function public.recalculate_supporting_document_status(text, uuid) from public;
grant execute on function public.recalculate_supporting_document_status(text, uuid) to authenticated;

alter table claim_number_sequences enable row level security;
alter table claims enable row level security;
alter table claim_lines enable row level security;
alter table claim_advances enable row level security;
alter table claim_reimbursements enable row level security;
alter table claim_status_history enable row level security;
alter table claim_review_actions enable row level security;
alter table claim_evidence_requirements enable row level security;
alter table claim_import_batches enable row level security;
alter table claim_import_rows enable row level security;

drop policy if exists "claims_select" on claims;
create policy "claims_select" on claims for select to authenticated
using (
  app_private.user_can_access_entity(entity_id)
  or claimant_user_id = auth.uid()
);
drop policy if exists "claims_insert" on claims;
create policy "claims_insert" on claims for insert to authenticated
with check (
  app_private.user_can_access_entity(entity_id)
  and app_private.current_user_can('can_manage_claims')
);
drop policy if exists "claims_update" on claims;
create policy "claims_update" on claims for update to authenticated
using (
  app_private.user_can_access_entity(entity_id)
  and (app_private.current_user_can('can_manage_claims') or app_private.current_user_can('can_review_claims'))
)
with check (
  app_private.user_can_access_entity(entity_id)
  and (app_private.current_user_can('can_manage_claims') or app_private.current_user_can('can_review_claims'))
);

drop policy if exists "claim_lines_select" on claim_lines;
create policy "claim_lines_select" on claim_lines for select to authenticated
using (exists (select 1 from claims c where c.id = claim_id and (app_private.user_can_access_entity(c.entity_id) or c.claimant_user_id = auth.uid())));
drop policy if exists "claim_lines_manage" on claim_lines;
create policy "claim_lines_manage" on claim_lines for all to authenticated
using (exists (select 1 from claims c where c.id = claim_id and app_private.user_can_access_entity(c.entity_id) and app_private.current_user_can('can_manage_claims')))
with check (exists (select 1 from claims c where c.id = claim_id and app_private.user_can_access_entity(c.entity_id) and app_private.current_user_can('can_manage_claims')));

drop policy if exists "claim_advances_select" on claim_advances;
create policy "claim_advances_select" on claim_advances for select to authenticated
using (exists (select 1 from claims c where c.id = claim_id and (app_private.user_can_access_entity(c.entity_id) or c.claimant_user_id = auth.uid())));
drop policy if exists "claim_advances_manage" on claim_advances;
create policy "claim_advances_manage" on claim_advances for all to authenticated
using (exists (select 1 from claims c where c.id = claim_id and app_private.user_can_access_entity(c.entity_id) and app_private.current_user_can('can_manage_claims')))
with check (exists (select 1 from claims c where c.id = claim_id and app_private.user_can_access_entity(c.entity_id) and app_private.current_user_can('can_manage_claims')));

drop policy if exists "claim_reimbursements_select" on claim_reimbursements;
create policy "claim_reimbursements_select" on claim_reimbursements for select to authenticated
using (app_private.user_can_access_entity(entity_id));
drop policy if exists "claim_reimbursements_manage" on claim_reimbursements;
create policy "claim_reimbursements_manage" on claim_reimbursements for all to authenticated
using (app_private.user_can_access_entity(entity_id) and app_private.current_user_can('can_prepare_claim_reimbursements'))
with check (app_private.user_can_access_entity(entity_id) and app_private.current_user_can('can_prepare_claim_reimbursements'));

drop policy if exists "claim_status_history_select" on claim_status_history;
create policy "claim_status_history_select" on claim_status_history for select to authenticated
using (exists (select 1 from claims c where c.id = claim_id and (app_private.user_can_access_entity(c.entity_id) or c.claimant_user_id = auth.uid())));
drop policy if exists "claim_status_history_insert" on claim_status_history;
create policy "claim_status_history_insert" on claim_status_history for insert to authenticated
with check (exists (select 1 from claims c where c.id = claim_id and app_private.user_can_access_entity(c.entity_id)));

drop policy if exists "claim_review_actions_select" on claim_review_actions;
create policy "claim_review_actions_select" on claim_review_actions for select to authenticated
using (exists (select 1 from claims c where c.id = claim_id and (app_private.user_can_access_entity(c.entity_id) or c.claimant_user_id = auth.uid())));
drop policy if exists "claim_review_actions_insert" on claim_review_actions;
create policy "claim_review_actions_insert" on claim_review_actions for insert to authenticated
with check (exists (select 1 from claims c where c.id = claim_id and app_private.user_can_access_entity(c.entity_id)));

drop policy if exists "claim_evidence_requirements_select" on claim_evidence_requirements;
create policy "claim_evidence_requirements_select" on claim_evidence_requirements for select to authenticated
using (entity_id is null or app_private.user_can_access_entity(entity_id));
drop policy if exists "claim_evidence_requirements_manage" on claim_evidence_requirements;
create policy "claim_evidence_requirements_manage" on claim_evidence_requirements for all to authenticated
using (app_private.current_user_is_owner() or app_private.current_user_can('can_manage_claims'))
with check (app_private.current_user_is_owner() or app_private.current_user_can('can_manage_claims'));

drop policy if exists "claim_import_batches_select" on claim_import_batches;
create policy "claim_import_batches_select" on claim_import_batches for select to authenticated
using (app_private.user_can_access_entity(entity_id) and app_private.current_user_can('can_manage_claims'));
drop policy if exists "claim_import_batches_manage" on claim_import_batches;
create policy "claim_import_batches_manage" on claim_import_batches for all to authenticated
using (app_private.user_can_access_entity(entity_id) and app_private.current_user_can('can_manage_claims'))
with check (app_private.user_can_access_entity(entity_id) and app_private.current_user_can('can_manage_claims'));

drop policy if exists "claim_import_rows_select" on claim_import_rows;
create policy "claim_import_rows_select" on claim_import_rows for select to authenticated
using (exists (select 1 from claim_import_batches b where b.id = claim_import_batch_id and app_private.user_can_access_entity(b.entity_id) and app_private.current_user_can('can_manage_claims')));
drop policy if exists "claim_import_rows_manage" on claim_import_rows;
create policy "claim_import_rows_manage" on claim_import_rows for all to authenticated
using (exists (select 1 from claim_import_batches b where b.id = claim_import_batch_id and app_private.user_can_access_entity(b.entity_id) and app_private.current_user_can('can_manage_claims')))
with check (exists (select 1 from claim_import_batches b where b.id = claim_import_batch_id and app_private.user_can_access_entity(b.entity_id) and app_private.current_user_can('can_manage_claims')));

drop policy if exists "claim_number_sequences_owner_select" on claim_number_sequences;
create policy "claim_number_sequences_owner_select" on claim_number_sequences for select to authenticated
using (app_private.current_user_is_owner());

grant select, insert, update, delete on claim_number_sequences to authenticated;
grant select, insert, update, delete on claims to authenticated;
grant select, insert, update, delete on claim_lines to authenticated;
grant select, insert, update, delete on claim_advances to authenticated;
grant select, insert, update, delete on claim_reimbursements to authenticated;
grant select, insert on claim_status_history to authenticated;
grant select, insert on claim_review_actions to authenticated;
grant select, insert, update, delete on claim_evidence_requirements to authenticated;
grant select, insert, update, delete on claim_import_batches to authenticated;
grant select, insert, update, delete on claim_import_rows to authenticated;

revoke all on claim_number_sequences from anon;
revoke all on claims from anon;
revoke all on claim_lines from anon;
revoke all on claim_advances from anon;
revoke all on claim_reimbursements from anon;
revoke all on claim_status_history from anon;
revoke all on claim_review_actions from anon;
revoke all on claim_evidence_requirements from anon;
revoke all on claim_import_batches from anon;
revoke all on claim_import_rows from anon;

notify pgrst, 'reload schema';
