# Kadai — Architecture & Engineering Conventions

> **Kadai (கடை)** is a vertical retail ERP for Indian — first of all Tamil Nadu — small and
> mid-sized shops: general stores (மளிகை), supermarkets, textile/readymade stores, pharmacies,
> footwear, hardware, bakeries. One codebase ships as a **multi-tenant cloud SaaS** and as a
> **single-tenant on-premise server** that runs on the shop's own PC/LAN.
>
> This document is the contract every module is built against. If code and this document
> disagree, fix one of them in the same change.

---

## 1. Goals and non-negotiables

1. **Correct money.** Integer paise everywhere, deterministic GST maths shared by server and
   POS client, double-entry ledger that must balance at commit, gapless GST invoice numbering.
2. **Tenant isolation by construction.** PostgreSQL Row-Level Security on every tenant table,
   composite foreign keys `(tenant_id, x_id)`, separate DB roles for runtime vs. system work.
3. **Works when the internet doesn't.** On-prem mode runs fully offline on a LAN; the cloud POS
   is an installable PWA with an offline catalogue and an offline invoice queue.
4. **Tamil first.** Every UI string is translated (ta + en), product/customer names are
   bilingual, invoices print bilingual with amount in words in Tamil and English.
5. **Fast counter.** Keyboard-first billing, barcode/scale-barcode scanning, ≤100 ms p95 for
   product lookup and invoice save on a single store.
6. **Enterprise operability.** Structured logs, metrics, health checks, audit trail,
   idempotent APIs, migrations with checksums, backups, CI, containers, Kubernetes manifests.

---

## 2. Deployment modes (one codebase)

`KADAI_MODE=cloud | onprem` selects behaviour at boot. The same Docker image / build artefact
serves both.

| Concern | cloud | onprem |
|---|---|---|
| Tenancy | many tenants, self-signup | exactly one tenant, created by the first-run **setup wizard** (`/setup`) |
| Entitlements | plan + subscription (`plans`, `subscriptions`) | signed **license file** (Ed25519) uploaded in settings |
| Signup / platform admin | enabled | disabled (404) |
| Payment webhooks | public HTTPS endpoint | usually unreachable → **status polling** reconciles UPI |
| Files | S3-compatible object storage (or local in small installs) | local disk (`KADAI_DATA_DIR`) |
| Backups | managed Postgres backups | scheduled `pg_dump` to `KADAI_DATA_DIR/backups` + optional encrypted cloud upload |
| Web app | served by the API (`@fastify/static`) behind a CDN/ingress | served by the API on the LAN (`http://shop-pc:8080`) |
| Scaling | N stateless API pods + M worker pods | one process runs API + worker (`KADAI_EMBEDDED_WORKER=true`) |

Code branches on mode only through `config.mode` and the helpers `isCloud()` / `isOnPrem()` in
`apps/server/src/config`. Feature checks never look at mode directly — they ask the
**entitlements** service (§7.6), which is backed by the plan in cloud and the license on-prem.

---

## 3. Repository layout

```
.
├─ apps/
│  ├─ server/                 Fastify API + worker + migrations (Node 22, TypeScript, ESM)
│  │  ├─ migrations/          NNNN_name.sql — forward-only, checksummed
│  │  └─ src/
│  │     ├─ config/           env parsing (zod), mode helpers
│  │     ├─ db/               pools, Kysely instances, tenant transactions, migrator, generated types
│  │     ├─ core/             cross-cutting services (errors, auth, rbac, audit, numbering, posting, …)
│  │     ├─ plugins/          Fastify plugins (request context, auth, errors, rate limit, metrics, …)
│  │     ├─ modules/<name>/   one folder per business module (routes, service, jobs, tests)
│  │     ├─ jobs/             pg-boss worker bootstrap + job registry
│  │     ├─ app.ts            buildApp(config) — used by server.ts and tests
│  │     ├─ server.ts         HTTP entrypoint
│  │     └─ worker.ts         background worker entrypoint
│  └─ web/                    React 19 PWA (POS, back office, customer display, platform admin)
│     └─ src/
│        ├─ app/              shell, router, nav, providers
│        ├─ components/ui/    design-system components
│        ├─ lib/              api client, auth store, i18n, formatting, offline db, printing
│        ├─ features/<name>/  one folder per business module (pages, components, api hooks)
│        └─ locales/{ta,en}/  i18n JSON, one namespace file per module
├─ packages/
│  └─ shared/                 isomorphic domain logic + API contracts (zod) used by server & web
├─ deploy/                    Dockerfile, docker-compose (cloud/onprem), k8s, on-prem installers
├─ docs/                      this file, API.md, PRODUCT.md, runbooks
└─ .github/workflows/         CI
```

### 3.1 Module ownership map

Each business module owns exactly these paths; touching another module's paths requires a
deliberate cross-module change.

| Module | Server | Shared contracts | Web | Migration band |
|---|---|---|---|---|
| auth (foundation) | `modules/auth` | `api/auth.ts` | `features/auth` | 0001–0099 |
| identity | `modules/identity` (users, roles, stores, registers, devices, settings, number series, audit log, files) | `api/identity.ts` | `features/settings` | 1100–1199 |
| catalog | `modules/catalog` | `api/catalog.ts` | `features/catalog` | 0100–0199 |
| parties | `modules/parties` (customers, suppliers, doctors, loyalty) | `api/parties.ts` | `features/parties` | 0200–0299 |
| inventory | `modules/inventory` | `api/inventory.ts` | `features/inventory` | 0300–0399 |
| sales | `modules/sales` (POS, invoices, held bills, estimates, credit notes, offline sync, public invoice) | `api/sales.ts` | `features/pos`, `features/sales` | 0400–0499 |
| payments | `modules/payments` (providers, UPI intents, webhooks, receipts/vouchers, reconciliation) | `api/payments.ts` | `features/payments` | 0500–0599 |
| purchases | `modules/purchases` | `api/purchases.ts` | `features/purchases` | 0600–0699 |
| accounting | `modules/accounting` (accounts, journals, expenses, shifts, books, financial statements) | `api/accounting.ts` | `features/accounting` | 0700–0799 |
| reports | `modules/reports` (dashboard, sales/stock/party reports, GST returns, H1 register) | `api/reports.ts` | `features/reports`, `features/dashboard` | 0800–0899 |
| notifications | `modules/notifications` | `api/notifications.ts` | `features/notifications` | 0900–0999 |
| platform | `modules/platform` (plans, subscriptions, SaaS billing, platform admin, license, backups, API keys, system info) | `api/platform.ts` | `features/platform`, `features/billing`, `features/system` | 1000–1099 |

Foundation-owned (shared by everyone, change carefully, never break signatures):
`apps/server/src/{config,db,core,plugins,jobs,app.ts,server.ts,worker.ts}`, `modules/index.ts`,
`packages/shared/src/*` except `api/<module>.ts`, `apps/web/src/{app,components,lib}`.
Cross-module registries are pre-wired: `apps/server/src/modules/index.ts`,
`apps/server/src/jobs/registry.ts`, `apps/web/src/app/routes.tsx`, `apps/web/src/app/nav.ts`.

