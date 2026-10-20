#!/usr/bin/env bash
# =============================================================================
# Kadai on-prem upgrade (Docker or native Linux installation).
#
# Docker:  sudo ./upgrade.sh --version 1.4.0          (or --image <ref>; default: re-pull)
# Native:  sudo /opt/kadai/bin/upgrade.sh --bundle kadai-server-1.4.0-linux-x64.tar.gz
# Undo:    sudo ./upgrade.sh --rollback               (previous version + pre-upgrade backup)
#
# Order: fetch the new version first (no downtime) → pre_upgrade backup → switch → Kadai
# applies the new migrations on boot → wait for /health/ready. Migrations are forward-only, so
# a rollback restores the pre-upgrade backup together with the previous version.
# =============================================================================
set -Eeuo pipefail

KADAI_HOME=${KADAI_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}
# shellcheck source=lib/kadai-common.sh
source "$KADAI_HOME/lib/kadai-common.sh"

usage() {
  cat <<'EOF'
Usage: upgrade.sh [options]
  Docker installation:
    --version X.Y.Z      switch the image tag to X.Y.Z (same repository)
    --image REF          switch to an explicit image reference
  Native installation:
    --bundle FILE        kadai-server-<version>-linux-<arch>.tar.gz (SHA256SUMS next to it is checked)
  Both:
    --rollback           go back to the version and data from before the last upgrade
    --no-backup          skip the pre-upgrade backup (not recommended)
    --yes                do not ask for confirmation
    -h, --help
EOF
}

version='' image='' bundle='' rollback=0 backup=1 assume_yes=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) version=${2:?}; shift 2 ;;
    --image) image=${2:?}; shift 2 ;;
    --bundle) bundle=${2:?}; shift 2 ;;
    --rollback) rollback=1; shift ;;
    --no-backup) backup=0; shift ;;
    --yes | -y) assume_yes=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

kadai_detect_mode
if [[ "$KADAI_INSTALL_MODE" == docker ]]; then
  state_file="$KADAI_HOME/.upgrade-state"
else
  state_file="$KADAI_PREFIX/.upgrade-state"
fi

confirm() {
  ((assume_yes)) && return 0
  [[ -t 0 ]] || die "not a terminal: pass --yes to confirm"
  printf '%s [y/N] ' "$1" >&2
  local a
  read -r a
  [[ "$a" == y || "$a" == Y || "$a" == yes ]] || die "aborted"
}

pre_upgrade_backup() {
  if ((backup)); then
    log "pre-upgrade backup"
    "$KADAI_HOME/backup.sh" --kind pre_upgrade --no-prune
  else
    warn "skipping the pre-upgrade backup (--no-backup)"
    printf ''
  fi
}

# --- rollback -----------------------------------------------------------------------------
if ((rollback)); then
  [[ -f "$state_file" ]] || die "no previous upgrade recorded ($state_file missing)"
  prev=$(env_get "$state_file" PREVIOUS)
  dump=$(env_get "$state_file" BACKUP)
  [[ -n "$prev" ]] || die "$state_file does not name the previous version"
  confirm "Roll back to '$prev'${dump:+ and restore $dump}? Data entered since the upgrade is lost."
  if [[ "$KADAI_INSTALL_MODE" == docker ]]; then
    env_set "$KADAI_DOTENV" KADAI_IMAGE "$prev"
  else
    [[ -d "$KADAI_PREFIX/app.prev" ]] || die "$KADAI_PREFIX/app.prev is missing"
    systemctl stop "$KADAI_SERVICE"
    rm -rf "$KADAI_PREFIX/app.failed"
    mv "$KADAI_PREFIX/app" "$KADAI_PREFIX/app.failed"
    mv "$KADAI_PREFIX/app.prev" "$KADAI_PREFIX/app"
  fi
  if [[ -n "$dump" ]]; then
    "$KADAI_HOME/restore.sh" "$dump" --yes --no-safety-backup
  else
    warn "no pre-upgrade backup recorded: starting the previous version on the current data"
    kadai_start_app
    kadai_wait_ready 300
  fi
  rm -f "$state_file"
  log "rolled back to $prev"
  exit 0
fi

