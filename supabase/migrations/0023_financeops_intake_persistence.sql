-- ============================================================================================
-- 0023 - FinanceOps Phase 1A intake persistence.
--
-- STATUS: NUMBERED CANDIDATE - IMMUTABLE ONCE COMMITTED. NOT APPLIED TO PRODUCTION.
--   * Approved by the owner for numbering as 0023 (2026-10-02), on condition that this exact committed file
--     passes the full disposable validation again before any application persistence or Production
--     consideration. Validation so far has been on the un-numbered design draft only.
--   * Once committed this file must never be edited. Any change means a NEW migration (0024 or later) -
--     never an edit of 0023 - so that the validated file and the file any environment applies are identical.
--   * Verify integrity with the Git blob id of this path (platform independent), or SHA-256 after explicit LF
--     normalisation; a working-tree hash changes with core.autocrlf (see docs/financeops/migration-a/MIGRATION_0023_MANIFEST.md).
--   * No 'db push', no Production, no hosted project until the owner separately approves a Production window.
--
--   Owner decisions applied: Q1 data_verified; Q2 registry kept; Q3 two definer helpers kept (search_path='');
--   Q4 D11-literal central visibility; Q5 (modified) NO database gate on draft->unpaid - the FinanceOps-origin
--   gate is application-only and lives outside this file; Q6 no AAL2 for entity resolution; Q7 unresolved
--   junk may be rejected; Q8 links cleared (intake preserved) on supported draft-bill/document deletion;
--   Q9 no API delete path and no service-role cleanup path. Invariant: data_verified => process_state='complete'.
--
--   Application ordering note: a document must be inserted AND linked (document_links) to a same-entity bill
--   BEFORE the intake references it; documents RLS only exposes a document through a link, and the row trigger
--   reads the document as the calling user.
--
-- Adds ONLY new objects. Does NOT modify 0020/0021/0022, any existing table, policy, trigger
-- or function. Does not touch supplier_bills, documents, document_links, Storage, bill_payments,
-- payment vouchers, claims, bank or reconciliation objects.
--
-- New objects:
--   tables     public.finance_integration_identities, public.finance_intake_submissions
--   functions  app_private.current_user_can_review_unresolved_intakes()   [SECURITY DEFINER]
--              app_private.intake_is_superseded(text)                     [SECURITY DEFINER]
--              public.enforce_finance_intake_rules()                      [trigger, INVOKER]
--              public.audit_finance_intake_change()                       [trigger, INVOKER]
--              public.enforce_finance_integration_identity()              [trigger, INVOKER]
--   view       public.finance_intake_queue (security_invoker)
-- ============================================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

-- --------------------------------------------------------------------------------------------
-- 0. Preflight: fail rather than overwrite or build on a missing baseline.
-- --------------------------------------------------------------------------------------------
do $preflight$
begin
  if current_setting('server_version_num')::integer < 150000 then
    raise exception '0023 requires PostgreSQL 15 or newer (security_invoker views)';
  end if;

  if to_regclass('public.entities') is null
     or to_regclass('public.app_profiles') is null
     or to_regclass('public.supplier_bills') is null
     or to_regclass('public.documents') is null
     or to_regclass('public.audit_logs') is null
     or to_regclass('public.user_entity_access') is null then
    raise exception '0023 preflight failed: expected Finance tables are missing';
  end if;

  if to_regprocedure('app_private.current_user_has_app_access()') is null
     or to_regprocedure('app_private.current_user_can(text)') is null
     or to_regprocedure('app_private.user_can_access_entity(uuid)') is null
     or to_regprocedure('app_private.current_user_is_owner()') is null
     or to_regprocedure('app_private.current_user_has_aal2()') is null
     or to_regprocedure('app_private.current_user_is_data_entry()') is null then
    raise exception '0023 preflight failed: Stage 1B (0022) security helpers are missing';
  end if;

  -- Stage 1B marker: the draft-only insert policy must exist on supplier_bills.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'supplier_bills' and policyname = 'supplier_bills_finance_insert'
  ) then
    raise exception '0023 preflight failed: Stage 1B supplier_bills policies are not present';
  end if;

  if to_regclass('public.finance_integration_identities') is not null
     or to_regclass('public.finance_intake_submissions') is not null
     or to_regclass('public.finance_intake_queue') is not null
     or to_regprocedure('app_private.current_user_can_review_unresolved_intakes()') is not null
     or to_regprocedure('app_private.intake_is_superseded(text)') is not null
     or to_regprocedure('public.enforce_finance_intake_rules()') is not null
     or to_regprocedure('public.audit_finance_intake_change()') is not null
     or to_regprocedure('public.enforce_finance_integration_identity()') is not null then
    raise exception '0023 preflight failed: an object it creates already exists';
  end if;
