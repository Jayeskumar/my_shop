#!/usr/bin/env bash
# Integration test: on-prem backup.sh → restore.sh (native mode) against a real PostgreSQL.
#
#   bash deploy/tests/backup-restore.test.sh
#
# Needs psql/pg_dump/pg_restore on PATH and an owner role with CREATEDB:
#   KADAI_TEST_OWNER_URL  (default postgres://kadai_owner:kadai_owner@localhost:5432/postgres)
#   KADAI_TEST_APP_URL    (default postgres://kadai_app:kadai_app@localhost:5432/postgres)
# Creates and drops its own databases (kadai_bkptest_<random>…); systemctl is stubbed.
set -Eeuo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
owner_url=${KADAI_TEST_OWNER_URL:-postgres://kadai_owner:kadai_owner@localhost:5432/postgres}
app_url=${KADAI_TEST_APP_URL:-postgres://kadai_app:kadai_app@localhost:5432/postgres}
db="kadai_bkptest_$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"

tmp=$(mktemp -d)
url_for() { printf '%s/%s' "${1%/*}" "$2"; }
psql_owner() { psql -X -v ON_ERROR_STOP=1 -At "$(url_for "$owner_url" "${1:-postgres}")" "${@:2}"; }

cleanup() {
  local dbs
  dbs=$(psql_owner postgres -c "SELECT datname FROM pg_database WHERE datname LIKE '${db}%'" 2>/dev/null || true)
  for d in $dbs; do psql_owner postgres -q -c "DROP DATABASE IF EXISTS \"$d\"" >/dev/null 2>&1 || true; done
  rm -rf "$tmp"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
ok() { echo "ok - $*"; }

# --- fixture: a migrated database owned by the owner role ------------------------------------
psql_owner postgres -q -c "CREATE DATABASE \"$db\" TEMPLATE template0 ENCODING 'UTF8'"
psql_owner "$db" -q -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS citext;'
psql_owner "$db" -q -c "REVOKE ALL ON DATABASE \"$db\" FROM PUBLIC; GRANT CONNECT, TEMPORARY ON DATABASE \"$db\" TO kadai_app"
(
  cd "$repo/apps/server"
  DATABASE_URL=$(url_for "$app_url" "$db") DATABASE_SYSTEM_URL=$(url_for "$owner_url" "$db") NODE_ENV=test \
    pnpm exec tsx src/db/migrate-cli.ts >/dev/null 2>&1
) || fail "migrating the fixture database"
migrations=$(psql_owner "$db" -c 'SELECT count(*) FROM schema_migrations')
((migrations > 0)) || fail "no migrations applied"
psql_owner "$db" -q -c "INSERT INTO system_settings (key, value) VALUES ('deploy_test', '\"before\"')"
ok "fixture database $db migrated ($migrations migrations)"

# --- native installation stand-in ------------------------------------------------------------
mkdir -p "$tmp/bin" "$tmp/data"
cat >"$tmp/bin/systemctl" <<EOF
#!/usr/bin/env bash
echo "systemctl \$*" >>"$tmp/systemctl.log"
EOF
chmod +x "$tmp/bin/systemctl"
cat >"$tmp/kadai.env" <<EOF
DATABASE_URL=$(url_for "$app_url" "$db")
DATABASE_SYSTEM_URL=$(url_for "$owner_url" "$db")
KADAI_DATA_DIR=$tmp/data
PORT=18080
SMTP_FROM=Kadai <no-reply@localhost>
EOF
export PATH="$tmp/bin:$PATH" KADAI_INSTALL_MODE=native KADAI_ENV_FILE="$tmp/kadai.env" \
  KADAI_DB_NAME="$db" KADAI_HOME="$repo/deploy/onprem"

# --- backup ----------------------------------------------------------------------------------
dump=$("$repo/deploy/onprem/backup.sh" --kind manual --label t1 2>"$tmp/backup.log") || {
  cat "$tmp/backup.log" >&2
  fail "backup.sh"
}
[[ -s "$dump" && "$dump" == "$tmp/data/backups/kadai-$db-"*-manual-t1.dump ]] || fail "unexpected backup path $dump"
(cd "$(dirname "$dump")" && sha256sum -c --quiet "$(basename "$dump").sha256") || fail "checksum file"
[[ "$(stat -c %a "$dump")" == 600 ]] || fail "backup file must be private (mode $(stat -c %a "$dump"))"
recorded=$(psql_owner "$db" -c "SELECT count(*) FROM backups WHERE kind = 'manual' AND status = 'completed' AND location = '$dump' AND size_bytes > 0")
[[ "$recorded" == 1 ]] || fail "backup not recorded in the backups table"
ok "backup.sh wrote $(basename "$dump"), checksum verified, recorded in backups"

# A second backup while one is "running" must be refused.
exec 8>"$tmp/data/backups/.backup.lock"
flock -n 8
if "$repo/deploy/onprem/backup.sh" >/dev/null 2>&1; then fail "concurrent backup was not refused"; fi
exec 8>&-
ok "concurrent backups are refused (lock)"

# --- change data, then restore ------------------------------------------------------------------
psql_owner "$db" -q -c "UPDATE system_settings SET value = '\"after\"' WHERE key = 'deploy_test'"
"$repo/deploy/onprem/restore.sh" "$dump" --yes --no-start 2>"$tmp/restore.log" || {
  cat "$tmp/restore.log" >&2
  fail "restore.sh"
}
value=$(psql_owner "$db" -c "SELECT value #>> '{}' FROM system_settings WHERE key = 'deploy_test'")
[[ "$value" == before ]] || fail "restored value is '$value', expected 'before'"
old=$(psql_owner postgres -c "SELECT datname FROM pg_database WHERE datname LIKE '${db}_pre_restore_%'")
[[ -n "$old" ]] || fail "previous database was not kept"
old_value=$(psql_owner "$old" -c "SELECT value #>> '{}' FROM system_settings WHERE key = 'deploy_test'")
[[ "$old_value" == after ]] || fail "previous database lost its data"
[[ "$(psql_owner "$db" -c 'SELECT count(*) FROM schema_migrations')" == "$migrations" ]] || fail "schema_migrations differ"
grep -q "systemctl stop kadai" "$tmp/systemctl.log" || fail "Kadai was not stopped before the restore"
ls "$tmp/data/backups/"*-manual-pre-restore.dump >/dev/null 2>&1 || fail "no safety backup before the restore"
ok "restore.sh swapped in the backup, kept $old, took a safety backup"

# Runtime role still works on the restored database (database grants + table grants + RLS).
plans=$(psql -X -At "$(url_for "$app_url" "$db")" -c 'SELECT count(*) FROM plans')
((plans > 0)) || fail "kadai_app cannot read plans after the restore"
if psql -X -At "$(url_for "$app_url" "$db")" -c 'SELECT count(*) FROM schema_migrations' >/dev/null 2>&1; then
  fail "kadai_app must not read schema_migrations (system-only table)"
fi
if psql -X -At "$(url_for "$app_url" "$db")" -c 'DELETE FROM audit_logs' >/dev/null 2>&1; then
  fail "kadai_app must not delete from append-only audit_logs"
fi
ok "runtime role privileges survive the restore"

# --- broken archive is rejected before anything is stopped --------------------------------------
printf 'not a dump' >"$tmp/broken.dump"
: >"$tmp/systemctl.log"
if "$repo/deploy/onprem/restore.sh" "$tmp/broken.dump" --yes --no-start >/dev/null 2>&1; then fail "broken archive accepted"; fi
[[ ! -s "$tmp/systemctl.log" ]] || fail "Kadai was stopped for a broken archive"
cp "$dump" "$tmp/tampered.dump"
printf 'x' >>"$tmp/tampered.dump"
sed "s/$(basename "$dump")/tampered.dump/" "$dump.sha256" >"$tmp/tampered.dump.sha256"
if "$repo/deploy/onprem/restore.sh" "$tmp/tampered.dump" --yes --no-start >/dev/null 2>&1; then fail "tampered archive accepted"; fi
ok "broken and tampered archives are rejected up front"

# --- retention ---------------------------------------------------------------------------------
for i in 1 2 3 4; do
  f="$tmp/data/backups/kadai-$db-2020010${i}-000000-scheduled.dump"
  printf 'old' >"$f"
  touch -d "$((60 + i)) days ago" "$f"
done
"$repo/deploy/onprem/backup.sh" --kind scheduled --retention-days 30 --keep-min 4 >/dev/null 2>&1 || fail "backup with retention"
left_old=$(find "$tmp/data/backups" -name "kadai-$db-2020*" | wc -l)
total=$(find "$tmp/data/backups" -name 'kadai-*.dump' | wc -l)
# Newest 4 kept (3 recent + the newest old one); the 3 older old ones pruned.
[[ "$left_old" == 1 && "$total" == 4 ]] || fail "retention kept $total backups ($left_old old)"
ok "retention prunes old backups but keeps the newest --keep-min"

echo "all backup/restore checks passed"
