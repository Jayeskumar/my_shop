#!/usr/bin/env bash
# Assembles the native (no Docker) Kadai Server bundle for one platform, after the server
# and web builds. Run on that platform (native modules such as @node-rs/argon2 differ):
#
#   .github/scripts/bundle.sh <version> <linux-x64|linux-arm64|win-x64> [out dir]
#
# Layout: kadai-server-<version>-<target>/{dist,migrations,web,node_modules,package.json,release.json}
# node_modules is a flat (hoisted) production install without symlinks, so the archive unpacks
# the same on Linux and Windows. Output (default dist/release, git-ignored):
# <out>/kadai-server-<version>-<target>.tar.gz | .zip
set -Eeuo pipefail

version=${1:?version}
target=${2:?target}
out=${3:-dist/release}
name="kadai-server-${version}-${target}"
stage="dist/.stage/${name}"

[[ -f apps/server/dist/server.js && -f apps/web/dist/index.html ]] || {
  echo "build the server and the web app first" >&2
  exit 1
}
rm -rf "dist/.stage" && mkdir -p "dist/.stage" "$out"
out=$(cd "$out" && pwd)

pnpm --filter @kadai/server deploy --prod --legacy --config.node-linker=hoisted "$stage"
# pnpm deploy copies the whole package folder (sources, scripts, dev keys): keep only the
# manifest and the production dependencies, then add the build output.
find "$stage" -mindepth 1 -maxdepth 1 ! -name node_modules ! -name package.json -exec rm -rf {} +
rm -rf "$stage/node_modules/.bin" "$stage/node_modules/.cache" "$stage/node_modules/.pnpm"
find "$stage/node_modules" -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete

cp -R apps/server/dist "$stage/dist"
cp -R apps/server/migrations "$stage/migrations"
cp -R apps/web/dist "$stage/web"
cat >"$stage/release.json" <<EOF
{
  "version": "${version}",
  "commit": "${GITHUB_SHA:-$(git rev-parse HEAD)}",
  "target": "${target}",
  "node_major": 22,
  "pg_major": 16,
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

if find "$stage" -not -path '*/node_modules/*' \( -name '*.pem' -o -name '*.ts' \) | grep -q .; then
  echo "bundle contains sources or keys" >&2
  exit 1
fi

# Smoke test on this platform: the bundle resolves its modules and the native addon loads.
node "$stage/dist/cli.js" help >/dev/null
(cd "$stage" && node -e "import('@node-rs/argon2').then((m) => m.hash('kadai')).then(() => console.log('argon2 ok'))")

case "$target" in
  win-*) (cd dist/.stage && 7z a -tzip -mx=7 "$out/${name}.zip" "$name" >/dev/null) ;;
  *) tar -C dist/.stage -czf "$out/${name}.tar.gz" "$name" ;;
esac
rm -rf dist/.stage
ls -l "$out"