end
$preflight$;

-- --------------------------------------------------------------------------------------------
-- 1. Integration identity registry (designates WHICH data_entry user is FinanceOps and
--    which entities it may submit for). Not a role; owner-managed; AAL2 to change.
-- --------------------------------------------------------------------------------------------
create table public.finance_integration_identities (
  user_id uuid primary key references auth.users(id) on delete cascade,
  integration text not null default 'financeops',
  active_status boolean not null default true,
  allowed_entity_ids uuid[] not null,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fii_integration_known check (integration = 'financeops'),
  constraint fii_entities_count check (cardinality(allowed_entity_ids) between 1 and 4)
);

create function public.enforce_finance_integration_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- The identity must be an ACTIVE data_entry user. It must never be finance_staff or any other role.
  if not exists (
    select 1 from public.app_profiles p
    where p.id = new.user_id and p.active_status = true and p.role = 'data_entry'
  ) then
    raise exception 'A FinanceOps integration identity must be an active data_entry user';
  end if;

  -- Only the four approved entities, each of which must exist; no duplicates.
  if exists (
    select 1
    from unnest(new.allowed_entity_ids) as a(entity_id)
    left join public.entities e on e.id = a.entity_id
    where e.id is null or e.short_code not in ('IEA', 'IETA', 'PLC', 'KALER')
  ) then
    raise exception 'allowed_entity_ids must reference only the approved entities IEA, IETA, PLC, KALER';
  end if;
  if cardinality(new.allowed_entity_ids) <> (select count(distinct x) from unnest(new.allowed_entity_ids) as x) then
    raise exception 'allowed_entity_ids must not contain duplicates';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger fii_enforce_rules
before insert or update on public.finance_integration_identities
for each row execute function public.enforce_finance_integration_identity();

-- --------------------------------------------------------------------------------------------
-- 2. Intake persistence.
-- --------------------------------------------------------------------------------------------
create table public.finance_intake_submissions (
  id uuid primary key default gen_random_uuid(),

  -- idempotency / provenance
  intake_id text not null,
  payload_hash text not null,
  integration_key_id text,
  request_id text,
  source jsonb not null,
  payload jsonb not null,

  -- entity: NULL only while unresolved (D4/D10). entity_code_declared is what FinanceOps stated.
  entity_code_declared text,
  entity_id uuid references public.entities(id) on delete restrict,

  -- records created from this intake (never before the entity is resolved)
  supplier_bill_id uuid references public.supplier_bills(id) on delete set null,
  document_id uuid references public.documents(id) on delete set null,

  -- original document facts (the file itself is stored only for entity-resolved intakes)
  document_sha256 text not null,
  document_mime_type text not null,
  document_filename text not null,
  document_size_bytes integer not null,

  flags text[] not null default '{}',
  duplicate_matches jsonb not null default '[]'::jsonb,

  -- mechanical progress vs human data review are separate axes
  process_state text not null default 'received',
  review_status text not null default 'pending_review',
  review_note text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,

  -- D10 path 1: reviewer entity resolution on the same row (set once)
  entity_resolved_by uuid references auth.users(id) on delete set null,
  entity_resolved_at timestamptz,
  entity_resolution_note text,

  -- D10 path 2: a NEW intake that supersedes an unresolved one (lineage lives on the new row)
  supersedes_intake_id text,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint fis_intake_id_key unique (intake_id),
  constraint fis_supersedes_fk foreign key (supersedes_intake_id)
    references public.finance_intake_submissions (intake_id) on delete restrict,

  constraint fis_intake_id_format check (intake_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  constraint fis_payload_hash_format check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint fis_document_sha256_format check (document_sha256 ~ '^[0-9a-f]{64}$'),
  constraint fis_document_mime check (document_mime_type in ('application/pdf', 'image/jpeg', 'image/png')),
  constraint fis_document_size check (document_size_bytes between 1 and 4194304),
  constraint fis_entity_code_declared check (entity_code_declared is null or entity_code_declared in ('IEA', 'IETA', 'PLC', 'KALER')),
  constraint fis_source_is_object check (jsonb_typeof(source) = 'object'),
  constraint fis_payload_is_object check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 65536),
  constraint fis_duplicates_is_array check (jsonb_typeof(duplicate_matches) = 'array'),
  constraint fis_flags_size check (cardinality(flags) <= 64),
  constraint fis_process_state check (process_state in ('received', 'awaiting_entity', 'bill_created', 'document_attached', 'complete')),
  constraint fis_review_status check (review_status in ('pending_review', 'data_verified', 'rejected', 'duplicate_suspected', 'needs_attention')),

  -- No Supplier Bill and no stored document until exactly one authorised entity is resolved.
  constraint fis_no_records_without_entity check (entity_id is not null or (supplier_bill_id is null and document_id is null)),
  -- An unresolved row is always 'awaiting_entity', and 'awaiting_entity' only exists while unresolved.
  constraint fis_awaiting_entity_state check ((entity_id is null) = (process_state = 'awaiting_entity')),
  constraint fis_data_verified_needs_review check (review_status <> 'data_verified' or (reviewed_at is not null and entity_id is not null)),
  -- Q-review: a row can never be data_verified while its mechanical state is bill_created / document_attached.
  constraint fis_data_verified_needs_complete check (review_status <> 'data_verified' or process_state = 'complete'),
  constraint fis_resolution_note_pair check ((entity_resolved_at is null) = (entity_resolution_note is null)),
  constraint fis_resolution_note_length check (entity_resolution_note is null or length(btrim(entity_resolution_note)) >= 3),
  constraint fis_no_self_supersede check (supersedes_intake_id is distinct from intake_id),
  -- A superseding intake must already carry its (FinanceOps-declared) entity and was never reviewer-resolved.
  constraint fis_supersede_has_entity check (supersedes_intake_id is null or (entity_id is not null and entity_resolved_at is null))
);

