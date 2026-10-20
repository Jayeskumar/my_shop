# Kadai operator shortcuts (deployment, packaging, kit tests). Development uses pnpm directly
# (see docs/ARCHITECTURE.md §20). Everything here wraps scripts in deploy/ and .github/scripts/.
.DEFAULT_GOAL := help
SHELL := /usr/bin/env bash

IMAGE ?= kadai:dev
VERSION ?= 0.0.0-dev
DOCKER_BUILD_ARGS ?=

.PHONY: help image image-run deploy-check deploy-test onprem-e2e cloud-e2e bundle onprem-kit \
        k8s-render-staging k8s-render-production

help: ## list targets
	@grep -hE '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-24s %s\n", $$1, $$2}'

image: ## build the container image (IMAGE=kadai:dev)
	docker build -f deploy/docker/Dockerfile -t $(IMAGE) \
	  --build-arg KADAI_VERSION=$(VERSION) --build-arg GIT_COMMIT=$$(git rev-parse --short HEAD) \
	  --build-arg BUILD_DATE=$$(date -u +%Y-%m-%dT%H:%M:%SZ) $(DOCKER_BUILD_ARGS) .

image-run: ## print the image's commands (help)
	docker run --rm $(IMAGE) help

deploy-check: ## static checks: shellcheck, hadolint, actionlint, compose, Caddy, kustomize/kubeconform
	bash deploy/tests/validate.sh

deploy-test: ## shell library tests + backup/restore integration (needs local PostgreSQL roles)
	bash deploy/tests/onprem-lib.test.sh
	bash deploy/tests/backup-restore.test.sh

onprem-e2e: ## on-prem Docker kit end-to-end with IMAGE (root: data folder owned by uid 10001)
	sudo -E bash deploy/tests/onprem-compose.test.sh $(IMAGE)

cloud-e2e: ## cloud compose smoke test with IMAGE
	bash deploy/tests/cloud-compose.test.sh $(IMAGE)

bundle: ## native server bundle for this machine (after pnpm build), into dist/release
	.github/scripts/bundle.sh $(VERSION) $$(case "$$(uname -m)" in aarch64|arm64) echo linux-arm64;; *) echo linux-x64;; esac)

onprem-kit: ## on-prem kit zip into dist/release
	.github/scripts/onprem-kit.sh $(VERSION) ghcr.io/jayeskumar/my_shop https://github.com/Jayeskumar/my_shop/releases/download/v$(VERSION)

k8s-render-staging: ## render the staging overlay
	kubectl kustomize deploy/k8s/overlays/staging

k8s-render-production: ## render the production overlay
	kubectl kustomize deploy/k8s/overlays/production
