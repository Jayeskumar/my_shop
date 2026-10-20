#!/usr/bin/env bash
# Installs the pinned, checksum-verified validators used by deploy/tests/validate.sh
# (linux-amd64 GitHub runners): kustomize, kubeconform, actionlint, hadolint.
#   .github/scripts/install-deploy-tools.sh <bin dir>
set -Eeuo pipefail

bin=${1:?bin dir}
mkdir -p "$bin"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fetch() { # fetch <url> <sha256> <file>
  curl -fsSL --retry 3 -o "$tmp/$3" "$1"
  echo "$2  $tmp/$3" | sha256sum -c --quiet
}

fetch https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv5.4.3/kustomize_v5.4.3_linux_amd64.tar.gz \
  3669470b454d865c8184d6bce78df05e977c9aea31c30df3c669317d43bcc7a7 kustomize.tgz
tar -xzf "$tmp/kustomize.tgz" -C "$bin" kustomize

fetch https://github.com/yannh/kubeconform/releases/download/v0.6.7/kubeconform-linux-amd64.tar.gz \
  95f14e87aa28c09d5941f11bd024c1d02fdc0303ccaa23f61cef67bc92619d73 kubeconform.tgz
tar -xzf "$tmp/kubeconform.tgz" -C "$bin" kubeconform

fetch https://github.com/rhysd/actionlint/releases/download/v1.7.7/actionlint_1.7.7_linux_amd64.tar.gz \
  023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757 actionlint.tgz
tar -xzf "$tmp/actionlint.tgz" -C "$bin" actionlint

fetch https://github.com/hadolint/hadolint/releases/download/v2.12.0/hadolint-Linux-x86_64 \
  56de6d5e5ec427e17b74fa48d51271c7fc0d61244bf5c90e828aab8362d55010 hadolint
install -m 0755 "$tmp/hadolint" "$bin/hadolint"

chmod 0755 "$bin"/*
"$bin/kustomize" version
"$bin/kubeconform" -v
"$bin/actionlint" -version | head -n 1
"$bin/hadolint" --version