---

## 4. Technology

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 LTS, TypeScript 5.9 strict, ESM | one language end-to-end; shared domain code |
| HTTP | Fastify 5 + `fastify-type-provider-zod` | fast, schema-first, OpenAPI generation |
| Validation / contracts | Zod 4 in `@kadai/shared` | same schemas validate API input and web forms |
| Database | PostgreSQL 16 | RLS, `NULLS NOT DISTINCT`, LISTEN/NOTIFY, trusted extensions |
| Query builder | Kysely 0.28 (types generated by `kysely-codegen`) | type-safe SQL without an ORM's magic |
| Jobs | pg-boss 10 (Postgres-backed) | no Redis required on-prem; exactly-once-ish with retries |
| Cache / rate-limit store | in-memory, optional Redis in cloud (`REDIS_URL`) | |
| Auth | `jose` (JWT HS256), `@node-rs/argon2` (argon2id) | |
| Web | React 19, Vite 7, React Router 7, TanStack Query 5, Tailwind CSS 4, Radix primitives | |
| Forms | react-hook-form + zod resolver | |
| i18n | i18next + react-i18next (ta default, en) | |
| Offline | Dexie (IndexedDB) + vite-plugin-pwa (Workbox) | |
| Charts | Recharts | |
| Tests | Vitest (unit + integration against real Postgres), Testing Library, Playwright (e2e) | |
| Lint/format | ESLint 9 flat config + typescript-eslint, Prettier | |
| Package manager | pnpm workspaces | |

---

## 5. Data conventions (apply everywhere: DB, API, UI)

* **IDs** — UUID v7 generated by the application (`newId()` from `@kadai/shared`), so offline
  POS devices can create ids and retries are idempotent. DB default `gen_random_uuid()` is only a
  fallback.
* **Money** — `bigint` paise, suffix `_paise` (`total_paise: 11800` = ₹118.00). Never floats.
  Format only at the edge (`formatINR()` → `₹1,23,456.50`, Indian digit grouping).
* **Quantity** — `bigint` milli base-units, suffix `_milli` (`qty_milli: 1500` = 1.5 kg).
  Base unit = the product's `unit`. Pieces are `1000` per piece.
* **Pack pricing** — product/batch prices are **per pack of `pack_size` base units**.
  `pack_size` is 1 except e.g. pharmacy strips (unit `TAB`, pack 10, MRP per strip).
  Amount = `round(price_paise × qty_milli / (pack_size × 1000))` → `amountForQty()` in shared.
* **Rates** — integer basis points, suffix `_bp` (18% → `1800`, 0.25% → `25`).
* **Rounding** — round-half-away-from-zero on integer arithmetic only (`roundDiv()` in shared).
* **Dates** — business dates are `YYYY-MM-DD` strings in the tenant timezone (`Asia/Kolkata`);
  instants are ISO-8601 timestamps with offset (`timestamptz`). `pg` is configured to return
  `date` as string and `int8` as JS number (safe: < 2^53 paise).
* **Financial year** — April→March by default (`tenants.fy_start_month`). Label `2026-27`,
  short form `2627` (`fyOf(date)`, `fyShort()` in shared).
* **JSON naming** — `snake_case` for every API field (request and response) and DB column.
  TypeScript variables stay camelCase; data objects keep snake_case keys. No mapping layers.
* **Phones** — stored E.164 (`+919876543210`); `normalizeIndianPhone()` accepts 10-digit input.
* **Addresses** — `address` jsonb `{line1, line2, city, district, state_code, pincode}` (`AddressSchema`
  in `@kadai/shared/api/common`; `state_code` is the 2-digit GST state code).
* **Enums** — lower_snake strings checked in SQL and mirrored as `z.enum` in shared.
* **Soft delete** — master data uses `is_active=false`; financial documents are never deleted,
  only cancelled (with a reversal) — drafts may be deleted.

---

## 6. Database

### 6.1 Roles & pools

| Pool | DB role | RLS | Used for |
|---|---|---|---|
| `appDb` | `kadai_app` (`DATABASE_URL`) | **enforced** | every tenant-scoped request & job |
| `systemDb` | `kadai_owner` (`DATABASE_SYSTEM_URL`) | bypassed (table owner) | migrations, login/user lookup across tenants, signup/onboarding, webhook routing, job fan-out across tenants, platform admin |

`systemDb` usage is restricted to `core/` and the explicitly listed flows; module code that
needs it must justify it in a comment. In dev a single URL may be used for both (warning logged).

### 6.2 Tenant transactions

```ts
// apps/server/src/db/tenant.ts
await withTenant(appDb, ctx, async (tx) => { ... })  // BEGIN; set_config('app.tenant_id', ctx.tenantId, true);
                                                     //        set_config('app.user_id',   ctx.userId,   true); ... COMMIT
```

* Each request handler that touches tenant data runs inside **one** `withTenant` transaction
  (`req.tx(fn)` helper on the request). Services receive `(tx, ctx, input)` and never open their
  own transactions; this keeps posting (stock + journal + payments) atomic.
* `SET LOCAL`-style config means a pooled connection can never leak tenant context.
* Policies: `tenant_id = current_tenant_id()` for USING and WITH CHECK (generic, applied by
  `kadai_ensure_conventions()` after every migration batch). No tenant context → zero rows.

### 6.3 Integrity rules baked into the schema

* `UNIQUE (tenant_id, id)` on every tenant table + composite FKs → no cross-tenant references.
* Append-only (trigger `forbid_mutation` + revoked grants): `audit_logs`, `stock_movements`,
  `journal_entries`, `journal_lines`, `loyalty_ledger`.
* Journal entries must balance — deferred constraint trigger checks at COMMIT.
* Document totals: `total = taxable + cgst + sgst + igst + cess (+ round_off)` CHECKs; IGST xor
  CGST/SGST by `is_interstate`.
* One open shift per register; one live subscription per tenant; one default payment provider
  per store; supplier invoice number unique per supplier per FY.

### 6.4 Migrations

* Plain SQL files `apps/server/migrations/NNNN_description.sql`, applied in lexical order by
  `pnpm --filter @kadai/server db:migrate` (also on boot when `KADAI_MIGRATE_ON_BOOT=true`).
* Runner: advisory lock → each pending file in its own transaction → record name + sha256 in
  `schema_migrations` → `kadai_ensure_conventions()` → `kadai_apply_grants(<app role>)`.
  Editing an applied file is detected (checksum mismatch → refuse to start).
* Pending files that sort before already-applied ones are applied with a warning (parallel module
  development). Each module owns a number band (§3.1).
* After changing schema run `pnpm --filter @kadai/server db:types` to regenerate
  `src/db/schema.generated.ts` (kysely-codegen). Never hand-edit the generated file.

### 6.5 Query style

* Kysely for everything; `sql` template tag for window functions/CTEs. Always filter by
  `tenant_id` explicitly too (defence in depth + index usage) even though RLS enforces it.
* Lists: `limit` (default 50, max 200) + `offset`, return `total` with `count(*) over()` or a
  separate count. Search uses `ILIKE`/`pg_trgm` on `search_text` columns.
