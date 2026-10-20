# shellcheck shell=bash
# =============================================================================
# Shared helpers for the Kadai on-prem host scripts (backup.sh, restore.sh, upgrade.sh,
# install-linux.sh). Sourced, never executed. Works for both installation modes:
#
#   docker  KADAI_HOME holds docker-compose.yml + .env (default: the folder of the script)
#   native  systemd service "kadai", config in /etc/kadai/kadai.env, app in /opt/kadai/app
#
# Database access always uses the owner role (kadai_owner): it owns every object, may create
# databases (restore into a scratch database, then rename) and needs no superuser rights.
# =============================================================================

KADAI_DB_NAME=${KADAI_DB_NAME:-kadai}
KADAI_DB_OWNER=${KADAI_DB_OWNER:-kadai_owner}
KADAI_DB_APP_USER=${KADAI_DB_APP_USER:-kadai_app}
KADAI_PREFIX=${KADAI_PREFIX:-/opt/kadai}
KADAI_ENV_FILE=${KADAI_ENV_FILE:-/etc/kadai/kadai.env}
KADAI_SERVICE=${KADAI_SERVICE:-kadai}

if [[ -t 2 ]]; then
  _c_red=$'\033[31m' _c_yellow=$'\033[33m' _c_green=$'\033[32m' _c_reset=$'\033[0m'
else
  _c_red='' _c_yellow='' _c_green='' _c_reset=''
fi

