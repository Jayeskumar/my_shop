#!/usr/bin/env bash
# =============================================================================
# Kadai Server installer for Linux (one shop, on-premise).
#
#   sudo ./install-linux.sh                    Docker mode (installs Docker when missing)
#   sudo ./install-linux.sh --mode native      systemd service + Node.js 22 + PostgreSQL 16
#
# Run it from the unpacked on-prem bundle (kadai-onprem-<version>.zip). Re-running on an
# installed machine is refused: use upgrade.sh. Supported: Debian 12/13, Ubuntu 22.04/24.04
# (and newer), RHEL/Rocky/AlmaLinux 8/9 (native mode: x86_64 / arm64).
# =============================================================================
set -Eeuo pipefail

SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
KADAI_HOME=$SRC_DIR
# shellcheck source=lib/kadai-common.sh
source "$SRC_DIR/lib/kadai-common.sh"

usage() {
  cat <<'EOF'
Usage: install-linux.sh [options]
  --mode docker|native   installation mode (default: docker; asks when Docker is missing)
  --dir DIR              Docker mode: install folder (default /opt/kadai)
  --port PORT            HTTP port on the LAN (default 8080)
  --public-url URL       address counter PCs use (default http://<LAN IP>:<port>)
  --image REF            Docker mode: container image (default from release.env)
  --bundle FILE          native mode: kadai-server-<version>-linux-<arch>.tar.gz
                         (default: next to this script, else downloaded from the release)
  --backup-timer         also install a daily host-level backup (systemd timer, 22:45)
  --no-firewall          do not open the HTTP port in ufw / firewalld
  --yes                  accept defaults, no questions
  -h, --help
EOF
}

mode='' dir=/opt/kadai port=8080 public_url='' image='' bundle='' backup_timer=0 firewall=1 assume_yes=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) mode=${2:?}; shift 2 ;;
    --dir) dir=${2:?}; shift 2 ;;
    --port) port=${2:?}; shift 2 ;;
    --public-url) public_url=${2:?}; shift 2 ;;
    --image) image=${2:?}; shift 2 ;;
    --bundle) bundle=${2:?}; shift 2 ;;
    --backup-timer) backup_timer=1; shift ;;
    --no-firewall) firewall=0; shift ;;
    --yes | -y) assume_yes=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[[ "$(uname -s)" == Linux ]] || die "this installer is for Linux (Windows: windows/install.ps1)"
((EUID == 0)) || die "run as root: sudo $0 $*"
have systemctl || die "systemd is required"
if [[ ! "$port" =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)); then die "invalid --port $port"; fi

# Release metadata written by the release workflow (version, image, download URL).
RELEASE_VERSION=$(env_get "$SRC_DIR/release.env" KADAI_VERSION)
RELEASE_IMAGE=$(env_get "$SRC_DIR/release.env" KADAI_IMAGE)
RELEASE_URL=$(env_get "$SRC_DIR/release.env" KADAI_RELEASE_URL)

ask() { # ask "question" default → answer
  local q=$1 def=$2 a
  if ((assume_yes)) || [[ ! -t 0 ]]; then
    printf '%s' "$def"
    return 0
  fi
  printf '%s [%s]: ' "$q" "$def" >&2
  read -r a
  printf '%s' "${a:-$def}"
}

rand_hex() { openssl rand -hex "$1" 2>/dev/null || od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
rand_b64() { openssl rand -base64 "$1" 2>/dev/null | tr -d '\n' || head -c "$1" /dev/urandom | base64 -w0; }

lan_ip() {
  local ip=''
  if have ip; then ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}' | head -n 1); fi
  [[ -n "$ip" ]] || ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  printf '%s' "${ip:-$(hostname)}"
}

os_family() ( # subshell: /etc/os-release must not overwrite our variables
  # shellcheck disable=SC1091
  . /etc/os-release
  case " ${ID:-} ${ID_LIKE:-} " in
    *" debian "* | *" ubuntu "*) printf 'debian' ;;
    *" rhel "* | *" fedora "* | *" centos "*) printf 'rhel' ;;
    *) printf 'unknown' ;;
  esac
)

open_firewall() {
  ((firewall)) || return 0
  local nets=(10.0.0.0/8 172.16.0.0/12 192.168.0.0/16)
  if have ufw && ufw status 2>/dev/null | grep -q '^Status: active'; then
    for n in "${nets[@]}"; do ufw allow from "$n" to any port "$port" proto tcp comment 'Kadai (LAN)' >/dev/null; done
    log "ufw: port $port opened for private (LAN) addresses"
  elif have firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
    for n in "${nets[@]}"; do
      firewall-cmd --permanent \
        --add-rich-rule="rule family=\"ipv4\" source address=\"$n\" port port=\"$port\" protocol=\"tcp\" accept" >/dev/null
    done
    firewall-cmd --reload >/dev/null
    log "firewalld: port $port opened for private (LAN) addresses"
  fi
}