* Row locks: `forUpdate()` on documents being posted/cancelled, number series rows, stock rows.

---

## 7. Server architecture

### 7.1 App factory & plugins

`buildApp(config, deps?)` returns a configured Fastify instance (used by `server.ts` and tests via
`app.inject`). Registration order:

1. `requestContext` — request id (`x-request-id` in/out), logger child, timing.
2. security — `@fastify/helmet`, `@fastify/cors` (cloud: allow-list), `@fastify/cookie`,
   `@fastify/rate-limit` (global + stricter on auth/OTP/webhooks).
3. `errorHandler` — maps `AppError`, Zod errors, PG errors (unique → 409, FK → 422,
   check → 422, RLS → 404/403) to the error envelope; never leaks stack traces in production.
4. `auth` — parses `Authorization: Bearer <jwt>` or `X-Api-Key`; populates `req.auth`.
5. `metrics` (`/metrics`, prom-client), `health` (`/health/live`, `/health/ready`).
6. `swagger` (`/api/docs`, non-production or when `KADAI_API_DOCS=true`).
7. Business modules under `/api/v1` (`modules/index.ts`), webhooks under `/webhooks`,
   public pages under `/public/v1`.
8. Static web app (`apps/web/dist`) with SPA fallback (when `KADAI_SERVE_WEB=true`).

### 7.2 Request context

```ts
interface RequestContext {
  requestId: string
  tenantId: string          // always set for tenant routes
  userId: string | null     // null for API keys
  membershipId: string | null
  sessionId: string | null             // auth_sessions.id (null for API keys / jobs)
  apiKeyId: string | null              // api_keys.id for X-Api-Key requests
  roleCode: string                     // 'api_key' / 'system' for non-user actors
  permissions: ReadonlySet<Permission>
  storeIds: readonly string[] | null   // null = all stores
  deviceId: string | null
  registerId: string | null            // from trusted device
  locale: 'ta' | 'en'
  ip: string; userAgent: string
  authMethods: readonly ('password' | 'otp' | 'pin' | 'api' | 'system')[]
}
```

Route helpers (in `core/http.ts`):

```ts
app.post('/products', {
  schema: { body: ProductCreateSchema, response: { 201: dataOf(ProductSchema) } },
  preHandler: [requirePermission('catalog.write'), requireFeature('catalog')],
}, async (req, reply) => {
  const product = await req.tx((tx) => catalog.createProduct(tx, req.ctx, req.body))
  return reply.code(201).send({ data: product })
})
```

* `requireAuth` (default for `/api/v1`, except routes marked `config: { public: true }`).
* `requirePermission(...perms)` — any-of; 403 `FORBIDDEN`.
* `requireFeature(feature)` — 402 `FEATURE_NOT_IN_PLAN` with `{feature, plan}` details.
* `requireStoreAccess(storeId)` — membership store scoping (403).
* `assertWithinLimit(tx, ctx, 'products')` — plan limits (402 `PLAN_LIMIT_REACHED`).

### 7.3 API conventions

* Base path `/api/v1`; JSON; snake_case.
* Success envelope: single → `{ "data": {...} }`; list → `{ "data": [...], "page": { "limit", "offset", "total" } }`.
* Error envelope: `{ "error": { "code": "VALIDATION_ERROR", "message": "…", "details": {...}, "request_id": "…" } }`.
  Codes: `VALIDATION_ERROR`(400) `UNAUTHENTICATED`(401) `FEATURE_NOT_IN_PLAN`/`PLAN_LIMIT_REACHED`(402)
  `FORBIDDEN`(403) `NOT_FOUND`(404) `CONFLICT`/`DUPLICATE`(409) `UNPROCESSABLE`/`INSUFFICIENT_STOCK`/
  `CREDIT_LIMIT_EXCEEDED`/`RX_REQUIRED`/`EXPIRED_BATCH`(422) `RATE_LIMITED`(429) `INTERNAL`(500)
  `PROVIDER_ERROR`(502). Auth/flow codes: `OTP_INVALID`/`OTP_EXPIRED`(400) `INVALID_CREDENTIALS`/
  `SESSION_REVOKED`(401) `TENANT_SUSPENDED`/`DEVICE_NOT_TRUSTED`/`LICENSE_INVALID`(403)
  `IDEMPOTENCY_MISMATCH`/`IDEMPOTENCY_IN_PROGRESS`/`STALE_WRITE`/`SETUP_ALREADY_DONE`/
  `NUMBER_SERIES_EXHAUSTED`(409) `ACCOUNT_LOCKED`/`PIN_LOCKED`(423) — the full catalogue with
  statuses and ta/en texts is `@kadai/shared/errors.ts`. `message` is English; the web maps `code` →
  localized text.
* **Idempotency** — every POST that creates a financial document or payment accepts
  `Idempotency-Key` (or a body `client_ref`). Same key + same body → same response; same key +
  different body → 409 `IDEMPOTENCY_MISMATCH`. Implemented in `core/idempotency.ts`.
* **Concurrency** — mutable master records return `updated_at`; PATCH may send
  `if_updated_at` → 409 `STALE_WRITE` on mismatch.
* Filters as query params (`?q=&status=&from=2026-10-01&to=2026-10-31&store_id=`), sorting
  `?sort=-created_at`. CSV exports: `?format=csv` on report endpoints.
* All request/response schemas are Zod in `@kadai/shared/api/<module>` so the web client gets
  identical types (`z.infer`).
* **Route catalogues** — each contract file exports `<module>Routes = defineRoutes({...})`
  (`api/common.ts`): one entry per endpoint with `method`, `path` (relative to the scope prefix
  `/api/v1`, `/public/v1` or `/webhooks`), `permission`, `feature`, `mode`, `idempotent`, and the
  `params`/`query`/`body`/`response` schemas (`response` is the complete body, i.e. the envelope:
  `dataOf(X)` / `listOf(X)`). The server registers each route from its definition with
  `route(app, def, handler)` (`core/http.ts`: schemas + permission/feature/mode guards applied
  automatically) and the web calls it through a
  typed client (`routeUrl()`, `RouteBody<R>`, `RouteResponse<R>`), so paths and payloads cannot
  drift. docs/API.md is the human-readable index of the same catalogue.

### 7.4 Authentication

* **Password login** (`POST /api/v1/auth/login`): phone or email + password (argon2id,
  `m=19456,t=2,p=1`). 5 failures → 15-minute lock (`users.locked_until`).
* **OTP login / signup / reset** (`/auth/otp/request`, `/auth/otp/verify`): 6-digit, 5-minute
  TTL, hashed, 5 attempts, per-phone and per-IP rate limits. SMS via the notifications provider
  (DLT template). In dev the code is logged.
* **Tokens** — access JWT (15 min, HS256, claims `sub`, `tid`, `mid`, `sid`, `did`, `amr`),
  refresh token (opaque 256-bit, stored as sha256 in `auth_sessions`, 30 days, rotation with
  reuse detection by `family_id`: reuse revokes the whole family). Web: refresh token in an
  httpOnly `SameSite=Strict` cookie `kadai_rt` scoped to `/api/v1/auth` (Secure when
  `PUBLIC_BASE_URL` is https); access token in memory only. Non-browser clients send the header
  `X-Kadai-Token-Delivery: body` to get `refresh_token` in the body (no cookie) and refresh with
  a body `refresh_token` (answered in the body). Cookie-based refresh/logout require
  `X-Requested-With: kadai`. Logout also works with only the refresh cookie (expired access token).
