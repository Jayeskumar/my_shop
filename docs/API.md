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
| `GET  /setup/status` | public deployment probe, both modes: `{setup_required, mode, version, token_required}` (cloud: `setup_required: false`) |
| `POST /setup` | on-prem first-run wizard (creates the single tenant + owner); 404 in cloud |

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

Route catalogue: `identityRoutes` in `@kadai/shared/api/identity` (also hosts the shared contract
helpers: query/PATCH field helpers, `DeleteResultSchema`, CSV helpers, `ImportJobSchema`,
`documentPath()`).

| Method & path | perm | Notes |
|---|---|---|
| `L/C /users` · `G/U /users/:id` · `POST /users/:id/disable` · `POST /users/:id/enable` · `POST /users/:id/reset-pin` · `POST /users/:id/reset-password` | `users.manage` | `:id` = user id. Create = invite by phone (`first_login`: `temporary_password` returned once / `password` / `otp`), role, `store_ids` (null = all), PIN; plan limit `users`; cannot disable yourself or the last owner; admin password reset needs no SMS (on-prem) |
| `L/C /roles` · `G/U/D /roles/:id` | `users.manage` (+feat `custom_roles` to create; checked for custom roles on U/D) | system roles: rename only; delete → 409 when assigned |
| `GET /permissions` | `users.manage` | permission catalogue grouped by area with ta/en labels and implications (`permissionCatalog()`) |
| `L /stores` · `G /stores/:id` | any member | store pickers / transfer destinations |
| `C /stores` · `U /stores/:id` | `settings.manage` | plan limit `stores` (+feat `multi_store` beyond one); code `A-Z0-9` ≤ 4 (changeable only before its first number series); GSTIN prefix = state; deactivating the last active store → 409 |
| `L/C /registers` · `G/U /registers/:id` | `settings.manage` | plan limit `registers`; code ≤ 2 unique per store; settings PATCH is deep-partial |
| `L/C /devices` · `POST /devices/:id/revoke` | `settings.manage` | create returns `device_secret` once; revoke kills the device's sessions |
| `GET/PATCH /settings` | read: any member; write: `settings.manage` | `{tenant, settings}`; PATCH is a strict deep-partial (`SettingsPatchSchema`, unknown keys → 400), audited diff |
| `GET/PATCH /settings/business` | `settings.manage` | name, legal name, GSTIN (+state), PAN, scheme (`confirm_gst_scheme_change` when invoices exist in the FY), address, logo |
| `L /number-series?fy=&store_id=` · `C /number-series` · `U /number-series/:id` | `settings.manage` | unused series listed with `id: null` (customise them with C before the first document); next_number only increases; prefix change after documents needs `force` (audited); 16-char GST limit (`seriesFormatIssues()`) |
| `L /audit-logs` | `audit.read` (+feat `audit_log`) | filters: user_id, action prefix, entity_type, entity_id, from/to |
| `POST /files?purpose=` (multipart, part `file`) · `GET /files/:id` · `GET /files/:id/content` | any member | `FILE_UPLOAD_RULES` per purpose (logo/product_image ≤ 2 MB images, prescription ≤ 5 MB images/PDF, import ≤ 10 MB CSV/XLSX); tenant-scoped; content needs the bearer token (fetch as blob) |

## catalog

Route catalogue: `catalogRoutes` in `@kadai/shared/api/catalog`. Taxonomy rows (categories,
brands, tax slab rules) are deleted only when unused (409 `{hint: 'deactivate'}`); products and
promotions answer DELETE with `{id, result: 'deleted' | 'deactivated'}`.