install_backup_timer() { # install_backup_timer <scripts dir> <postgres unit>
  ((backup_timer)) || return 0
  local scripts=$1 pg_unit=$2
  sed -e "s#@SCRIPTS_DIR@#$scripts#g" -e "s#@PG_UNIT@#$pg_unit#g" \
    "$SRC_DIR/systemd/kadai-backup.service" >/etc/systemd/system/kadai-backup.service
  cp "$SRC_DIR/systemd/kadai-backup.timer" /etc/systemd/system/kadai-backup.timer
  systemctl daemon-reload
  systemctl enable --now kadai-backup.timer >/dev/null
  log "daily backup timer enabled (systemctl list-timers kadai-backup.timer)"
}

finish() { # finish <url>
  cat >&2 <<EOF

${_c_green}Kadai is running.${_c_reset}
  Open on this PC:        http://localhost:$port
  Open on counter PCs:    $1
  First visit shows the setup wizard: create the shop and the owner login.
  Then upload the license in Settings → System (Free plan limits apply until then).

  Backups:   $2/backup.sh      (also scheduled inside Kadai)
  Upgrade:   $2/upgrade.sh
  Docs:      docs/DEPLOYMENT.md, docs/RUNBOOK.md
EOF
}

# --- choose the mode ----------------------------------------------------------------------
if [[ -z "$mode" ]]; then
  if have docker; then
    mode=docker
  else
    log "Docker is not installed."
    printf '  1) install Docker and run Kadai in containers (recommended)\n  2) native install: Node.js + PostgreSQL + systemd service\n' >&2
    case "$(ask 'Choose 1 or 2' 1)" in
      2 | native) mode=native ;;
      *) mode=docker ;;
    esac
  fi
