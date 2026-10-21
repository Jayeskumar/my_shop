#!/usr/bin/env bash
# Provision one git worktree + dev/test databases per business module.
set -euo pipefail
MAIN=/home/user/my_shop
BRANCH=claude/laughing-hamilton-cleqkb
MODULES=(${MODULES:-catalog parties identity inventory sales payments purchases accounting reports notifications platform licensing onprem})
export PGPASSWORD=kadai_owner
mkdir -p /home/user/wt

for key in "${MODULES[@]}"; do
  wt="/home/user/wt/$key"
  echo "=== $key"
  if [ ! -d "$wt" ]; then
    git -C "$MAIN" worktree add "$wt" -b "mod/$key" "$BRANCH"
  fi
  for db in "kadai_dev_$key" "kadai_test_$key"; do
    if ! psql -h localhost -U kadai_owner -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1; then
      createdb -h localhost -U kadai_owner -O kadai_owner "$db"
    fi
    psql -h localhost -U kadai_owner -d "$db" -qc "CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS citext;" >/dev/null
  done
  # .env: point every database URL at the module's own databases (test URLs first: they contain /kadai_test)
  sed -e "s#/kadai_test\([^_a-z0-9]\|\$\)#/kadai_test_${key}\1#g" \
      -e "s#/kadai\([^_a-z0-9]\|\$\)#/kadai_dev_${key}\1#g" \
      "$MAIN/.env" > "$wt/.env"
  (cd "$wt" && flock /tmp/kadai-pnpm.lock pnpm install --frozen-lockfile --prefer-offline >/dev/null)
  (cd "$wt" && pnpm db:migrate >/dev/null)
  echo "    ok: $(grep -E '^(DATABASE_URL|TEST_DATABASE_URL)=' "$wt/.env" | tr '\n' ' ')"
done
git -C "$MAIN" worktree list