* OTP requests for login / reset answer identically for unknown numbers (no SMS is sent). A reset
  `otp_token` is single use (refused once the password changed after its OTP was verified); a
  reset revokes every session, a change every session except the current login. Signing in
  accepts pending (`invited`) memberships. Signup requires a signup `otp_token` whenever a real
  SMS provider is configured.
* **Tenant selection** — a user with exactly one active membership gets a tenant-scoped session;
  with several, a tenant-less token and calls `POST /auth/select-tenant`, which rotates the
  login's live session into a tenant-scoped one (same refresh family).
* **Trusted devices & PIN** — a manager registers a counter PC (`POST /api/v1/devices`) → device
  secret stored in the browser. Cashiers then switch with a 4–6 digit PIN
  (`POST /auth/pin-login {device_id, device_secret, user_id, pin}`); 5 wrong PINs lock the
  membership PIN for 15 minutes. Device binds the session to a register (offline numbering).
* **API keys** (`X-Api-Key: kd_live_<prefix>_<secret>`) for enterprise integrations, hashed,
  scoped permissions + stores, feature `api_access`.
* Permissions are resolved per request from the membership's role (cached 30 s in-process,
  invalidated on role/membership change via `NOTIFY kadai_cache`).

### 7.5 Authorization (RBAC)

Permission codes live in `@kadai/shared/permissions.ts` (single source). System roles are seeded
per tenant: `owner` (all), `manager`, `cashier`, `accountant`, `inventory_clerk`, `pharmacist`.
Custom roles require feature `custom_roles`. The owner role cannot be edited or removed from the
last owner.

### 7.6 Entitlements & limits

`core/entitlements.ts` → `getEntitlements(ctx)` returns `{ plan_code, features: Set, limits }`
from the subscription/plan (cloud) or license (on-prem), cached per tenant. Limits:
`stores`, `users`, `registers`, `products`, `invoices_per_month` (counted in `usage_counters`
inside the invoice transaction). Suspended tenants → 403 `TENANT_SUSPENDED` on every route except
billing/self-service.

### 7.7 Audit

`audit(tx, ctx, { action, entity_type, entity_id, summary, changes })` inside the business
transaction. Mandatory for: logins, role/permission changes, settings changes, price changes,
invoice/credit-note/purchase cancellation, stock adjustments, manual journal entries, payment
provider changes, discount/price overrides beyond limits, data exports.

### 7.8 Observability

* pino JSON logs (`LOG_LEVEL`), request id on every line, redaction of `authorization`,
  `cookie`, `password`, `pin`, `credentials`, `otp`.
* prom-client metrics: HTTP histograms by route, DB pool stats, job counts/failures, invoices
  created, payment intent outcomes.
* `/health/live` (process), `/health/ready` (DB reachable, migrations current, worker heartbeat).
* Optional OpenTelemetry export (`OTEL_EXPORTER_OTLP_ENDPOINT`).

---

## 8. Core domain services (foundation contracts)

All live in `apps/server/src/core/` and take `(tx, ctx, input)`. They are the **only** writers
of their tables.

### 8.1 Numbering — `core/numbering.ts`

```ts
nextNumber(tx, ctx, { docType, storeId, registerId?, date }): Promise<{ number: string; fy: string; seq: number }>
peekSeries(tx, ctx, {...}): Promise<{ prefix, next_number, padding, fy }>
acceptOfflineNumber(tx, ctx, { docType, storeId, registerId, date, number }): Promise<{ number, fy, renumbered: boolean }>
```

* Series row is created on first use for the FY with the default prefix template and locked
  `FOR UPDATE` → gapless within a transaction. Only `sales_invoice` / `bill_of_supply` use a
  per-register series (when `registerId` is passed); every other doc type is numbered per store.
  `peekSeries` neither locks nor creates (unused series report their defaults).
* Default prefix templates (`{store}` = store code, `{reg}` = register code, `{fy}` = `2627`):

  | doc_type | template | example |
  |---|---|---|
  | sales_invoice (POS register) | `{store}-{reg}/{fy}/` | `S1-A/2627/00042` |
  | sales_invoice (back office) | `{store}/{fy}/` | `S1/2627/00042` |
  | bill_of_supply (register / back office) | `{store}-{reg}B/{fy}/` / `{store}B/{fy}/` | `S1-AB/2627/00042` |
  | credit_note | `CN{store}/{fy}/` | `CNS1/2627/00007` |
  | estimate / sales_order | `EST{store}/{fy}/` / `SO{store}/{fy}/` | |
  | receipt / payment_voucher | `RC{store}/{fy}/` / `PV{store}/{fy}/` | |
  | purchase_order / purchase_bill / debit_note | `PO{store}/{fy}/` / `GRN{store}/{fy}/` / `DN{store}/{fy}/` | |
  | stock_adjustment / stock_transfer / expense / journal | `ADJ…` / `TR…` / `EXP…` / `JV…` | |

* The `-` between store and register codes (both `[A-Z0-9]`) keeps register series from
  colliding with another store's back-office series (store `S1` + register `A` vs store `S1A`).
* GST rule: invoice numbers ≤ 16 characters, only `A-Z 0-9 / -` — applied to documents issued
  under GST (invoices, bills of supply, credit/debit notes, receipt/payment vouchers, stock
  transfers); internal documents (estimates, orders, GRNs, adjustments, expenses, journals) allow
  32. Padding (default 5) shrinks (min 3) to fit; otherwise `CONFLICT` with a message to shorten
  the store/register code. A series whose numbers outgrow the limit fails with
  `NUMBER_SERIES_EXHAUSTED` (409).
* `acceptOfflineNumber` keeps the offline number only when it equals the series' next number,
  else issues the next one (`renumbered: true`, `offline_number` returned for the audit).

### 8.2 Inventory posting — `core/inventory.ts`

```ts
postStock(tx, ctx, movements: Array<{
  store_id, product_id, batch_id?: string | null,
  qty_milli: number,                // signed
  movement_type: StockMovementType,
  unit_cost_paise?: number | null,  // per pack, required for inbound movements
  ref_type?, ref_id?, ref_line_id?, reason?,
}>, opts?: { allowNegative?: boolean }): Promise<PostedMovement[]>   // returns balance_after & cost used
getAvailable(tx, ctx, { store_id, product_id, batch_id? }): Promise<number>
pickBatchesFefo(tx, ctx, { store_id, product_id, qty_milli, today, allowNegative? }): Promise<Array<{ batch_id, qty_milli, batch_no, expiry_date }>>
```

* Locks the `stock_levels` rows (`INSERT … ON CONFLICT DO NOTHING` then `SELECT … FOR UPDATE`) in
  a deterministic order (product_id, batch_id) to avoid deadlocks.
