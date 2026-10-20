#!/usr/bin/env bash
# Static validation of the deployment kit. Each check runs when its tool is installed and is
# skipped (with a message) otherwise; KADAI_VALIDATE_STRICT=1 (CI) turns a skip into a failure.
#
#   bash deploy/tests/validate.sh
#
#   ShellCheck   every *.sh in deploy/ and .github/scripts/
#   hadolint     deploy/docker/Dockerfile
#   actionlint   .github/workflows/*.yml
#   docker       docker compose config (on-prem incl. profile tls, cloud with bundled/external DB),
#                Caddyfiles via the caddy image (needs a running Docker daemon) or a local caddy
#   kustomize    build staging/production + kubeconform -strict (with Prometheus Operator CRDs)
#   python3      every YAML document parses; Windows service XML is well-formed
set -Eeuo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo"
strict=${KADAI_VALIDATE_STRICT:-0}
failures=0
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

pass() { printf '  ok    %s\n' "$*"; }
fail() {
  printf '  FAIL  %s\n' "$*" >&2
  failures=$((failures + 1))
}
skip() {
  if ((strict)); then fail "$* (tool missing, KADAI_VALIDATE_STRICT=1)"; else printf '  skip  %s\n' "$*"; fi
}
have() { command -v "$1" >/dev/null 2>&1; }

echo "shell scripts"
mapfile -t scripts < <(find deploy .github/scripts -type f -name '*.sh' | sort)
for f in "${scripts[@]}"; do bash -n "$f" || fail "bash -n $f"; done
sh -n deploy/docker/docker-entrypoint.sh || fail "sh -n docker-entrypoint.sh"
if have shellcheck; then
  if shellcheck -x -P deploy/onprem "${scripts[@]}"; then pass "shellcheck (${#scripts[@]} scripts)"; else fail shellcheck; fi
else skip shellcheck; fi

echo "Dockerfile"
if have hadolint; then
  # DL3008: apt packages are not version-pinned (security fixes arrive with each rebuild).
  if hadolint --failure-threshold warning --ignore DL3008 deploy/docker/Dockerfile; then pass hadolint; else fail hadolint; fi
else skip hadolint; fi

echo "GitHub workflows"
if have actionlint; then
  if actionlint; then pass actionlint; else fail actionlint; fi
else skip actionlint; fi

echo "YAML / XML syntax"
if have python3 && python3 -c 'import yaml' 2>/dev/null; then
  if python3 - <<'PY'; then pass "YAML parses"; else fail "YAML syntax"; fi
import glob, sys, yaml
bad = 0
files = sorted(set(glob.glob('deploy/**/*.y*ml', recursive=True) + glob.glob('.github/**/*.y*ml', recursive=True)))
for f in files:
    try:
        list(yaml.safe_load_all(open(f, encoding='utf-8')))
    except Exception as e:  # noqa: BLE001
        print(f'{f}: {e}', file=sys.stderr); bad += 1
sys.exit(1 if bad else 0)
PY
  if python3 -c 'import sys, xml.dom.minidom as m; m.parse(sys.argv[1])' deploy/onprem/windows/kadai-service.xml; then
    pass "kadai-service.xml well-formed"
  else fail "kadai-service.xml"; fi
else skip "python3 + PyYAML"; fi

echo "Docker Compose"
if have docker && docker compose version >/dev/null 2>&1; then
  sed 's/=CHANGE_ME$/=validate-only/' deploy/onprem/.env.example >"$tmp/onprem.env"
  sed 's/=CHANGE_ME$/=validate-only/' deploy/cloud/.env.example >"$tmp/cloud.env"
  dc_check() { # dc_check <label> <compose args...>
    local label=$1
    shift
    if docker compose "$@" config -q; then pass "compose: $label"; else fail "compose: $label"; fi
  }
  dc_check "on-prem" --env-file "$tmp/onprem.env" -f deploy/onprem/docker-compose.yml
  dc_check "on-prem + tls" --env-file "$tmp/onprem.env" -f deploy/onprem/docker-compose.yml --profile tls
  dc_check "cloud (bundled db)" --env-file "$tmp/cloud.env" -f deploy/cloud/docker-compose.yml
  sed -e 's#^COMPOSE_PROFILES=db$#COMPOSE_PROFILES=#' -e 's#^DATABASE_URL=$#DATABASE_URL=postgres://a:b@db.example:5432/kadai#' \
    -e 's#^DATABASE_SYSTEM_URL=$#DATABASE_SYSTEM_URL=postgres://c:d@db.example:5432/kadai#' "$tmp/cloud.env" >"$tmp/cloud-ext.env"
  dc_check "cloud (external db)" --env-file "$tmp/cloud-ext.env" -f deploy/cloud/docker-compose.yml
  if docker compose --env-file /dev/null -f deploy/onprem/docker-compose.yml config -q >/dev/null 2>&1; then
    fail "on-prem compose must refuse to start without secrets"
  else
    pass "on-prem compose refuses missing secrets"
  fi
else skip "docker compose"; fi

echo "Caddyfiles"
caddy_validate() { # caddy_validate <file> <env...>
  local file=$1
  shift
  if have caddy; then
    env "$@" caddy validate --adapter caddyfile --config "$file" >/dev/null 2>&1
  elif have docker && docker info >/dev/null 2>&1; then
    local args=()
    for e in "$@"; do args+=(-e "$e"); done
    docker run --rm "${args[@]}" -v "$repo/$file:/etc/caddy/Caddyfile:ro" "${CADDY_IMAGE:-caddy:2}" \
      caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile >/dev/null 2>&1
  else
    return 2
  fi
}
for spec in "deploy/cloud/Caddyfile KADAI_DOMAIN=app.example.in ACME_EMAIL=ops@example.in" \
  "deploy/onprem/Caddyfile KADAI_TLS_SITES=kadai.local"; do
  read -r -a parts <<<"$spec"
  rc=0
  caddy_validate "${parts[@]}" || rc=$?
  case $rc in
    0) pass "caddy validate ${parts[0]}" ;;
    2) skip "caddy validate ${parts[0]} (no caddy binary or Docker daemon)" ;;
    *) fail "caddy validate ${parts[0]}" ;;
  esac
done

echo "Kubernetes"
if have kustomize; then
  for overlay in staging production; do
    if kustomize build "deploy/k8s/overlays/$overlay" >"$tmp/$overlay.yaml"; then
      pass "kustomize build $overlay"
      if have kubeconform; then
        mkdir -p "$tmp/kubeconform-cache"
        if kubeconform -strict -summary -kubernetes-version "${KUBERNETES_VERSION:-1.30.0}" -cache "$tmp/kubeconform-cache" \
          -schema-location default \
          -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
          "$tmp/$overlay.yaml"; then
          pass "kubeconform $overlay"
        else fail "kubeconform $overlay"; fi
      else skip "kubeconform $overlay"; fi
      grep -q 'image: kadai$' "$tmp/$overlay.yaml" && fail "$overlay: an image was not mapped (image: kadai)"
      grep -q 'kadai-secrets' "$tmp/$overlay.yaml" || fail "$overlay: pods must read the kadai-secrets Secret"
      if grep -q '^kind: Secret$' "$tmp/$overlay.yaml"; then fail "$overlay: the build must not contain a Secret"; fi
    else fail "kustomize build $overlay"; fi
  done
else skip "kustomize"; fi

echo
if ((failures)); then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "deployment kit validation passed"
