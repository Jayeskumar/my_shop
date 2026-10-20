#!/usr/bin/env bash
# =============================================================================
# Kadai Kubernetes deployment: migrations first, then the rollout.
#
#   deploy/k8s/deploy.sh <staging|production> <image tag> [--dry-run]
#
#   1. renders the overlay with the image tag (temporary kustomization, nothing is edited)
#   2. applies the objects labelled kadai.io/deploy-phase=pre-migrate (namespace, config,
#      service account, network policies) and deletes the previous kadai-migrate Job
#   3. runs the kadai-migrate Job with the NEW image and waits for it (fails → stop here,
#      the running version keeps serving)
#   4. applies everything else and waits for the api and worker rollouts
# Requires kubectl (with kustomize) and the Secret kadai-secrets in the target namespace.
# KADAI_IMAGE_REPO overrides the image repository (default ghcr.io/jayeskumar/my_shop).
# =============================================================================
set -Eeuo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
env=${1:-}
tag=${2:-}
dry_run=0
[[ "${3:-}" == --dry-run ]] && dry_run=1

die() {
  echo "deploy.sh: $*" >&2
  exit 1
}
[[ "$env" == staging || "$env" == production ]] || die "usage: deploy.sh <staging|production> <image tag> [--dry-run]"
[[ "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "invalid image tag '$tag'"
command -v kubectl >/dev/null || die "kubectl is required"

repo=${KADAI_IMAGE_REPO:-ghcr.io/jayeskumar/my_shop}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Wrapper kustomization: the overlay plus the requested image tag. Kustomize only accepts
# relative paths to other kustomizations.
overlay_rel=$(realpath --relative-to="$work" "$here/overlays/$env" 2>/dev/null ||
  python3 -c 'import os, sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' "$here/overlays/$env" "$work")
cat >"$work/kustomization.yaml" <<EOF
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - $overlay_rel
images:
  - name: ghcr.io/jayeskumar/my_shop
    newName: $repo
    newTag: $tag
EOF
kubectl kustomize "$work" >"$work/all.yaml"
ns=$(awk '/^kind: Namespace$/ {f = 1} f && /^  name:/ {print $2; exit}' "$work/all.yaml")
[[ -n "$ns" ]] || die "could not find the Namespace in the rendered overlay"
echo "deploying $repo:$tag to namespace $ns ($env)"

if ((dry_run)); then
  kubectl apply --dry-run=server -f "$work/all.yaml"
  exit 0
fi

# Namespace, ConfigMap, ServiceAccount and NetworkPolicies must exist before the Job runs.
kubectl apply -f "$work/all.yaml" --selector kadai.io/deploy-phase=pre-migrate
kubectl -n "$ns" get secret kadai-secrets >/dev/null ||
  die "secret kadai-secrets is missing in namespace $ns (see deploy/k8s/base/secret.example.yaml)"

echo "running database migrations"
kubectl -n "$ns" delete job kadai-migrate --ignore-not-found --wait=true
kubectl apply -f "$work/all.yaml" --selector app.kubernetes.io/component=migrate
if ! kubectl -n "$ns" wait --for=condition=complete job/kadai-migrate --timeout=30m; then
  kubectl -n "$ns" logs job/kadai-migrate --tail=200 || true
  die "migrations failed: the running version is untouched (see docs/RUNBOOK.md#migrations-failed)"
fi
kubectl -n "$ns" logs job/kadai-migrate --tail=50 || true

echo "rolling out api and worker"
kubectl apply -f "$work/all.yaml"
kubectl -n "$ns" rollout status deployment/kadai-api --timeout=15m
kubectl -n "$ns" rollout status deployment/kadai-worker --timeout=15m
echo "done: $repo:$tag is live in $ns"