* Inbound movements update moving-average cost:
  `new_avg = (old_qty × old_avg + in_qty × in_cost) / (old_qty + in_qty)` (when old_qty ≤ 0 →
  `in_cost`). `unit_cost_paise` is required for `opening` / `purchase` / `transfer_in`; other
  inbound movements default to the row's cost. Outbound movements use the current average and
  return it as COGS. For batch-tracked products the `stock_levels` row is per batch, so its average
  *is* the batch's (landed) purchase price; `batches.purchase_price_paise` (then
  `products.purchase_price_paise`) is used for a row without cost history.
* Each result carries `movement_id`, `unit_cost_paise`, `cost_paise` (|value|), `value_paise`
  (signed), `balance_after_milli`, `avg_cost_after_paise`, `skipped` — in input order. Movement
  signs are validated per type (e.g. `sale` < 0, `purchase` > 0; `adjustment`/`stock_take` ±).
  Batch-tracked products require `batch_id`; others must not pass one.
* `pickBatchesFefo` orders by expiry (FIFO by batch creation when `settings.inventory.fefo` is
  off), skips expired batches when `settings.inventory.block_expired_sale` (a batch is sellable on
  its expiry date), puts a shortfall on the last batch when negatives are allowed (else
  `INSUFFICIENT_STOCK`), and returns one unbatched pick for non-batch products. It does not lock;
  `postStock` re-checks under lock.
* Negative stock: allowed when `settings.inventory.allow_negative_stock` (default true for small
  shops) or `opts.allowNegative`; otherwise 422 `INSUFFICIENT_STOCK` with product details.
* Products with `track_inventory=false` (services) are ignored.

### 8.3 Ledger posting — `core/ledger.ts`

```ts
postJournal(tx, ctx, {
  entry_date, store_id?, source_type, source_id?, narration?,
  lines: Array<{ account: AccountRef, debit_paise?: number, credit_paise?: number,
                 party?: { type: 'customer' | 'supplier', id: string }, memo?: string }>,
}): Promise<{ entry_id: string | null }>
reverseJournal(tx, ctx, { source_type, source_id, entry_date, narration? }): Promise<{ entry_id: string | null; entry_ids: string[] }>
systemAccountId(tx, ctx, subtype: SystemAccountSubtype): Promise<string>   // cached per tx
```

* `AccountRef` = `{ subtype: 'cash' }` or `{ id: '…' }` (same tenant, active). Zero-amount lines
  are dropped; lines are merged per (account, party, store, side); the entry must balance or it
  throws before hitting the DB. An entry whose lines are all zero is not written
  (`{ entry_id: null }`). Lines may override the entry's `store_id` (stock transfers).
* `reverseJournal` mirrors every not-yet-reversed entry of the source (`{ entry_id, entry_ids }`);
  a source with nothing posted returns `entry_id: null`, an already reversed one is `CONFLICT`.
* **Party balances**: for lines on `receivable` with a customer party,
  `customers.balance_paise += debit − credit`; on `payable` with a supplier party,
  `suppliers.balance_paise += credit − debit`. This is the only place party balances change.
  A party on any other account (e.g. the customer on `customer_advance` for store credit) is an
  annotation; a supplier on `receivable` or a customer on `payable` is rejected.
* System chart of accounts is seeded per tenant (`@kadai/shared/accounting.ts` → `DEFAULT_CHART`):

  | code | subtype | name |
  |---|---|---|
  | 1100 | cash | Cash in hand |
  | 1200 | bank | Bank account |
  | 1210 | upi_clearing | UPI / PSP clearing |
  | 1220 | card_clearing | Card clearing |
  | 1300 | receivable | Accounts receivable (Sundry debtors) |
  | 1400 | inventory | Stock in hand |
  | 1510/1520/1530/1540 | input_cgst / input_sgst / input_igst / input_cess | Input GST |
  | 2100 | payable | Accounts payable (Sundry creditors) |
  | 2210/2220/2230/2240 | output_cgst / output_sgst / output_igst / output_cess | Output GST |
  | 2300 | customer_advance | Store credit / advances |
  | 3100 | capital | Owner's capital |
  | 3200 | drawings | Owner's drawings |
  | 3900 | opening_balance | Opening balance equity |
  | 4100 | sales | Sales |
  | 4200 | sales_returns | Sales returns |
  | 4300 | other_income | Other income |
  | 4400 | round_off | Round off |
  | 4500 | discount_received | Discount received |
  | 5100 | cogs | Cost of goods sold |
  | 5200 | inventory_adjustment | Stock adjustment / shrinkage |
  | 5210 | inventory_writeoff | Expired / damaged stock written off |
  | 5300–5390 | (expense) | Rent, Electricity, Salaries, Transport, Repairs, Telephone & internet, Bank & PSP charges, Packing, Miscellaneous |
  | 5360 | bank_charges | Bank & PSP charges (also the posting account for PSP fees, e.g. `payment_intents.fee_paise`) |
  | 5400 | discount_allowed | Discount allowed |

### 8.4 Payments — `core/payments.ts`

```ts
recordPayment(tx, ctx, {
  direction: 'in' | 'out', store_id, register_id?, shift_id?, method, amount_paise,
  payment_date, party?: { type, id }, reference?, payment_intent_id?, account_id?,
  allocations: Array<{ target_type, target_id, amount_paise }>, notes?, client_ref?, number?: boolean,
}): Promise<Payment>
cancelPayment(tx, ctx, { payment_id, reason, date? }): Promise<{ reversal_entry_id: string | null }>
```

* Resolves the ledger account by method (`cash`→cash, `upi`→provider settlement account or
  bank, `card`→card_clearing, `bank_transfer`/`cheque`/`other`→bank, `wallet`→upi_clearing,
  `store_credit`→customer_advance) unless `account_id` given. A payment consuming a payment
  intent uses the provider account's `settlement_account_id`, else `upi_clearing` for PSP
  providers (razorpay, cashfree, phonepe, paytm, mock), else bank (`upi_vpa`). The intent must be
  `paid`, unused, same store and amount; it is linked both ways (`payments.payment_intent_id`,
  `payment_intents.payment_id`).
* Posts the journal: `in` = Dr account, Cr counter; `out` = Dr counter, Cr account; counter =
  payable(supplier) for a supplier party, else receivable(customer or walk-in). `store_credit`
  lines on customer_advance carry the customer: `out` issues store credit (credit-note
  settlement), `in` redeems it — never more than the customer's customer_advance balance.
* Applies allocations (rows locked, over-allocation → 422): `in` → `sales_invoice`
  (`paid_paise`, `due_paise`, `payment_status`), `debit_note`, `opening_balance`; `out` →
  `purchase_bill` (same columns), `credit_note` (`settled_paise`), `expense` (on credit),
  `opening_balance`. The remainder stays in `unallocated_paise` (advance). `number: true` takes a
  `receipt` / `payment_voucher` number; `client_ref` makes it idempotent (same request → the same
  payment, different → `IDEMPOTENCY_MISMATCH`).
