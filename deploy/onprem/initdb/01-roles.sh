#!/usr/bin/env bash
# =============================================================================
# PostgreSQL first-start initialisation for Kadai (official postgres image runs every
# /docker-entrypoint-initdb.d/*.sh once, when the data volume is empty).
#
# Creates (idempotently):
#   * KADAI_DB_OWNER      LOGIN CREATEDB  — owns the database and every table (migrations,
#                                           system pool, backups/restore)
#   * KADAI_DB_APP_USER   LOGIN           — runtime role; Row-Level Security applies to it
#   * KADAI_DB_NAME       owned by KADAI_DB_OWNER, only these two roles may connect
#   * extensions pg_trgm and citext
# The migrator grants the runtime role its table privileges (kadai_apply_grants).
# Also used by deploy/cloud/docker-compose.yml.
# =============================================================================

# The image entrypoint *sources* scripts that lost their executable bit (e.g. after copying
# from a Windows PC); run in a child shell then, so our shell options do not leak into it.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  bash "${BASH_SOURCE[0]}"
  return $?
fi

set -Eeuo pipefail

db="${KADAI_DB_NAME:-kadai}"
owner="${KADAI_DB_OWNER:-kadai_owner}"
app="${KADAI_DB_APP_USER:-kadai_app}"
: "${KADAI_DB_OWNER_PASSWORD:?KADAI_DB_OWNER_PASSWORD is required}"
: "${KADAI_DB_APP_PASSWORD:?KADAI_DB_APP_PASSWORD is required}"

for name in "$db" "$owner" "$app"; do
  if [[ ! "$name" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; then
    echo "01-roles.sh: invalid identifier '$name' (lower-case letters, digits, _)" >&2
    exit 1
  fi
done

psql_admin=(psql -v ON_ERROR_STOP=1 --no-psqlrc --username "${POSTGRES_USER:-postgres}")

# psql variables (:'x' literal, :"x" identifier) do the quoting; format() + \gexec makes every
# statement conditional so the script can be re-run safely.
"${psql_admin[@]}" --dbname postgres \
  -v db="$db" -v owner="$owner" -v app="$app" \
  -v owner_pw="$KADAI_DB_OWNER_PASSWORD" -v app_pw="$KADAI_DB_APP_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN CREATEDB PASSWORD %L', :'owner', :'owner_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'owner') \gexec
SELECT format('ALTER ROLE %I LOGIN CREATEDB PASSWORD %L', :'owner', :'owner_pw') \gexec
SELECT format('CREATE ROLE %I LOGIN NOCREATEDB NOCREATEROLE PASSWORD %L', :'app', :'app_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app') \gexec
SELECT format('ALTER ROLE %I LOGIN NOCREATEDB NOCREATEROLE PASSWORD %L', :'app', :'app_pw') \gexec
SELECT format('CREATE DATABASE %I OWNER %I ENCODING %L TEMPLATE template0', :'db', :'owner', 'UTF8')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', :'db', :'app') \gexec
SELECT format('GRANT ALL ON DATABASE %I TO %I', :'db', :'owner') \gexec
SQL

"${psql_admin[@]}" --dbname "$db" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
SQL

echo "01-roles.sh: database '$db' ready (owner '$owner', runtime role '$app')"
