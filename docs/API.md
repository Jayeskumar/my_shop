# Kadai — HTTP API surface (v1)

Conventions are in [ARCHITECTURE.md §7.3](./ARCHITECTURE.md). All paths below are under
`/api/v1` unless they start with `/webhooks`, `/public` or `/health`. `perm:` is the required
permission (any-of), `feat:` the required plan feature. Request/response Zod schemas live in
`packages/shared/src/api/<module>.ts`; the owning module may refine shapes but must keep the
paths and semantics below (other modules' UIs are built against them).

Legend: **C** create, **L** list (paginated, filterable), **G** get one, **U** partial update
(PATCH), **D** delete/deactivate.

---

## auth (foundation)

| Method & path | Purpose |
|---|---|
| `POST /auth/signup` | cloud only. `{business_name, business_name_ta?, business_type, owner_name, phone, password, email?, state_code, gstin?, gst_scheme?, locale, otp_token?}` → tenant + owner + store `S1` + register `A` + presets; returns session |
| `POST /auth/login` | `{identifier, password}` → session `{access_token, token_type, expires_in, user, memberships[], tenant_id}` (`SessionResponseSchema`) + refresh cookie |
| `POST /auth/otp/request` | `{phone, purpose: login\|signup\|reset_password}` |
| `POST /auth/otp/verify` | `{phone, code, purpose}` → session (login) or `{otp_token}` (signup/reset) |
| `POST /auth/password/reset` | `{otp_token, new_password}` |
| `POST /auth/password/change` | `{current_password, new_password}` (authenticated) |
| `POST /auth/select-tenant` | `{tenant_id}` → session scoped to tenant |
| `POST /auth/refresh` | cookie or `{refresh_token}` → new access token (rotation) |
| `POST /auth/logout` | revoke current session (`{all: true}` for every session) |
| `POST /auth/pin-login` | `{device_id, device_secret, user_id, pin}` → session bound to device/register |
| `GET  /auth/pin-users?device_id=&device_secret=` | users who can PIN-login on a trusted device (names only) |
| `GET  /me` | user, tenant, membership (role, permissions, store_ids), entitlements, settings, stores, registers, mode |
| `GET  /setup/status` · `POST /setup` | on-prem first-run wizard (creates the single tenant + owner); 404 in cloud |

Session endpoints (signup, login, OTP login, select-tenant, refresh, PIN login, setup) return the
`SessionResponse` and set the refresh token as the httpOnly cookie `kadai_rt`
(`Path=/api/v1/auth; SameSite=Strict`); send `X-Kadai-Token-Delivery: body` to receive
`refresh_token` in the body instead. Cookie refresh/logout need `X-Requested-With: kadai`.
`password/reset`, `password/change` and `logout` answer 204. Lockouts: 5 wrong passwords → 423
`ACCOUNT_LOCKED`, 5 wrong PINs → 423 `PIN_LOCKED` (15 minutes, `Retry-After`). Rate limits per IP:
login/OTP-verify 10/min, OTP request 3/10 min (+ per phone), signup 10/h, PIN 60/min. `POST /setup`
needs `setup_token` when `KADAI_SETUP_TOKEN` is set; afterwards it is 409 `SETUP_ALREADY_DONE`.
Route catalogue: `authRoutes` in `@kadai/shared/api/auth`.

## identity (users, roles, org, settings)

| Method & path | perm | Notes |
|---|---|---|
| `L/C /users` · `G/U /users/:id` · `POST /users/:id/disable` · `POST /users/:id/enable` · `POST /users/:id/reset-pin` | `users.manage` | create = invite by phone (+ temporary password / OTP onboarding), role, store_ids, PIN |
| `L/C /roles` · `G/U/D /roles/:id` | `users.manage` (+feat `custom_roles` for non-system) | permissions editable for custom roles |
| `GET /permissions` | `users.manage` | catalogue of permission codes with ta/en labels |
| `L/C /stores` · `G/U /stores/:id` | `settings.manage` | plan limit `stores` |
| `L/C /registers` · `G/U /registers/:id` | `settings.manage` | plan limit `registers` |
| `L/C /devices` · `POST /devices/:id/revoke` | `settings.manage` | create returns `device_secret` once |
| `GET/PATCH /settings` | read: any member; write: `settings.manage` | tenant profile + typed settings (shared `TenantSettingsSchema`) |
| `GET/PATCH /settings/business` | `settings.manage` | name, legal name, GSTIN, PAN, address, logo, scheme |
| `L /number-series` · `U /number-series/:id` | `settings.manage` | prefix/padding; cannot lower next_number |
| `L /audit-logs` | `audit.read` (+feat `audit_log`) | filters: user, action, entity, from/to |
| `POST /files` (multipart) · `GET /files/:id` · `GET /files/:id/content` | any member | purpose-scoped, size/type limits |

## catalog

| Method & path | perm |
|---|---|
| `L/C /categories` · `G/U/D /categories/:id` (tree; `?flat=true`) | read `catalog.read`, write `catalog.write` |
| `L/C /brands` · `U/D /brands/:id` | 〃 |
| `L/C /tax-slab-rules` · `G/U/D /tax-slab-rules/:id` | 〃 |
| `L/C /products` (`q`, `category_id`, `brand_id`, `kind`, `is_active`, `low_stock`, `barcode`, `sort`) · `G/U/D /products/:id` | 〃 |
| `POST /products/:id/variants` `{axes: {size: [...], color: [...]}, price_overrides?}` → generates child variants | `catalog.write` (+feat `variants`) |
| `GET /products/lookup?code=` | barcode / SKU / scale-PLU exact lookup (scale barcodes parsed) | `catalog.read` |
| `POST/DELETE /products/:id/barcodes` | `catalog.write` |
| `POST /products/bulk-update` `{ids, set: {gst_rate_bp?, category_id?, is_active?, price_change?}}` | `catalog.write` |
| `POST /products/import` (CSV file id) → `imports` row · `GET /imports/:id` | `catalog.write` |
| `GET /products/export?format=csv` | `catalog.read` |
| `L/C /promotions` · `G/U/D /promotions/:id` | `catalog.write` (+feat `promotions`) |
| `GET/PUT /store-prices?store_id=` | `catalog.write` (+feat `store_pricing`) |
| `POST /labels` `{items: [{product_id, copies, batch_id?}], template}` → label print payload | `catalog.read` (+feat `barcode_labels`) |
| `GET /units` · `GET /hsn/search?q=` | any member |

## parties

| Method & path | perm |
|---|---|
| `L/C /customers` (`q`, `has_due`, `tag`, `sort`) · `G/U/D /customers/:id` | `customers.read` / `customers.write` |
| `GET /customers/:id/ledger?from=&to=` (khata statement with running balance) · `GET /customers/:id/summary` | `customers.read` |
| `GET /customers/lookup?phone=` | `customers.read` |
| `POST /customers/:id/loyalty/adjust` · `GET /customers/:id/loyalty` | `customers.write` (+feat `loyalty`) |
| `POST /customers/import` | `customers.write` |
| `L/C /suppliers` · `G/U/D /suppliers/:id` · `GET /suppliers/:id/ledger` | `suppliers.read` / `suppliers.write` |
| `L/C /doctors` · `U/D /doctors/:id` | `customers.write` |

## inventory

| Method & path | perm |
|---|---|
| `GET /stock?store_id=&q=&category_id=&low_stock=&out_of_stock=` (levels with value) | `inventory.read` |
| `GET /stock/products/:productId` (per store & batch) | `inventory.read` |
| `GET /stock/movements?product_id=&store_id=&type=&from=&to=` | `inventory.read` |
| `L /batches?product_id=&expiring_within_days=&expired=` · `U /batches/:id` | `inventory.read` / `inventory.adjust` |
| `L/C /stock-adjustments` · `G/U/D /stock-adjustments/:id` (draft) · `POST /stock-adjustments/:id/post` · `POST /stock-adjustments/:id/cancel` | `inventory.adjust` |
| `POST /stock/opening` `{store_id, lines:[{product_id, qty_milli, unit_cost_paise, batch?}]}` | `inventory.adjust` |
| `L/C /stock-transfers` · `G/U /stock-transfers/:id` · `POST …/:id/dispatch` · `POST …/:id/receive` · `POST …/:id/cancel` | `inventory.transfer` (+feat `stock_transfers`) |
| `GET /stock/alerts?store_id=` (low stock, expiring, expired counts + top items) | `inventory.read` |

## sales & POS

| Method & path | perm |
|---|---|
| `GET /pos/bootstrap?register_id=&since=` | `pos.use` |
| `POST /pos/quote` (cart → server-priced lines & totals; validates promotions, stock, rx) | `pos.use` |
| `POST /sales/invoices` (create & complete; `status: 'completed' \| 'held' \| 'draft'`, tenders, `client_ref`) | `sales.create` |
| `L /sales/invoices` (`q`, `status`, `doc_type`, `store_id`, `register_id`, `customer_id`, `from`, `to`, `payment_status`) · `G /sales/invoices/:id` | `sales.read` |
| `PATCH /sales/invoices/:id` (held/draft only) · `DELETE /sales/invoices/:id` (held/draft only) | `sales.create` |
| `POST /sales/invoices/:id/complete` (held/draft → completed with tenders) | `sales.create` |
| `POST /sales/invoices/:id/cancel` `{reason}` | `sales.cancel` |
| `POST /sales/invoices/:id/payments` (collect due: tenders) | `payments.collect` |
| `GET /sales/invoices/:id/print?format=thermal_80\|thermal_58\|a4` (print model) | `sales.read` |
| `POST /sales/invoices/:id/share` `{channel: whatsapp\|sms, phone?}` → share link + notification | `sales.read` |
| `GET /sales/held?store_id=` | `pos.use` |
| `POST /sales/estimates` · `POST /sales/estimates/:id/convert` | `sales.create` |
| `L/C /sales/credit-notes` · `G /sales/credit-notes/:id` · `POST /sales/credit-notes/:id/cancel` | `sales.return` |
| `GET /sales/invoices/:id/returnable` (lines with returnable qty) | `sales.return` |
| `POST /pos/sync` `{register_id, invoices: [...], credit_notes: [...]}` (offline upload, ordered) | `pos.use` |
| `GET /public/v1/invoices/:share_token` (no auth: invoice view model + UPI link if due) | public |

## payments & UPI

| Method & path | perm |
|---|---|
| `L/C /payment-providers` · `G/U/D /payment-providers/:id` · `POST /payment-providers/:id/test` | `payments.configure` (dynamic providers need feat `upi_dynamic`) |
| `POST /payments/intents` `{amount_paise, purpose, ref_type?, ref_id?, register_id?, customer_id?, provider_account_id?}` | `payments.collect` |
| `G /payments/intents/:id` · `GET /payments/intents/:id/stream` (SSE) | `payments.collect` |
| `POST /payments/intents/:id/confirm` `{utr?}` (manual confirm for VPA) · `POST /payments/intents/:id/cancel` | `payments.collect` |
| `POST /payments/intents/:id/mock-pay` | dev/test only |
| `L /payments/intents` (reconciliation: status, provider, date, unapplied) · `POST /payments/intents/:id/apply` `{target_type, target_id}` | `payments.read` |
| `POST /payments/links` `{customer_id, amount_paise?, send_via?}` | `payments.collect` |
| `L/C /payments` (receipts & vouchers: `direction`, `party_type`, `party_id`, `method`, `from`, `to`) · `G /payments/:id` · `POST /payments/:id/cancel` | `payments.read` / `payments.collect` (`out` needs `payments.pay`) |
| `GET /payments/upi-qr?vpa_account_id=&amount_paise=` (static/standee QR payload) | `payments.collect` |
| `POST /webhooks/payments/:provider/:account_id` | public, signature-verified |

## purchases

| Method & path | perm |
|---|---|
| `L/C /purchase-orders` · `G/U/D /purchase-orders/:id` · `POST …/:id/send` · `POST …/:id/cancel` · `POST …/:id/close` | `purchases.write` / `purchases.read` (+feat `purchases`) |
| `L/C /purchase-bills` (draft) · `G/U/D /purchase-bills/:id` · `POST …/:id/post` · `POST …/:id/cancel` | 〃 |
| `POST /purchase-bills/from-order/:orderId` | 〃 |
| `GET /purchase-bills/:id/returnable` | 〃 |
| `L/C /debit-notes` · `G /debit-notes/:id` · `POST /debit-notes/:id/cancel` | 〃 |
| `GET /purchases/reorder-suggestions?store_id=` (below reorder level, last supplier & cost) | `purchases.read` |
| Supplier payments use `POST /payments` with `direction:'out', party_type:'supplier'` | |

## accounting

| Method & path | perm |
|---|---|
| `L/C /accounts` · `G/U /accounts/:id` (system accounts: rename only) | `accounting.read` / `accounting.write` |
| `L /journal-entries` · `G /journal-entries/:id` · `C /journal-entries` (manual, balanced) · `POST /journal-entries/:id/reverse` | `accounting.read` / `accounting.write` |
| `L/C /expenses` · `G /expenses/:id` · `POST /expenses/:id/cancel` | `expenses.write` / `accounting.read` |
| `POST /shifts/open` `{register_id, opening_cash_paise}` · `GET /shifts/current?register_id=` · `POST /shifts/:id/close` `{counted_cash_paise, denominations}` · `L /shifts` · `G /shifts/:id` (X/Z report) · `POST /shifts/:id/cash-entries` | `shifts.operate` / `shifts.manage` |
| `GET /books/day-book?date=&store_id=` · `GET /books/cash-book?from=&to=` · `GET /books/ledger/:accountId?from=&to=` | `accounting.read` |
| `GET /statements/trial-balance?as_of=` · `/statements/profit-loss?from=&to=` · `/statements/balance-sheet?as_of=` | `accounting.read` |

## reports & GST

All support `?format=csv` and `store_id` filter.

| Method & path | perm |
|---|---|
| `GET /reports/dashboard?store_id=&date=` (today vs yesterday, 30-day trend, payment mix, top items, low stock, dues, expiring) | `reports.read` |
| `GET /reports/sales-summary?group_by=day\|month\|store\|register\|user\|payment_method&from=&to=` | `reports.read` |
| `GET /reports/item-sales` · `/reports/category-sales` · `/reports/brand-sales` · `/reports/profit` (margin by item/category) | `reports.read` |
| `GET /reports/stock-summary` (valuation) · `/reports/stock-ageing` · `/reports/expiry` · `/reports/dead-stock` | `reports.read` |
| `GET /reports/customer-outstanding` (ageing 0–30/31–60/61–90/90+) · `/reports/supplier-outstanding` | `reports.read` |
| `GET /reports/tax/gstr1?period=YYYY-MM` (sections) · `GET /reports/tax/gstr1/export?period=&format=json\|csv` (GST portal offline-tool JSON) | `reports.gst` (+feat `gst_reports`) |
| `GET /reports/tax/gstr3b?period=` · `/reports/tax/hsn-summary?from=&to=` · `/reports/tax/purchase-register` · `/reports/tax/sales-register` | `reports.gst` |
| `GET /reports/pharmacy/h1-register?from=&to=` · `/reports/pharmacy/schedule-sales` | `reports.read` |
| `GET /reports/shifts?from=&to=` · `/reports/cancellations` · `/reports/discounts` | `reports.read` |

## notifications

| Method & path | perm |
|---|---|
| `L /notifications` (outbox with status) · `POST /notifications/:id/retry` | `settings.manage` |
| `POST /notifications/send` `{channel, template_code, to, params}` | `notifications.send` |
| `L /notification-templates` · `PUT /notification-templates/:code/:channel/:locale` | `settings.manage` |
| `POST /customers/:id/remind` `{channel}` (due reminder with UPI link) | `customers.write` |
| `POST /webhooks/notifications/:provider` (delivery receipts) | public, verified |

## platform, billing & system

| Method & path | perm |
|---|---|
| `GET /billing/plans` · `GET /billing/subscription` · `POST /billing/checkout` `{plan_code, cycle}` (Razorpay subscription link) · `POST /billing/cancel` · `GET /billing/invoices` | `billing.manage` (cloud) |
| `POST /webhooks/platform/razorpay` | public, verified |
| `GET /platform/tenants` · `GET /platform/tenants/:id` · `POST /platform/tenants/:id/suspend` · `…/resume` · `…/plan` · `GET /platform/metrics` · `PUT /platform/plans/:code` | platform admin (cloud) |
| `GET /system/info` (version, mode, license, db size, last backup) | `settings.manage` |
| `GET/PUT /system/license` (upload signed license) | `settings.manage` (onprem) |
| `L/C /system/backups` · `GET /system/backups/:id/download` | `settings.manage` (onprem) |
| `L/C /api-keys` · `POST /api-keys/:id/revoke` | `settings.manage` (+feat `api_access`) |

## health

`GET /health/live` · `GET /health/ready` · `GET /metrics` (Prometheus; protect with `METRICS_TOKEN`).
