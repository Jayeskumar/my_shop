#!/usr/bin/env bash
# Builds the on-prem kit (kadai-onprem-<version>.zip): Docker Compose files, Linux installer,
# backup/restore/upgrade scripts, systemd units, Windows installer and the operator docs,
# stamped with the release image and download URL.
#
#   .github/scripts/onprem-kit.sh <version> <image repository> <release download URL> [out dir]
set -Eeuo pipefail

version=${1:?version}
image_repo=${2:?image repository, e.g. ghcr.io/owner/repo}
release_url=${3:?release download URL}
out=${4:-dist/release}
name="kadai-onprem-${version}"
stage="dist/.kit/${name}"

rm -rf dist/.kit && mkdir -p "$stage/docs" "$out"
out=$(cd "$out" && pwd)
cp -R deploy/onprem/. "$stage/"
cp docs/DEPLOYMENT.md docs/RUNBOOK.md "$stage/docs/"

cat >"$stage/release.env" <<EOF
KADAI_VERSION=${version}
KADAI_IMAGE=${image_repo}:${version}
KADAI_RELEASE_URL=${release_url}
KADAI_NODE_MAJOR=22
EOF
# Pin the image in the example configuration as well (manual setups copy it to .env).
sed -i "s#^KADAI_IMAGE=.*#KADAI_IMAGE=${image_repo}:${version}#" "$stage/.env.example"

cat >"$stage/README.txt" <<EOF
Kadai Server ${version} - on-premise kit
=======================================

Linux (Docker, recommended):   sudo ./install-linux.sh
Linux (native, no Docker):     sudo ./install-linux.sh --mode native
Windows 10/11 (native):        windows\\README.md  (PowerShell as administrator: .\\windows\\install.ps1)

Then open http://<this-pc>:8080 and complete the setup wizard.
Backups: ./backup.sh  |  Restore: ./restore.sh <file>  |  Upgrade: ./upgrade.sh --version <x.y.z>
Full guide: docs/DEPLOYMENT.md, incident playbooks: docs/RUNBOOK.md
EOF

chmod 0755 "$stage"/*.sh "$stage"/initdb/*.sh
(cd dist/.kit && zip -qr -X "$out/${name}.zip" "$name")
rm -rf dist/.kit
unzip -l "$out/${name}.zip" | tail -n 1
