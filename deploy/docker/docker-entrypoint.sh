#!/bin/sh
# =============================================================================
# Kadai container entrypoint (runs under tini as PID 1).
#
#   kadai-entrypoint server            HTTP API + web app (+ embedded worker when
#                                      KADAI_EMBEDDED_WORKER=true, the on-prem default)
#   kadai-entrypoint worker            background jobs only (cloud: M worker replicas)
#   kadai-entrypoint migrate [--status|--dry-run]
#   kadai-entrypoint cli <command> ... server CLI (migrate, create-platform-admin, cleanup, ...)
#   kadai-entrypoint version | help
#   kadai-entrypoint <program> ...     anything else is executed as is (sh, pg_dump, psql, ...)
#
# Secrets may be supplied as files (Docker/Kubernetes secrets, systemd credentials):
# for VAR in the list below, VAR_FILE=/path reads the value from that file.
# =============================================================================
set -eu

SECRET_VARS="DATABASE_URL DATABASE_SYSTEM_URL JWT_SECRET KADAI_ENCRYPTION_KEYS METRICS_TOKEN \
REDIS_URL S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY MSG91_AUTH_KEY WHATSAPP_ACCESS_TOKEN \
WHATSAPP_APP_SECRET WHATSAPP_WEBHOOK_VERIFY_TOKEN SMTP_URL MSG91_WEBHOOK_TOKEN \
EMAIL_WEBHOOK_URL EMAIL_WEBHOOK_SECRET RAZORPAY_PLATFORM_KEY_ID \
RAZORPAY_PLATFORM_KEY_SECRET RAZORPAY_PLATFORM_WEBHOOK_SECRET KADAI_LICENSE_PUBLIC_KEY \
KADAI_ADMIN_PASSWORD"

die() {
  echo "kadai-entrypoint: $*" >&2
  exit 1
}

# VAR_FILE → VAR (the names come from the fixed list above, so eval is safe).
load_secret_files() {
  for var in $SECRET_VARS; do
    eval "file=\${${var}_FILE:-}"
    [ -n "$file" ] || continue
    eval "current=\${${var}:-}"
    [ -z "$current" ] || die "both $var and ${var}_FILE are set; use one"
    [ -r "$file" ] || die "${var}_FILE=$file is not readable"
    value=$(cat "$file")
    export "$var=$value"
    unset "${var}_FILE"
  done
}

check_data_dir() {
  dir=${KADAI_DATA_DIR:-/data}
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir" 2>/dev/null || die "KADAI_DATA_DIR $dir does not exist and cannot be created"
  fi
  if [ ! -w "$dir" ]; then
    die "KADAI_DATA_DIR $dir is not writable by uid $(id -u). For a bind mount run: chown -R $(id -u):$(id -g) <host dir>"
  fi
}

usage() {
  cat <<'EOF'
Kadai container commands:
  server                     HTTP API + web app (default)
  worker                     background job worker
  migrate [--status|--dry-run]
  cli <command> [args]       server CLI; "cli help" lists commands
  version                    print the application version
  <program> [args]           run any other program (sh, psql, pg_dump, ...)
EOF
}

cmd=${1:-server}
[ "$#" -gt 0 ] && shift

case "$cmd" in
  server)
    load_secret_files
    check_data_dir
    exec node --enable-source-maps /app/dist/server.js "$@"
    ;;
  worker)
    load_secret_files
    check_data_dir
    exec node --enable-source-maps /app/dist/worker.js "$@"
    ;;
  migrate)
    load_secret_files
    exec node --enable-source-maps /app/dist/migrate.js "$@"
    ;;
  cli)
    load_secret_files
    exec node --enable-source-maps /app/dist/cli.js "$@"
    ;;
  version | --version)
    echo "${KADAI_VERSION:-unknown} (${KADAI_GIT_COMMIT:-unknown})"
    ;;
  help | --help | -h)
    usage
    ;;
  *)
    load_secret_files
    exec "$cmd" "$@"
    ;;
esac
