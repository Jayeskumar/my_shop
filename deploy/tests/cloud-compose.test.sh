#!/usr/bin/env bash
# Smoke test of the cloud compose deployment (deploy/cloud) with a locally built image:
#
#   bash deploy/tests/cloud-compose.test.sh <image>
#
# migrate (one-shot) must succeed before 2 api replicas and the worker start; both api
# replicas must report ready, and the worker must write its heartbeat. Caddy is started only
# with KADAI_E2E_CADDY=1 (it binds ports 80/443). Everything is removed afterwards.
set -Eeuo pipefail

image=${1:?usage: cloud-compose.test.sh <image>}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
work=$(mktemp -d)
project="kadai-cloud-e2e-$$"
cp -R "$here/../cloud" "$work/cloud"
mkdir -p "$work/onprem" && cp -R "$here/../onprem/initdb" "$work/onprem/initdb"
# shellcheck source=../onprem/lib/kadai-common.sh
source "$here/../onprem/lib/kadai-common.sh"
dcc() { docker compose --project-directory "$work/cloud" -f "$work/cloud/docker-compose.yml" "$@"; }

teardown() {
  local rc=$?
  if ((rc != 0)); then
    dcc ps -a >&2 || true
    dcc logs --no-color --tail 60 >&2 || true
  fi
  dcc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$rc"
}
trap teardown EXIT
fail() {
  echo "FAIL: $*" >&2
  exit 1
}
ok() { echo "ok - $*"; }

envf="$work/cloud/.env"
cp "$work/cloud/.env.example" "$envf"
env_set "$envf" COMPOSE_PROJECT_NAME "$project"
env_set "$envf" KADAI_IMAGE "$image"
env_set "$envf" KADAI_DOMAIN localhost
[[ -z "${KADAI_POSTGRES_IMAGE:-}" ]] || env_set "$envf" KADAI_POSTGRES_IMAGE "$KADAI_POSTGRES_IMAGE"
[[ -z "${KADAI_REDIS_IMAGE:-}" ]] || env_set "$envf" KADAI_REDIS_IMAGE "$KADAI_REDIS_IMAGE"
[[ -z "${KADAI_CADDY_IMAGE:-}" ]] || env_set "$envf" KADAI_CADDY_IMAGE "$KADAI_CADDY_IMAGE"
for k in POSTGRES_PASSWORD KADAI_DB_OWNER_PASSWORD KADAI_DB_APP_PASSWORD METRICS_TOKEN; do
  env_set "$envf" "$k" "$(openssl rand -hex 24)"
done
env_set "$envf" JWT_SECRET "$(openssl rand -base64 48)"
env_set "$envf" KADAI_ENCRYPTION_KEYS "k$(date +%Y%m):$(openssl rand -base64 32)"

# db, redis and the one-shot migrate service start as dependencies of api/worker.
services=(api worker)
if [[ "${KADAI_E2E_CADDY:-0}" == 1 ]]; then services+=(caddy); fi
dcc up -d --quiet-pull --wait --wait-timeout 300 "${services[@]}" || fail "stack did not become healthy"

[[ "$(docker inspect -f '{{.State.ExitCode}}' "$(dcc ps -a -q migrate)")" == 0 ]] || fail "migrate job failed"
ok "migrate job completed before api/worker started"

mapfile -t apis < <(dcc ps -q api)
[[ ${#apis[@]} == 2 ]] || fail "expected 2 api replicas, got ${#apis[@]}"
probe='fetch("http://127.0.0.1:8080/health/ready").then(async (r) => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1) }, () => process.exit(1))'
for c in "${apis[@]}"; do
  out=$(docker exec "$c" node -e "$probe") || fail "api replica $c not ready: $out"
  [[ "$out" == *'"mode":"cloud"'* ]] || fail "api replica not in cloud mode: $out"
done
ok "2 api replicas ready (cloud mode, read-only root filesystem)"

metrics=$(docker exec "${apis[0]}" node -e 'fetch("http://127.0.0.1:8080/metrics").then((r) => { console.log(r.status); process.exit(0) })')
[[ "$metrics" == 401 ]] || fail "/metrics must require METRICS_TOKEN (got $metrics)"
ok "/metrics requires the bearer token"

for _ in $(seq 1 30); do
  beat=$(dcc exec -T db psql -U kadai_owner -d kadai -At -c "SELECT count(*) FROM system_settings WHERE key = 'worker_heartbeat' AND updated_at > now() - interval '90 seconds'")
  [[ "$beat" == 1 ]] && break
  sleep 2
done
[[ "$beat" == 1 ]] || fail "no worker heartbeat"
ok "worker heartbeat written"

if [[ "${KADAI_E2E_CADDY:-0}" == 1 ]]; then
  code=$(curl -sk -o /dev/null -w '%{http_code}' https://localhost/health/live)
  [[ "$code" == 200 ]] || fail "Caddy → api: HTTP $code"
  code=$(curl -sk -o /dev/null -w '%{http_code}' https://localhost/metrics)
  [[ "$code" == 404 ]] || fail "Caddy must hide /metrics (HTTP $code)"
  ok "Caddy terminates TLS, balances to the api and hides /metrics"
fi

echo "cloud compose smoke test passed"
