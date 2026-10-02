#!/usr/bin/env bash
# Concurrency checks for Migration A: two REAL concurrent psql sessions against the DISPOSABLE lab database.
# Usage: DBC=<lab db container> ./race_checks.sh   (container must be a local disposable Supabase db; never Production)
set -u
DBC="${DBC:?set DBC to the disposable db container name}"
FO='20000000-0000-4000-8000-000000000001'
FS='20000000-0000-4000-8000-000000000002'
OUT="$(mktemp -d)"
P() { docker exec -i "$DBC" psql -X -q -U postgres -d postgres "$@"; }

session() { # $1 user uuid, $2 body sql  -> prints the psql output (errors included)
  cat <<SQL | P 2>&1
begin;
select set_config('request.jwt.claim.sub', '$1', true), set_config('request.jwt.claims', '{"sub":"$1","role":"authenticated","aal":"aal1"}', true) \gset
set local role authenticated;
$2
commit;
SQL
}
successor() { echo "insert into public.finance_intake_submissions (intake_id, payload_hash, source, payload, entity_code_declared, entity_id, document_sha256, document_mime_type, document_filename, document_size_bytes, created_by, supersedes_intake_id) select '$1', repeat('f',64), '{}', '{}', 'IEA', id, repeat('7',64), 'application/pdf', 'x.pdf', 10, auth.uid(), '$2' from public.entities where short_code = 'IEA';"; }
resolve() { echo "update public.finance_intake_submissions set entity_id = (select id from public.entities where short_code = 'IEA'), entity_resolution_note = 'race resolution' where intake_id = '$1';"; }
state() { P -A -t -c "select intake_id, coalesce((select short_code from public.entities where id = s.entity_id), 'NULL') as entity, (select count(*) from public.finance_intake_submissions c where c.supersedes_intake_id = s.intake_id) as successors from public.finance_intake_submissions s where intake_id = '$1';"; }

echo "=== RACE 1: supersede holds the row lock; a concurrent reviewer resolution must lose"
( session "$FO" "$(successor race_a_s01 race_a_0001) select pg_sleep(5);" > "$OUT/r1_super.txt" ) &
sleep 1.5
( session "$FS" "$(resolve race_a_0001)" > "$OUT/r1_resolve.txt" ) &
wait
echo "-- supersede session:"; cat "$OUT/r1_super.txt" | grep -E 'ERROR|DETAIL|CONTEXT' | head -3
echo "-- resolve session:";   cat "$OUT/r1_resolve.txt" | grep -E 'ERROR|DETAIL|CONTEXT' | head -3
echo "-- final: $(state race_a_0001)   successor row exists: $(P -A -t -c "select count(*) from public.finance_intake_submissions where intake_id='race_a_s01'")"

echo "=== RACE 2: reviewer resolution holds the row lock; a concurrent supersession must lose"
( session "$FS" "$(resolve race_b_0001) select pg_sleep(5);" > "$OUT/r2_resolve.txt" ) &
sleep 1.5
( session "$FO" "$(successor race_b_s01 race_b_0001)" > "$OUT/r2_super.txt" ) &
wait
echo "-- resolve session:";   cat "$OUT/r2_resolve.txt" | grep -E 'ERROR|DETAIL|CONTEXT' | head -3
echo "-- supersede session:"; cat "$OUT/r2_super.txt" | grep -E 'ERROR|DETAIL|CONTEXT' | head -3
echo "-- final: $(state race_b_0001)   successor row exists: $(P -A -t -c "select count(*) from public.finance_intake_submissions where intake_id='race_b_s01'")"

echo "=== RACE 3: two simultaneous successors for the same original: exactly one may exist"
( session "$FO" "$(successor race_c_s01 race_c_0001) select pg_sleep(3);" > "$OUT/r3_a.txt" ) &
sleep 1
( session "$FO" "$(successor race_c_s02 race_c_0001)" > "$OUT/r3_b.txt" ) &
wait
echo "-- session A:"; cat "$OUT/r3_a.txt" | grep -E 'ERROR|DETAIL' | head -3
echo "-- session B:"; cat "$OUT/r3_b.txt" | grep -E 'ERROR|DETAIL' | head -3
echo "-- final: $(state race_c_0001)"

echo "=== RACE 4: two identical idempotent inserts at once (ON CONFLICT DO NOTHING): exactly one row"
IDEM="insert into public.finance_intake_submissions (intake_id, payload_hash, source, payload, document_sha256, document_mime_type, document_filename, document_size_bytes, created_by) values ('race_d_0001', repeat('f',64), '{}', '{}', repeat('7',64), 'application/pdf', 'x.pdf', 10, auth.uid()) on conflict (intake_id) do nothing;"
( session "$FO" "$IDEM select pg_sleep(3);" > "$OUT/r4_a.txt" ) &
sleep 1
( session "$FO" "$IDEM" > "$OUT/r4_b.txt" ) &
wait
echo "-- rows for race_d_0001: $(P -A -t -c "select count(*) from public.finance_intake_submissions where intake_id='race_d_0001'")   audit 'received' events: $(P -A -t -c "select count(*) from public.audit_logs where action='financeops_intake_received' and payload->>'intake_id'='race_d_0001'")"
rm -rf "$OUT"