| Method & path | perm |
|---|---|
| `L/C /categories` · `G/U/D /categories/:id` (tree, not paginated; `?flat=true` list with paths) | read `catalog.read`, write `catalog.write` |
| `L/C /brands` · `U/D /brands/:id` | 〃 |
| `L/C /tax-slab-rules` · `G/U/D /tax-slab-rules/:id` | 〃 |
| `L/C /products` (`q`, `barcode`, `category_id` incl. descendants, `brand_id`, `kind`, `is_active`, `low_stock`, `store_id`, `parent_id`, `hide_variants`, `ids`, `sort`) · `G/U/D /products/:id` | 〃 (create: plan limit `products`) |
| `POST /products/:id/variants` `{axes: {size: [...], color: [...]}, value_labels_ta?, price_overrides?, generate_barcodes?}` → child variants (idempotent) | `catalog.write` (+feat `variants`) |
| `GET /products/lookup?code=&store_id=` (barcode → SKU → scale barcode; 404 when none) | `catalog.read` |
| `POST /products/:id/barcodes` (`{barcode, qty_milli}` or `{generate: true}`) · `DELETE /products/:id/barcodes/:barcodeId` | `catalog.write` |
| `POST /products/bulk-update` `{ids (≤ 500), set: {gst_rate_bp?, tax_slab_rule_id?, category_id?, brand_id?, is_active?, price_change?}}` | `catalog.write` |
| `POST /products/import` `{file_id, mode, dry_run (default true), match_by}` → `imports` row (> 1000 rows: job `catalog.import`) · `GET /imports/:id` · `GET /products/import/template?business_type=` (CSV) | `catalog.write` (`/imports/:id`: `catalog.write` or `customers.write`) |
| `GET /products/export?format=csv` (list filters; import columns of the vertical) | `catalog.read` |
| `L/C /promotions` · `G/U/D /promotions/:id` (`status`, `active`, `kind`, `store_id`) | read `catalog.read`, write `catalog.write` (+feat `promotions`) |
| `GET /store-prices?store_id=` · `PUT /store-prices` `{store_id, upserts, deletes}` | `catalog.write` (+feat `store_pricing`) |
| `POST /labels` `{template: 38x25\|50x25\|a4_65, items: [{product_id, batch_id?, copies}], store_id?, generate_missing_barcodes?}` → label print model | `catalog.read` (+feat `barcode_labels`) |
| `GET /units` · `GET /hsn/search?q=` | any member |

## parties

Route catalogue: `partiesRoutes` in `@kadai/shared/api/parties`. Balances change only through
core ledger posting; loyalty points only through `core/loyalty.ts`.

| Method & path | perm |
|---|---|
| `L/C /customers` (`q`, `has_due`, `overdue`, `credit`, `tag`, `customer_type`, `is_active`, `ids`, `sort`) · `G/U/D /customers/:id` (duplicate phone → 409 `{existing_id}`; D = delete or deactivate) | `customers.read` / `customers.write` |
| `GET /customers/:id/ledger?from=&to=&format=json\|csv` (khata statement with running balance) · `GET /customers/:id/summary` | `customers.read` |
| `GET /customers/lookup?phone=` | `customers.read` |
| `GET /customers/:id/loyalty` · `POST /customers/:id/loyalty/adjust` `{points, notes}` | `customers.read` / `customers.write` (+feat `loyalty`) |
| `POST /customers/import` (≤ 1000 rows, dry run default) · `GET /customers/import/template` | `customers.write` |
| `L/C /suppliers` · `G/U/D /suppliers/:id` · `GET /suppliers/:id/ledger` (bank details: last 4 digits + IFSC only) | `suppliers.read` / `suppliers.write` |
| `L/C /doctors` · `G/U/D /doctors/:id` | `customers.read` / `customers.write` |

## inventory

Route catalogue: `inventoryRoutes` in `@kadai/shared/api/inventory`. Prefilled cross-module forms:
`purchaseReturnPrefillPath()` → `/purchases/returns/new?store_id=&supplier_id=&batch_ids=a,b`,
`reorderPrefillPath()` → `/purchases/orders/new?source=reorder&store_id=&product_ids=`,
`adjustmentPrefillPath()`, `transferPrefillPath()`; parse with `parseInventoryPrefill()`.

