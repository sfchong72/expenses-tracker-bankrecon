create table if not exists uat_feedback (
  id uuid primary key default gen_random_uuid(),
  page_path text,
  feedback_type text not null default 'remark' check (feedback_type in ('remark', 'issue', 'question', 'idea')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'blocker')),
  summary text not null,
  details text,
  screenshot_reference text,
  status text not null default 'open' check (status in ('open', 'reviewing', 'resolved', 'closed')),
  submitted_by uuid references auth.users(id) on delete set null,
  submitted_at timestamptz not null default now(),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  resolution_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_uat_feedback_updated_at on uat_feedback;
create trigger set_uat_feedback_updated_at
before update on uat_feedback
for each row execute function public.set_updated_at();

alter table uat_feedback enable row level security;

drop policy if exists "uat_feedback_insert_active" on uat_feedback;
create policy "uat_feedback_insert_active" on uat_feedback
for insert to authenticated
with check (app_private.current_user_is_active() and submitted_by = auth.uid());

drop policy if exists "uat_feedback_select_owner_or_self" on uat_feedback;
create policy "uat_feedback_select_owner_or_self" on uat_feedback
for select to authenticated
using (app_private.current_user_is_owner() or submitted_by = auth.uid());

drop policy if exists "uat_feedback_owner_update" on uat_feedback;
create policy "uat_feedback_owner_update" on uat_feedback
for update to authenticated
using (app_private.current_user_is_owner())
with check (app_private.current_user_is_owner());

grant select, insert, update on uat_feedback to authenticated;
revoke all on uat_feedback from anon;

create index if not exists uat_feedback_status_idx on uat_feedback(status, priority, submitted_at desc);
create index if not exists uat_feedback_submitted_by_idx on uat_feedback(submitted_by, submitted_at desc);
