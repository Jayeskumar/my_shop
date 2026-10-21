# Kadai — Deployment guide

How to run Kadai as a **cloud SaaS** (Kubernetes or Docker Compose) and as an **on-premise
shop server** (Docker on Linux, native Linux, native Windows). Incident playbooks are in
[RUNBOOK.md](./RUNBOOK.md); the architecture and configuration contract is
[ARCHITECTURE.md](./ARCHITECTURE.md).

One build serves every deployment. `KADAI_MODE=cloud | onprem` selects the behaviour at boot.

| Artefact (per release `vX.Y.Z`) | Used for |
|---|---|
| `ghcr.io/jayeskumar/my_shop:X.Y.Z` (linux/amd64 + arm64) | Kubernetes, cloud Compose, on-prem Docker |
| `kadai-onprem-X.Y.Z.zip` | on-prem kit: Compose files, Linux installer, backup/restore/upgrade scripts, systemd units, Windows installer, these docs |
| `kadai-server-X.Y.Z-linux-x64.tar.gz` / `-win-x64.zip` | native installs (no Docker) |
| `kadai-image-X.Y.Z.spdx.json`, `SHA256SUMS` | SBOM and checksums (`sha256sum -c SHA256SUMS`) |

The image also carries BuildKit provenance and SBOM attestations (`docker buildx imagetools
inspect <image> --format '{{json .Provenance}}'`, `gh attestation verify oci://<image> -R
Jayeskumar/my_shop`).

> **Registry access.** GHCR packages of a private repository are private. Before shipping to
> shops, make the package public (GitHub → Packages → my_shop → Package settings → Change
> visibility) or give each installation a read-only token (`docker login ghcr.io`).

---

## 1. Choosing a deployment

