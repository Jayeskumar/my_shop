# syntax=docker/dockerfile:1
# =============================================================================
# Kadai (கடை) — one image for cloud SaaS and on-premise (KADAI_MODE=cloud|onprem)
#
#   docker build -f deploy/docker/Dockerfile -t kadai:dev .            (context = repo root)
#   docker run --rm kadai:dev help
#
# Stages
#   toolchain  Node 22 + pnpm (corepack, version pinned by package.json "packageManager")
#   build      frozen-lockfile install, server bundle (tsup) + web app (vite)   [build platform]
#   prod-deps  production node_modules of @kadai/server only (pnpm deploy)     [target platform]
#   runtime    node:22 slim + tini + postgresql-client (pg_dump for on-prem backups), non-root
#
# The JavaScript build runs on the build platform (fast multi-arch builds); only the
# production dependency install runs on the target platform, so native optional packages
# (@node-rs/argon2 prebuilt binaries) match the image architecture.
# =============================================================================

ARG NODE_IMAGE=node:22-trixie-slim

# -----------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS toolchain
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src

# -----------------------------------------------------------------------------
FROM toolchain AS build
# Manifests first: the dependency layers are reused until the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
# `pnpm fetch` reads only the lockfile: downloads every package into the store.
RUN --mount=type=cache,id=kadai-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm fetch
COPY . .
RUN --mount=type=cache,id=kadai-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --offline
RUN pnpm --filter @kadai/server build \
 && pnpm --filter @kadai/web build \
 && test -f apps/server/dist/server.js \
 && test -f apps/web/dist/index.html

# -----------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS prod-deps
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
# Only the server's production dependencies. The server bundle already inlines @kadai/shared;
# --legacy: workspace packages are not injected (pnpm 10 default deploy requires that).
RUN --mount=type=cache,id=kadai-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm --filter @kadai/server deploy --prod --legacy /out \
 && rm -rf /out/node_modules/.cache

# -----------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# Major version of the PostgreSQL client tools (pg_dump/pg_restore must be >= the server).
ARG PG_MAJOR=16
ARG KADAI_VERSION=0.0.0-dev
ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown
ARG SOURCE_URL=https://github.com/Jayeskumar/my_shop

LABEL org.opencontainers.image.title="Kadai" \
      org.opencontainers.image.description="Kadai (கடை) — retail ERP, POS, GST and UPI for Indian shops (cloud SaaS and on-premise)" \
      org.opencontainers.image.version="${KADAI_VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.url="${SOURCE_URL}" \
      org.opencontainers.image.documentation="${SOURCE_URL}/blob/main/docs/DEPLOYMENT.md" \
      org.opencontainers.image.vendor="Kadai" \
      org.opencontainers.image.licenses="LicenseRef-Proprietary"

# tini (PID 1, signal forwarding) and the PostgreSQL client from the PGDG repository
# (Debian's own client may be older than the server major version).
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl tini; \
    install -d /usr/share/postgresql-common/pgdg; \
    curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
      https://www.postgresql.org/media/keys/ACCC4CF8.asc; \
    . /etc/os-release; \
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends "postgresql-client-${PG_MAJOR}"; \
    apt-get purge -y --auto-remove curl; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    pg_dump --version; \
    groupadd --system --gid 10001 kadai; \
    useradd --system --uid 10001 --gid kadai --home-dir /home/kadai --create-home \
      --shell /usr/sbin/nologin kadai; \
    install -d -o kadai -g kadai -m 0750 /data

WORKDIR /app
# Application files are owned by root and read-only for the runtime user.
COPY --from=prod-deps /out/package.json ./package.json
COPY --from=prod-deps /out/node_modules ./node_modules
COPY --from=build /src/apps/server/dist ./dist
COPY --from=build /src/apps/server/migrations ./migrations
COPY --from=build /src/apps/web/dist ./web
COPY --chmod=0755 deploy/docker/docker-entrypoint.sh /usr/local/bin/kadai-entrypoint
COPY --chmod=0644 deploy/docker/healthcheck.mjs /app/healthcheck.mjs

ENV NODE_ENV=production \
    KADAI_VERSION=${KADAI_VERSION} \
    KADAI_GIT_COMMIT=${GIT_COMMIT} \
    HOST=0.0.0.0 \
    PORT=8080 \
    KADAI_DATA_DIR=/data \
    KADAI_SERVE_WEB=true \
    KADAI_WEB_DIST=/app/web \
    KADAI_MIGRATIONS_DIR=/app/migrations

USER kadai:kadai
EXPOSE 8080
# Files and on-prem backups. Mount a volume here (named volume, bind mount or PVC).
VOLUME ["/data"]

# API containers: GET /health/live; worker / migrate / cli containers: process alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "/app/healthcheck.mjs"]

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/kadai-entrypoint"]
CMD ["server"]
