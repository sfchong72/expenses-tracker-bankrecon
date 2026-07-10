# Data Model

## invoices
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | gen_random_uuid() |
| user_id | uuid nullable | owner — populated at lock-down sprint |
| vendor | text | required |
| description | text | optional |
| amount | numeric(12,2) | required |
| currency | text | default 'MYR' |
| invoice_date | date | required |
| due_date | date | required |
| status | text | unpaid / paid / overdue |
| reference_number | text | optional |
| created_at | timestamptz | default now() |

## receipts
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid nullable | |
| merchant | text | required |
| description | text | |
| amount | numeric(12,2) | required |
| currency | text | default 'MYR' |
| expense_date | date | required |
| category | text | Transport / Meals / Office / General |
| receipt_image_url | text | optional file link |
| created_at | timestamptz | |

## bank_transactions
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid nullable | |
| description | text | required |
| amount | numeric(12,2) | required |
| direction | text | debit / credit |
| transaction_date | date | required |
| bank_reference | text | optional |
| statement_month | text | e.g. '2025-06' |
| created_at | timestamptz | |

## reconciliation_matches
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid nullable | |
| bank_transaction_id | uuid FK → bank_transactions | |
| invoice_id | uuid FK → invoices nullable | |
| receipt_id | uuid FK → receipts nullable | |
| match_type | text | exact / fuzzy / manual |
| match_value | numeric | **AI field** |
| match_value_source | text | system / ai / user |
| match_value_confidence | numeric | 0.0–1.0 |
| match_value_review_status | text | unreviewed / accepted / rejected |
| matched_by | text | system / ai / user |
| status | text | accepted / rejected / pending |
| created_at | timestamptz | |

Constraint: exactly one of `invoice_id` or `receipt_id` must be set (enforced in app logic; DB allows null for flexibility).

## audit_logs
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid nullable | |
| action | text | e.g. match_created, match_overridden, export_csv |
| entity_type | text | invoice / receipt / bank_transaction / match |
| entity_id | uuid | |
| payload | jsonb | before/after snapshot |
| created_at | timestamptz | |

## RLS
- All tables: v1 permissive (select + all open) — replaced in Sprint 5 with `auth.uid() = user_id`.