| Method & path | perm |
|---|---|
| `GET /stock?store_id=<id>\|all&q=&category_id=&brand_id=&low_stock=&out_of_stock=&in_stock=&group=product\|batch&sort=&format=json\|csv` (levels with value at cost & MRP, status; `totals` in the envelope) | `inventory.read` |
| `GET /stock/products/:productId?store_id=` (per store & batch, last 20 movements) | `inventory.read` |
| `GET /stock/movements?product_id=&store_id=&batch_id=&type=&ref_type=&ref_id=&user_id=&from=&to=&format=` | `inventory.read` |
| `L /batches?product_id=&store_id=&supplier_id=&expiring_within_days=&expired=&with_stock_only=` · `U /batches/:id` | `inventory.read` / `inventory.adjust` or `catalog.write` (expiry & mfg changes need `inventory.adjust`) |
| `L/C /stock-adjustments` · `G/U/D /stock-adjustments/:id` (draft) · `POST /stock-adjustments/:id/post` · `POST /stock-adjustments/:id/cancel` `{reason}` | `inventory.adjust` |
| `POST /stock/opening` `{store_id, date?, force?, lines:[{product_id, qty_milli, unit_cost_paise, batch_id? \| batch?}]}` (posted adjustment kind `opening`) | `inventory.adjust` |
| `L/C /stock-transfers` · `G/U /stock-transfers/:id` · `POST …/:id/dispatch` · `POST …/:id/receive` `{lines?, shortfall_reason?}` · `POST …/:id/cancel` `{reason}` (draft or dispatched → `cancelled`) | read `inventory.read`, write `inventory.transfer` (+feat `stock_transfers`) |
| `GET /stock/alerts?store_id=&limit=` (low stock, out of stock, expiring, expired counts + top items) | `inventory.read` |

## sales & POS

Route catalogue: `salesRoutes` in `@kadai/shared/api/sales`. Cart pricing is `priceCart()` (shared
by the POS — also offline — and the server); quote problems are typed `issues`
(`SALES_BLOCKING_ISSUE_CODES` / `SALES_WARNING_CODES`); create / complete throw the first blocking
one as `salesIssueErrorCode()` with `details.reason` (e.g. 422 `RX_REQUIRED`, `EXPIRED_BATCH`,
`CREDIT_LIMIT_EXCEEDED`, `INSUFFICIENT_STOCK`; 403 for overrides). Tenders follow
`allocateTenders()` (non-cash first, must fit; cash = money handed over, change returned; the rest is
due/credit). Returns are pro-rata with `prorateReturnLine()` (the final return takes the exact
remainder). Every list takes `?format=csv`.