* `cancelPayment` reverses the journal, restores the documents, releases the intent (paid but
  unused again), marks the payment cancelled and audits. Allocation rows of cancelled payments
  are kept for history: sums over `payment_allocations` must join payments with
  `status = 'completed'`.

### 8.5 Other core helpers

`core/settings.ts` (typed tenant settings with defaults from shared), `core/entitlements.ts`,
`core/audit.ts`, `core/idempotency.ts`, `core/crypto.ts` (AES-256-GCM envelope with key ids for
provider credentials; `KADAI_ENCRYPTION_KEYS`), `core/files.ts` (local/S3 storage),
`core/events.ts` (LISTEN/NOTIFY fan-out for SSE), `core/jobs.ts` (enqueue helpers),
`core/onboarding.ts` (create tenant + owner + store + register + roles + chart of accounts +
vertical presets).

---

## 9. GST & pricing engine (`@kadai/shared/gst.ts`, `pricing.ts`)

The **same** functions price a cart in the POS (offline too) and on the server. The server is
authoritative: it recomputes every document from inputs and rejects/flags mismatches.

### 9.1 Line computation

Inputs: `unit_price_paise` (per pack), `qty_milli`, `pack_size`, `price_includes_tax`,
`gst_rate_bp`, `cess_rate_bp`, `discount_bp`, `discount_paise` (flat), `allocated_bill_discount_paise`,
`is_interstate`, `tax_mode` (`'regular' | 'composition' | 'unregistered'`).

```
gross       = roundDiv(unit_price × qty_milli, pack_size × 1000)
item_disc   = min(gross, discount_paise + roundDiv(gross × discount_bp, 10000))
net         = gross − item_disc − allocated_bill_discount        (≥ 0)
if tax_mode ≠ regular or rate = 0:  taxable = net; taxes = 0
elif inclusive:  taxable = roundDiv(net × 10000, 10000 + gst_bp + cess_bp)
                 cess    = roundDiv(taxable × cess_bp, 10000);  gst = net − taxable − cess
else:            taxable = net; cess = roundDiv(taxable × cess_bp, 10000); gst = roundDiv(taxable × gst_bp, 10000)
interstate → igst = gst;  else sgst = floor(gst / 2), cgst = gst − sgst
line_total  = taxable + gst + cess
```

* **Price-slab GST** (`tax_slab_rules`, e.g. apparel/footwear: ≤ ₹2,500 per piece → 5%, above → 18%):
  for each slab ascending, compute the per-piece taxable value at that slab's rate (net ÷ pieces);
  the first slab whose `max_unit_value_paise` is ≥ that value (or null) applies. Seeded rules are
  editable data — GST rates change, code doesn't.
* Bill discount (bp or paise) is allocated pro-rata to lines by `gross − item_disc` using the
  largest-remainder method so allocations sum exactly.
* Invoice totals are sums of lines; `round_off` brings `taxable + taxes` to the nearest rupee when
  `settings.invoice.round_off = 'nearest_rupee'` (|round_off| ≤ 50 paise).
* Allowed GST rates (bp): 0, 10, 25, 100, 150, 300, 500, 600, 750, 1200, 1800, 2800, 4000.
  Defaults reflect the GST 2.0 structure (5% / 18% / 40% plus special rates) but every product
  carries its own rate.

### 9.2 Document type & place of supply

* Tenant `gst_scheme='regular'` → `tax_invoice`. `composition` / `unregistered` →
  `bill_of_supply`, no tax charged; composition invoices print *"Composition taxable person, not
  eligible to collect tax on supplies"*.
* `place_of_supply` defaults to the store's state (over-the-counter supply). Back-office invoices
  may set it explicitly (e.g. goods delivered to an inter-state customer). `is_interstate =
  place_of_supply ≠ store.state_code`.
* B2B when `customer_gstin` is present (validated with the GSTIN checksum, `gstin.ts`).
* GSTR-1 buckets: B2B (has GSTIN), B2CL (inter-state, no GSTIN, invoice value > ₹1,00,000),
  B2CS (everything else), CDNR/CDNUR for credit notes, HSN summary, document summary.

### 9.3 Amount in words

`amountInWords(paise, 'en' | 'ta')` using the Indian system (thousand, lakh, crore):
*"Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Fifty Paise Only"* /
*"ரூபாய் ஒரு லட்சத்து இருபத்து மூன்றாயிரத்து நானூற்று ஐம்பத்து ஆறு மற்றும் ஐம்பது பைசா மட்டும்"*.

---

## 10. Posting rules (what each document does)

| Document (event) | Stock (`postStock`) | Journal (`postJournal`) |
|---|---|---|
| Sales invoice completed | `sale` −qty per line (batch per line; FEFO auto-pick) | Dr receivable(customer?) total; Cr sales (taxable); Cr output_cgst/sgst/igst/cess; Dr/Cr round_off. Dr cogs, Cr inventory (cost). Then tenders via `recordPayment` (Dr cash/bank/upi_clearing, Cr receivable). |
| Sales invoice cancelled (same day/any day with permission) | `sale_cancel` +qty at original cost | `reverseJournal` of the sale + cancel its payments (refund recorded if money returned) |
| Credit note (return) | `sale_return` +qty for restocked lines (at original unit cost) | Dr sales_returns (taxable); Dr output taxes; Cr receivable(customer) total; Dr inventory, Cr cogs (restocked cost). Settlement: cash/upi → `recordPayment(out)`; `adjust_due` → nothing more; `store_credit` → leaves a credit balance |
| Purchase bill posted | `purchase` +(qty+free) at landed cost; batches created/updated | Dr inventory (taxable + other charges); Dr input taxes (if itc_eligible, else into inventory); Cr payable(supplier) total; round_off |
| Purchase bill cancelled | `purchase_cancel` −qty | reverse |
| Debit note (purchase return) | `purchase_return` −qty | Dr payable(supplier) total; Cr inventory (taxable); Cr input taxes |
| Supplier payment | — | Dr payable(supplier), Cr cash/bank (via `recordPayment(out)`) |
| Customer receipt | — | Dr cash/bank/upi, Cr receivable(customer) (via `recordPayment(in)`) |
| Expense | — | Dr expense account (+ input tax if ITC eligible); Cr cash/bank or payable(supplier) |
| Stock adjustment / write-off | ±qty (`adjustment`/`stock_take`/`damage`/`expiry_writeoff`) | loss: Dr inventory_adjustment or inventory_writeoff, Cr inventory; gain: reverse |
| Opening stock | `opening` +qty | Dr inventory, Cr opening_balance |
| Stock transfer dispatched/received | `transfer_out` at source / `transfer_in` at destination | Dr inventory(store=to), Cr inventory(store=from) at cost (on receive) |
| Shift pay-in / pay-out | — | Dr/Cr cash vs. chosen account (drawings, expense, bank deposit) |
| Customer/supplier opening balance | — | Dr receivable / Cr payable vs opening_balance |

Every posting happens in the same DB transaction as the document change.

---

## 11. Payments & UPI

### 11.1 Providers (`modules/payments/providers/*`)