fi
[[ "$mode" == docker || "$mode" == native ]] || die "--mode must be docker or native"
public_url=${public_url:-http://$(lan_ip):$port}

# =============================================================================
# Docker mode
# =============================================================================
install_docker_mode() {
  if ! have docker; then
    log "installing Docker Engine (get.docker.com)"
    local tmp
    tmp=$(mktemp)
    download https://get.docker.com "$tmp"
    sh "$tmp"
    rm -f "$tmp"
  fi
  systemctl enable --now docker >/dev/null
  docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing (package docker-compose-plugin)"

  [[ ! -f "$dir/.env" ]] || die "Kadai is already installed in $dir: use $dir/upgrade.sh"
  image=${image:-$RELEASE_IMAGE}
  [[ -n "$image" ]] || image=$(env_get "$SRC_DIR/.env.example" KADAI_IMAGE)
  log "installing into $dir (image $image)"

  mkdir -p "$dir"
  if [[ "$(cd "$dir" && pwd -P)" != "$(cd "$SRC_DIR" && pwd -P)" ]]; then
    cp -R "$SRC_DIR/docker-compose.yml" "$SRC_DIR/Caddyfile" "$SRC_DIR/.env.example" "$SRC_DIR/initdb" \
      "$SRC_DIR/lib" "$SRC_DIR/backup.sh" "$SRC_DIR/restore.sh" "$SRC_DIR/upgrade.sh" \
      "$SRC_DIR/systemd" "$dir/"
    [[ -f "$SRC_DIR/release.env" ]] && cp "$SRC_DIR/release.env" "$dir/"
  fi
  chmod 0755 "$dir"/*.sh "$dir"/initdb/*.sh

  local envf="$dir/.env"
  (umask 077 && cp "$dir/.env.example" "$envf")
  env_set "$envf" KADAI_IMAGE "$image"
  env_set "$envf" PUBLIC_BASE_URL "$public_url"
  env_set "$envf" KADAI_HTTP_PORT "$port"
  env_set "$envf" POSTGRES_PASSWORD "$(rand_hex 24)"
  env_set "$envf" KADAI_DB_OWNER_PASSWORD "$(rand_hex 24)"
  env_set "$envf" KADAI_DB_APP_PASSWORD "$(rand_hex 24)"
  env_set "$envf" JWT_SECRET "$(rand_b64 48)"
  env_set "$envf" KADAI_ENCRYPTION_KEYS "k$(date +%Y%m):$(rand_b64 32)"
  env_set "$envf" METRICS_TOKEN "$(rand_hex 24)"
  chmod 600 "$envf"

  install -d -o 10001 -g 10001 -m 0750 "$dir/data" "$dir/data/backups"

  KADAI_HOME=$dir
  KADAI_INSTALL_MODE=docker
  KADAI_DOTENV=$envf
  log "pulling images"
  dc pull
  log "starting PostgreSQL and Kadai (the first start applies all migrations)"
  dc up -d
  open_firewall
  install_backup_timer "$dir" ""
  kadai_wait_ready 600 || die "Kadai did not become ready: docker compose -f $dir/docker-compose.yml logs kadai"
  log "secrets are in $envf — keep a copy of that file somewhere safe (needed for disaster recovery)"
  finish "$public_url" "$dir"
}

# =============================================================================
# Native mode
# =============================================================================
PG_MAJOR=${KADAI_PG_MAJOR:-16}

install_packages() {
  case "$(os_family)" in
    debian)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -q
      apt-get install -y -q --no-install-recommends ca-certificates curl xz-utils tar openssl
      if ! dpkg -s "postgresql-$PG_MAJOR" >/dev/null 2>&1; then
        log "installing PostgreSQL $PG_MAJOR (apt.postgresql.org)"
        install -d /usr/share/postgresql-common/pgdg
        download https://www.postgresql.org/media/keys/ACCC4CF8.asc /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
        # shellcheck disable=SC1091
        . /etc/os-release
        echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
          >/etc/apt/sources.list.d/pgdg.list
        apt-get update -q
        apt-get install -y -q "postgresql-$PG_MAJOR"
      fi
      PG_UNIT="postgresql@${PG_MAJOR}-main.service"
      PG_BIN=/usr/lib/postgresql/$PG_MAJOR/bin
      systemctl enable --now "$PG_UNIT" >/dev/null
      PG_PORT=$(pg_lsclusters -h 2>/dev/null | awk -v v="$PG_MAJOR" '$1 == v && $2 == "main" {print $3}')
      ;;
    rhel)
      dnf install -y -q ca-certificates curl xz tar openssl
      if ! rpm -q "postgresql${PG_MAJOR}-server" >/dev/null 2>&1; then
        log "installing PostgreSQL $PG_MAJOR (download.postgresql.org)"
        local el
        el=$(rpm -E '%{rhel}')
        dnf install -y -q "https://download.postgresql.org/pub/repos/yum/reporpms/EL-${el}-$(uname -m)/pgdg-redhat-repo-latest.noarch.rpm"
        dnf -qy module disable postgresql 2>/dev/null || true
        dnf install -y -q "postgresql${PG_MAJOR}-server" "postgresql${PG_MAJOR}"
        "/usr/pgsql-${PG_MAJOR}/bin/postgresql-${PG_MAJOR}-setup" initdb
      fi
      PG_UNIT="postgresql-${PG_MAJOR}.service"
      PG_BIN=/usr/pgsql-$PG_MAJOR/bin
      systemctl enable --now "$PG_UNIT" >/dev/null
      PG_PORT=5432
      ;;
    *) die "unsupported distribution for native mode: use --mode docker" ;;
  esac
  PG_PORT=${PG_PORT:-5432}
}

install_native_mode() {
  [[ ! -f "$KADAI_ENV_FILE" ]] || die "Kadai is already installed ($KADAI_ENV_FILE exists): use $KADAI_PREFIX/bin/upgrade.sh"
  local arch
  arch=$(node_arch)

  # Application bundle: argument, next to this script, or the release download.
  if [[ -z "$bundle" ]]; then
    bundle=$(find "$SRC_DIR" -maxdepth 1 -name "kadai-server-*-linux-${arch}.tar.gz" | sort | tail -n 1)
  fi
  if [[ -z "$bundle" ]]; then
    [[ -n "$RELEASE_URL" && -n "$RELEASE_VERSION" ]] || die "pass --bundle kadai-server-<version>-linux-${arch}.tar.gz"
    local name="kadai-server-${RELEASE_VERSION}-linux-${arch}.tar.gz"
    log "downloading $name"
    download "$RELEASE_URL/$name" "$SRC_DIR/$name"
    download "$RELEASE_URL/SHA256SUMS" "$SRC_DIR/SHA256SUMS"
    bundle="$SRC_DIR/$name"
  fi
  if [[ -f "$(dirname "$bundle")/SHA256SUMS" ]]; then
    (cd "$(dirname "$bundle")" && grep -E "  $(basename "$bundle")\$" SHA256SUMS | sha256sum -c --quiet) ||
      die "checksum mismatch for $bundle"
  fi

  install_packages
  log "PostgreSQL $PG_MAJOR on port $PG_PORT ($PG_UNIT)"

  id kadai >/dev/null 2>&1 ||
    useradd --system --user-group --home-dir /var/lib/kadai --shell /usr/sbin/nologin kadai
  install -d -o kadai -g kadai -m 0750 /var/lib/kadai /var/lib/kadai/backups
  install -d -m 0755 "$KADAI_PREFIX" "$KADAI_PREFIX/bin"

  local node_major
  node_major=$(env_get "$SRC_DIR/release.env" KADAI_NODE_MAJOR "${KADAI_NODE_MAJOR:-22}")
  kadai_install_node "$node_major" "$KADAI_PREFIX/node"

  log "unpacking $(basename "$bundle")"
  rm -rf "$KADAI_PREFIX/app.new"
  mkdir -p "$KADAI_PREFIX/app.new"
  tar -xzf "$bundle" -C "$KADAI_PREFIX/app.new" --strip-components=1
  [[ -f "$KADAI_PREFIX/app.new/dist/server.js" ]] || die "$bundle is not a Kadai server bundle"
  rm -rf "$KADAI_PREFIX/app"
  mv "$KADAI_PREFIX/app.new" "$KADAI_PREFIX/app"
  chown -R root:root "$KADAI_PREFIX/app"
  local version
  version=$(json_field "$KADAI_PREFIX/app/release.json" version || true)

  cp -R "$SRC_DIR/lib" "$SRC_DIR/backup.sh" "$SRC_DIR/restore.sh" "$SRC_DIR/upgrade.sh" "$KADAI_PREFIX/bin/"
  chmod 0755 "$KADAI_PREFIX"/bin/*.sh

  log "creating database roles and the kadai database"
  local owner_pw app_pw
  owner_pw=$(rand_hex 24)
  app_pw=$(rand_hex 24)
  (cd / && runuser -u postgres -- env PATH="$PG_BIN:$PATH" PGPORT="$PG_PORT" POSTGRES_USER=postgres \
    KADAI_DB_NAME=kadai KADAI_DB_OWNER=kadai_owner KADAI_DB_APP_USER=kadai_app \
    KADAI_DB_OWNER_PASSWORD="$owner_pw" KADAI_DB_APP_PASSWORD="$app_pw" \
    bash "$SRC_DIR/initdb/01-roles.sh")

  install -d -m 0750 -g kadai /etc/kadai
  (
    umask 027
    cat >"$KADAI_ENV_FILE" <<EOF
# Kadai Server configuration (native). Secrets below were generated by install-linux.sh:
# keep a copy of this file in a safe place (needed for disaster recovery).
KADAI_MODE=onprem
NODE_ENV=production
KADAI_VERSION=${version:-$RELEASE_VERSION}
HOST=0.0.0.0
PORT=$port
PUBLIC_BASE_URL=$public_url
TZ=Asia/Kolkata
LOG_LEVEL=info
DATABASE_URL=postgres://kadai_app:$app_pw@127.0.0.1:$PG_PORT/kadai
DATABASE_SYSTEM_URL=postgres://kadai_owner:$owner_pw@127.0.0.1:$PG_PORT/kadai
DATABASE_APP_ROLE=kadai_app
KADAI_MIGRATE_ON_BOOT=true
KADAI_EMBEDDED_WORKER=true
KADAI_SERVE_WEB=true
KADAI_DATA_DIR=/var/lib/kadai
KADAI_WEB_DIST=$KADAI_PREFIX/app/web
KADAI_MIGRATIONS_DIR=$KADAI_PREFIX/app/migrations
JWT_SECRET=$(rand_b64 48)
KADAI_ENCRYPTION_KEYS=k$(date +%Y%m):$(rand_b64 32)
METRICS_TOKEN=$(rand_hex 24)
SMS_PROVIDER=log
WHATSAPP_PROVIDER=log
EMAIL_PROVIDER=log
KADAI_BACKUP_RETENTION_DAYS=30
KADAI_BACKUP_KEEP_MIN=7
EOF
  )
  chgrp kadai "$KADAI_ENV_FILE"
  chmod 0640 "$KADAI_ENV_FILE"

  sed -e "s#@PREFIX@#$KADAI_PREFIX#g" -e "s#@ENV_FILE@#$KADAI_ENV_FILE#g" \
    -e "s#@DATA_DIR@#/var/lib/kadai#g" -e "s#@PG_UNIT@#$PG_UNIT#g" \
    -e "s#@PATH@#$PG_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin#g" \
    "$SRC_DIR/systemd/kadai.service" >/etc/systemd/system/kadai.service
  systemctl daemon-reload
  systemctl enable --now kadai.service >/dev/null

  KADAI_INSTALL_MODE=native
  KADAI_DOTENV=$KADAI_ENV_FILE
  open_firewall
  install_backup_timer "$KADAI_PREFIX/bin" "$PG_UNIT"
  kadai_wait_ready 600 || die "Kadai did not become ready: journalctl -u kadai -n 200"
  finish "$public_url" "$KADAI_PREFIX/bin"
}

if [[ "$mode" == docker ]]; then install_docker_mode; else install_native_mode; fi
