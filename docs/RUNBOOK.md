# Kadai — Operations runbook

Playbooks for incidents in cloud (Kubernetes / Compose) and on-prem (Docker, native Linux,
Windows) installations. Deployment details: [DEPLOYMENT.md](./DEPLOYMENT.md). Every playbook:
**stabilise → find the cause → fix → verify → write down what happened** (audit trail, ticket).

Shop impact first: billing must continue. The POS keeps billing offline (cash / static UPI
QR / card) and syncs later, so a server problem is urgent but rarely stops the counter.

---

## Access cheat sheet

| | Logs | SQL shell (owner role) | Restart |
|---|---|---|---|
| Kubernetes | `kubectl -n kadai logs deploy/kadai-api --since=30m` (`-l app.kubernetes.io/component=worker`) | `kubectl -n kadai exec -it deploy/kadai-api -- sh -c 'PSQL_HISTORY=/tmp/h psql "$DATABASE_SYSTEM_URL"'` | `kubectl -n kadai rollout restart deploy/kadai-api deploy/kadai-worker` |
| Cloud Compose | `docker compose logs --since 30m api worker` | `docker compose exec db psql -U kadai_owner kadai` | `docker compose restart api worker` |
| On-prem Docker (`/opt/kadai`) | `docker compose logs --since 30m kadai` | `docker compose exec db psql -U kadai_owner kadai` | `docker compose restart kadai` |
| Native Linux | `journalctl -u kadai --since "30 min ago"` | `sudo -u postgres psql kadai` | `sudo systemctl restart kadai` |
| Windows | `C:\ProgramData\Kadai\logs\kadai-service.out.log` | `& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -h 127.0.0.1 -U kadai_owner kadai` (password: `DATABASE_SYSTEM_URL` in `kadai.env`) | `Restart-Service kadai` |

Logs are JSON: filter with `jq 'select(.level=="error" or .level=="warn")'`; follow one request
with its `request_id` (also returned to clients as `x-request-id`). Health detail:
`curl -s http://127.0.0.1:8080/health/ready | jq` (inside the cluster/container or on the PC).

---

## Database down

**Symptoms:** `/health/ready` 503 with `checks.database.status = "error"`, 5xx on every API call,
`KadaiApiReplicasUnavailable`, on-prem counters show "server unreachable" and switch to offline
billing.

1. Is PostgreSQL running and accepting connections?
   * Kubernetes / managed: provider console (instance state, failover, maintenance window,
     storage full), `pg_isready -h <host>` from a pod.
   * Docker: `docker compose ps db`, `docker compose logs --tail 100 db`.
   * Native: `systemctl status postgresql@16-main` (Debian) / `postgresql-16` (RHEL), `journalctl -u postgresql@16-main`.
   * Windows: `Get-Service postgresql-x64-16`; logs in `C:\Program Files\PostgreSQL\16\data\log`.