create unique index fis_supersedes_uidx on public.finance_intake_submissions (supersedes_intake_id) where supersedes_intake_id is not null;
create unique index fis_supplier_bill_uidx on public.finance_intake_submissions (supplier_bill_id) where supplier_bill_id is not null;
create unique index fis_document_uidx on public.finance_intake_submissions (document_id) where document_id is not null;
create index fis_unresolved_idx on public.finance_intake_submissions (created_at) where entity_id is null;
create index fis_entity_review_idx on public.finance_intake_submissions (entity_id, review_status, created_at desc);
create index fis_document_sha256_idx on public.finance_intake_submissions (document_sha256);
create index fis_created_by_idx on public.finance_intake_submissions (created_by);

-- --------------------------------------------------------------------------------------------
-- 3. Helper functions (the only new SECURITY DEFINER surface).
-- --------------------------------------------------------------------------------------------

-- D11: only Owner, Finance Manager and Finance Staff may see or resolve an intake whose entity is unknown.
create function app_private.current_user_can_review_unresolved_intakes()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.current_user_has_app_access()
    and exists (
      select 1 from public.app_profiles p
      where p.id = auth.uid()
        and p.active_status = true
        and p.role in ('owner', 'finance_manager', 'finance_staff')
    );
$$;
-- (Reviewer set is exactly D11 / Q4: Owner, Finance Manager, Finance Staff. data_entry, management,
--  read_only and every non-finance role are excluded.)