| Method & path | perm | Notes |
|---|---|---|
| `GET /pos/bootstrap?register_id=&store_id=&since=` | `pos.use` (+feat `pos`) | full catalogue / delta since the cursor (products, barcodes, store prices, FEFO batches with stock, promotions, slab rules, categories, quick keys, settings, register series state, open shift, public provider fields, 200 recent customers, removed ids) |
| `POST /pos/quote` | `pos.use` or `sales.create` | priced lines (FEFO splits `key#2`…), totals, tax breakup, promotions, credit & loyalty, `issues`, `can_complete`, `requires` |
| `POST /sales/invoices` | `sales.create` | `status: completed \| held \| draft`; POS needs `client_ref` (idempotent, also `Idempotency-Key`); plan limit `invoices_per_month`; result `{invoice, tenders, change_paise, warnings}` |
| `L /sales/invoices` (`q`, `status`, `doc_type`, `payment_status`, `channel`, `store_id`, `register_id`, `customer_id`, `created_by`, `shift_id`, `has_due`, `offline`, `from`, `to`, `sort`) · `G /sales/invoices/:id` | `sales.read` | default excludes estimates and held/draft; list carries `summary` totals; detail has lines, payments, credit notes, journal entry, shift, customer khata, rx, audit |
| `PATCH /sales/invoices/:id` · `DELETE /sales/invoices/:id` | `sales.create` | held / draft only (else 409) |
| `POST /sales/invoices/:id/complete` `{tenders, register_id?, changes?}` | `sales.create` | re-priced at current prices (manual prices kept, re-checked) |
| `POST /sales/invoices/:id/cancel` `{reason}` | `sales.cancel` | not with credit notes (409); refunds list flags manual PSP refunds |
| `POST /sales/invoices/:id/payments` `{tenders}` | `payments.collect` | collect the due |
| `GET /sales/invoices/:id/print?format=thermal_80\|thermal_58\|a4&locale=` · `GET /sales/credit-notes/:id/print` | `sales.read` (credit notes: or `sales.return`) | `SalesPrintModel`: everything for a GST bilingual A4 / thermal document (no internal ids or costs) |
| `POST /sales/invoices/:id/share` `{channel: whatsapp\|sms, phone?}` | `sales.read` | share link `/i/<token>` + notification `invoice_share` (+ `wa_me_url`) |
| `GET /sales/held?store_id=&register_id=` | `pos.use` or `sales.create` | held bills / drafts |
| `POST /sales/estimates` · `POST /sales/estimates/:id/convert` | `sales.create` | estimates are invoices with `doc_type: estimate` (list: `L /sales/invoices?doc_type=estimate`; valid until = `due_date`) |
| `GET /sales/invoices/:id/returnable` | `sales.return` | sold / returned / returnable qty + credited amounts, `refundable_paise` |
| `L/C /sales/credit-notes` · `G /sales/credit-notes/:id` | `sales.return` (L/G: or `sales.read`) | settlement `cash \| upi \| bank_transfer` (refund, ≤ refundable), `adjust_due`, `store_credit`; free-form returns need `store_id` and prices |
| `POST /sales/credit-notes/:id/cancel` `{reason}` | `sales.cancel` | reverses stock, journal, settlement, loyalty |
| `POST /pos/sync` `{register_id, invoices, credit_notes}` | `pos.use` (+feat `pos`) | invoices then credit notes, in order, one transaction each; per item `created \| duplicate \| renumbered \| failed`; returns the register series state |
| `GET /public/v1/invoices/:share_token` | public | `{document: SalesPrintModel, pay: {upi_uri, amount_paise, …} \| null}` |

## payments & UPI

