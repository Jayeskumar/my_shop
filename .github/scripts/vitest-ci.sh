#!/usr/bin/env bash
# CI wrapper around a workspace package's Vitest suite.
#
#   .github/scripts/vitest-ci.sh <package filter> <report name> [extra vitest args]
#
# Always writes a JUnit report to reports/<name>-junit.xml. Adds V8 coverage
# (reports/coverage/<name>/: lcov, json-summary, text summary) when @vitest/coverage-v8 is
# installed in the workspace; until it is added as a devDependency the suite runs without
# coverage and a notice says so.
set -Eeuo pipefail

pkg=${1:?package filter, e.g. @kadai/shared}
name=${2:?report name}
shift 2

root=$(git rev-parse --show-toplevel)
reports="$root/reports"
mkdir -p "$reports"
dir=$(pnpm --filter "$pkg" exec pwd)

args=(run --reporter=default --reporter=junit "--outputFile.junit=$reports/$name-junit.xml")
if [[ -d "$dir/node_modules/@vitest/coverage-v8" || -d "$root/node_modules/@vitest/coverage-v8" ]]; then
  args+=(
    --coverage.enabled=true --coverage.provider=v8
    --coverage.reporter=text-summary --coverage.reporter=lcov --coverage.reporter=json-summary
    "--coverage.reportsDirectory=$reports/coverage/$name"
  )
else
  echo "::notice title=Coverage disabled::@vitest/coverage-v8 is not installed; $name runs without coverage"
fi

cd "$dir"
exec pnpm exec vitest "${args[@]}" "$@"