-- Boolean existence only: lets the resolution trigger and the queue see a successor intake that the
-- caller's entity scope would otherwise hide. VOLATILE so it takes a fresh snapshot inside a
-- concurrent resolve-vs-supersede race (READ COMMITTED).
create function app_private.intake_is_superseded(p_intake_id text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not app_private.current_user_has_finance_role() then
    return false;
  end if;
  return exists (select 1 from public.finance_intake_submissions s where s.supersedes_intake_id = p_intake_id);
end;
$$;

revoke all on function app_private.current_user_can_review_unresolved_intakes() from public, anon;
revoke all on function app_private.intake_is_superseded(text) from public, anon;
grant execute on function app_private.current_user_can_review_unresolved_intakes() to authenticated, service_role;
grant execute on function app_private.intake_is_superseded(text) to authenticated, service_role;

-- --------------------------------------------------------------------------------------------
-- 4. Row rules (SECURITY INVOKER: every read it does is subject to the caller's own RLS).
--    Server-controlled columns are overwritten here, never trusted from the client.
-- --------------------------------------------------------------------------------------------
create function public.enforce_finance_intake_rules()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  is_integration boolean;
  original public.finance_intake_submissions%rowtype;
  resolved_code text;
  linked_entity uuid;
  linked_status text;
  linked_hash text;
  state_rank_old integer;
  state_rank_new integer;
begin
  -- Referential SET NULL actions (a draft bill, a document or an auth user was deleted) run as nested
  -- triggers (depth > 1) and may have no auth.uid(). They may only turn the link/actor columns into NULL
  -- and must change nothing else. A user-issued UPDATE always runs at depth 1 and never reaches this.
  if tg_op = 'UPDATE' and pg_catalog.pg_trigger_depth() > 1 then
    if (new.supplier_bill_id is not null and new.supplier_bill_id is distinct from old.supplier_bill_id)
       or (new.document_id is not null and new.document_id is distinct from old.document_id)
       or (new.reviewed_by is not null and new.reviewed_by is distinct from old.reviewed_by)
       or (new.entity_resolved_by is not null and new.entity_resolved_by is distinct from old.entity_resolved_by)
       or (new.created_by is not null and new.created_by is distinct from old.created_by)
       or (pg_catalog.to_jsonb(new) - array['supplier_bill_id', 'document_id', 'reviewed_by', 'entity_resolved_by', 'created_by', 'updated_at']::text[])
          is distinct from
          (pg_catalog.to_jsonb(old) - array['supplier_bill_id', 'document_id', 'reviewed_by', 'entity_resolved_by', 'created_by', 'updated_at']::text[]) then
      raise exception 'Nested updates may only clear record-link and actor references';
    end if;
    new.updated_at := now();
    return new;
  end if;

  if actor is null then
    raise exception 'Finance intake changes require an authenticated user';
  end if;

  select exists (
    select 1 from public.finance_integration_identities i
    where i.user_id = actor and i.active_status = true and i.integration = 'financeops'
  ) into is_integration;

  ---------------------------------------------------------------- INSERT
  if tg_op = 'INSERT' then
    if not is_integration then
      raise exception 'Only the designated FinanceOps integration identity may create finance intakes';
    end if;
    if new.created_by is distinct from actor then
      raise exception 'created_by must be the authenticated FinanceOps identity';
    end if;
    if new.reviewed_by is not null or new.reviewed_at is not null or new.review_note is not null
       or new.entity_resolved_by is not null or new.entity_resolved_at is not null or new.entity_resolution_note is not null
       or new.supplier_bill_id is not null or new.document_id is not null then
      raise exception 'A new finance intake cannot carry review, entity-resolution or record links';
    end if;
    if new.review_status not in ('pending_review', 'duplicate_suspected') then
      raise exception 'A new finance intake starts as pending_review or duplicate_suspected';
    end if;

    new.created_at := now();
    new.updated_at := now();

    if new.entity_id is null then
      -- Unresolved: FinanceOps must not have declared a code; no bill/file will exist.
      if new.entity_code_declared is not null then
        raise exception 'A declared entity code requires a resolved entity';
      end if;
      new.process_state := 'awaiting_entity';
    else
      select e.short_code into resolved_code from public.entities e where e.id = new.entity_id;
      if resolved_code is null or resolved_code not in ('IEA', 'IETA', 'PLC', 'KALER')
         or resolved_code is distinct from new.entity_code_declared then
        raise exception 'The entity must be an approved entity matching the declared entity code';
      end if;
      new.process_state := 'received';
    end if;

    if new.supersedes_intake_id is not null then
      -- Lock the original so a concurrent reviewer resolution cannot also win.
      select * into original from public.finance_intake_submissions s where s.intake_id = new.supersedes_intake_id for update;
      if not found then
        raise exception 'The intake to supersede was not found';
      end if;
      if original.entity_id is not null or original.entity_resolved_at is not null then
        raise exception 'intake_already_resolved: the original intake already has an entity';
      end if;
      if original.created_by is distinct from new.created_by then
        raise exception 'Only the originating FinanceOps identity may supersede an intake';
      end if;
      if original.review_status = 'rejected' then
        raise exception 'A rejected intake cannot be superseded';
      end if;
      -- (a second successor is rejected by the unique index fis_supersedes_uidx)
    end if;

    return new;
  end if;

  ---------------------------------------------------------------- UPDATE
  if new.id is distinct from old.id
     or new.intake_id is distinct from old.intake_id
     or new.payload_hash is distinct from old.payload_hash
     or new.integration_key_id is distinct from old.integration_key_id
     or new.request_id is distinct from old.request_id
     or new.source is distinct from old.source
     or new.payload is distinct from old.payload
     or new.entity_code_declared is distinct from old.entity_code_declared
     or new.document_sha256 is distinct from old.document_sha256
     or new.document_mime_type is distinct from old.document_mime_type
     or new.document_filename is distinct from old.document_filename
     or new.document_size_bytes is distinct from old.document_size_bytes
     or new.supersedes_intake_id is distinct from old.supersedes_intake_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Finance intake provenance and original-document columns are immutable';
  end if;
  new.updated_at := now();

  -- Terminal review states are frozen (checked first, so a rejected unresolved intake cannot be resolved either).
  if old.review_status in ('data_verified', 'rejected') then
    raise exception 'A finance intake that is % cannot be changed', old.review_status;
  end if;

  -- The kill switch freezes the creating identity: once it is no longer an active registry identity it
  -- cannot advance (or review) its own rows through any path.
  if old.created_by is not distinct from actor and not is_integration then
    raise exception 'The creating FinanceOps identity is no longer active in the integration registry';
  end if;

  -- D10 path 1: entity resolution (a standalone, set-once action by Finance Staff or above).
  if old.entity_id is null and new.entity_id is not null then
    if is_integration or not app_private.current_user_can_review_unresolved_intakes() then
      raise exception 'Only Owner, Finance Manager or Finance Staff may resolve an unresolved intake entity';
    end if;
    if app_private.intake_is_superseded(old.intake_id) then
      raise exception 'intake_already_resolved: the intake was superseded by a new intake';
    end if;
    select e.short_code into resolved_code from public.entities e where e.id = new.entity_id;
    if resolved_code is null or resolved_code not in ('IEA', 'IETA', 'PLC', 'KALER') then
      -- (an entity the caller cannot access is invisible through entities RLS and lands here too)
      raise exception 'The entity must be one of the approved entities, and one you can access';
    end if;
    if new.entity_resolution_note is null or length(btrim(new.entity_resolution_note)) < 3 then
      raise exception 'A resolution note is required';
    end if;
    if new.review_status is distinct from old.review_status or new.review_note is distinct from old.review_note
       or new.supplier_bill_id is distinct from old.supplier_bill_id or new.document_id is distinct from old.document_id
       or new.flags is distinct from old.flags or new.duplicate_matches is distinct from old.duplicate_matches then
      raise exception 'Entity resolution must be a standalone change';
    end if;
    new.entity_resolved_by := actor;
    new.entity_resolved_at := now();
    new.process_state := 'received';
    return new;
  end if;

  -- Otherwise the entity and its resolution trail are immutable.
  if new.entity_id is distinct from old.entity_id
     or new.entity_resolved_by is distinct from old.entity_resolved_by
     or new.entity_resolved_at is distinct from old.entity_resolved_at
     or new.entity_resolution_note is distinct from old.entity_resolution_note then
    raise exception 'The entity and its resolution trail cannot be changed once set';
  end if;

  -- Record links must belong to the same entity, be the original document, and are set once.
  if new.supplier_bill_id is distinct from old.supplier_bill_id then
    if old.supplier_bill_id is not null or new.supplier_bill_id is null then
      raise exception 'The supplier bill link can only be set once';
    end if;
    select b.entity_id, b.payment_status into linked_entity, linked_status
    from public.supplier_bills b where b.id = new.supplier_bill_id;
    if linked_entity is distinct from new.entity_id then
      raise exception 'The supplier bill belongs to a different entity than the intake';
    end if;
    if linked_status <> 'draft' then
      raise exception 'An intake can only be linked to a draft supplier bill';
    end if;
  end if;
  if new.document_id is distinct from old.document_id then
    if old.document_id is not null or new.document_id is null then
      raise exception 'The document link can only be set once';
    end if;
    select d.entity_id, d.file_hash into linked_entity, linked_hash
    from public.documents d where d.id = new.document_id;
    if linked_entity is distinct from new.entity_id or linked_hash is distinct from new.document_sha256 then
      raise exception 'The linked document must be the original file of the same entity';
    end if;
  end if;

  -- process_state moves forward only, and only to states its links support.
  if new.process_state is distinct from old.process_state then
    state_rank_old := array_position(array['awaiting_entity', 'received', 'bill_created', 'document_attached', 'complete'], old.process_state);
    state_rank_new := array_position(array['awaiting_entity', 'received', 'bill_created', 'document_attached', 'complete'], new.process_state);
    if state_rank_new <= state_rank_old or new.process_state = 'awaiting_entity' then
      raise exception 'process_state can only move forward';
    end if;
    if new.process_state in ('bill_created', 'document_attached', 'complete') and new.supplier_bill_id is null then
      raise exception 'process_state % requires a linked supplier bill', new.process_state;
    end if;
    if new.process_state in ('document_attached', 'complete') and new.document_id is null then
      raise exception 'process_state % requires a linked document', new.process_state;
    end if;
  end if;

  if is_integration and old.created_by = actor then
    ------------------------------------------------------------ FinanceOps identity: mechanical columns only
    if new.review_note is distinct from old.review_note
       or new.reviewed_by is distinct from old.reviewed_by
       or new.reviewed_at is distinct from old.reviewed_at then
      raise exception 'The FinanceOps integration identity cannot review its own intakes';
    end if;
    if new.review_status is distinct from old.review_status
       and not (old.review_status = 'pending_review' and new.review_status in ('duplicate_suspected', 'needs_attention')) then
      raise exception 'The FinanceOps integration identity can only flag an intake as duplicate_suspected or needs_attention';
    end if;
  else
    ------------------------------------------------------------ human reviewer (policy already required can_manage_bills + entity access,
    ------------------------------------------------------------ or the central Finance-review set for an unresolved intake)
    if is_integration then
      raise exception 'A FinanceOps integration identity cannot perform human review';
    end if;
    if new.flags is distinct from old.flags or new.duplicate_matches is distinct from old.duplicate_matches then
      raise exception 'Extraction flags and duplicate matches are a record of what FinanceOps reported and cannot be edited';
    end if;
    if new.review_status is distinct from old.review_status then
      if not (
        (old.review_status = 'pending_review' and new.review_status in ('data_verified', 'rejected', 'needs_attention', 'duplicate_suspected'))
        or (old.review_status = 'needs_attention' and new.review_status in ('pending_review', 'data_verified', 'rejected'))
        or (old.review_status = 'duplicate_suspected' and new.review_status in ('pending_review', 'rejected'))
      ) then
        raise exception 'Invalid review status transition % -> %', old.review_status, new.review_status;
      end if;
      if new.review_status in ('data_verified', 'rejected') then
        -- Four-eyes: the identity that created the intake can never verify or reject it.
        if old.created_by is not distinct from actor then
          raise exception 'Four-eyes rule: the creator of an intake cannot verify or reject it';
        end if;
        if new.review_status = 'data_verified'
           and (new.supplier_bill_id is null or new.document_id is null) then
          raise exception 'Data can only be verified once the draft bill and the original document are linked';
        end if;
        if new.review_status = 'data_verified' and new.process_state <> 'complete' then
          raise exception 'Data can only be verified once process_state is complete';
        end if;
        new.reviewed_by := actor;
        new.reviewed_at := now();
      else
        new.reviewed_by := old.reviewed_by;
        new.reviewed_at := old.reviewed_at;
      end if;
    else
      new.reviewed_by := old.reviewed_by;
      new.reviewed_at := old.reviewed_at;
    end if;
  end if;

  return new;
end;
$$;

create trigger fis_enforce_rules
before insert or update on public.finance_intake_submissions
for each row execute function public.enforce_finance_intake_rules();

-- --------------------------------------------------------------------------------------------
-- 5. Audit (DB-enforced, so auditing does not depend on application code — the Stage 1B lesson
--    from draft -> unpaid). SECURITY INVOKER: audit_logs_auth_insert already admits any active
--    user, and a failed audit insert fails the whole statement (fail closed).
-- --------------------------------------------------------------------------------------------
create function public.audit_finance_intake_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.audit_logs (actor_user_id, action, entity_type, entity_id, payload, is_demo, data_origin)
    values (
      auth.uid(), 'financeops_intake_received', 'finance_intake', new.entity_id,
      pg_catalog.jsonb_build_object(
        'submission_id', new.id, 'intake_id', new.intake_id, 'payload_hash', new.payload_hash,
        'integration_key_id', new.integration_key_id, 'request_id', new.request_id,
        'entity_code_declared', new.entity_code_declared, 'review_status', new.review_status,
        'document_sha256', new.document_sha256, 'flags', pg_catalog.to_jsonb(new.flags), 'source', new.source
      ),
      false, 'imported'
    );
    if new.supersedes_intake_id is not null then
      insert into public.audit_logs (actor_user_id, action, entity_type, entity_id, payload, is_demo, data_origin)
      values (
        auth.uid(), 'financeops_intake_superseded', 'finance_intake', new.entity_id,
        pg_catalog.jsonb_build_object('new_intake_id', new.intake_id, 'superseded_intake_id', new.supersedes_intake_id),
        false, 'imported'
      );
      insert into public.audit_logs (actor_user_id, action, entity_type, entity_id, payload, is_demo, data_origin)
      values (
        auth.uid(), 'financeops_intake_superseded_by', 'finance_intake', null,
        pg_catalog.jsonb_build_object('intake_id', new.supersedes_intake_id, 'superseded_by_intake_id', new.intake_id),
        false, 'imported'
      );
    end if;
    return new;
  end if;

  if old.entity_id is null and new.entity_id is not null then
    insert into public.audit_logs (actor_user_id, action, entity_type, entity_id, payload, before_data, after_data, is_demo, data_origin)
    values (
      auth.uid(), 'financeops_intake_entity_resolved', 'finance_intake', new.entity_id,
      pg_catalog.jsonb_build_object('submission_id', new.id, 'intake_id', new.intake_id, 'note', new.entity_resolution_note),
      pg_catalog.jsonb_build_object('entity_id', null),
      pg_catalog.jsonb_build_object('entity_id', new.entity_id),
      false, 'manual'
    );
  end if;

  if new.review_status is distinct from old.review_status then
    insert into public.audit_logs (actor_user_id, action, entity_type, entity_id, payload, before_data, after_data, is_demo, data_origin)
    values (
      auth.uid(), 'financeops_intake_' || new.review_status, 'finance_intake', new.entity_id,
      pg_catalog.jsonb_build_object('submission_id', new.id, 'intake_id', new.intake_id, 'note', new.review_note),
      pg_catalog.jsonb_build_object('review_status', old.review_status),
      pg_catalog.jsonb_build_object('review_status', new.review_status),
      false, 'manual'
    );
  end if;

  if new.supplier_bill_id is distinct from old.supplier_bill_id then
    insert into public.audit_logs (actor_user_id, action, entity_type, entity_id, payload, is_demo, data_origin)
    values (
      auth.uid(),
      case when new.supplier_bill_id is null then 'financeops_intake_bill_link_cleared' else 'financeops_intake_linked_bill' end,
      'finance_intake', new.entity_id,
      pg_catalog.jsonb_build_object('submission_id', new.id, 'intake_id', new.intake_id,
        'supplier_bill_id', coalesce(new.supplier_bill_id, old.supplier_bill_id)),
      false, 'manual'
    );
  end if;

  if new.document_id is distinct from old.document_id then
    insert into public.audit_logs (actor_user_id, action, entity_type, entity_id, payload, is_demo, data_origin)
    values (
      auth.uid(),
      case when new.document_id is null then 'financeops_intake_document_link_cleared' else 'financeops_intake_linked_document' end,
      'finance_intake', new.entity_id,
      pg_catalog.jsonb_build_object('submission_id', new.id, 'intake_id', new.intake_id,
        'document_id', coalesce(new.document_id, old.document_id)),
      false, 'manual'
    );
  end if;

  return new;
end;
$$;

create trigger fis_audit_changes
after insert or update on public.finance_intake_submissions
for each row execute function public.audit_finance_intake_change();

revoke all on function public.enforce_finance_integration_identity() from public, anon, authenticated;
revoke all on function public.enforce_finance_intake_rules() from public, anon, authenticated;
revoke all on function public.audit_finance_intake_change() from public, anon, authenticated;

-- --------------------------------------------------------------------------------------------
-- 6. RLS
-- --------------------------------------------------------------------------------------------
alter table public.finance_integration_identities enable row level security;
alter table public.finance_intake_submissions enable row level security;

revoke all on table public.finance_integration_identities from public, anon, authenticated;
revoke all on table public.finance_intake_submissions from public, anon, authenticated;
grant select, insert, update, delete on table public.finance_integration_identities to authenticated;
-- No DELETE grant on intakes: lineage is preserved. (service_role keeps its default privileges.)
grant select, insert, update on table public.finance_intake_submissions to authenticated;

-- Registry: the identity can read itself; the Owner (with AAL2) manages it.
create policy fii_select on public.finance_integration_identities for select to authenticated
  using (
    app_private.current_user_has_app_access()
    and (user_id = (select auth.uid()) or app_private.current_user_is_owner())
  );
create policy fii_owner_write on public.finance_integration_identities for all to authenticated
  using (app_private.current_user_is_owner() and app_private.current_user_has_aal2())
  with check (app_private.current_user_is_owner() and app_private.current_user_has_aal2());

-- Intakes: SELECT
--   * the creator (the FinanceOps identity) reads its own submissions (status / idempotent replay);
--   * entity_id IS NULL  -> only the central Finance-review set (Owner / Finance Manager / Finance Staff, D11);
--   * entity_id NOT NULL -> ordinary entity-scoped Finance visibility (this is what lets the intern verify, D2).
create policy fis_select on public.finance_intake_submissions for select to authenticated
  using (
    app_private.current_user_has_app_access()
    and (
      created_by = (select auth.uid())
      or (entity_id is null and app_private.current_user_can_review_unresolved_intakes())
      or (
        entity_id is not null
        and app_private.user_can_access_entity(entity_id)
        and app_private.current_user_can('can_view_finance')
      )
    )
  );

-- Intakes: INSERT — only the designated, active FinanceOps identity, which must currently be data_entry
-- (promoting it to finance_staff makes this policy fail closed), only for its allowed entities.
create policy fis_insert_integration on public.finance_intake_submissions for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and app_private.current_user_is_data_entry()
    and review_status in ('pending_review', 'duplicate_suspected')
    and exists (
      select 1 from public.finance_integration_identities i
      where i.user_id = (select auth.uid()) and i.active_status = true and i.integration = 'financeops'
        and (entity_id is null or entity_id = any (i.allowed_entity_ids))
    )
    and (entity_id is null or app_private.user_can_access_entity(entity_id))
  );

-- Intakes: UPDATE (three permissive paths; the row trigger enforces exactly which columns each may touch)
-- (a) the FinanceOps identity advances its own mechanical columns;
create policy fis_update_integration on public.finance_intake_submissions for update to authenticated
  using (
    created_by = (select auth.uid())
    and app_private.current_user_is_data_entry()
    and exists (select 1 from public.finance_integration_identities i where i.user_id = (select auth.uid()) and i.active_status = true and i.integration = 'financeops')
  )
  with check (
    created_by = (select auth.uid())
    and app_private.current_user_is_data_entry()
    and exists (
      select 1 from public.finance_integration_identities i
      where i.user_id = (select auth.uid()) and i.active_status = true and i.integration = 'financeops'
        and (entity_id is null or entity_id = any (i.allowed_entity_ids))
    )
  );

-- (b) entity-scoped human review (intern / Finance Staff / Finance Manager / Owner): data review + record links;
create policy fis_update_review on public.finance_intake_submissions for update to authenticated
  using (
    entity_id is not null
    and app_private.user_can_access_entity(entity_id)
    and app_private.current_user_can('can_manage_bills')
  )
  with check (
    entity_id is not null
    and app_private.user_can_access_entity(entity_id)
    and app_private.current_user_can('can_manage_bills')
  );

-- (c) D10 path 1: Finance Staff or above resolve an unresolved entity, only to an entity they may access.
--     The same path lets them reject an unresolved intake that is not ours (entity stays NULL; the trigger
--     still restricts what can change and forbids data_verified without an entity).
create policy fis_update_resolve_entity on public.finance_intake_submissions for update to authenticated
  using (
    entity_id is null
    and app_private.current_user_can_review_unresolved_intakes()
  )
  with check (
    app_private.current_user_can_review_unresolved_intakes()
    and (entity_id is null or app_private.user_can_access_entity(entity_id))
  );

-- --------------------------------------------------------------------------------------------
-- 7. Queue view (security_invoker: the caller's RLS applies to every row).
-- --------------------------------------------------------------------------------------------
create view public.finance_intake_queue
with (security_invoker = true, security_barrier = true)
as
select
  s.*,
  (s.entity_id is null) as is_unresolved,
  app_private.intake_is_superseded(s.intake_id) as is_superseded
from public.finance_intake_submissions s;

revoke all on public.finance_intake_queue from public, anon, authenticated;
grant select on public.finance_intake_queue to authenticated;

notify pgrst, 'reload schema';

commit;