# --- docker -------------------------------------------------------------------------------
if [[ "$KADAI_INSTALL_MODE" == docker ]]; then
  [[ -z "$bundle" ]] || die "--bundle is for native installations; use --version or --image"
  current=$(env_get "$KADAI_DOTENV" KADAI_IMAGE)
  [[ -n "$current" ]] || die "KADAI_IMAGE is not set in $KADAI_DOTENV"
  if [[ -n "$image" ]]; then
    target=$image
  elif [[ -n "$version" ]]; then
    [[ "$version" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || die "invalid --version $version"
    repo=${current%@*}
    # Strip a tag only when the last path segment carries one (registry ports have ':' too).
    [[ "${repo##*/}" == *:* ]] && repo=${repo%:*}
    target="$repo:${version#v}"
  else
    target=$current
  fi
  log "current image: $current"
  log "target image:  $target"
  confirm "Upgrade Kadai to $target?"

  log "pulling $target (Kadai keeps running meanwhile)"
  docker pull "$target"
  dump=$(pre_upgrade_backup)
  printf 'PREVIOUS=%s\nBACKUP=%s\nAT=%s\n' "$current" "$dump" "$(date -Iseconds)" >"$state_file"

  env_set "$KADAI_DOTENV" KADAI_IMAGE "$target"
  log "recreating the kadai container (migrations run on boot)"
  dc up -d --no-deps kadai
  if kadai_wait_ready 900; then
    log "upgrade complete: $(dc exec -T kadai kadai-entrypoint version 2>/dev/null || echo "$target")"
    docker image prune -f >/dev/null 2>&1 || true
    exit 0
  fi
  die "the new version is not healthy: inspect 'docker compose logs kadai', or run ./upgrade.sh --rollback"
fi

# --- native -------------------------------------------------------------------------------
[[ -n "$bundle" ]] || die "native installation: pass --bundle kadai-server-<version>-linux-$(node_arch).tar.gz"
[[ -r "$bundle" ]] || die "cannot read $bundle"
sums="$(dirname "$bundle")/SHA256SUMS"
if [[ -f "$sums" ]]; then
  (cd "$(dirname "$bundle")" && grep -E "  $(basename "$bundle")\$" SHA256SUMS | sha256sum -c --quiet) ||
    die "checksum mismatch for $bundle"
  log "bundle checksum OK"
else
  warn "no SHA256SUMS next to the bundle: integrity not verified"
fi

new="$KADAI_PREFIX/app.new"
rm -rf "$new"
mkdir -p "$new"
tar -xzf "$bundle" -C "$new" --strip-components=1
[[ -f "$new/dist/server.js" && -d "$new/migrations" && -f "$new/web/index.html" ]] ||
  die "$bundle does not look like a Kadai server bundle"
new_version=$(json_field "$new/release.json" version)
need_node=$(json_field "$new/release.json" node_major)
need_node=${need_node:-22}
log "installed: $(json_field "$KADAI_PREFIX/app/release.json" version 2>/dev/null || echo unknown) → bundle: ${new_version:-unknown}"
confirm "Upgrade Kadai to ${new_version:-this bundle}?"

if [[ "$(node_major_of "$KADAI_PREFIX/node/bin/node")" != "$need_node" ]]; then
  log "the new version needs Node.js $need_node"
  kadai_install_node "$need_node" "$KADAI_PREFIX/node"
fi

dump=$(pre_upgrade_backup)
printf 'PREVIOUS=%s\nBACKUP=%s\nAT=%s\n' "$(json_field "$KADAI_PREFIX/app/release.json" version 2>/dev/null || echo previous)" \
  "$dump" "$(date -Iseconds)" >"$state_file"

log "switching application files"
systemctl stop "$KADAI_SERVICE"
rm -rf "$KADAI_PREFIX/app.prev"
mv "$KADAI_PREFIX/app" "$KADAI_PREFIX/app.prev"
mv "$new" "$KADAI_PREFIX/app"
chown -R root:root "$KADAI_PREFIX/app"
systemctl start "$KADAI_SERVICE"
if kadai_wait_ready 900; then
  log "upgrade complete: ${new_version:-new version}"
  exit 0
fi
die "the new version is not healthy: inspect 'journalctl -u $KADAI_SERVICE', or run upgrade.sh --rollback"
