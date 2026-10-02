-- Catalogue snapshot: one line per object "kind|identifier|md5(definition)". Sorted for diffing.
select line from (
  select 'policy|' || schemaname || '.' || tablename || '.' || policyname || '|' ||
         md5(coalesce(cmd,'') || coalesce(roles::text,'') || coalesce(qual,'') || '~' || coalesce(with_check,'')) as line
  from pg_policies where schemaname in ('public','storage','auth')
  union all
  select 'function|' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|' ||
         md5(pg_get_functiondef(p.oid) || p.prosecdef::text || coalesce(p.proconfig::text,'') || coalesce(p.proacl::text,''))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public','app_private') and p.prokind in ('f','p')
  union all
  select 'trigger|' || c.relname || '.' || t.tgname || '|' || md5(pg_get_triggerdef(t.oid))
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal
  union all
  select 'column|' || table_name || '.' || column_name || '|' || md5(data_type || coalesce(column_default,'') || is_nullable)
  from information_schema.columns where table_schema = 'public'
  union all
  select 'constraint|' || c.relname || '.' || k.conname || '|' || md5(pg_get_constraintdef(k.oid))
  from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
  union all
  select 'grant|' || table_name || '|' || grantee || '|' || privilege_type
  from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon','authenticated','public')
  union all
  select 'view|' || c.relname || '|' || md5(pg_get_viewdef(c.oid) || coalesce(c.reloptions::text,''))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'v'
  union all
  select 'rls|' || c.relname || '|' || c.relrowsecurity::text || c.relforcerowsecurity::text
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'
  union all
  select 'index|' || tablename || '.' || indexname || '|' || md5(indexdef) from pg_indexes where schemaname = 'public'
) s order by line;