| | Cloud — Kubernetes | Cloud — Compose | On-prem — Docker | On-prem — native Linux | On-prem — Windows |
|---|---|---|---|---|---|
| For | SaaS at scale | SaaS pilot, one VM | most shops (Linux PC / mini server) | Linux without Docker | shop PC running Windows 10/11 |
| Processes | N api + M worker pods, migrate Job | api ×N, worker ×M, migrate, Caddy, Postgres, Redis | Postgres + one Kadai container (API + embedded worker) | systemd `kadai` + PostgreSQL 16 | service "Kadai Server" (WinSW) + PostgreSQL 16 |
| HTTPS | ingress-nginx + cert-manager | Caddy (Let's Encrypt) | optional LAN TLS (Caddy, local CA) | — | — |
| Backups | managed PostgreSQL (PITR) + logical dumps | `pg_dump` / provider snapshots | in-app schedule + `backup.sh` | in-app + `backup.sh` | in-app + `backup.ps1` |

Minimum sizes: on-prem PC 4 GB RAM, 2 cores, 20 GB free SSD (8 GB RAM recommended for
supermarkets with several counters). Cloud: start with 3 × (0.5 vCPU, 1 GiB) api pods, 2 ×
(0.25 vCPU, 768 MiB) workers, PostgreSQL 16 with 2 vCPU / 8 GB and Redis 256 MB.

---

## 2. Configuration

The variables, their defaults and meaning are the contract in
[ARCHITECTURE.md §19](./ARCHITECTURE.md#19-configuration-env). The server also understands these
deployment/tuning variables:

| Variable | Default | Notes |
|---|---|---|
| `TRUST_PROXY` | `false` | `1` behind exactly one proxy (Caddy, ingress-nginx); a CIDR list also works. Needed for correct client IPs (rate limits, audit). |
| `BODY_LIMIT_BYTES` | `1048576` | JSON body limit (uploads are multipart, limits per purpose: imports 20 MB). |
| `DATABASE_SYSTEM_POOL_MAX` | `10` | owner-role pool per process (in addition to `DATABASE_POOL_MAX`). |
| `DATABASE_STATEMENT_TIMEOUT_MS` / `DATABASE_IDLE_TX_TIMEOUT_MS` | `15000` / `60000` | per-statement timeout; abort idle transactions. |
| `ACCESS_TOKEN_TTL_SECONDS` / `REFRESH_TOKEN_TTL_DAYS` | `900` / `30` | |
| `KADAI_HEALTH_REQUIRE_WORKER` | `true` in production | `/health/ready` fails without a fresh worker heartbeat. Set `false` on cloud API pods (the worker runs separately; alert on it instead). |
| `RATE_LIMIT_GLOBAL_MAX` | `600` | requests/min per user (or IP). |
| `KADAI_WEB_DIST`, `KADAI_MIGRATIONS_DIR` | repo paths | set by the image (`/app/web`, `/app/migrations`) and the native installers. |
| `KADAI_VERSION` | package version | set by the image / installers; shown in `/health/*`, logs and `kadai_build_info`. |
| `METRICS_TOKEN` | — | bearer token for `GET /metrics` (required in cloud deployments). |
| `LOG_LEVEL`, `LOG_PRETTY` | `info`, off in production | JSON logs on stdout. |
| `NOTIFICATION_PROVIDER_TIMEOUT_MS` | `10000` | timeout of one SMS / WhatsApp / e-mail provider call (a timeout is retried). |
| `MSG91_BASE_URL` / `WHATSAPP_BASE_URL` | `https://control.msg91.com` / `https://graph.facebook.com` | provider API base URLs (egress proxies, tests). |

**Secrets as files.** The container entrypoint reads `VAR_FILE=/path` for `DATABASE_URL`,
`DATABASE_SYSTEM_URL`, `JWT_SECRET`, `KADAI_ENCRYPTION_KEYS`, `METRICS_TOKEN`, `REDIS_URL`, S3 keys,
MSG91/WhatsApp/SMTP/e-mail webhook/Razorpay secrets (Docker/Kubernetes secrets, systemd credentials).

### Generating secrets

```bash
openssl rand -base64 48                                  # JWT_SECRET (≥ 32 bytes)
echo "k$(date +%Y%m):$(openssl rand -base64 32)"         # KADAI_ENCRYPTION_KEYS (kid:32-byte key)
openssl rand -hex 24                                     # database passwords, METRICS_TOKEN
openssl rand -hex 32                                     # Razorpay / WhatsApp webhook secrets
```

Use hex for database passwords (safe inside `postgres://` URLs). **Keep `KADAI_ENCRYPTION_KEYS`
with the backups**: payment-provider credentials in a restored database cannot be decrypted
without it. Production refuses to start with development secrets or
`KADAI_ENCRYPTION_KEYS` missing, or with `KADAI_ENABLE_MOCK_PAYMENTS=true`.

### Database roles

Every deployment uses two roles (ARCHITECTURE §6.1): **`kadai_owner`** (owns all objects; runs
migrations, the system pool, backups; `CREATEDB` for restores) and **`kadai_app`** (runtime role,
Row-Level Security enforced). The migrator grants `kadai_app` its privileges after each run.
For a managed PostgreSQL 16 (RDS, Cloud SQL, Azure, Crunchy, …):

```sql
CREATE ROLE kadai_owner LOGIN CREATEDB PASSWORD '<hex>';
CREATE ROLE kadai_app   LOGIN PASSWORD '<hex>';            -- no CREATEDB, not a superuser
CREATE DATABASE kadai OWNER kadai_owner TEMPLATE template0 ENCODING 'UTF8';
REVOKE ALL ON DATABASE kadai FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE kadai TO kadai_app;
\c kadai
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
```

Never point `DATABASE_URL` at the owner role or a superuser: RLS would be bypassed. Use
`sslmode=verify-full` towards managed databases.

---

## 3. Cloud on Kubernetes

Manifests: `deploy/k8s` (kustomize). `base/` holds the workloads; `overlays/staging` and
`overlays/production` set namespace, image tag, hostnames, sizing and the monitoring component.

| Object | Notes |
|---|---|
| `Deployment/kadai-api` | 3 replicas (HPA 3–12 on CPU 70 %), readiness `/health/ready` (DB + migrations), liveness `/health/live`, startup probe, `preStop` delay, non-root uid 10001, read-only root FS, `emptyDir` `/tmp` + `/data`, zone/host spread |
| `Deployment/kadai-worker` | 2 replicas (HPA 2–4), pg-boss workers; cron/interval jobs are singletons across replicas |
| `Job/kadai-migrate` | `migrate` with the new image **before** the rollout (Argo CD PreSync hook / Flux force annotations included) |
| `Service`, `Ingress` ×2 | ingress-nginx + cert-manager; 25 MB bodies for imports, buffering off + 300 s timeouts for SSE; separate `/webhooks` ingress with its own rate limit |
| `PodDisruptionBudget`, `NetworkPolicy` | max 1 unavailable; default-deny, ingress only from `ingress-nginx`/`monitoring`, egress DNS, 5432/6379, 443/465/587 |
| `ServiceMonitor`, `PrometheusRule` | `components/monitoring` (needs the Prometheus Operator CRDs and kube-state-metrics; remove it from the overlay otherwise) |

Prerequisites: Kubernetes ≥ 1.27 (PSA labels), ingress-nginx, cert-manager with a
`letsencrypt-prod` / `letsencrypt-staging` ClusterIssuer, metrics-server (HPA), PostgreSQL 16 and
Redis reachable from the cluster, an S3 bucket (`S3_BUCKET` — pod disks are ephemeral).

```bash
# 1. hostnames, bucket, providers: edit overlays/<env>/config.env and the Ingress patch
# 2. secrets (or External Secrets / Sealed Secrets / SOPS — see base/secret.example.yaml)
kubectl create namespace kadai
kubectl -n kadai create secret generic kadai-secrets --from-env-file=kadai-secrets.env
# 3. migrate, then roll out (renders the overlay with the tag; nothing is edited)
deploy/k8s/deploy.sh production 1.4.0
# 4. first platform administrator (cloud SaaS vendor staff)
kubectl -n kadai exec deploy/kadai-api -- kadai-entrypoint cli create-platform-admin \
  --name "Ops" --email ops@example.in --password '<strong password>'
```

`deploy.sh` applies namespace/config/network policies, deletes the previous migrate Job, runs
the new one and waits; a failed migration stops the deploy while the running version keeps
serving. New api pods also stay unready until migrations are current, so a forgotten Job
blocks the rollout instead of serving an old schema. GitOps: Argo CD runs the Job as a
`PreSync` hook; Flux recreates it (`kustomize.toolkit.fluxcd.io/force`).

The namespace enforces Pod Security "restricted". `TRUST_PROXY=1` assumes the ingress controller
is the only hop and sets `X-Forwarded-For` (use proxy protocol or `externalTrafficPolicy: Local`
on its LoadBalancer to keep client IPs). API pods run with `KADAI_HEALTH_REQUIRE_WORKER=false`
so a worker outage never removes the API from the load balancer; `KadaiWorkerUnavailable`
alerts instead.

## 4. Cloud with Docker Compose (single host)

`deploy/cloud/docker-compose.yml`: Caddy (automatic HTTPS, HTTP/3, compression, security
headers, `/metrics` hidden, load balancing over the api replicas) → `api` ×`KADAI_API_REPLICAS`
(read-only root FS), `worker` ×`KADAI_WORKER_REPLICAS`, one-shot `migrate` (api/worker start only
after it succeeded), PostgreSQL 16 (profile `db`) and Redis.

```bash
cd deploy/cloud
cp .env.example .env && chmod 600 .env     # domain, ACME e-mail, image tag, secrets
docker compose up -d
docker compose ps                           # migrate "exited (0)", api/worker "healthy"/"running"
docker compose exec api kadai-entrypoint cli create-platform-admin --name Ops --email ops@example.in --password '…'
```

DNS for `KADAI_DOMAIN` must point at the host and ports 80/443 must be reachable for Let's
Encrypt. External database: set `COMPOSE_PROFILES=` and `DATABASE_URL`/`DATABASE_SYSTEM_URL`.
Upgrade: change `KADAI_IMAGE`, `docker compose up -d` (migrate runs first).

---

## 5. On-premise

Every on-prem install runs one Kadai process with the API, the web app and the background worker
(`KADAI_EMBEDDED_WORKER=true`), applies migrations on boot and serves the counters on the LAN at
`http://<server>:8080`. There is exactly one tenant, created by the setup wizard.

### 5.1 Linux with Docker (recommended)

From the unpacked `kadai-onprem-X.Y.Z.zip`:

```bash
sudo ./install-linux.sh            # installs Docker if missing (get.docker.com), asks otherwise
```

It copies the kit to `/opt/kadai`, generates `.env` with fresh secrets (mode 600), creates the
data folder `/opt/kadai/data` (owner uid 10001 — files, logs, backups), pulls the images, starts
PostgreSQL (roles from `initdb/01-roles.sh`) and Kadai, opens TCP 8080 for private (LAN)
addresses in ufw/firewalld and waits for `/health/ready`. Options: `--port`, `--public-url`,
`--image`, `--backup-timer` (extra daily host-level backup at 22:45), `--no-firewall`, `--yes`.

Manual equivalent: `cp .env.example .env`, fill every `CHANGE_ME`, `install -d -o 10001 -g 10001
data`, `docker compose up -d`. Compose refuses to start while a secret is missing. PostgreSQL is
not published on the LAN; for admin tools use `docker compose exec db psql -U kadai_owner kadai`.

### 5.2 Linux native (no Docker)

```bash
sudo ./install-linux.sh --mode native [--bundle kadai-server-X.Y.Z-linux-x64.tar.gz]
```

Debian 12/13, Ubuntu 22.04+ (apt.postgresql.org) or RHEL/Rocky/Alma 8–9 (PGDG). It installs
PostgreSQL 16, a private Node.js 22 in `/opt/kadai/node` (verified against `SHASUMS256.txt`),
the app in `/opt/kadai/app`, creates the system user `kadai`, `/var/lib/kadai` (data, backups),
`/etc/kadai/kadai.env` (0640 root:kadai) and the hardened systemd unit `kadai.service`
(`ProtectSystem=strict`, no capabilities, writes only to `/var/lib/kadai`). Scripts are copied
to `/opt/kadai/bin`. Logs: `journalctl -u kadai`.

### 5.3 Windows 10/11 (native)

See [deploy/onprem/windows/README.md](../deploy/onprem/windows/README.md). In an elevated
PowerShell: `powershell -ExecutionPolicy Bypass -File .\windows\install.ps1`. It installs a
private Node.js 22, PostgreSQL 16 (EDB installer, unattended, signature checked), the service
**Kadai Server** (WinSW, runs as LocalService, restarts on failure, depends on PostgreSQL), a
firewall rule for TCP 8080 limited to the local subnet on Private/Domain networks
(`-SetNetworkPrivate` fixes a "Public" LAN profile), a desktop shortcut and optionally a daily
backup task (`-BackupTask`). Config: `C:\ProgramData\Kadai\kadai.env` (ACL: SYSTEM,
Administrators, LocalService read). Logs: `C:\ProgramData\Kadai\logs`.

### 5.4 On-prem HTTPS (LAN)

Browsers allow the installable POS app (service worker: offline app shell, “Install” button) only
on HTTPS or on `localhost`. Billing works over plain `http://<server>:8080` from any counter, but
for the installable/offline-capable app on counter PCs enable the `tls` profile:

```bash
# .env: KADAI_TLS_SITES=kadai.local 192.168.1.10   (names/IPs separated by spaces)
#       KADAI_HTTP_BIND=127.0.0.1                    (optional: plain HTTP only on this PC)
#       PUBLIC_BASE_URL=https://kadai.local
docker compose --profile tls up -d
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./kadai-root-ca.crt
```

Install `kadai-root-ca.crt` once per counter device: Windows `certutil -addstore -f Root
kadai-root-ca.crt` (admin), Linux `cp … /usr/local/share/ca-certificates/ && update-ca-certificates`,
Android Settings → Security → Encryption & credentials → Install a certificate → CA. When
`PUBLIC_BASE_URL` is `https://…` the server sends HSTS, so use only the HTTPS address afterwards.

### 5.5 First run and license

1. Open `http://<server>:8080` → setup wizard (`/setup`): shop, GST details, owner login.
2. Without a license Kadai runs the Free plan (writable evaluation). Settings → System shows the
   **installation id**; the vendor signs a license for it
   (`kadai-entrypoint cli issue-license sign --key <vendor private key> --kid <kid> …`, see
   `apps/server/scripts/dev-keys/README.md`) and the shop uploads it in Settings → System
   (`PUT /api/v1/system/license`). A tampered or foreign license switches to read-only, never to
   data loss. Production installs reject licenses signed with development keys.
3. Settings → Payments: the shop's UPI ID (static QR, free) and optionally Razorpay (§9).

---

## 6. Upgrades

Rules for every deployment: **back up first, migrations run before the new code serves
traffic, migrations are forward-only** (a rollback = previous version + restore of the
pre-upgrade backup). Applied migration files are checksummed; CI rejects edits to them.

| Deployment | Upgrade | Rollback |
|---|---|---|
| Kubernetes | `deploy/k8s/deploy.sh production X.Y.Z` (migrate Job → rollout) | backward-compatible migrations: `kubectl rollout undo`; otherwise restore (RUNBOOK) + previous tag |
| Cloud Compose | `KADAI_IMAGE=…:X.Y.Z` in `.env`, `docker compose up -d` | previous tag + restore if the schema changed |
| On-prem Docker | `sudo /opt/kadai/upgrade.sh --version X.Y.Z` | `sudo /opt/kadai/upgrade.sh --rollback` |
| On-prem native | `sudo /opt/kadai/bin/upgrade.sh --bundle kadai-server-X.Y.Z-linux-x64.tar.gz` | `… upgrade.sh --rollback` |
| Windows | `.\install.ps1 -Upgrade -BundlePath .\kadai-server-X.Y.Z-win-x64.zip` | `.\install.ps1 -Rollback` |

The on-prem upgraders fetch the new version first (no downtime), take a `pre_upgrade` backup,
switch, wait for `/health/ready` (migrations on boot) and record the previous version and
backup for `--rollback`. Schedule upgrades after closing time; offline POS invoices queued on
counters sync once the server is back.

Cloud migrations must be **expand/contract**: a release may only add (columns, tables, nullable
fields); drops happen one release later, so the previous version keeps working while pods roll.

---

## 7. Backups and restore

**On-prem.** The application's scheduled job (`platform.backup`, daily 23:00 — ARCHITECTURE §14)
writes `pg_dump -Fc` files to `<data>/backups`. The host scripts below complement it; enable
their schedule as well (`install-linux.sh --backup-timer`, `install.ps1 -BackupTask`) so a second,
independent copy exists:

```bash
sudo ./backup.sh                                     # manual backup (prints the file path)
sudo ./backup.sh --dest /media/usb/kadai --label before-gst-change
sudo ./restore.sh /opt/kadai/data/backups/kadai-kadai-20261020-230000-scheduled.dump
```

`backup.sh` verifies each archive (`pg_restore --list`), writes a `.sha256`, copies it to
`KADAI_BACKUP_COPY_TO` (USB disk / NAS — keep one copy **off the PC**), records it in Settings →
System and prunes files older than `KADAI_BACKUP_RETENTION_DAYS` (30) while always keeping the
newest `KADAI_BACKUP_KEEP_MIN` (7). `restore.sh` checks the archive and checksum, asks you to type
the database name, takes a safety backup, stops Kadai, restores into a scratch database in one
transaction, swaps it in atomically (the old database stays as `kadai_pre_restore_<time>`), starts
Kadai (newer migrations applied on boot) and waits until ready. Windows: `backup.ps1` /
`restore.ps1` with the same behaviour. Disaster recovery onto a new PC: install Kadai, copy the
old `.env` / `kadai.env` secrets (at least `KADAI_ENCRYPTION_KEYS`), then restore the newest backup.

**Cloud.** Use the managed database's PITR (≥ 7 days) plus a daily logical dump to a separate
account/bucket (`pg_dump -Fc "$DATABASE_SYSTEM_URL"`), restore-tested monthly into a scratch
instance. A database restore affects all tenants; per-tenant recovery is done from exports.

---

## 8. TLS

* Kubernetes: cert-manager certificates on the Ingress (`kadai-tls`), HTTP → HTTPS redirect.
* Compose: Caddy obtains/renews Let's Encrypt certificates; HTTP/3 enabled.
* The server sets HSTS and `upgrade-insecure-requests` when `PUBLIC_BASE_URL` is `https://`.
* On-prem: §5.4. Database connections leave the host only in cloud setups: use
  `sslmode=verify-full`.

## 9. Scaling

* API pods are stateless (files in S3, rate-limit state in Redis, sessions in PostgreSQL); scale
  by CPU. POS latency target: ≤ 100 ms p95 for lookups and invoice save.
* PostgreSQL connections: each API process opens up to `DATABASE_POOL_MAX` + `DATABASE_SYSTEM_POOL_MAX`
  + 1 (LISTEN) connections, each worker the same plus pg-boss's pool. Size `max_connections` ≥
  `(max api pods + workers) × (pool + system pool + 2)` + 20 for admin/migrations, or lower the
  pools. A transaction-mode PgBouncer is **not** suitable for the LISTEN connection and pg-boss;
  use session mode or direct connections.
* Workers: 2 replicas cover thousands of shops; pg-boss distributes jobs.
* Multi-region is out of scope for v1 (single primary database).

## 10. Monitoring

* **Health:** `/health/live` (process), `/health/ready` (database, migrations, worker heartbeat
  where required; JSON detail). External uptime check on `https://<host>/health/ready` every
  minute.
* **Metrics** (`GET /metrics`, `Authorization: Bearer $METRICS_TOKEN`): `kadai_http_request_duration_seconds`
  (method, route, status), `kadai_db_pool_connections` (pool, state), `kadai_invoices_created_total`,
  `kadai_payment_intents_total` (provider, status), `kadai_jobs_processed_total` /
  `kadai_job_duration_seconds` (processes that run jobs), `kadai_build_info`, Node.js defaults
  (`kadai_nodejs_*`, `kadai_process_*`).
* **Logs:** pino JSON on stdout, one line per request with `request_id` (also in the
  `x-request-id` response header), secrets redacted. Ship with the cluster's log agent;
  on-prem Docker keeps 5 × 10 MB per container, systemd uses the journal, Windows rolls 8 × 10 MB.
* **Alerts** (`deploy/k8s/components/monitoring/prometheusrule.yaml`): API down, < 2 ready API
  replicas, 5xx > 2 %, p95 > 1 s, DB pool waiting, event-loop lag, payment intents failing,
  worker unavailable, migrate Job failed, restarts. Also alert on: PostgreSQL disk > 80 %,
  replication/backup age > 26 h, certificate expiry < 14 days, worker heartbeat age > 2 min
  (`SELECT now() - updated_at FROM system_settings WHERE key = 'worker_heartbeat'`).
* On-prem: Docker restarts exited containers (`restart: unless-stopped`; health is shown by
  `docker compose ps`), systemd / WinSW restart the service on failure; Settings → System shows
  the last backup.

## 11. Payments (UPI)

**Shop UPI ID (`upi_vpa`, default, free):** Settings → Payments → add the shop's VPA and payee
name; QR codes carry the amount; the cashier confirms receipt (manual confirmation, audited).
Works offline and on-prem.

**Razorpay dynamic QR / payment links (auto-confirmation):**

1. Razorpay Dashboard (live mode, and separately test mode) → API Keys: create a key; in Kadai
   Settings → Payments add a Razorpay provider with key id + key secret (stored encrypted).
2. Razorpay Dashboard → Webhooks → *Add new webhook*:
   * URL: `https://<your host>/webhooks/payments/razorpay/<provider account id>` — the account id
     is shown on the provider in Settings → Payments (`GET /api/v1/payment-providers/:id`).
   * Secret: `openssl rand -hex 32`, the same value entered as the provider's webhook secret.
   * Active events: `qr_code.credited`, `payment_link.paid`, `payment.failed`.
3. Test with a ₹1 QR in test mode. Webhooks are verified (`X-Razorpay-Signature`, HMAC-SHA256
   of the raw body) and de-duplicated by `x-razorpay-event-id`.

On-prem servers are normally not reachable from the internet: **do not port-forward the shop
server**; the worker polls Razorpay for open intents (every 15 s), which confirms payments
without webhooks. Outbound HTTPS to `api.razorpay.com` must be allowed.

**SaaS billing (cloud vendor):** `RAZORPAY_PLATFORM_KEY_ID/SECRET/WEBHOOK_SECRET`; webhook URL
`https://<host>/webhooks/platform/razorpay` with the Razorpay Subscriptions events
(`subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`,
`subscription.cancelled`, `subscription.completed`, `payment.failed`).

## 12. SMS, WhatsApp and e-mail

**SMS in India requires DLT registration** (TRAI TCCCPR 2018) before any provider delivers:

1. Register the business as a Principal Entity on a DLT portal (Jio, Airtel, Vi/Vilpower, BSNL,
   …) → **Entity ID**.
2. Register a 6-character sender **header** (e.g. `KADAIS`) and each **content template**
   (OTP, invoice link, due reminder; Tamil templates are Unicode, 70 characters per part) with
   `{#var#}` placeholders exactly matching what Kadai sends → **template IDs**.
3. MSG91: add the entity id and templates, then set `SMS_PROVIDER=msg91`, `MSG91_AUTH_KEY`,
   `MSG91_SENDER_ID`, `MSG91_DLT_ENTITY_ID`, `MSG91_OTP_TEMPLATE_ID` (required with msg91). Each
   default text that should go by SMS needs its MSG91 Flow template id (linked to the DLT
   template) in `MSG91_TEMPLATE_<CODE>`: `MSG91_TEMPLATE_INVOICE_SHARE`,
   `MSG91_TEMPLATE_PAYMENT_RECEIPT`, `MSG91_TEMPLATE_DUE_REMINDER`, `MSG91_TEMPLATE_PAYMENT_LINK`,
   `MSG91_TEMPLATE_DAILY_SUMMARY`, `MSG91_TEMPLATE_PO_TO_SUPPLIER`, `MSG91_TEMPLATE_WELCOME`.
   The exact texts to register (placeholders as `{#var#}`, Flow variables named like the
   placeholders: `##shop_name##`, `##due##`, …) come from `dltTemplateText()` of the defaults;
   a shop's own SMS text (notification templates) carries its id in `provider_template_id`.
   An SMS without a template id fails with `not_configured`; messages that do not match a
   registered template are dropped by the operator.
4. Delivery reports: in MSG91 set the webhook to
   `https://<host>/webhooks/notifications/msg91?token=<MSG91_WEBHOOK_TOKEN>` and set
   `MSG91_WEBHOOK_TOKEN` (`openssl rand -hex 24`; MSG91 does not sign reports, so without the
   token anyone could post them).

**WhatsApp (Meta WhatsApp Cloud API):** Meta Business account → app with the WhatsApp product →
phone number id, a permanent System User token, the app secret. Set `WHATSAPP_PROVIDER=whatsapp_cloud`,
`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` (older name `WHATSAPP_TOKEN` is accepted),
`WHATSAPP_APP_SECRET` (signature of the delivery callbacks — without it they are rejected),
`WHATSAPP_WEBHOOK_VERIFY_TOKEN` (`openssl rand -hex 32`), optionally `WHATSAPP_API_VERSION`
(`v21.0`). Webhook callback URL `https://<host>/webhooks/notifications/whatsapp_cloud` with that
verify token, subscribed to `messages` (delivery statuses). Templates (utility category, ta + en)
must be approved by Meta under the names `kadai_invoice_share`, `kadai_payment_receipt`,
`kadai_due_reminder`, `kadai_payment_link`, `kadai_daily_summary`, `kadai_low_stock`,
`kadai_expiry_alert`, `kadai_purchase_order`, `kadai_welcome` with the texts of
`whatsappTemplateText()` (body parameters in placeholder order); a shop's own text names its own
approved template. Templates approved with a dynamic URL button (`https://<host>/{{1}}`) are
listed in `WHATSAPP_URL_BUTTON_TEMPLATES` (comma separated codes, e.g. `due_reminder,invoice_share`):
the button then gets the link path.

**E-mail:** this build bundles no SMTP client. Set `EMAIL_PROVIDER=email_webhook`,
`EMAIL_WEBHOOK_URL` (a small relay of your choice: your mail provider's HTTP API behind a
function, n8n, a Postfix sidecar…), `EMAIL_WEBHOOK_SECRET` and `EMAIL_FROM` (falls back to
`SMTP_FROM`). Each e-mail is `POST`ed as JSON `{event: "notification.email", id, tenant_id,
notification_id, template_code, locale, from, to, to_name, subject, text}` with headers
`Idempotency-Key` and `X-Kadai-Signature: sha256=<hex HMAC-SHA256 of the raw body with the
secret>`; answer 2xx (optionally `{"id": "<message id>"}`), 408/425/429/5xx are retried. Set up
SPF/DKIM for the sending domain at the relay. `EMAIL_PROVIDER=smtp` is reserved and only logs a
warning.

In production a channel without a live provider is not "sent" to the log: its messages are
cancelled with `channel_not_configured` (the outbox shows why). On-prem shops without their own
provider use Kadai messaging (`kadai_relay`) when connected.

`log` providers (default) only write messages to the server log — never use them in production
for OTP (the server warns at boot).

## 13. Operator security checklist

* Secrets only in `.env`/`kadai.env` (mode 600/640) or the secret store; never in Git or tickets.
* Runtime role `kadai_app` without `CREATEDB`/superuser; owner role only for migrations/system work.
* Containers non-root (uid 10001), read-only root filesystem in Kubernetes/cloud Compose,
  Pod Security "restricted", NetworkPolicies on.
* `METRICS_TOKEN` set; `/metrics` hidden at the edge; API docs (`/api/docs`) off in production.
* On-prem: PostgreSQL not published; firewall limited to the LAN; no port forwarding; backups
  copied off the PC; Windows network profile Private.
* Keep the image patched: rebuild/upgrade monthly (base image + PGDG client); Dependabot and
  `pnpm audit --prod` gate dependencies; Trivy/Grype on the published SBOM.

## 14. Building and releasing

```bash
docker build -f deploy/docker/Dockerfile -t kadai:dev .            # or: make image
docker build --secret id=extra_ca,src=corp-root-ca.pem …            # behind a TLS-inspecting proxy
make deploy-check     # shellcheck, hadolint, actionlint, compose, Caddy, kustomize + kubeconform
make deploy-test      # shell tests + backup/restore integration against local PostgreSQL
make onprem-e2e IMAGE=kadai:dev && make cloud-e2e IMAGE=kadai:dev   # Docker end-to-end tests
```

CI (`.github/workflows/ci.yml`) runs lint, format, typecheck, unit tests, server integration
tests on PostgreSQL 16 (`db:types:check` included), build, Playwright smoke, the image build
with on-prem and cloud Compose end-to-end tests, deployment-kit checks, Windows script checks
(PowerShell 5.1 parse, PSScriptAnalyzer, Pester) and `pnpm audit --prod --audit-level high`.
Pull requests that edit an applied migration fail. Coverage reports are collected when
`@vitest/coverage-v8` is installed (JUnit reports always).

Release: push a tag `vX.Y.Z` (`vX.Y.Z-rc.N` for pre-releases). `release.yml` re-runs CI, pushes
the multi-arch image with provenance + SBOM attestations, builds and smoke-tests the native
bundles on Linux and Windows, assembles the on-prem kit and publishes the GitHub release with
`SHA256SUMS`.
