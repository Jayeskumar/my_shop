#!/usr/bin/env bash
# Unit tests for deploy/onprem/lib/kadai-common.sh (no database, no Docker needed).
#   bash deploy/tests/onprem-lib.test.sh
set -Eeuo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../onprem/lib/kadai-common.sh
source "$here/../onprem/lib/kadai-common.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
failures=0
passes=0

check() { # check <name> <expected> <actual>
  if [[ "$2" == "$3" ]]; then
    passes=$((passes + 1))
  else
    failures=$((failures + 1))
    printf 'FAIL %s\n  expected: [%s]\n  actual:   [%s]\n' "$1" "$2" "$3" >&2
  fi
}

# --- env_get --------------------------------------------------------------------------------
cat >"$tmp/a.env" <<'EOF'
# comment
PLAIN=value
SPACES=Kadai <no-reply@localhost>
QUOTED="double quoted"
SINGLE='single quoted'
EMPTY=
export EXPORTED=yes
DUP=first
DUP=second
URL=postgres://kadai_app:p%40ss@db:5432/kadai?sslmode=require
WINDOWS=crlf
EOF
printf 'CRLF=dos\r\n' >>"$tmp/a.env"
check 'env_get plain' 'value' "$(env_get "$tmp/a.env" PLAIN)"
check 'env_get keeps spaces and <>' 'Kadai <no-reply@localhost>' "$(env_get "$tmp/a.env" SPACES)"
check 'env_get strips double quotes' 'double quoted' "$(env_get "$tmp/a.env" QUOTED)"
check 'env_get strips single quotes' 'single quoted' "$(env_get "$tmp/a.env" SINGLE)"
check 'env_get empty uses default' 'fallback' "$(env_get "$tmp/a.env" EMPTY fallback)"
check 'env_get missing uses default' 'dflt' "$(env_get "$tmp/a.env" NOPE dflt)"
check 'env_get export prefix' 'yes' "$(env_get "$tmp/a.env" EXPORTED)"
check 'env_get last assignment wins' 'second' "$(env_get "$tmp/a.env" DUP)"
check 'env_get keeps = ? % in values' 'postgres://kadai_app:p%40ss@db:5432/kadai?sslmode=require' "$(env_get "$tmp/a.env" URL)"
check 'env_get strips CR' 'dos' "$(env_get "$tmp/a.env" CRLF)"
check 'env_get no prefix match' '' "$(env_get "$tmp/a.env" PLAI)"
check 'env_get missing file' 'd' "$(env_get "$tmp/missing.env" X d)"

# --- env_set --------------------------------------------------------------------------------
printf 'A=1\nB=2\n# keep me\n' >"$tmp/b.env"
chmod 600 "$tmp/b.env"
env_set "$tmp/b.env" B 'new value with $dollar & stuff'
env_set "$tmp/b.env" C 3
check 'env_set replaces' 'new value with $dollar & stuff' "$(env_get "$tmp/b.env" B)"
check 'env_set appends' '3' "$(env_get "$tmp/b.env" C)"
check 'env_set keeps others' '1' "$(env_get "$tmp/b.env" A)"
check 'env_set keeps comments' '1' "$(grep -c '^# keep me$' "$tmp/b.env")"
check 'env_set keeps mode' '600' "$(stat -c %a "$tmp/b.env")"
check 'env_set single line per key' '1' "$(grep -c '^B=' "$tmp/b.env")"
env_set "$tmp/new.env" X y
check 'env_set creates file' 'y' "$(env_get "$tmp/new.env" X)"

# --- url_with_db ----------------------------------------------------------------------------
check 'url_with_db simple' 'postgres://u:p@h:5432/postgres' "$(url_with_db 'postgres://u:p@h:5432/kadai' postgres)"
check 'url_with_db keeps query' 'postgres://u:p@h/x?sslmode=require&a=b' "$(url_with_db 'postgres://u:p@h/kadai?sslmode=require&a=b' x)"

# --- kadai_app_path (docker mode maps the data bind mount to /data) --------------------------
mkdir -p "$tmp/kit/data/backups" "$tmp/elsewhere"
printf 'KADAI_DATA_PATH=./data\n' >"$tmp/kit/.env"
KADAI_HOME="$tmp/kit" KADAI_INSTALL_MODE=docker KADAI_DOTENV="$tmp/kit/.env"
touch "$tmp/kit/data/backups/x.dump" "$tmp/elsewhere/y.dump"
check 'app path inside data' '/data/backups/x.dump' "$(kadai_app_path "$tmp/kit/data/backups/x.dump")"
check 'app path outside data' "$tmp/elsewhere/y.dump" "$(kadai_app_path "$tmp/elsewhere/y.dump")"
check 'docker backup dir default' "$tmp/kit/data/backups" "$(kadai_backup_dir)"
printf 'KADAI_BACKUP_DIR=/mnt/usb/kadai\n' >>"$tmp/kit/.env"
check 'backup dir override' '/mnt/usb/kadai' "$(kadai_backup_dir)"
KADAI_INSTALL_MODE=native KADAI_DOTENV="$tmp/native.env"
printf 'KADAI_DATA_DIR=/var/lib/kadai\n' >"$tmp/native.env"
check 'native backup dir' '/var/lib/kadai/backups' "$(kadai_backup_dir)"
check 'native app path unchanged' '/var/lib/kadai/backups/z.dump' "$(kadai_app_path /var/lib/kadai/backups/z.dump)"
check 'native local url' 'http://127.0.0.1:8080' "$(kadai_local_url)"

# --- json_field / node helpers ---------------------------------------------------------------
printf '{\n  "version": "1.4.0",\n  "commit": "abc123",\n  "node_major": 22\n}\n' >"$tmp/release.json"
check 'json_field string' '1.4.0' "$(json_field "$tmp/release.json" version)"
check 'json_field number' '22' "$(json_field "$tmp/release.json" node_major)"
check 'node_major_of current node' "$(node -p 'process.versions.node.split(".")[0]')" "$(node_major_of "$(command -v node)")"
check 'node_major_of missing binary' '0' "$(node_major_of "$tmp/no-node")"
case "$(uname -m)" in x86_64) check 'node_arch' 'x64' "$(node_arch)" ;; aarch64) check 'node_arch' 'arm64' "$(node_arch)" ;; esac

# --- initdb script rejects unsafe identifiers ------------------------------------------------
out=$(KADAI_DB_NAME='bad;name' KADAI_DB_OWNER_PASSWORD=x KADAI_DB_APP_PASSWORD=y bash "$here/../onprem/initdb/01-roles.sh" 2>&1 || true)
check 'initdb rejects bad identifiers' 'yes' "$([[ "$out" == *"invalid identifier"* ]] && echo yes || echo no)"

printf '%d passed, %d failed\n' "$passes" "$failures"
((failures == 0))
