create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  vendor text not null,
  description text,
  amount numeric(12,2) not null,
  currency text not null default 'MYR',
  invoice_date date not null,
  due_date date not null,
  status text not null default 'unpaid',
  reference_number text,
  created_at timestamptz not null default now()
);
alter table invoices enable row level security;
drop policy if exists "invoices_v1_read" on invoices;
create policy "invoices_v1_read" on invoices for select using (true);
drop policy if exists "invoices_v1_write" on invoices;
create policy "invoices_v1_write" on invoices for all using (true) with check (true);

create table if not exists receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  merchant text not null,
  description text,
  amount numeric(12,2) not null,
  currency text not null default 'MYR',
  expense_date date not null,
  category text not null default 'General',
  receipt_image_url text,
  created_at timestamptz not null default now()
);
alter table receipts enable row level security;
drop policy if exists "receipts_v1_read" on receipts;
create policy "receipts_v1_read" on receipts for select using (true);
drop policy if exists "receipts_v1_write" on receipts;
create policy "receipts_v1_write" on receipts for all using (true) with check (true);

create table if not exists bank_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  description text not null,
  amount numeric(12,2) not null,
  direction text not null default 'debit',
  transaction_date date not null,
  bank_reference text,
  statement_month text,
  created_at timestamptz not null default now()
);
alter table bank_transactions enable row level security;
drop policy if exists "bank_transactions_v1_read" on bank_transactions;
create policy "bank_transactions_v1_read" on bank_transactions for select using (true);
drop policy if exists "bank_transactions_v1_write" on bank_transactions;
create policy "bank_transactions_v1_write" on bank_transactions for all using (true) with check (true);

create table if not exists reconciliation_matches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  bank_transaction_id uuid references bank_transactions(id) on delete cascade,
  invoice_id uuid references invoices(id) on delete set null,
  receipt_id uuid references receipts(id) on delete set null,
  match_type text not null default 'exact',
  match_value numeric(12,2),
  match_value_source text,
  match_value_confidence numeric,
  match_value_review_status text default 'unreviewed',
  matched_by text not null default 'system',
  status text not null default 'accepted',
  created_at timestamptz not null default now()
);
alter table reconciliation_matches enable row level security;
drop policy if exists "reconciliation_matches_v1_read" on reconciliation_matches;
create policy "reconciliation_matches_v1_read" on reconciliation_matches for select using (true);
drop policy if exists "reconciliation_matches_v1_write" on reconciliation_matches;
create policy "reconciliation_matches_v1_write" on reconciliation_matches for all using (true) with check (true);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  payload jsonb,
  created_at timestamptz not null default now()
);
alter table audit_logs enable row level security;
drop policy if exists "audit_logs_v1_read" on audit_logs;
create policy "audit_logs_v1_read" on audit_logs for select using (true);
drop policy if exists "audit_logs_v1_write" on audit_logs;
create policy "audit_logs_v1_write" on audit_logs for all using (true) with check (true);

insert into invoices (vendor, description, amount, invoice_date, due_date, status, reference_number) values
  ('Mega Supplies Sdn Bhd', 'Office stationery bulk order', 4200.00, '2025-06-01', '2025-06-30', 'unpaid', 'INV-2025-0041'),
  ('CloudHost Pro', 'Annual server hosting renewal', 1800.00, '2025-06-05', '2025-06-20', 'paid', 'INV-2025-0042'),
  ('PrintFast Solutions', 'Marketing brochure printing', 960.00, '2025-06-10', '2025-07-10', 'unpaid', 'INV-2025-0043'),
  ('TechRepair Hub', 'Laptop screen replacement x2', 650.00, '2025-06-12', '2025-06-19', 'overdue', 'INV-2025-0044');

insert into receipts (merchant, description, amount, expense_date, category) values
  ('Petronas Petrol Station', 'Fuel for company vehicle', 120.00, '2025-06-13', 'Transport'),
  ('Village Park Restaurant', 'Client lunch meeting', 210.50, '2025-06-14', 'Meals & Entertainment'),
  ('Grab', 'Airport transfer', 55.00, '2025-06-15', 'Transport'),
  ('Mr DIY', 'Office supplies', 88.30, '2025-06-16', 'Office'),
  ('Watsons', 'First aid kit refill', 45.00, '2025-06-17', 'Office');

insert into bank_transactions (description, amount, direction, transaction_date, bank_reference, statement_month) values
  ('CLOUDHOST PRO RENEWAL', 1800.00, 'debit', '2025-06-06', 'TXN-20250606-001', '2025-06'),
  ('MEGA SUPPLIES SDN BHD', 4200.00, 'debit', '2025-06-30', 'TXN-20250630-002', '2025-06'),
  ('PETRONAS DAMANSARA', 120.00, 'debit', '2025-06-13', 'TXN-20250613-003', '2025-06'),
  ('GRAB*TRIP', 55.00, 'debit', '2025-06-15', 'TXN-20250615-004', '2025-06'),
  ('VILLAGE PARK REST', 210.50, 'debit', '2025-06-14', 'TXN-20250614-005', '2025-06'),
  ('SALARY CREDIT', 8500.00, 'credit', '2025-06-25', 'TXN-20250625-006', '2025-06');

insert into reconciliation_matches (bank_transaction_id, invoice_id, match_type, match_value, match_value_source, match_value_confidence, match_value_review_status, matched_by, status)
select bt.id, inv.id, 'exact', 1800.00, 'system', 1.0, 'accepted', 'system', 'accepted'
from bank_transactions bt, invoices inv
where bt.bank_reference = 'TXN-20250606-001' and inv.reference_number = 'INV-2025-0042';

insert into reconciliation_matches (bank_transaction_id, receipt_id, match_type, match_value, match_value_source, match_value_confidence, match_value_review_status, matched_by, status)
select bt.id, r.id, 'exact', 120.00, 'system', 1.0, 'accepted', 'system', 'accepted'
from bank_transactions bt, receipts r
where bt.bank_reference = 'TXN-20250613-003' and r.merchant = 'Petronas Petrol Station';

insert into reconciliation_matches (bank_transaction_id, receipt_id, match_type, match_value, match_value_source, match_value_confidence, match_value_review_status, matched_by, status)
select bt.id, r.id, 'exact', 55.00, 'system', 1.0, 'accepted', 'system', 'accepted'
from bank_transactions bt, receipts r
where bt.bank_reference = 'TXN-20250615-004' and r.merchant = 'Grab';