```ts
interface PaymentProvider {
  code: 'upi_vpa' | 'razorpay' | 'mock'      // cashfree/phonepe/paytm adapters follow the same interface
  capabilities: { dynamicQr: boolean; links: boolean; webhooks: boolean; polling: boolean; refunds: boolean }
  createQr(acct, intent): Promise<{ upi_uri?: string; image_url?: string; provider_ref?: string; expires_at?: Date }>
  createLink(acct, intent, customer): Promise<{ short_url: string; provider_ref: string }>
  fetchStatus(acct, intent): Promise<NormalizedStatus>      // polling (on-prem, missed webhooks)
  verifyWebhook(secret, rawBody: Buffer, headers): boolean
  parseWebhook(body): NormalizedEvent[]
  cancel(acct, intent): Promise<void>
  testCredentials(acct): Promise<void>
}
```

* **`upi_vpa` (default, zero-cost)** — the shop's own UPI ID (`pa`). We generate an NPCI UPI
  intent `upi://pay?pa=<vpa>&pn=<payee>&am=<₹ 2dp>&cu=INR&tn=<note>&tr=<reference_code>&mc=<mcc>`
  (`buildUpiUri()` in shared; values percent-encoded, except `@` in `pa`, kept literal for UPI-app
  compatibility). The POS renders it as a QR (with amount)
  — works offline too. There is no bank callback, so the cashier confirms receipt (soundbox /
  phone) with optional UTR; `confirmation='manual'`, audited.
* **`razorpay`** — dynamic single-use, fixed-amount UPI QR (`POST /v1/payments/qr_codes`,
  `type=upi_qr, usage=single_use, fixed_amount=true`) and Payment Links (`POST /v1/payment_links`)
  for dues collection. Webhooks `qr_code.credited`, `payment_link.paid`, `payment.failed`,
  verified with `X-Razorpay-Signature` = HMAC-SHA256(raw body, webhook secret), deduplicated by
  `x-razorpay-event-id`. Polling: `GET /v1/payments/qr_codes/:id/payments`,
  `GET /v1/payment_links/:id`. QR closed at provider on cancel/expiry.
* **`mock`** — dev/test only (`KADAI_ENABLE_MOCK_PAYMENTS=true`): pays after a delay or via
  `POST /api/v1/payments/intents/:id/mock-pay`.

Credentials (`key_id`, `key_secret`, webhook secret) are encrypted with AES-256-GCM
(`core/crypto.ts`) and never returned by the API (only `key_id` masked).

### 11.2 Intent lifecycle

`created → pending → paid | failed | expired | cancelled`

1. POS asks `POST /api/v1/payments/intents {amount_paise, purpose:'pos_sale', ref_type:'pos_cart', ref_id:<client_ref>, register_id}`.
2. Provider QR/link created; response contains `upi_uri` / `image_url` / `short_url`, `expires_at` (default 10 min).
3. Confirmation arrives by webhook (cloud), polling job (both modes; backoff 3s→30s), or manual confirm.
   Exactly one transition to `paid` (row lock + status check); amount must equal; extra/late
   payments are recorded as unapplied receipts for refund/apply.
4. On `paid`, `NOTIFY kadai_payment_intents` → SSE `GET /api/v1/payments/intents/:id/stream`
   pushes `{status}` to the POS and the customer display.
5. The POS then completes the invoice with tender `{method:'upi', payment_intent_id}`; the sales
   service verifies the intent is `paid`, unused, same tenant/amount, and links it
   (`payments.payment_intent_id`). Paid-but-unused intents (abandoned carts) appear in the
   reconciliation screen to apply to an invoice/customer or refund.

### 11.3 Dues collection (khata)

`POST /api/v1/payments/links {customer_id, amount_paise?}` → link via WhatsApp/SMS
(notifications module). When paid, a receipt is recorded for the customer and allocated FIFO to
their oldest due invoices.

---

## 12. POS & offline

* **Bootstrap** `GET /api/v1/pos/bootstrap?register_id=&since=` returns products (sellable
  fields only), barcodes, store prices, active promotions, tax slab rules, batches with stock &
  expiry (pharmacy), settings, register info, number-series state, payment providers (VPA only),
  and a `cursor` for delta sync. Cached in IndexedDB (Dexie) with the cursor.
* **Pricing** is computed client-side with `@kadai/shared` (identical to the server).
* **Online save** → `POST /api/v1/sales/invoices` with `client_ref` (idempotent).
* **Offline** → invoice gets the next number from the register's series locally (the register's
  series is used by that device only), is printed, and queued in IndexedDB. On reconnect
  `POST /api/v1/pos/sync` uploads queued invoices **in order**; the server accepts the offline
  number when it equals the series' next number (`acceptOfflineNumber`), otherwise assigns the
  next one and returns `renumbered: true` (audited for review). Offline tenders: cash, card,
  static-VPA UPI (manual). Stock is posted at sync time (negative stock allowed for synced
  offline invoices, flagged).
* **Held bills** (`status='held'`) survive refreshes and can be recalled on any register of the
  store.
* **Scale barcodes** — EAN-13 with configurable prefixes (default `21–29`): `PP IIIII VVVVV C`
  (`parseScaleBarcode()` in shared) with value = weight or price per `settings.pos.scale_barcode`
  (`weight_unit_divisor` value units per kg, default 1000 = grams; `price_divisor` value units per
  rupee, default 100 = paise).
* **Customer display** — second window `/pos/display` gets cart + UPI QR via `BroadcastChannel`.
* **Printing** — browser printing with dedicated CSS for 58 mm / 80 mm thermal and A4 GST
  invoice (bilingual). Tamil shaping is handled by the browser (no raw ESC/POS for Tamil).
* **Keyboard map** — F1 help, F2 product search, F3 customer, F4 hold, F5 recall, F6 discount,
  F7 qty, F8 payment, F9 cash exact, F10 UPI QR, F12 save & print, Esc cancel, Ctrl+P reprint.

---

## 13. Vertical behaviour

Vertical = `tenants.business_type`; presets applied by onboarding (categories, tax rules,
settings, sample units). Vertical-specific product attributes are validated by
`@kadai/shared/verticals.ts` (`attributes` JSON).

* **General store / supermarket** — loose items by weight (`decimal_qty`, KG/G/L), scale
  barcodes, case barcodes (`product_barcodes.qty_milli`), MRP vs selling price ("You saved ₹x"),
  promotions (buy X get Y, combo, bill % off), multiple counters, khata (credit) with reminders.
* **Apparel / textiles** — variant matrix (size × colour) as child products, barcode label
  printing per variant, fabric by metre (`M`, decimal qty), price-slab GST rule, alteration
  notes, exchange (return + new sale).
* **Pharmacy** — batch + expiry mandatory (`track_batches`), FEFO, block expired, near-expiry
  alerts, strips/loose tablets via `pack_size` + `allow_loose`, drug schedule (`H`, `H1`, `X`,
  `G`, `OTC`) in `attributes.schedule`, prescription capture (`rx`) required for H/H1/X,
  Schedule H1 register report, generic/composition search & substitutes, drug licence numbers
  on invoice, expiry returns to supplier (debit note).
* **Footwear / electronics / hardware / bakery / stationery** — general features + variants
  (footwear sizes), serial numbers (electronics, `serial_numbers`), weighed items (bakery).