2. Common causes and fixes:
   * **Disk full** → [Disk full (on-prem)](#disk-full-on-prem); in the cloud grow the volume.
   * **Too many connections** (`FATAL: sorry, too many clients`): count by role/app —
     `SELECT usename, application_name, state, count(*) FROM pg_stat_activity GROUP BY 1,2,3 ORDER BY 4 DESC;`
     Scale API pods down temporarily, lower `DATABASE_POOL_MAX`, raise `max_connections`
     (DEPLOYMENT §9 for the sizing formula).
   * **Wrong credentials after a secret change**: `password authentication failed for user` in the
     Kadai log → fix the Secret / `.env`, restart.
   * **Crash loop after an image change** (on-prem): check `docker compose logs db` for
     `database files are incompatible` (major version changed!) — put back
     `KADAI_POSTGRES_IMAGE=postgres:16-trixie`; never change the PostgreSQL major in place.
   * **Data corruption** (`invalid page`, checksum failures): stop writes, take a file-level copy
     of the data directory, then [restore the newest backup](#restoring-a-backup).
3. Kadai reconnects automatically (pools, LISTEN connection with backoff). Verify
   `/health/ready` = 200, then check that counters synced their offline invoices
   (Sales → Invoices, filter by today; renumbered offline invoices are audited).

## Migrations failed

**Symptoms:** `kadai-migrate` Job failed (`KadaiMigrationJobFailed`), `deploy.sh` stopped,
on-prem container/service restarting with `[migrate]` errors, `/health/ready` shows
`checks.migrations.pending` or `modified`.

Each migration file runs in its own transaction: a failed file is rolled back completely and the
previous version keeps running (cloud) — the database is consistent.

1. Read the error: `kubectl -n kadai logs job/kadai-migrate`, `docker compose logs kadai | grep migrate`,
   `journalctl -u kadai | grep migrate`. Status at any time:
   `kadai-entrypoint migrate --status` (exit 2 = checksum mismatch).
2. By cause:
   * **SQL error in a new migration** (constraint violated by existing data, lock timeout): do not
     hand-edit the database. Ship a fixed release (new migration file or data fix migration),
     then re-run the deploy. For lock timeouts retry outside business hours.
   * **`checksum mismatch`**: an applied migration file was edited. Restore the file from the
     release tag (`git show vX.Y.Z:apps/server/migrations/<file>`). Only if the change was
     intentionally cosmetic and approved by engineering may the recorded checksum be updated
     (`UPDATE schema_migrations SET checksum = '<sha256 of LF-normalised file>' WHERE name = '<file>'`).
   * **"pending file sorts before applied ones"** is a warning (parallel module bands), not a failure.
   * **Database newer than the code** (`missing file` warning after a rollback): fine for
     backward-compatible migrations; otherwise restore the pre-upgrade backup with the old version
     (on-prem: `upgrade.sh --rollback`, Windows `install.ps1 -Rollback`).
3. Verify: `migrate --status` shows every file `applied`, `/health/ready` 200, new pods ready.

## Payments stuck pending

**Symptoms:** UPI QR shown but the POS never turns "paid", reconciliation lists many `pending`
intents, `KadaiPaymentIntentsFailing`, shop says "customer paid, Kadai says pending".

1. Never ask the customer to pay again. Check the money first: Razorpay Dashboard → QR codes /
   Payments (dynamic QR) or the shop's bank/UPI app (static VPA).
2. Is the worker alive? (polling and expiry run there)
   `SELECT now() - updated_at AS heartbeat_age, value FROM system_settings WHERE key = 'worker_heartbeat';`
   Older than 90 s → [Worker down](#worker-down-jobs-not-running).
3. Open intents and job queues:
   ```sql
   SELECT provider, status, count(*), min(created_at), max(last_polled_at)
     FROM payment_intents WHERE status IN ('created','pending') GROUP BY 1,2;
   SELECT name, state, count(*) FROM pgboss.job
    WHERE name LIKE 'payments.%' AND created_on > now() - interval '1 hour' GROUP BY 1,2 ORDER BY 1,2;
   ```
   Many `failed` `payments.*` jobs → read `output` of the newest: `SELECT output FROM pgboss.job WHERE name = 'payments.poll-intent' AND state = 'failed' ORDER BY completed_on DESC LIMIT 3;`
   Typical: invalid Razorpay key (rotated in the dashboard → update the provider in Settings →
   Payments), outbound HTTPS blocked (on-prem firewall/proxy; NetworkPolicy egress 443), Razorpay
   outage (status.razorpay.com).
4. Webhooks (cloud): `SELECT event_type, signature_valid, processing_error, count(*) FROM payment_webhook_events WHERE received_at > now() - interval '1 hour' GROUP BY 1,2,3;`
   Invalid signatures → [Webhook signature failures](#webhook-signature-failures). Unprocessed
   rows with errors are retried by `payments.process-webhook`; polling still confirms intents.
5. Backfill: once the cause is fixed the 15-second poll sweep re-checks every open intent; paid
   intents become `paid` and stream to the POS. Intents that expired before the payment arrived
   are recorded as **unapplied receipts** → Payments → Reconciliation → apply to the invoice /
   customer or refund. Static-VPA payments are confirmed by the cashier (with UTR) — this is by
   design, not a fault.
6. Verify with a ₹1 test payment on the affected register.

## Webhook signature failures

**Symptoms:** `payment_webhook_events.signature_valid = false`, Razorpay dashboard shows webhook
deliveries with 4xx, payments confirm only via polling (delayed).

1. Which account? The URL is `/webhooks/payments/razorpay/<provider account id>`:
   `SELECT provider_account_id, count(*) FROM payment_webhook_events WHERE NOT signature_valid AND received_at > now() - interval '1 day' GROUP BY 1;`
2. Causes:
   * Secret differs between the Razorpay webhook and the Kadai provider (most common after
     someone "regenerated" it) → set a new secret (`openssl rand -hex 32`) in both places.
   * Webhook created in **test** mode but provider in **live** mode (or vice versa).
   * URL points to another provider account id (copied from another shop/store).
   * A proxy rewrites the body (only Caddy/ingress-nginx are supported; no body-transforming
     WAF rules on `/webhooks/*`). The signature is over the exact raw bytes.
3. Razorpay retries failed deliveries for 24 h; after fixing, use *Resend* in the dashboard for
   older events. Polling has already confirmed most intents; check
   [Payments stuck pending](#payments-stuck-pending) step 5 for anything left.
4. A burst of invalid signatures from unknown sources is an attack/probe: the endpoint is rate
   limited (`/webhooks` ingress); optionally restrict sources with
   `nginx.ingress.kubernetes.io/whitelist-source-range`.

## High latency or errors

**Symptoms:** `KadaiHighLatencyP95`, `KadaiHigh5xxRate`, `KadaiDbPoolSaturated`,
`KadaiEventLoopLag`, cashiers report slow billing.

1. Where? Prometheus:
   `topk(10, histogram_quantile(0.95, sum by (le, route) (rate(kadai_http_request_duration_seconds_bucket[5m]))))`
   and 5xx by route: `sum by (route, status_code) (rate(kadai_http_request_duration_seconds_count{status_code=~"5.."}[5m]))`.
   Logs: `jq 'select(.duration_ms > 1000)'` / `select(.level=="error")`.
2. Database:
   ```sql
   SELECT pid, now() - query_start AS runtime, state, wait_event_type, wait_event, left(query, 120)
     FROM pg_stat_activity WHERE datname = current_database() AND state <> 'idle' ORDER BY runtime DESC LIMIT 20;
   SELECT relation::regclass, mode, granted, count(*) FROM pg_locks WHERE NOT granted GROUP BY 1,2,3;
   ```
   Long report queries → they are cut at `DATABASE_STATEMENT_TIMEOUT_MS`; move heavy reports off
   peak or add the missing index (new migration). Lock waits on `number_series` / `stock_levels`
   are expected per register under load — many waiters for minutes mean a stuck transaction:
   `SELECT pg_terminate_backend(<pid>)` for an `idle in transaction` session older than a few
   minutes (they are also killed after `DATABASE_IDLE_TX_TIMEOUT_MS`).
   Bloat/vacuum: `SELECT relname, n_dead_tup, last_autovacuum FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 10;`
3. Pool waiting (`kadai_db_pool_connections{state="waiting"} > 0`): DB slow (above) or pool too
   small for the load → scale API pods (HPA) rather than raising pools beyond `max_connections`.
4. CPU / event loop: `kubectl top pods -n kadai`; event-loop lag with high CPU → scale out; with
   low CPU → a synchronous hot path (report it with the route and a CPU profile:
   `NODE_OPTIONS=--cpu-prof` on one pod).
5. Errors after a deploy → roll back (`kubectl rollout undo deploy/kadai-api` if migrations are
   backward compatible).

## Worker down, jobs not running

**Symptoms:** `KadaiWorkerUnavailable`, `/health/ready` worker check failing (on-prem), no
notifications / alerts / renewals, payments only confirm manually.

1. Cloud: `kubectl -n kadai get pods -l app.kubernetes.io/component=worker`, logs, OOMKilled
   (`kubectl describe pod`) → raise the memory limit. On-prem the worker is inside the Kadai
   process: restart the service/container.
2. Queue health: `SELECT name, state, count(*) FROM pgboss.job WHERE created_on > now() - interval '6 hours' GROUP BY 1,2 ORDER BY 1,2;`
   Jobs piling up in `created` with a live worker → the worker cannot keep up (scale workers) or a
   job type keeps failing (read `output`).
3. After recovery pg-boss retries failed jobs per job policy; cron jobs resume at their next slot.

## Disk full (on-prem)

**Symptoms:** PostgreSQL stops (`No space left on device`, `could not write to file`), Kadai 5xx,
backups failing.

1. Where is the space? `df -h /` `/opt/kadai` `/var/lib/docker`; `du -sh /opt/kadai/data/* | sort -h`;
   `docker system df`. Windows: Explorer → This PC; `C:\ProgramData\Kadai\data\backups`.
2. Safe to delete, in this order:
   * Old Docker images: `docker image prune -a` (keeps images of running containers).
   * Old backups **after** copying the newest to an external disk: `./backup.sh` prunes by
     retention; or delete the oldest `kadai-*.dump` files manually (keep at least the last 3).
   * Old rolled-back databases left by restores: `docker compose exec db psql -U kadai_owner -l`,
     then `dropdb -U kadai_owner kadai_pre_restore_<time>` once the restore was verified.
   * Exports / imports older than 30 days in `data/files` only through the application
     (Settings → Files), never by hand (database rows reference them).
   * **Never** delete files inside the PostgreSQL data directory (`pg_wal` included).
3. PostgreSQL usually starts again by itself once space is free (`docker compose up -d db`);
   then `docker compose up -d kadai` and check `/health/ready`.
4. Prevent: `KADAI_BACKUP_COPY_TO` to a USB/NAS, retention 30 days, logs are already rotated
   (Docker json-file 5 × 10 MB, journald, WinSW 8 × 10 MB). Move the data to a bigger disk with
   `docker compose down`, copy `/opt/kadai/data` and the `pgdata` volume, `up -d`.

## Restoring a backup

Decide what you need: **whole database** (hardware failure, corruption, wrong bulk import) vs
**single record** (look it up in the audit log and correct it with a document — e.g. a credit note
— instead of a restore). A restore loses everything entered after the backup: export today's
invoices first if the database is still readable.

* **On-prem Linux (Docker or native):**
  `sudo /opt/kadai/restore.sh <file.dump>` (native: `/opt/kadai/bin/restore.sh`). It verifies,
  asks for the database name, makes a safety backup, restores into a scratch database, swaps it in
  and starts Kadai. The replaced database stays as `kadai_pre_restore_<time>`; to undo, stop Kadai
  and rename the databases back (`ALTER DATABASE … RENAME TO …` from the `postgres` database).
* **Windows:** `.\restore.ps1 -File <file.dump>` from `C:\Program Files\Kadai\scripts` (admin).
* **New PC (disaster recovery):** install Kadai, put the old `KADAI_ENCRYPTION_KEYS` (and ideally
  the whole old `.env`/`kadai.env` secrets) in place, restart, then run the restore. The license
  stays valid: it is bound to the installation id stored in the database.
* **Cloud:** PITR in the provider to a new instance at the chosen time → run
  `kadai-entrypoint migrate --status` against it → switch `DATABASE_URL`/`DATABASE_SYSTEM_URL` in
  the Secret → `deploy.sh` (or rollout restart). A full restore affects **all tenants**: announce
  it; for one tenant use exports or a side-by-side restore and copy data with engineering support.
* Verify: `/health/ready` 200, latest invoice numbers per register, stock of a few items, a
  customer balance, and that counters' offline queues have synced.

## Rotating encryption keys

`KADAI_ENCRYPTION_KEYS` is a key ring (`kid:base64key,…`): the **first** key encrypts, every
listed key decrypts. Envelopes are `v1:<kid>:…`, so you can see which key protects what.

1. Generate a new key: `echo "k$(date +%Y%m):$(openssl rand -base64 32)"`.
2. **Prepend** it: `KADAI_ENCRYPTION_KEYS=knew:…,kold:…` in the Secret / `.env` / `kadai.env`;
   restart all API and worker processes (`rollout restart`, `docker compose up -d`, service restart).
3. Re-encrypt stored credentials: open each payment provider in Settings → Payments and save it
   again (and re-enter webhook secrets) — new writes use the new key. Check what still uses an
   old key:
   ```sql
   SELECT split_part(credentials_encrypted, ':', 2) AS kid, count(*) FROM payment_provider_accounts
    WHERE credentials_encrypted IS NOT NULL GROUP BY 1;
   SELECT split_part(webhook_secret_encrypted, ':', 2) AS kid, count(*) FROM payment_provider_accounts
    WHERE webhook_secret_encrypted IS NOT NULL GROUP BY 1;
   ```
4. Only when no row uses the old `kid` any more: remove it from the ring and restart again.
   Keep the retired key with the backups made before the rotation (those backups need it).

**Key compromised?** Rotate as above immediately, **and** rotate the provider secrets themselves
at Razorpay/WhatsApp/MSG91 (the encrypted values may be exposed).

**`JWT_SECRET`:** single value. Changing it invalidates every access token at once; web clients
refresh silently with their refresh token (stored server-side), so users stay logged in. To log
everyone out as well, also revoke all sessions (next playbook).

## Revoking sessions

Users can end their own sessions (`POST /api/v1/auth/logout {"all": true}`); disabling a user or
membership in Settings → Users ends access within the cache window (≤ 30 s). For incidents
(stolen phone, leaked password, departed employee):

```sql
BEGIN;
UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'ops: <ticket>'
 WHERE user_id = '<user uuid>' AND revoked_at IS NULL;
-- every API process drops its cached session checks immediately
SELECT pg_notify('kadai_cache', json_build_object('scope', 'session', 'user_id', '<user uuid>')::text);
COMMIT;
```

Find the user: `SELECT id, full_name, phone, email, status FROM users WHERE phone = '+91…' OR email = '…';`.
Also reset the password (password reset by OTP) and the POS PIN, and revoke trusted devices that
were with the person (Settings → Devices → Revoke). Everyone, everywhere (secret leak): run the
`UPDATE` without the `user_id` filter, rotate `JWT_SECRET`, restart. API keys: Settings → API keys →
Revoke (or `UPDATE api_keys SET revoked_at = now() WHERE key_prefix = 'kd_live_…'` +
`SELECT pg_notify('kadai_cache', '{"scope":"api_key"}');`).

## Suspending a tenant

Cloud only (non-payment, abuse, legal request). Suspended tenants get `403 TENANT_SUSPENDED` on
every route except billing/self-service; **data is kept**.

1. Preferred: platform admin console / API `POST /api/v1/platform/tenants/<id>/suspend` (audited in
   `platform_audit_logs`); resume with `…/resume`.
2. Emergency SQL (system role), same effect:
   ```sql
   BEGIN;
   UPDATE tenants SET status = 'suspended', suspended_reason = '<reason / ticket>' WHERE id = '<tenant uuid>';
   INSERT INTO platform_audit_logs (action, tenant_id, details)
   VALUES ('tenant.suspend', '<tenant uuid>', '{"via": "runbook", "ticket": "<ticket>"}');
   SELECT pg_notify('kadai_cache', json_build_object('scope', 'rbac', 'tenant_id', '<tenant uuid>')::text);
   SELECT pg_notify('kadai_cache', json_build_object('scope', 'entitlements', 'tenant_id', '<tenant uuid>')::text);
   COMMIT;
   ```
   Resume: `status = 'active', suspended_reason = NULL` with the same notifications and an audit row
   `tenant.resume`. For an abusive tenant also [revoke its users' sessions](#revoking-sessions).
3. Verify: a request with that tenant's token returns `TENANT_SUSPENDED`; other tenants unaffected.

## On-prem license problems

**Symptoms:** banner "license invalid", writes fail with `403 LICENSE_INVALID` (read-only mode),
or features fall back to the Free plan.

* Expired / not yet valid → Free plan limits (still writable): upload the renewed license.
* Tampered file, other installation id (new PC without restoring the database) or a
  development-signed license on a production install → read-only. Settings → System shows the
  installation id; the vendor issues a license for it. Restoring the shop's database onto the new
  PC keeps the original installation id (and license) valid.
* Never edit `system_settings` license rows by hand: the license is signature-checked.

## PostgreSQL collation warning after an image change (on-prem)

`WARNING: database "kadai" has a collation version mismatch` after changing
`KADAI_POSTGRES_IMAGE` to a different Debian release means text indexes may be ordered
differently. Fix outside business hours: `docker compose exec db psql -U postgres -d kadai -c
'REINDEX DATABASE kadai'` then `ALTER DATABASE kadai REFRESH COLLATION VERSION;` (also for
`postgres` and `template1`). Keep the pinned image (`postgres:16-trixie`) to avoid this.
