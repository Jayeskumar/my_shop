#!/usr/bin/env bash
# =============================================================================
# Kadai on-prem database backup (Docker or native Linux installation).
#
#   sudo ./backup.sh                       manual backup into the default folder
#   sudo ./backup.sh --kind scheduled      what the optional systemd timer runs
#   sudo ./backup.sh --dest /media/usb/kadai --label before-gst-change
#
# Writes kadai-<db>-<YYYYmmdd-HHMMSS>-<kind>[-label].dump (pg_dump custom format, compressed)
# plus a .sha256 file, verifies the archive with pg_restore --list, optionally copies it to
# KADAI_BACKUP_COPY_TO (USB disk / NAS), records it in the application's backup list and
# prunes old backups (older than --retention-days, always keeping the newest --keep-min).
# Prints the backup file path on stdout.
# =============================================================================
set -Eeuo pipefail

KADAI_HOME=${KADAI_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}
# shellcheck source=lib/kadai-common.sh
source "$KADAI_HOME/lib/kadai-common.sh"

usage() {
  cat <<'EOF'
Usage: backup.sh [options]
  --kind KIND            scheduled | manual | pre_upgrade   (default: manual)
  --dest DIR             backup folder (default: KADAI_BACKUP_DIR or <data dir>/backups)
  --label TEXT           short label added to the file name (letters, digits, - _)
  --retention-days N     delete backups older than N days (default 30; 0 = never)
  --keep-min N           always keep the newest N backups (default 7)
  --no-prune             do not delete old backups
  -h, --help             show this help
EOF
}

kind=manual dest='' label='' prune=1 retention='' keep_min=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --kind) kind=${2:?--kind needs a value}; shift 2 ;;
    --dest) dest=${2:?--dest needs a value}; shift 2 ;;
    --label) label=${2:?--label needs a value}; shift 2 ;;
    --retention-days) retention=${2:?}; shift 2 ;;
    --keep-min) keep_min=${2:?}; shift 2 ;;
    --no-prune) prune=0; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

case "$kind" in scheduled | manual | pre_upgrade) ;; *) die "--kind must be scheduled, manual or pre_upgrade" ;; esac
[[ -z "$label" || "$label" =~ ^[A-Za-z0-9_-]{1,40}$ ]] || die "--label may only contain letters, digits, - and _"

kadai_detect_mode
retention=${retention:-$(env_get "$KADAI_DOTENV" KADAI_BACKUP_RETENTION_DAYS 30)}
keep_min=${keep_min:-$(env_get "$KADAI_DOTENV" KADAI_BACKUP_KEEP_MIN 7)}
[[ "$retention" =~ ^[0-9]+$ && "$keep_min" =~ ^[0-9]+$ ]] || die "retention values must be whole numbers"
dest=${dest:-$(kadai_backup_dir)}
copy_to=$(env_get "$KADAI_DOTENV" KADAI_BACKUP_COPY_TO)

umask 077
mkdir -p "$dest"

# One backup at a time (the scheduled timer and a manual run must not overlap).
exec 9>"$dest/.backup.lock"
flock -n 9 || die "another backup is already running (lock: $dest/.backup.lock)"

stamp=$(date +%Y%m%d-%H%M%S)
started=$(date -Iseconds)
name="kadai-${KADAI_DB_NAME}-${stamp}-${kind}${label:+-$label}.dump"
final="$dest/$name"
partial="$dest/.${name}.partial"
trap 'rm -f "$partial"' EXIT

log "backing up database '$KADAI_DB_NAME' ($KADAI_INSTALL_MODE) → $final"
kadai_pg_dump >"$partial" || die "pg_dump failed (is the database running?)"
[[ -s "$partial" ]] || die "pg_dump produced an empty file"
kadai_pg_list "$partial" >/dev/null || die "the new archive is not readable by pg_restore"

sha=$(sha256_of "$partial")
size=$(stat -c %s "$partial")
mv -f "$partial" "$final"
printf '%s  %s\n' "$sha" "$name" >"$final.sha256"

# Let the application read backups that live in its own data folder (download from Settings).
if [[ "$KADAI_INSTALL_MODE" == docker ]]; then
  if [[ "$(kadai_app_path "$final")" == /data/* ]]; then
    chown 10001:10001 "$final" "$final.sha256" 2>/dev/null || true
  fi
elif [[ "$final" == "$(env_get "$KADAI_DOTENV" KADAI_DATA_DIR /var/lib/kadai)"/* ]]; then
  chown kadai:kadai "$final" "$final.sha256" 2>/dev/null || true
fi
log "backup written: $(numfmt --to=iec "$size" 2>/dev/null || echo "$size bytes"), sha256 $sha"

if [[ -n "$copy_to" ]]; then
  if mkdir -p "$copy_to" 2>/dev/null && cp -f "$final" "$final.sha256" "$copy_to/"; then
    if (cd "$copy_to" && sha256sum -c --quiet "$name.sha256"); then
      log "copied to $copy_to"
    else
      warn "copy in $copy_to does not match its checksum"
    fi
  else
    warn "could not copy the backup to $copy_to (is the disk mounted?)"
  fi
fi

kadai_record_backup "$kind" "$(kadai_app_path "$final")" "$size" "$sha" "$started"

if ((prune)) && ((retention > 0)); then
  # Newest first; skip the newest keep_min, delete the rest when older than the retention.
  mapfile -t backups < <(find "$dest" -maxdepth 1 -type f -name 'kadai-*.dump' -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
  cutoff=$(($(date +%s) - retention * 86400))
  for ((i = keep_min; i < ${#backups[@]}; i++)); do
    f=${backups[$i]}
    if (($(stat -c %Y "$f") < cutoff)); then
      rm -f -- "$f" "$f.sha256"
      log "pruned $(basename "$f")"
    fi
  done
fi

printf '%s\n' "$final"