log() { printf '%s[kadai]%s %s\n' "$_c_green" "$_c_reset" "$*" >&2; }
warn() { printf '%s[kadai] WARNING:%s %s\n' "$_c_yellow" "$_c_reset" "$*" >&2; }
die() {
  printf '%s[kadai] ERROR:%s %s\n' "$_c_red" "$_c_reset" "$*" >&2
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# Reads KEY from a dotenv file without executing it (values may contain spaces, <, >, $ ...).
# Last assignment wins; surrounding single or double quotes are removed.
env_get() {
  local file=$1 key=$2 default=${3:-} line value
  [[ -r "$file" ]] || {
    printf '%s' "$default"
    return 0
  }
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" | tail -n 1 || true)
  if [[ -z "$line" ]]; then
    printf '%s' "$default"
    return 0
  fi
  value=${line#*=}
  value=${value%$'\r'}
  if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value=${BASH_REMATCH[1]}; fi
  if [[ -z "$value" ]]; then value=$default; fi
  printf '%s' "$value"
}

# Replaces (or appends) KEY=value in a dotenv file, keeping its permissions.
env_set() {
  local file=$1 key=$2 value=$3 tmp
  tmp=$(mktemp "${file}.XXXXXX")
  if [[ -f "$file" ]]; then
    chmod --reference="$file" "$tmp" 2>/dev/null || true
    awk -v k="$key" -v v="$value" '
      BEGIN { done = 0 }
      $0 ~ "^[[:space:]]*" k "=" { if (!done) { print k "=" v; done = 1 }; next }
      { print }
      END { if (!done) print k "=" v }' "$file" >"$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >"$tmp"
  fi
  mv -f "$tmp" "$file"
}

# Detects the installation mode once and sets KADAI_INSTALL_MODE (docker | native).
kadai_detect_mode() {
  if [[ -n "${KADAI_INSTALL_MODE:-}" ]]; then
    [[ "$KADAI_INSTALL_MODE" == docker || "$KADAI_INSTALL_MODE" == native ]] ||
      die "KADAI_INSTALL_MODE must be docker or native"
  elif [[ -f "${KADAI_HOME:-}/docker-compose.yml" && -f "${KADAI_HOME:-}/.env" ]]; then
    KADAI_INSTALL_MODE=docker
  elif [[ -f "$KADAI_ENV_FILE" ]]; then
    KADAI_INSTALL_MODE=native
  else
    die "no Kadai installation found (looked for ${KADAI_HOME:-?}/docker-compose.yml + .env and $KADAI_ENV_FILE)"
  fi
  if [[ "$KADAI_INSTALL_MODE" == docker ]]; then
    have docker || die "docker is not installed"
    docker compose version >/dev/null 2>&1 || die "the docker compose plugin is required"
    KADAI_DOTENV="$KADAI_HOME/.env"
  else
    [[ -r "$KADAI_ENV_FILE" ]] || die "$KADAI_ENV_FILE is not readable (run as root)"
    KADAI_DOTENV="$KADAI_ENV_FILE"
  fi
  export KADAI_INSTALL_MODE KADAI_DOTENV
}

dc() { docker compose --project-directory "$KADAI_HOME" -f "$KADAI_HOME/docker-compose.yml" "$@"; }

# Pulls the compose images; an image that cannot be pulled is fine when it is already present
# locally (offline installs: docker load -i kadai-images.tar before running the scripts).
kadai_pull_images() {
  dc pull --ignore-pull-failures || true
  local img missing=0
  for img in $(dc config --images); do
    if ! docker image inspect "$img" >/dev/null 2>&1; then
      warn "image $img is neither pullable nor present locally"
      missing=1
    fi
  done
  ((missing == 0)) || die "missing container images (internet access, registry login or docker load needed)"
}

# Host folder for backups (+ the path the application sees, recorded in the backups table).
kadai_backup_dir() {
  local configured
  configured=$(env_get "$KADAI_DOTENV" KADAI_BACKUP_DIR)
  if [[ -n "$configured" ]]; then
    printf '%s' "$configured"
  elif [[ "$KADAI_INSTALL_MODE" == docker ]]; then
    local data
    data=$(env_get "$KADAI_DOTENV" KADAI_DATA_PATH ./data)
    [[ "$data" == /* ]] || data="$KADAI_HOME/${data#./}"
    printf '%s/backups' "$data"
  else
    printf '%s/backups' "$(env_get "$KADAI_DOTENV" KADAI_DATA_DIR /var/lib/kadai)"
  fi
}

# Path of a host backup file as seen by the application (inside the container in docker mode).
kadai_app_path() {
  local file=$1 data
  if [[ "$KADAI_INSTALL_MODE" == docker ]]; then
    data=$(env_get "$KADAI_DOTENV" KADAI_DATA_PATH ./data)
    [[ "$data" == /* ]] || data="$KADAI_HOME/${data#./}"
    data=$(cd "$data" 2>/dev/null && pwd -P || printf '%s' "$data")
    local real
    real=$(cd "$(dirname "$file")" && pwd -P)/$(basename "$file")
    if [[ "$real" == "$data"/* ]]; then
      printf '/data/%s' "${real#"$data"/}"
      return 0
    fi
  fi
  printf '%s' "$file"
}

# postgres://user:pw@host:port/db?opts with the database replaced.
url_with_db() {
  local url=$1 db=$2 base query=''
  if [[ "$url" == *\?* ]]; then
    query="?${url#*\?}"
    url=${url%%\?*}
  fi
  base=${url%/*}
  printf '%s/%s%s' "$base" "$db" "$query"
}

# psql as the owner role. Usage: kadai_psql <database> [psql args...]  (SQL on stdin or -c)
kadai_psql() {
  local db=$1
  shift
  if [[ "$KADAI_INSTALL_MODE" == docker ]]; then
    dc exec -T db psql -X -v ON_ERROR_STOP=1 -U "$KADAI_DB_OWNER" -d "$db" "$@"
  else
    local url
    url=$(env_get "$KADAI_DOTENV" DATABASE_SYSTEM_URL)
    [[ -n "$url" ]] || die "DATABASE_SYSTEM_URL is missing in $KADAI_DOTENV"
    psql -X -v ON_ERROR_STOP=1 "$(url_with_db "$url" "$db")" "$@"
  fi
}

# pg_dump -Fc of the live database to stdout.
kadai_pg_dump() {
  if [[ "$KADAI_INSTALL_MODE" == docker ]]; then
    dc exec -T db pg_dump -U "$KADAI_DB_OWNER" -d "$KADAI_DB_NAME" -Fc -Z 6
  else
    pg_dump -Fc -Z 6 "$(env_get "$KADAI_DOTENV" DATABASE_SYSTEM_URL)"
  fi
}

# pg_restore helper. Usage: kadai_pg_restore <archive on host> <target db> [extra args]
kadai_pg_restore() {
  local file=$1 db=$2
  shift 2
  if [[ "$KADAI_INSTALL_MODE" == docker ]]; then
    local remote="/tmp/kadai-restore-$$.dump"
    dc cp "$file" "db:$remote"
    local rc=0
    dc exec -T db pg_restore -U "$KADAI_DB_OWNER" -d "$db" "$@" "$remote" || rc=$?
    dc exec -T db rm -f "$remote" || true
    return "$rc"
  else
    local url
    url=$(env_get "$KADAI_DOTENV" DATABASE_SYSTEM_URL)
    pg_restore -d "$(url_with_db "$url" "$db")" "$@" "$file"
  fi
}

# Lists the table of contents of an archive (validates it is a readable pg_dump -Fc file).
kadai_pg_list() {
  local file=$1
  if [[ "$KADAI_INSTALL_MODE" == docker ]]; then
    dc exec -T db pg_restore --list <"$file"
  else
    pg_restore --list "$file"
  fi
}

kadai_stop_app() {
  if [[ "$KADAI_INSTALL_MODE" == docker ]]; then
    dc stop kadai
  else
    systemctl stop "$KADAI_SERVICE"
  fi
}

kadai_start_app() {
  if [[ "$KADAI_INSTALL_MODE" == docker ]]; then
    dc up -d kadai
  else
    systemctl start "$KADAI_SERVICE"
  fi
}

# Local URL of the HTTP port (host side).
kadai_local_url() {
  local port
  if [[ "$KADAI_INSTALL_MODE" == docker ]]; then
    port=$(env_get "$KADAI_DOTENV" KADAI_HTTP_PORT 8080)
  else
    port=$(env_get "$KADAI_DOTENV" PORT 8080)
  fi
  printf 'http://127.0.0.1:%s' "$port"
}

http_get() {
  if have curl; then
    curl -fsS -m 10 "$1"
  elif have wget; then
    wget -q -T 10 -O - "$1"
  else
    die "curl or wget is required"
  fi
}

# Waits until /health/ready answers 200 (migrations applied, database reachable, worker alive).
kadai_wait_ready() {
  local timeout=${1:-300} url waited=0
  url="$(kadai_local_url)/health/ready"
  log "waiting for $url (up to ${timeout}s)"
  until http_get "$url" >/dev/null 2>&1; do
    if ((waited >= timeout)); then
      warn "Kadai did not become ready in ${timeout}s; last response:"
      http_get "$url" >&2 || true
      return 1
    fi
    sleep 5
    waited=$((waited + 5))
  done
  log "Kadai is ready"
}

# Inserts a row into the application's backups registry (shown in Settings → System).
# Best effort: older databases without the table, or a stopped database, only log a warning.
kadai_record_backup() {
  local kind=$1 location=$2 size=$3 sha=$4 started=$5
  kadai_psql "$KADAI_DB_NAME" -q \
    -v kind="$kind" -v location="$location" -v size="$size" -v sha="$sha" -v started="$started" \
    >/dev/null 2>&1 <<'SQL' || warn "could not record the backup in the backups table"
SELECT format(
  'INSERT INTO backups (kind, status, location, size_bytes, checksum_sha256, started_at, finished_at)
   VALUES (%L, %L, %L, %s, %L, %L::timestamptz, now())',
  :'kind', 'completed', :'location', :'size', :'sha', :'started')
WHERE to_regclass('public.backups') IS NOT NULL \gexec
SQL
}

sha256_of() { sha256sum "$1" | awk '{print $1}'; }

# Machine architecture in Node.js release naming (x64 | arm64).
node_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) printf 'x64' ;;
    aarch64 | arm64) printf 'arm64' ;;
    *) die "unsupported CPU architecture $(uname -m) (x86_64 or arm64 required)" ;;
  esac
}

download() {
  local url=$1 out=$2
  if have curl; then
    curl -fsSL --retry 3 --retry-delay 2 -o "$out" "$url"
  elif have wget; then
    wget -q --tries=3 -O "$out" "$url"
  else
    die "curl or wget is required to download $url"
  fi
}

# Installs the latest Node.js <major> release into <dest> (private runtime used only by Kadai),
# verifying the archive against the official SHASUMS256.txt. KADAI_NODE_DIST_URL overrides
# the download site (mirror / offline repository).
kadai_install_node() {
  local major=$1 dest=$2 arch base tmp sums file sum
  arch=$(node_arch)
  base="${KADAI_NODE_DIST_URL:-https://nodejs.org/dist}/latest-v${major}.x"
  tmp=$(mktemp -d)
  download "$base/SHASUMS256.txt" "$tmp/SHASUMS256.txt"
  sums=$(<"$tmp/SHASUMS256.txt")
  file=$(grep -oE "node-v${major}\.[0-9]+\.[0-9]+-linux-${arch}\.tar\.xz" <<<"$sums" | head -n 1)
  [[ -n "$file" ]] || die "no Node.js ${major} build for linux-${arch} at $base"
  sum=$(grep -E "  ${file}\$" <<<"$sums" | awk '{print $1}')
  log "downloading $file"
  download "$base/$file" "$tmp/$file"
  (cd "$tmp" && printf '%s  %s\n' "$sum" "$file" | sha256sum -c --quiet) || die "checksum mismatch for $file"
  rm -rf "$dest.new"
  mkdir -p "$dest.new"
  tar -xJf "$tmp/$file" -C "$dest.new" --strip-components=1
  rm -rf "$dest.old"
  [[ -d "$dest" ]] && mv "$dest" "$dest.old"
  mv "$dest.new" "$dest"
  rm -rf "$dest.old" "$tmp"
  log "Node.js $("$dest/bin/node" --version) installed in $dest"
}

# Major version of a node binary (0 when missing).
node_major_of() {
  local v
  v=$("$1" --version 2>/dev/null || true)
  v=${v#v}
  printf '%s' "${v%%.*}" | grep -E '^[0-9]+$' || printf '0'
}

# Reads a top-level string/number field from a small JSON file (release.json) without jq.
json_field() {
  sed -nE "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"?([^\",}]*)\"?.*/\1/p" "$1" | head -n 1
}