---

## 14. Background jobs (pg-boss)

Registered in `apps/server/src/jobs/registry.ts` from each module's `jobs.ts`
(`export const jobs: JobDefinition[]`). Every handler receives `{ tenant_id, ... }` and runs inside
`withTenant`. Cron jobs fan out per tenant using `systemDb`.

| Job | Schedule | Module |
|---|---|---|
| `payments.poll-intents` | every 15 s | payments |
| `payments.expire-intents` | every 1 min | payments |
| `payments.process-webhook` | on webhook | payments |
| `notifications.send` | on enqueue + every 1 min sweep | notifications |
| `notifications.due-reminders` | daily 10:00 IST | notifications |
| `notifications.daily-summary` | daily 21:30 IST | notifications |
| `inventory.alerts` (low stock / expiry digest) | daily 08:00 IST | inventory |
| `platform.subscription-renewals` | hourly | platform (cloud) |
| `platform.backup` | daily 23:00 local | platform (onprem) |
| `core.cleanup` (idempotency keys, OTPs, sessions) | hourly | foundation |

---

## 15. Notifications

Outbox table `notifications`; providers behind an interface: `log` (dev), `msg91` (SMS with DLT
template ids), `whatsapp_cloud` (Meta WhatsApp Cloud API templates), `smtp` (email). Templates are
code-defined defaults (ta/en) overridable per tenant (`notification_templates`). Invoice sharing
sends the public invoice link `/i/<share_token>` (+ UPI pay link when due).

---

## 16. Web application

* **Routing** — React Router data routers; `app/routes.tsx` composes `features/*/routes.tsx`.
  Route objects carry `handle: { permission?, feature?, title }` for guards and breadcrumbs.
* **State** — server state in TanStack Query (keys `[module, resource, params]`); auth/session in
  a small store (`lib/auth`); POS cart in a reducer + IndexedDB persistence.
* **API client** — `lib/api.ts`: `api.get/post/patch/del<T>(path, body?, {idempotencyKey})`,
  automatic access-token refresh on 401 (single-flight), error → `ApiError{code, message,
  details}`; module hooks in `features/<m>/api.ts`.
* **UI kit** — `components/ui`: Button, IconButton, Input, MoneyInput (₹ with paise), QtyInput
  (unit-aware), Select, Combobox (async search), DatePicker, Dialog, Drawer, Tabs, Table
  (TanStack Table with server pagination), Badge, Card, EmptyState, Skeleton, Toast (sonner),
  ConfirmDialog, PageHeader, FormField, Kbd. Tailwind tokens: primary teal, accent saffron.
* **i18n** — `t('catalog:product.name')`; Tamil default; numbers/currency via `Intl` `en-IN`;
  dates `dd-MM-yyyy`. Fonts: Noto Sans Tamil + Inter (self-hosted via @fontsource).
* **Accessibility** — keyboard reachable, visible focus, labels on inputs, colour contrast AA.
* **Responsive** — POS and key screens usable on 360 px Android phones; tables collapse to cards.
* **PWA** — installable; app shell cached; POS works offline (see §12).

---

## 17. Security checklist

* RLS + composite FKs; app role cannot read `password_hash`, sessions, OTPs, webhook payloads.
* argon2id passwords, PIN hashes, refresh rotation + reuse detection, lockouts.
* Strict CORS in cloud; same-origin cookies; CSRF not applicable to bearer APIs (refresh cookie is
  `SameSite=Strict` + requires `X-Requested-With: kadai` header).
* Rate limits: login 10/min/IP, OTP 3/10 min/phone, webhooks 300/min, global 600/min/user.
* Input validation with Zod on every route; output schemas for public endpoints.
* Secrets only from env/secret store; provider credentials encrypted at rest.
* Audit trail for sensitive actions; platform admin actions in `platform_audit_logs`.
* Dependency audit in CI (`pnpm audit --prod`), container runs as non-root, read-only FS.
* On-prem license verified with an embedded Ed25519 public key; tamper → read-only mode, never
  data loss.

---

## 18. Testing strategy

* **Shared** — exhaustive unit tests for money/GST/pricing/words/GSTIN/UPI/scale barcodes
  (table-driven, property-style checks that totals reconcile).
* **Server** — integration tests per module with Vitest against a real Postgres database
  (`TEST_DATABASE_URL`, migrated in global setup). Each test file creates its own tenant via
  `createTestTenant()` (fixtures in `src/test/`), so files run in parallel without truncation.
  Invariants asserted in posting tests: journal balanced, `Σ stock_movements = stock_levels`,
  party balance = AR/AP ledger balance, invoice totals reconcile.
* **Web** — component tests (Testing Library + MSW) for critical flows; Playwright e2e: signup →
  product → POS sale with UPI (mock provider) → print → return → GST report.
* CI runs lint, typecheck, unit, integration (Postgres service), build, e2e (smoke).

---

## 19. Configuration (env)

| Variable | Default | Notes |
|---|---|---|
| `KADAI_MODE` | `cloud` | `cloud` \| `onprem` |
| `NODE_ENV` | `development` | |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | |
| `DATABASE_URL` | — | runtime role (RLS) |
| `DATABASE_SYSTEM_URL` | = `DATABASE_URL` | owner role |
| `DATABASE_APP_ROLE` | `kadai_app` | role granted by migrator |
| `DATABASE_POOL_MAX` | `20` | |
| `KADAI_MIGRATE_ON_BOOT` | `true` onprem / `false` cloud | |
| `JWT_SECRET` | — | ≥ 32 bytes |
| `KADAI_ENCRYPTION_KEYS` | — | `kid1:base64key,kid2:…` (first = active) |
| `PUBLIC_BASE_URL` | `http://localhost:8080` | links in messages, webhooks |
| `CORS_ORIGINS` | — | comma separated (cloud) |
| `REDIS_URL` | — | optional |
| `KADAI_DATA_DIR` | `./data` | files, backups (onprem) |
| `S3_*` | — | cloud file storage |
| `KADAI_SERVE_WEB` | `true` | serve `apps/web/dist` |
| `KADAI_EMBEDDED_WORKER` | `true` onprem | run worker in API process |
| `KADAI_LICENSE_PUBLIC_KEY` | built-in | override for testing |
| `KADAI_SETUP_TOKEN` | — | on-prem: when set, `POST /setup` must carry it (`setup_token`) |
| `SMS_PROVIDER` / `MSG91_*` | `log` | |
| `WHATSAPP_PROVIDER` / `WHATSAPP_*` | `log` | |
| `RAZORPAY_PLATFORM_*` | — | SaaS billing (cloud) |
| `KADAI_ENABLE_MOCK_PAYMENTS` | `false` | dev/test |
| `LOG_LEVEL` | `info` | |

---

## 20. Local development

```bash
pnpm install
cp .env.example .env            # points at local Postgres roles kadai_owner / kadai_app
pnpm db:migrate                 # apply migrations
pnpm dev                        # server :8080 + web :5173 (proxy /api → :8080)
pnpm test                       # all unit + integration tests
pnpm lint && pnpm typecheck
```
