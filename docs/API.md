# Kadai — HTTP API surface (v1)

Conventions are in [ARCHITECTURE.md §7.3](./ARCHITECTURE.md). All paths below are under
`/api/v1` unless they start with `/webhooks`, `/public` or `/health`. `perm:` is the required
permission (any-of), `feat:` the required plan feature. Request/response Zod schemas live in
`packages/shared/src/api/<module>.ts`; the owning module may refine shapes but must keep the
paths and semantics below (other modules' UIs are built against them).

Legend: **C** create, **L** list (paginated, filterable), **G** get one, **U** partial update
(PATCH), **D** delete/deactivate.

Contract conventions shared by every catalogue (`ROUTE_CATALOGUES` in
`@kadai/shared/api/catalogues` lists them all; `test/api/catalogues.test.ts` checks them together):

- `response` is the full envelope (`dataOf` / `listOf`); lists may extend it with `summary`
  (aggregates over the whole filtered range) or, for tabular views (stock, reports), `totals`.
  No response schema = 204.
- Field helpers come from `@kadai/shared/api/common`: `zQueryList` / `zQueryIds` (repeated keys or
  comma lists), `zQueryInt`, `zStoreScope` (id or `all`), `zIfUpdatedAt` (PATCH → 409
  `STALE_WRITE`), `zNullableText` (missing = unchanged, null/'' = clear), `zAmountPaise`, `zMilli0`,
  `zReason`, `zListFormat` (`?format=json|csv`), `DATE_RANGE_FIELDS` + `dateOrderOk`.
- `?sort=` is `sortQuery([...]).prefault('<default>')`, so handlers always receive
  `{field, direction}`.
- Users on documents are the flat pair `<x>_by` (user id) + `<x>_by_name` (`created_by`,
  `posted_by`, `cancelled_by`, `opened_by`; `salesperson_id` + `salesperson_name`).
- Path params are camelCase (`:id`, `:productId`, `:shareToken`); paths are kebab-case.
- Validation messages of custom rules are snake_case keys (`<MODULE>_VALIDATION_KEYS`); errors
  carry `details.reason`.

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

Route catalogue: `identityRoutes` in `@kadai/shared/api/identity` (also hosts `DeleteResultSchema`,
CSV helpers, `ImportJobSchema` and `documentPath()`; the query / PATCH field helpers are defined
once in `@kadai/shared/api/common` and re-exported here).

| Method & path | perm | Notes |
|---|---|---|
| `L/C /users` · `G/U /users/:id` · `POST /users/:id/disable` · `POST /users/:id/enable` · `POST /users/:id/reset-pin` · `POST /users/:id/reset-password` | `users.manage` | `:id` = user id. Create = invite by phone (`first_login`: `temporary_password` returned once / `password` / `otp`), role, `store_ids` (null = all), PIN; plan limit `users`; cannot disable yourself or the last owner; admin password reset needs no SMS (on-prem) |
| `L/C /roles` · `G/U/D /roles/:id` | `users.manage` (+feat `custom_roles` to create; checked for custom roles on U/D) | system roles: rename only; delete → 409 when assigned |
| `GET /users/directory?q=&store_id=&include_disabled=` | any member | member names for pickers / filters (id, name, role, status, store_ids; ≤ 500, no contact or security fields) |
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
| `GET /public/v1/invoices/:shareToken` | public | `{document: SalesPrintModel, pay: {upi_uri, amount_paise, …} \| null}` |

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
| `GET /public/v1/pay/:referenceCode` | public | pay page model: shop, amount, status, UPI deep link |
| `POST /webhooks/payments/:provider/:accountId` | public, signature-verified | raw body HMAC (invalid → 401, logged), deduplicated by event id, `{data: {ok: true}}` |

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

Route catalogue: `accountingRoutes` in `@kadai/shared/api/accounting`. Balances are always derived
from `journal_lines` (natural sign: + = the account's normal side). Posting plans and maths are
shared: `computeExpenseAmounts()` / `expenseJournalLines()`, `cashEntryJournalLines()`,
`expectedShiftCash()` / `shiftDifferenceJournalLines()`, `buildAccountTree()`, `runningBalances()`.
Every list, book and statement takes `?format=csv`; errors carry `details.reason` from
`ACCOUNTING_ERROR_REASONS`.

| Method & path | perm | Notes |
|---|---|---|
| `GET /accounts?as_of=&store_id=&type=&money=cash\|bank&q=&include_inactive=&balances=` | `accounting.read`, `expenses.write`, `shifts.operate` or `payments.configure` | whole chart, not paginated; balances need `accounting.read` |
| `C /accounts` · `G/U/D /accounts/:id` | `accounting.write` (C: also `expenses.write` for expense heads) | code 3–6 digits starting with the type digit (`suggestAccountCode()`), unique; parent of the same type; system accounts: name / name_ta / bank details only (422 `system_account_locked`); D = delete without journal lines, else deactivate (balance-sheet accounts need a zero balance: 409 `account_has_balance`) |
| `L /journal-entries` (`from`, `to`, `source_type`, `source_id`, `account_id`, `party_type`+`party_id`, `store_id`, `reversals`, `q`, `sort`) · `G /journal-entries/:id` | `accounting.read` (+feat `accounting`) | detail: lines with account / party names and the source document link (`journalSourcePath()`) |
| `C /journal-entries` · `POST /journal-entries/:id/reverse` `{reason, entry_date?}` | `accounting.write` (+feat `accounting`) | manual JV: balanced, ≥ 2 lines, receivable / payable lines need a party, JV number, audited; reverse manual entries only (409 `not_manual`), once (409 `already_reversed`) |
| `L/C /expenses` · `G /expenses/:id` · `POST /expenses/:id/cancel` `{reason}` | `expenses.write` (L/G: or `accounting.read`) | amount as `total_paise` (incl. GST) or `taxable_paise`; ITC; cash / bank / credit (`supplier_id` → payable); EXP number; cash paid from a counter joins its open shift; list `summary` by category and method; cancel = reversal (409 `expense_has_payments`) |
| `POST /shifts/open` `{register_id, opening_cash_paise, denominations?}` · `GET /shifts/current?register_id=` · `L /shifts` · `G /shifts/:id` | `shifts.operate` (+feat `shifts`; current: or `pos.use`) | one open shift per register (409 `shift_already_open`); detail = live X report while open, stored Z report once closed; operate-only members see their own shifts |
| `POST /shifts/:id/cash-entries` `{kind, amount_paise, reason, account_id? \| counter?}` · `POST /shifts/:id/close` `{counted_cash_paise, denominations?, notes?}` | `shifts.operate` (another member's shift: `shifts.manage`) | pay-in / pay-out journal vs drawings / capital / bank / other income or an account; close: expected = opening + cash receipts − cash payments + pay-ins − pay-outs − cash expenses, the difference posts to `cash_short_excess`; no reopen (corrections by journal) |
| `GET /books/day-book?date=&store_id=` · `GET /books/cash-book?from=&to=&account_id=` · `GET /books/ledger/:accountId?from=&to=&party_type=&party_id=` | `accounting.read` (+feat `accounting`) | paginated rows with the running balance over the whole range; opening / closing |
| `GET /statements/trial-balance?as_of=` · `/statements/profit-loss?from=&to=&store_id=&compare_from=&compare_to=` · `/statements/balance-sheet?as_of=` | `accounting.read` (+feat `accounting`) | TB / BS tenant-wide (store-scoped members: 403 `all_stores_required`); BS equity includes this FY's profit and earlier years' profit; `balanced` checks |

Cross-module: the accounting module adds the system subtype `cash_short_excess` (5250 "Cash short /
excess", `CASH_SHORT_EXCESS_ACCOUNT`) to the shared DEFAULT_CHART and backfills existing tenants
with a 07xx migration.

## reports & GST

Route catalogue: `reportsRoutes` in `@kadai/shared/api/reports`; the generic viewer renders the
`REPORTS` catalogue (report key → route, filters, columns with formats, totals, chart). Tabular
reports answer `{data, page, totals, meta}` (`limit` ≤ 5000); `?format=csv` streams every row with
the English column labels and a totals row (`reportCsv()`); `store_id` = a store or `all` (store
access respected); ranges ≤ 366 days (400 `range_too_long`). Only completed documents count; credit
notes reduce sales.

| Method & path | perm (+feat) |
|---|---|
| `GET /reports/dashboard?store_id=&date=` (today vs yesterday, 30-day trend, payment mix, top items, dues, payables, stock alerts, open shifts, UPI) | `reports.read` |
| `GET /reports/sales-summary?group_by=day\|month\|hour\|store\|register\|user\|payment_method&from=&to=` · `/reports/item-sales` · `/reports/category-sales` · `/reports/cancellations` | `reports.read` (`reports_basic`) |
| `GET /reports/brand-sales` · `/reports/profit?group_by=item\|category\|brand` · `/reports/discounts?group_by=bill\|item\|promotion\|user` | `reports.read` (`advanced_reports`) |
| `GET /reports/shifts?from=&to=` | `reports.read` (`shifts`) |
| `GET /reports/stock-summary` (`reports_basic`) · `/reports/expiry?days=` (`batches_expiry`) · `/reports/stock-ageing` · `/reports/dead-stock?days=` (`advanced_reports`) | `reports.read` |
| `GET /reports/customer-outstanding` (ageing 0–30/31–60/61–90/90+ by invoice date) · `/reports/supplier-outstanding` (by due date) | `reports.read` (`reports_basic`) |
| `GET /reports/tax/gstr1?period=YYYY-MM&gstin=` (`kind: gstr1 \| composition \| unregistered`) · `GET /reports/tax/gstr1/export?period=&format=json\|csv&section=` (file) · `/reports/tax/gstr3b?period=` · `/reports/tax/hsn-summary` · `/reports/tax/sales-register` · `/reports/tax/purchase-register` | `reports.gst` (`gst_reports`) |
| `GET /reports/pharmacy/h1-register?from=&to=` · `/reports/pharmacy/schedule-sales` | `reports.read` (`reports_basic`) |

GSTR-1 JSON = `buildGstr1PortalJson()` (offline-tool layout, `GSTR1_PORTAL_SCHEMA_VERSION`, HSN split
`hsn_b2b` / `hsn_b2c`, B2CL above ₹1,00,000); CSV = `gstr1Csv()`; GSTR-3B tax payment uses
`utiliseItc()` (rule 88A order). Composition tenants get the CMP-08 quarterly summary.

## notifications

Route catalogue: `notificationsRoutes` in `@kadai/shared/api/notifications`. Business code writes
the outbox with `enqueueNotification(tx, ctx, …)` (`apps/server/src/core/notify.ts`) inside its
transaction; job `notifications.send` delivers it (5 attempts, `notificationRetryDelaySeconds()`
backoff; `notifications.sweep` every minute). Templates: `NOTIFICATION_TEMPLATES` (10 codes ×
channels × ta/en) + tenant overrides; providers implement `NotificationProvider` and register in
`getNotificationProviders()` (core/notify.ts; on-prem relay: `kadai_relay`).

| Method & path | perm | Notes |
|---|---|---|
| `L /notifications` (`status`, `channel`, `template_code`, `q`, `ref_type`, `ref_id`, `from`, `to`) · `G /notifications/:id` · `POST /notifications/:id/retry` | `settings.manage` | list `summary` by status / channel; retry failed / cancelled (409 `not_retryable`); OTP params redacted |
| `POST /notifications/send` `{channel, template_code, to, params, recipient_name?, locale?, ref_type?, ref_id?, scheduled_at?}` | `notifications.send` (+feat `notifications`) | template-based only (`ADHOC_TEMPLATE_CODES`; no free text over SMS: DLT); rate limited 30/min |
| `GET /notification-templates?code=&channel=&locale=` · `PUT /notification-templates/:code/:channel/:locale` · `DELETE /notification-templates/:code/:channel/:locale` | `settings.manage` (PUT: +feat `notifications`) | defaults merged with overrides, provider status and `settings.notifications`; PUT validated by `templateBodyIssues()` (an SMS override needs its DLT template id); DELETE = back to the default |
| `POST /customers/:id/remind` `{channel: whatsapp\|sms\|wa_me, include_payment_link?, amount_paise?, store_id?, phone?, locale?}` | `customers.write` | due > 0 (422 `no_due`); payment-link intent (payments) + `due_reminder` notification; `wa_me` returns the text and a wa.me link on every plan |
| `POST /webhooks/notifications/:provider` · `GET /webhooks/notifications/whatsapp_cloud` (hub.challenge) | public, verified | WhatsApp `X-Hub-Signature-256` (app secret), MSG91 delivery reports; statuses only move forward (`nextNotificationStatus()`) |

Jobs: `notifications.send`, `notifications.sweep` (every minute), `notifications.due-reminders`
(10:00 IST, `shouldSendDueReminder()`), `notifications.daily-summary` (21:30 IST).

## platform, billing & system (cloud billing, api-keys, system info)

Route catalogue: `platformRoutes` in `@kadai/shared/api/platform`. Every price is computed by the
shared `priceOrder()` (`@kadai/shared/api/licensing`; buyer channel `cloud`, place of supply =
tenant state vs `KADAI_VENDOR_STATE_CODE`); cloud plan purchases are price-book lines
`cloudPlanProductCode(plan, cycle)` (`cloud_growth_yearly` rows; monthly lines synthesized from
`plans.price_monthly_paise`). Offers, announcements and vendor orders live in the vendor tables
(0010) and are read/written through the system pool (justified in each handler).

| Method & path | perm | Notes |
|---|---|---|
| `GET /billing/plans` | `billing.manage` (cloud) | public plans: features, limits, monthly/yearly excl. & incl. 18% GST, yearly savings, recommended (Valarchi) |
| `GET /billing/subscription` | 〃 | plan, subscription, entitlements, usage meters vs limits (incl. bills this month), trial days left, active vendor offers for this tenant (audience: business type, state, segment), pending checkout |
| `POST /billing/quote` `{plan_code, cycle, coupon_code?}` | 〃 | `PriceQuote` with offer / coupon result + CGST/SGST or IGST, period, first charge date |
| `POST /billing/checkout` `{plan_code, cycle, coupon_code?, auto_renew?}` | 〃 | prepaid (yearly / monthly): `vendor_orders` (kind `cloud_plan`) + Razorpay payment link → `short_url`; monthly `auto_renew`: Razorpay subscription (`RAZORPAY_PLAN_<CODE>_<CYCLE>`, free months → future `start_at`) |
| `POST /billing/cancel` `{reason?, feedback?}` | 〃 | cancel at period end |
| `GET /billing/invoices` · `GET /billing/invoices/:id/print` | 〃 | paid vendor orders + `platform_invoices`; print = `VendorInvoicePrint` (GST, bilingual) |
| `POST /webhooks/platform/razorpay` | public, verified | `RAZORPAY_PLATFORM_WEBHOOK_SECRET`; dedup `payment_webhook_events` provider `razorpay_platform`; `payment_link.paid`: `cloud_plan` orders fulfilled here (gapless `KD/<FY>/<seq>` via `vendorInvoiceCounterKey`), other kinds → job `licensing.fulfil-order`; `subscription.*` → `RAZORPAY_SUBSCRIPTION_EVENT_STATUS` |
| `GET /announcements` · `POST /announcements/:id/dismiss` | any member (cloud) | `Banner[]` from the shared `selectBanners()` (channel cloud, business type, plan); critical banners cannot be dismissed |
| `GET /system/info` | `settings.manage` (both modes) | version, commit, mode, node, uptime, db version/size, migrations, worker heartbeat, storage; `onprem` summary filled by the onprem module |
| `L/C /api-keys` · `POST /api-keys/:id/revoke` | `settings.manage` (+feat `api_access`) | create `{name, permissions ⊆ yours (missingPermissions → 403), store_ids?, expires_at?}` → full key `kd_live_<prefix>_<secret>` shown once |

Job `platform.subscription-renewals` (hourly, cloud): trial ended → Free, `past_due` > 7 days →
downgrade, prepaid renewal reminders 7 and 1 days before the period end.

## licensing & vendor console

Our control plane (cloud deployment with `KADAI_VENDOR_CONSOLE=true`; 404 otherwise). Tables of
migration 0010 — system pool only. Route catalogues in `@kadai/shared/api/licensing`:
`licensingRoutes` (console, `/api/v1/platform/*`, tenant-less user tokens, guarded by the staff
capability in `VendorRouteDef.vendor` — `STAFF_ROLE_CAPABILITIES`; partner users only see their own
partner's rows; every mutation writes `platform_audit_logs`) and `licensingPublicRoutes`
(`/public/v1/*`, `LicensingPublicRouteDef.licensing` = authentication + rate limit). Errors carry
`details.reason` from `LICENSING_ERROR_REASONS`. Shared helpers: licence keys
(`generateLicenseKey`, `parseLicenseKey`, `formatLicenseKeyInput`), signed requests
(`installationSignaturePayload`), `priceOrder`, `planUpgrades` / `isReleaseEligible`,
`amcStatus` / `licenseTermStatus` / `extendTermEnd`, `licenseEffectiveFeatures` /
`licenseEffectiveLimits`, `selectBanners`, `formatVendorInvoiceNumber`, `partnerCommissionPaise`.

| Method & path | capability | Notes |
|---|---|---|
| `GET /platform/me` | any staff | role, partner, capabilities |
| `L/C /platform/staff` · `PATCH /platform/staff/:userId` · `GET /platform/audit-logs` | `vendor.staff.manage` / `vendor.audit.read` | create by phone (temporary password once for new users); owner/admin roles only by an owner; `users.is_platform_admin` kept in sync |
| `GET /platform/metrics?months=` | `vendor.dashboard` | KPIs, cloud (tenants by plan/status/type/state, MRR, signups, bills/day), on-prem (licences by edition/type, activations, check-ins 7 d, version adoption, renewals due 30/60/90 + rate, top districts), revenue by month, partner revenue, recent orders |
| `L/C /platform/products` · `PATCH /platform/products/:code` | `vendor.products.read` / `.write` | price book (`license_products`) |
| `L/C /platform/customers` · `G/U /platform/customers/:id` | `vendor.customers.read` / `.write` | search phone/business/GSTIN, partner, tag, AMC state; G = customer 360 (licences, activations, orders, timeline, AMC, versions) |
| `L/C /platform/licenses` · `G/U /platform/licenses/:id` · `GET …/:id/events` | `vendor.licenses.read` / `.issue` / `.manage` | issue → key `KD-XXXX-XXXX-XXXX-XXXX` shown once + sent (WhatsApp/SMS/email); only sha256 + prefix stored |
| `POST /platform/licenses/:id/suspend` · `…/resume` · `…/revoke` · `…/reissue-key` | `vendor.licenses.manage` | reason required; re-issue = new key (keys are never stored) |
| `POST /platform/licenses/:id/upgrade` · `…/addons` · `…/renew` | `vendor.licenses.issue` | limits recomputed; renew extends from max(today, current end) |
| `POST /platform/licenses/offline-activate` `{license_id \| license_key, request}` | `vendor.activations.manage` | shop's request file / `KDREQ1.` code → signed licence file |
| `L /platform/activations` · `POST …/:id/deactivate` · `POST …/:id/block` · `GET …/:id/license-file` | `vendor.licenses.read` / `vendor.activations.manage` / `vendor.licenses.manage` | transfer = deactivate (limit `LICENSE_TRANSFERS_PER_YEAR`, override by owner/admin) |
| `L/C /platform/offers` · `G/U /platform/offers/:id` · `GET …/:id/redemptions` · `POST /platform/offers/validate` | `vendor.offers.read` / `.write` | coupon codes and automatic campaigns (code null): kind, applies_to, channel, audience, schedule, limits, partner-exclusive, stackable, banner ta/en |
| `POST /platform/orders/quote` · `L/C /platform/orders` · `G/U /platform/orders/:id` | `vendor.orders.read` / `.write` | priced by `priceOrder` (partner pricing for partner-placed orders); draft → pending_payment → paid → fulfilled (`VENDOR_ORDER_TRANSITIONS`) |
| `POST /platform/orders/:id/payment-link` · `…/mark-paid` · `…/fulfil` · `…/cancel` · `…/refund` · `GET …/:id/invoice` | `vendor.orders.write` / `.payments` / `.read` | Razorpay payment link or manual UTR / partner credit; paid → gapless `KD/<FY>/<seq>`, licence issued/extended, commission accrued, redemption recorded; refund voids the commission; invoice = `VendorInvoicePrint` (SAC 997331) |
| `L/C /platform/partners` · `G/U /platform/partners/:id` · `L /platform/commissions` · `POST …/:id/approve` · `POST …/:id/pay` | `vendor.partners.*` / `vendor.commissions.*` | partner discount_bp (tier defaults 20/25/30%), commission_bp on referred direct sales |
| `L/C /platform/releases` · `G/U /platform/releases/:id` | `vendor.releases.read` / `.write` | notes ta/en, artifacts (sha256; Ed25519 signature over `sha256\|version\|platform` made server-side with `KADAI_RELEASE_SIGNING_KEY`), mandatory, min_upgrade_from, installs |
| `L/C /platform/announcements` · `G/U /platform/announcements/:id` | `vendor.announcements.read` / `.write` | audience: channels, business types, plan codes, states, version range, AMC state |
| `L /platform/tenants` · `G /platform/tenants/:id` · `POST …/:id/suspend` · `…/resume` · `…/plan` · `GET /platform/plans` · `PUT /platform/plans/:code` | `vendor.tenants.read` / `.manage` / `vendor.plans.write` | cloud tenant admin (moved here from the platform module) |

Public licensing API (scope `/public/v1`, no shop data ever required):

| Method & path | auth | Notes |
|---|---|---|
| `POST /licensing/activate` | licence key (+ installation signature with the new key) | validates key/status/max activations; same installation → idempotent (`reactivated`); same installation id with another fingerprint → 409 `clone_suspected`; returns the signed licence bound to the installation, `check_in_days`, vendor info |
| `POST /licensing/offline-activate` `{license_key, request}` | licence key | public `/activate` page: request file → licence file |
| `POST /licensing/check-in` | installation signature | `{license_id, app_version, platform, stats (counts only), connect_snapshot?, update_status?}` → refreshed licence (when changed), banners, priced offers, renewal (due, quote, checkout), releases (eligible + newest ineligible), add-on entitlements, vendor info |
| `GET /licensing/releases?channel=&from_version=&platform=` | 〃 | `ReleasePlan` with signed artifacts |
| `POST /licensing/renewal-quote` · `POST /licensing/renewal-checkout` `{items, coupon_code?}` | 〃 | live price / vendor order + Razorpay payment link paid from inside the shop app |
| `POST /licensing/license/refresh` · `POST /licensing/deactivate` | 〃 | freshly signed licence; self-service transfer (limited per year) |
| `POST /licensing/backups/upload-url` · `POST …/backups/:id/complete` · `GET …/backups` · `POST …/backups/:id/download-url` · `DELETE …/backups/:id` | 〃 (feat `cloud_backup`) | presigned S3 URLs for encrypted blobs (10 GB per add-on, 30 days retention); we never hold the key |
| `POST /licensing/relay/messages` · `GET /licensing/relay/messages/:id` | 〃 | SMS / WhatsApp / email through our providers, idempotent by `client_ref`, metered per licence & month (`RELAY_MONTHLY_QUOTA`) |
| `POST /connect/otp/request` · `POST /connect/otp/verify` | none (rate limited) | licensee phone OTP → connect token (`X-Kadai-Connect-Token`) |
| `GET /connect/shops` · `GET /connect/shops/:activationId/snapshot` | connect token | the owner's shops and their latest dashboard snapshot (another owner's shop → 404) |

Signed requests: headers `X-Kadai-Installation`, `X-Kadai-Timestamp` (unix seconds) and
`X-Kadai-Signature` (base64 Ed25519 over `METHOD\npath+query\ntimestamp\nsha256(body)`), ±10 min
skew, replayed signatures refused. Jobs: `licensing.fulfil-order` (on payment),
`licensing.renewal-reminders` (daily 10:00 IST: 30/15/7/1 days before, 7/30 days after; customer +
partner), `licensing.stale-installations` (no check-in for 45 days), `licensing.backup-retention`.

## on-prem system

Route catalogue: `onpremRoutes` in `@kadai/shared/api/onprem` (supersedes the old `/system/license`
and `/system/backups` lines). All routes are mode `onprem` (404 in cloud) and need
`settings.manage` unless noted. Every vendor call (`KADAI_VENDOR_URL`, default
`https://kadai.app`) is optional; an unreachable vendor is 502 `PROVIDER_ERROR`
`{reason: 'vendor_unreachable'}` and vendor errors are relayed with their `LICENSING_ERROR_REASONS`
reason. Licence verification stays local (core/license.ts): perpetual licences never need the
internet.

| Method & path | perm | Notes |
|---|---|---|
| `GET /system/license` | `settings.manage` | `LicenseStatusView`: state none/valid/grace/expired/not_yet_valid/tampered, edition, type, licensee, entitlements (limits), validity, AMC (`updates_until`), support, activation method, last vendor status |
| `POST /system/license/activate` `{license_key}` | 〃 | online activation (vendor) → stored licence, entitlements invalidated; allowed in read-only mode |
| `GET /system/license/activation-request` · `PUT /system/license` `{license}` | 〃 | offline: signed request (file / `KDREQ1.` code / QR, no secret inside) → licence file (`.kadai-license` JSON or `KDLIC1.` code) verified locally; PUT allowed in read-only mode |
| `POST /system/license/refresh` · `POST /system/license/deactivate` `{confirm}` | 〃 | refreshed licence after renewal; move to a new computer (vendor frees the seat first, audited) |
| `GET /system/vendor-state` · `POST /system/check-in` · `POST /system/banners/:id/dismiss` | vendor-state & dismiss: any member | last check-in: visible banners, offers with quotes, renewal, releases, add-on entitlements, support contacts, AMC status |
| `POST /system/renewal-quote` · `POST /system/renewal-checkout` `{items, coupon_code?}` | 〃 | live quote / payment URL; the extended licence arrives with the next check-in or refresh |
| `GET /system/updates?refresh=` · `POST /system/updates/install` `{version}` (202) · `GET /system/updates/status` | 〃 | eligible releases (AMC), stepping stones; install = pre_upgrade backup + `KADAI_DATA_DIR/updates/request.json`; status from `status.json` written by the host updater |
| `L/C /system/backups` · `GET /system/backups/:id/download` · `POST /system/backups/:id/restore-request` (202) | 〃 | `pg_dump -Fc` (202, background), retention 14 daily + 12 monthly + 10 manual (+5 pre-upgrade) `backupsToPrune`; restore only through the host updater (typed confirmation) |
| `GET/PUT /system/backup-settings` · `POST /system/backup-settings/test-path` | 〃 | schedule (default 23:00 IST), retention, external drive / USB folder, cloud upload |
| `GET /system/backups/cloud` · `POST …/cloud/setup` · `POST …/cloud/confirm` · `POST /system/backups/:id/upload-cloud` · `POST /system/backups/cloud/:cloudId/download` | 〃 (+feat `cloud_backup` for writes) | recovery code shown once (only a verifier stored); AES-256-GCM, scrypt key (`CLOUD_BACKUP_ENCRYPTION`) |
| `GET/PUT /system/connect` | 〃 (+feat `connect` for PUT) | Kadai Connect opt-in |
| `GET /system/network` | `settings.manage` or `pos.use` | LAN addresses, app/POS URLs for counters & phones, firewall command |
| `GET /system/disk` · `POST /system/support-bundle` | `settings.manage` | free space (warn < 2 GB); tar.gz with version, redacted config (`redactConfig`), migrations, logs, disk, last check-in — never database data |

Jobs: `onprem.check-in` (every 6 h when online + on demand; backoff `checkInDelaySeconds`),
`onprem.backup` (daily at the configured time), `onprem.cloud-backup-upload`. The messaging relay
is the notifications provider `kadai_relay` (used when no own SMS/WhatsApp provider is set).

## health

`GET /health/live` · `GET /health/ready` · `GET /metrics` (Prometheus; protect with `METRICS_TOKEN`).