Route catalogue: `paymentsRoutes` in `@kadai/shared/api/payments`. Provider secrets are write-only
(`key_id_masked`, `has_webhook_secret`). A paid intent is consumed exactly once by `recordPayment`
(core rules: locked, paid, unused, same store, amount = money received; partial application via
allocations, the rest is the customer's advance). Payment `origin` comes from `client_ref`
(`paymentClientRef`): POS tenders and return settlements are cancelled with their document.

| Method & path | perm | Notes |
|---|---|---|
| `L/C /payment-providers` · `G/U/D /payment-providers/:id` · `POST /payment-providers/:id/test` | `payments.configure` (L/G: or `payments.read`) | `upi_vpa` / `razorpay` / `mock`; dynamic providers need feat `upi_dynamic`; one default per store; webhook URL + events in the response; D = deactivate |
| `POST /payments/intents` `{amount_paise, purpose, store_id, register_id?, ref_type?, ref_id?, customer_id?, provider_account_id?, idempotency_key?}` | `payments.collect` | QR intent; provider failure → 502 `PROVIDER_ERROR` |
| `G /payments/intents/:id?wait=&since_status=` · `GET /payments/intents/:id/stream` (SSE, event `intent`) | `payments.collect` or `payments.read` | `wait` ≤ 25 s long poll; the stream closes on a terminal status |
| `POST /payments/intents/:id/confirm` `{utr?, payer_vpa?, paid_amount_paise?}` · `POST /payments/intents/:id/cancel` | `payments.collect` | confirm: `upi_vpa` only, audited; cancel: paid → 409 |
| `POST /payments/intents/:id/mock-pay` | `payments.collect` | dev/test only (`KADAI_ENABLE_MOCK_PAYMENTS`) |
| `L /payments/intents` (`status`, `provider`, `provider_account_id`, `purpose`, `store_id`, `register_id`, `customer_id`, `unapplied`, `from`, `to`, `q`) | `payments.read` | + `summary` (by status, unapplied, paid totals by provider) |
| `POST /payments/intents/:id/apply` `{target_type: sales_invoice\|customer, target_id}` | `payments.collect` | paid & unapplied → receipt (customer: FIFO) |
| `POST /payments/links` `{customer_id, store_id, amount_paise?, send_via?, phone?}` | `payments.collect` | Razorpay link or the Kadai pay page `/pay/<reference_code>` (template `payment_link`) |
| `GET /payments/open-items?party_type=&party_id=&direction=` | `payments.collect`, `payments.pay` or `payments.read` | open documents FIFO (opening balance first); auto-fill with `allocateFifo()` |
| `L /payments` (`direction`, `party_type`, `party_id`, `method`, `status`, `origin`, `store_id`, `register_id`, `shift_id`, `from`, `to`, `q`) · `G /payments/:id` | `payments.read` (G: or `payments.collect`) | list `summary` (in / out / by method); detail with allocation document numbers |
| `C /payments` `{direction, store_id, party_type, party_id, method, amount_paise, allocations? \| auto_allocate: 'fifo', …}` · `POST /payments/:id/cancel` `{reason}` | `payments.collect` (in) / `payments.pay` (out) | RC… / PV… numbers; cancel only `origin: manual` (else 409) |
| `GET /payments/upi-qr?provider_account_id=&store_id=&amount_paise=` | `payments.collect` | static / standee QR payload (no amount = customer enters it) |
| `GET /public/v1/pay/:reference_code` | public | pay page model: shop, amount, status, UPI deep link |
| `POST /webhooks/payments/:provider/:account_id` | public, signature-verified | raw body HMAC (invalid → 401, logged), deduplicated by event id, `{data: {ok: true}}` |

## purchases

Route catalogue: `purchasesRoutes` in `@kadai/shared/api/purchases` (every route +feat
`purchases`). Bill totals and landed costs come from `purchaseBillTotals()` (shared with the
bill-entry grid); debit notes are pro-rata with `prorateReturnLine()`.

| Method & path | perm | Notes |
|---|---|---|
| `L/C /purchase-orders` · `G/U/D /purchase-orders/:id` · `POST …/:id/send` `{via?, phone?}` · `POST …/:id/cancel` · `POST …/:id/close` | read `purchases.read`, write `purchases.write` | numbered on create; edit / delete while draft; send → template `po_to_supplier`; status from posted bills |
| `L/C /purchase-bills` (`q`, `status`, `payment_status`, `supplier_id`, `store_id`, `purchase_order_id`, `overdue`, `has_due`, `from`, `to`) · `G/U/D /purchase-bills/:id` | 〃 | drafts; duplicate supplier invoice no per supplier & FY → 409 `DUPLICATE` `{reason: 'duplicate_supplier_invoice', existing_bill_id}`; list `summary` |
| `POST /purchase-bills/:id/post` `{update_prices?, allow_past_expiry?}` · `POST …/:id/cancel` `{reason}` | `purchases.write` | post: GRN number, batches, stock at landed cost, journal, price updates (audited); cancel refused with live payments (409) or consumed stock (422) |
| `POST /purchase-bills/from-order/:orderId` | `purchases.write` | draft with the pending quantities |
| `GET /purchase-bills/:id/returnable` | `purchases.read` | returnable qty (charged + free − returned), credited amounts, stock |
| `L/C /debit-notes` · `G /debit-notes/:id` · `POST /debit-notes/:id/cancel` | read / write | from bill lines or free-form (product + batch); settlement `adjust_due \| refund_cash \| refund_bank` |
| `GET /debit-notes/prefill?batch_ids=&store_id=&supplier_id=` | `purchases.read` | free-form return lines for batches (expiry returns) |
| `GET /purchases/reorder-suggestions?store_id=&supplier_id=&category_id=&product_ids=` | `purchases.read` | grouped by last supplier; `suggestedReorderQtyMilli()` |
| Supplier payments: `POST /payments` with `direction: 'out', party_type: 'supplier'`, allocations `purchase_bill` | `payments.pay` | |

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
