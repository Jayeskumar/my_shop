#!/usr/bin/env bash
# =============================================================================
# Kadai on-prem database restore (Docker or native Linux installation).
#
#   sudo ./restore.sh /opt/kadai/data/backups/kadai-kadai-20261020-230000-scheduled.dump
#
# Safe by design:
#   1. verifies the archive (sha256 file when present, pg_restore --list)
#   2. asks for confirmation (type the database name; --yes for automation)
#   3. takes a safety backup of the current database (unless --no-safety-backup)
#   4. stops Kadai, restores into a NEW scratch database in one transaction
#   5. swaps names atomically: kadai → kadai_pre_restore_<time>, scratch → kadai
#   6. starts Kadai (pending migrations are applied on boot) and waits until it is ready
# The previous database is kept for rollback; drop it once you have checked the data.
# Restoring onto a fresh machine works the same way (install first, then restore).
# =============================================================================
set -Eeuo pipefail

KADAI_HOME=${KADAI_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}
# shellcheck source=lib/kadai-common.sh
source "$KADAI_HOME/lib/kadai-common.sh"

usage() {
  cat <<'EOF'
Usage: restore.sh <backup.dump> [options]
  --yes                  do not ask for confirmation
  --no-safety-backup     skip the backup of the current database (e.g. it is damaged)
  --no-start             leave Kadai stopped after the restore
  -h, --help             show this help
EOF
}

file='' assume_yes=0 safety=1 start=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes | -y) assume_yes=1; shift ;;
    --no-safety-backup) safety=0; shift ;;
    --no-start) start=0; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) usage >&2; die "unknown option: $1" ;;
    *) [[ -z "$file" ]] || die "only one backup file may be given"; file=$1; shift ;;
  esac
done
[[ -n "$file" ]] || {
  usage >&2
  exit 64
}
[[ -f "$file" && -r "$file" ]] || die "cannot read $file"
file=$(cd "$(dirname "$file")" && pwd -P)/$(basename "$file")

kadai_detect_mode
db=$KADAI_DB_NAME

# --- 1. verify ----------------------------------------------------------------------------
if [[ -f "$file.sha256" ]]; then
  expected=$(awk '{print $1; exit}' "$file.sha256")
  actual=$(sha256_of "$file")
  [[ "$expected" == "$actual" ]] || die "checksum mismatch for $file (expected $expected, got $actual)"
  log "checksum OK"
else
  warn "no $file.sha256 next to the backup: integrity not verified by checksum"
fi
toc=$(kadai_pg_list "$file") || die "$file is not a pg_dump custom-format archive"
log "archive details:"
grep -E '^;[[:space:]]+(Archive created at|dbname|Dumped from database version|Dumped by pg_dump version)' <<<"$toc" >&2 || true

# --- 2. confirm ---------------------------------------------------------------------------
if ((!assume_yes)); then
  [[ -t 0 ]] || die "not a terminal: pass --yes to confirm the restore"
  printf '\nThis REPLACES all data in database "%s" with the backup above.\n' "$db" >&2
  printf 'Kadai will be stopped during the restore. Type the database name (%s) to continue: ' "$db" >&2
  read -r answer
  [[ "$answer" == "$db" ]] || die "aborted"
fi

stamp=$(date +%Y%m%d_%H%M%S)
scratch="${db}_restore_${stamp}"
old="${db}_pre_restore_${stamp}"

# --- 3. safety backup ---------------------------------------------------------------------
if ((safety)); then
  log "taking a safety backup of the current database"
  "$KADAI_HOME/backup.sh" --kind manual --label pre-restore --no-prune >/dev/null ||
    die "safety backup failed; fix it or re-run with --no-safety-backup"
fi

# --- 4. restore into a scratch database ---------------------------------------------------
app_stopped=0
cleanup() {
  local rc=$?
  if ((rc != 0)); then
    warn "restore failed; the current database was not changed"
    kadai_psql postgres -q -c "DROP DATABASE IF EXISTS \"$scratch\"" >/dev/null 2>&1 || true
    if ((app_stopped)); then kadai_start_app >/dev/null 2>&1 || warn "could not restart Kadai"; fi
  fi
}
trap cleanup EXIT

log "stopping Kadai"
kadai_stop_app
app_stopped=1

log "creating scratch database $scratch"
kadai_psql postgres -q -v scratch="$scratch" >/dev/null <<'SQL'
SELECT format('CREATE DATABASE %I TEMPLATE template0 ENCODING %L', :'scratch', 'UTF8') \gexec
SQL
kadai_psql "$scratch" -q >/dev/null <<'SQL'
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
SQL

log "restoring (single transaction; this can take a few minutes)"
# --no-owner: every object becomes owned by the owner role running the restore, whatever the
# role names were on the machine that made the backup. Grants to the runtime role are kept.
kadai_pg_restore "$file" "$scratch" --no-owner --single-transaction --exit-on-error

kadai_psql "$scratch" -q -v db="$scratch" -v app="$KADAI_DB_APP_USER" >/dev/null <<'SQL'
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', :'db', :'app') \gexec
SQL

# --- 5. swap ------------------------------------------------------------------------------
log "swapping databases ($db → $old, $scratch → $db)"
kadai_psql postgres -q -v db="$db" -v old="$old" -v scratch="$scratch" >/dev/null <<'SQL'
-- Leftover sessions of the owner role (the runtime role's sessions ended with the app).
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE datname = :'db' AND pid <> pg_backend_pid() AND usename = current_user;
BEGIN;
SELECT format('ALTER DATABASE %I RENAME TO %I', :'db', :'old') \gexec
SELECT format('ALTER DATABASE %I RENAME TO %I', :'scratch', :'db') \gexec
COMMIT;
SQL
trap - EXIT

# --- 6. start -----------------------------------------------------------------------------
if ((start)); then
  log "starting Kadai (pending migrations are applied on boot)"
  kadai_start_app
  kadai_wait_ready 600 || die "Kadai did not become ready; check the logs. The previous database is kept as $old"
else
  log "Kadai left stopped (--no-start)"
fi

cat >&2 <<EOF

Restore complete. The previous database is kept as "$old" for rollback.
After checking the data, free its disk space with:
  $( [[ "$KADAI_INSTALL_MODE" == docker ]] && printf 'docker compose exec db dropdb -U %s "%s"' "$KADAI_DB_OWNER" "$old" || printf 'sudo -u postgres dropdb "%s"' "$old" )
EOF
