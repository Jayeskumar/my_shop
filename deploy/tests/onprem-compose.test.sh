#!/usr/bin/env bash
# End-to-end test of the on-prem Docker kit (deploy/onprem) with a locally built image:
#
#   sudo bash deploy/tests/onprem-compose.test.sh <image>      e.g. kadai:ci
#
# Copies the kit to a temporary folder, writes a .env with random secrets, starts PostgreSQL +
# Kadai, waits for /health/ready (initdb roles, migrations on boot, embedded worker), checks the
# web app, then runs backup.sh → change data → restore.sh and checks the data came back.
# Everything (containers, volumes, files) is removed afterwards. Root is needed because the
# data folder belongs to uid 10001 (like on a real installation).
# Optional: KADAI_E2E_PORT (default 18181), KADAI_E2E_SUBNET, KADAI_POSTGRES_IMAGE.
set -Eeuo pipefail

image=${1:?usage: onprem-compose.test.sh <image>}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
port=${KADAI_E2E_PORT:-18181}
work=$(mktemp -d)
kit="$work/kadai"
project="kadai-e2e-$$"

cp -R "$here/../onprem" "$kit"
# shellcheck source=../onprem/lib/kadai-common.sh
source "$kit/lib/kadai-common.sh"
KADAI_HOME=$kit

teardown() {
  local rc=$?
  if ((rc != 0)); then
    echo "--- docker compose ps / logs (failure)" >&2
    dc ps -a >&2 || true
    dc logs --no-color --tail 80 >&2 || true
  fi
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$rc"
}
trap teardown EXIT
fail() {
  echo "FAIL: $*" >&2
  exit 1
}
ok() { echo "ok - $*"; }

cp "$kit/.env.example" "$kit/.env"
env_set "$kit/.env" COMPOSE_PROJECT_NAME "$project"
env_set "$kit/.env" KADAI_IMAGE "$image"
env_set "$kit/.env" KADAI_HTTP_PORT "$port"
env_set "$kit/.env" KADAI_HTTP_BIND 127.0.0.1
env_set "$kit/.env" PUBLIC_BASE_URL "http://127.0.0.1:$port"
env_set "$kit/.env" KADAI_DOCKER_SUBNET "${KADAI_E2E_SUBNET:-172.31.251.0/24}"
[[ -z "${KADAI_POSTGRES_IMAGE:-}" ]] || env_set "$kit/.env" KADAI_POSTGRES_IMAGE "$KADAI_POSTGRES_IMAGE"
env_set "$kit/.env" POSTGRES_PASSWORD "$(openssl rand -hex 24)"
env_set "$kit/.env" KADAI_DB_OWNER_PASSWORD "$(openssl rand -hex 24)"
env_set "$kit/.env" KADAI_DB_APP_PASSWORD "$(openssl rand -hex 24)"
env_set "$kit/.env" JWT_SECRET "$(openssl rand -base64 48)"
env_set "$kit/.env" KADAI_ENCRYPTION_KEYS "k$(date +%Y%m):$(openssl rand -base64 32)"
chmod 600 "$kit/.env"
install -d -o 10001 -g 10001 -m 0750 "$kit/data" "$kit/data/backups"

kadai_detect_mode
[[ "$KADAI_INSTALL_MODE" == docker ]] || fail "mode detection: $KADAI_INSTALL_MODE"

dc up -d --quiet-pull
kadai_wait_ready 300 || fail "Kadai did not become ready"
ready=$(http_get "$(kadai_local_url)/health/ready")
[[ "$ready" == *'"mode":"onprem"'* && "$ready" == *'"worker":{"status":"ok"'* ]] || fail "unexpected readiness: $ready"
ok "stack up: database roles from initdb, migrations on boot, embedded worker heartbeat"

http_get "$(kadai_local_url)/" | grep -qi '<html' || fail "web app not served on /"
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$(kadai_local_url)/setup")" == 200 ]] || fail "SPA route /setup"
ok "web app and SPA fallback served"

[[ "$(docker inspect -f '{{.Config.User}}' "$(dc ps -q kadai)")" == kadai:kadai ]] || fail "container must run as kadai"
roles=$(kadai_psql postgres -At -c "SELECT string_agg(rolname || ':' || rolcreatedb, ',' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'kadai%'")
[[ "$roles" == "kadai_app:false,kadai_owner:true" ]] || fail "roles: $roles"
ok "runtime role has no CREATEDB; owner role does"

dump=$("$kit/backup.sh" --label e2e) || fail "backup.sh"
[[ -s "$dump" ]] || fail "no backup file"
[[ "$(stat -c %u "$dump")" == 10001 ]] || fail "backup in the data folder must belong to the app user"
loc=$(kadai_psql "$KADAI_DB_NAME" -At -c "SELECT location FROM backups ORDER BY started_at DESC LIMIT 1")
[[ "$loc" == "/data/backups/$(basename "$dump")" ]] || fail "backups.location is '$loc'"
dc exec -T kadai test -r "$loc" || fail "the application cannot read its backup at $loc"
ok "backup.sh: $(basename "$dump") recorded as $loc and readable by the app"

kadai_psql "$KADAI_DB_NAME" -q -c "INSERT INTO system_settings (key, value) VALUES ('e2e_marker', '\"after-backup\"')"
"$kit/restore.sh" "$dump" --yes || fail "restore.sh"
marker=$(kadai_psql "$KADAI_DB_NAME" -At -c "SELECT count(*) FROM system_settings WHERE key = 'e2e_marker'")
[[ "$marker" == 0 ]] || fail "restore did not bring back the backup state"
http_get "$(kadai_local_url)/health/ready" >/dev/null || fail "not ready after the restore"
ok "restore.sh: data rolled back to the backup, Kadai ready again"

echo "on-prem compose end-to-end passed"
