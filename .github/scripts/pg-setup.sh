#!/usr/bin/env bash
# Prepares the CI PostgreSQL service the way production is set up (deploy/onprem/initdb):
# owner role kadai_owner (CREATEDB, owns everything) and runtime role kadai_app (RLS applies).
# Each database given as an argument is created (owned by kadai_owner) with pg_trgm + citext.
#   .github/scripts/pg-setup.sh [database ...]
# Connection: libpq environment (PGHOST, PGUSER=postgres, PGPASSWORD).
set -Eeuo pipefail

psql -X -q -v ON_ERROR_STOP=1 -d postgres <<'SQL'
SELECT 'CREATE ROLE kadai_owner LOGIN CREATEDB PASSWORD ''kadai_owner'''
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kadai_owner') \gexec
SELECT 'CREATE ROLE kadai_app LOGIN PASSWORD ''kadai_app'''
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kadai_app') \gexec
SQL

for db in "$@"; do
  psql -X -q -v ON_ERROR_STOP=1 -d postgres -v db="$db" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER kadai_owner', :'db')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SQL
  psql -X -q -v ON_ERROR_STOP=1 -d "$db" -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm' -c 'CREATE EXTENSION IF NOT EXISTS citext'
  echo "database $db ready"
done
echo "roles kadai_owner / kadai_app ready"
