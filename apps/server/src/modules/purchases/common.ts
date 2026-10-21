/**
 * Shared helpers of the purchases module: errors with `details.reason`, business dates, store /
 * supplier / product lookups (with store scoping and "purchasable" checks), latest purchase
 * costs, stock on hand, user names, advisory locks, CSV replies and payment references. Every
 * function runs inside the caller's tenant transaction (req.tx / withTenant).
 */
import type { FastifyReply } from 'fastify'
import { type SelectQueryBuilder, sql } from 'kysely'
import {
  type ErrorCode,
  type PaymentMethod,
  type PaymentStatus,
  stateCodeFromGstin,
  todayIn,
} from '@kadai/shared'
import { AddressSchema } from '@kadai/shared/api/common'
import { paymentOriginOf } from '@kadai/shared/api/payments'
import type { PurchasesErrorReason, PurchasesValidationKey } from '@kadai/shared/api/purchases'
import type { RequestContext } from '../../core/context'
import { AppError, notFound, validationError } from '../../core/errors'
import { type PageEnvelope, type PageParams, assertStoreAccess } from '../../core/http'
import { tenantCalendar } from '../../core/numbering'
import type { Tx } from '../../db/tenant'

export type Ctx = RequestContext

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** AppError carrying `details.reason` (PURCHASES_ERROR_REASONS). */
export function reasonError(
  code: ErrorCode,
  reason: PurchasesErrorReason,
  message: string,
  details: Record<string, unknown> = {},
): AppError {
  return new AppError(code, message, { reason, ...details })
}

/** 400 VALIDATION_ERROR with snake_case message keys (PURCHASES_VALIDATION_KEYS). */
export function fieldIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; key: PurchasesValidationKey }>,
): AppError {
  return validationError(
    issues.map((i) => ({ path: i.path.join('.'), message: i.key, code: i.key })),
  )
}

export function fieldIssue(
  path: ReadonlyArray<string | number>,
  key: PurchasesValidationKey,
): AppError {
  return fieldIssues([{ path, key }])
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

export interface BusinessCalendar {
  today: string
  timezone: string
  fyStartMonth: number
}

/** Today in the tenant timezone plus the tenant calendar. */
export async function businessToday(tx: Tx, ctx: Pick<Ctx, 'tenantId'>): Promise<BusinessCalendar> {
  const cal = await tenantCalendar(tx, ctx)
  return { today: todayIn(cal.timezone), timezone: cal.timezone, fyStartMonth: cal.fyStartMonth }
}

/** Timestamp column → ISO string. */
export function iso(value: Date | string): string
export function iso(value: Date | string | null): string | null
export function iso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

// ---------------------------------------------------------------------------------------------
// Tenant, stores, suppliers
// ---------------------------------------------------------------------------------------------

export interface TenantInfo {
  name: string
  gst_scheme: string
  state_code: string
}

export async function loadTenant(tx: Tx, ctx: Pick<Ctx, 'tenantId'>): Promise<TenantInfo> {
  const row = await tx
    .selectFrom('tenants')
    .select(['name', 'gst_scheme', 'state_code'])
    .where('id', '=', ctx.tenantId)
    .executeTakeFirst()
  if (!row) throw notFound('tenant', ctx.tenantId)
  return row
}

export interface StoreInfo {
  id: string
  code: string
  name: string
  state_code: string
  is_active: boolean
}

/** Loads a store the member may act on (403 otherwise); `requireActive` → 422 store_inactive. */
export async function loadStore(
  tx: Tx,
  ctx: Ctx,
  storeId: string,
  opts: { requireActive?: boolean } = {},
): Promise<StoreInfo> {
  assertStoreAccess(ctx, storeId)
  const row = await tx
    .selectFrom('stores')
    .select(['id', 'code', 'name', 'state_code', 'is_active'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', storeId)
    .executeTakeFirst()
  if (!row) throw notFound('store', storeId)
  if (opts.requireActive && !row.is_active) {
    throw reasonError('UNPROCESSABLE', 'store_inactive', `Store ${row.code} is deactivated`, {
      store_id: row.id,
    })
  }
  return row
}

export interface SupplierInfo {
  id: string
  name: string
  phone: string | null
  gstin: string | null
  /** Effective state: the supplier's state code, else the GSTIN's. */
  state_code: string | null
  address: ReturnType<typeof AddressSchema.parse> | null
  drug_license_no: string | null
  balance_paise: number
  payment_terms_days: number | null
  is_active: boolean
}

const SUPPLIER_COLUMNS = [
  'id',
  'name',
  'phone',
  'gstin',
  'state_code',
  'address',
  'drug_license_no',
  'balance_paise',
  'payment_terms_days',
  'is_active',
] as const

type SupplierRow = {
  id: string
  name: string
  phone: string | null
  gstin: string | null
  state_code: string | null
  address: unknown
  drug_license_no: string | null
  balance_paise: number
  payment_terms_days: number | null
  is_active: boolean
}

function toSupplierInfo(row: SupplierRow): SupplierInfo {
  const address = AddressSchema.safeParse(row.address ?? {})
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    gstin: row.gstin,
    state_code: row.state_code ?? (row.gstin ? stateCodeFromGstin(row.gstin) : null),
    address: address.success ? address.data : null,
    drug_license_no: row.drug_license_no,
    balance_paise: row.balance_paise,
    payment_terms_days: row.payment_terms_days,
    is_active: row.is_active,
  }
}

export async function loadSupplier(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  supplierId: string,
  opts: { requireActive?: boolean } = {},
): Promise<SupplierInfo> {
  const row = await tx
    .selectFrom('suppliers')
    .select(SUPPLIER_COLUMNS)
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', supplierId)
    .executeTakeFirst()
  if (!row) throw notFound('supplier', supplierId)
  if (opts.requireActive && !row.is_active) {
    throw reasonError('UNPROCESSABLE', 'supplier_inactive', `Supplier ${row.name} is deactivated`, {
      supplier_id: row.id,
    })
  }
  return toSupplierInfo(row)
}

/** SupplierRef of the contract (detail responses). */
export function supplierRef(s: SupplierInfo): {
  id: string
  name: string
  phone: string | null
  gstin: string | null
  state_code: string | null
  address: SupplierInfo['address']
  drug_license_no: string | null
  balance_paise: number
  payment_terms_days: number | null
} {
  return {
    id: s.id,
    name: s.name,
    phone: s.phone,
    gstin: s.gstin,
    state_code: s.state_code,
    address: s.address,
    drug_license_no: s.drug_license_no,
    balance_paise: s.balance_paise,
    payment_terms_days: s.payment_terms_days,
  }
}

/** Inter-state purchase: the supplier's state differs from the store's (unknown → intra-state). */
export function supplyIsInterstate(store: { state_code: string }, supplier: SupplierInfo): boolean {
  return supplier.state_code !== null && supplier.state_code !== store.state_code
}

// ---------------------------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------------------------

export interface ProductInfo {
  id: string
  name: string
  name_ta: string | null
  sku: string | null
  kind: string
  unit: string
  pack_size: number
  hsn_code: string | null
  gst_rate_bp: number
  cess_rate_bp: number
  price_includes_tax: boolean
  mrp_paise: number | null
  sale_price_paise: number
  purchase_price_paise: number
  track_inventory: boolean
  track_batches: boolean
  is_active: boolean
  category_id: string | null
  reorder_level_milli: number | null
  reorder_qty_milli: number | null
}

export const PRODUCT_COLUMNS = [
  'id',
  'name',
  'name_ta',
  'sku',
  'kind',
  'unit',
  'pack_size',
  'hsn_code',
  'gst_rate_bp',
  'cess_rate_bp',
  'price_includes_tax',
  'mrp_paise',
  'sale_price_paise',
  'purchase_price_paise',
  'track_inventory',
  'track_batches',
  'is_active',
  'category_id',
  'reorder_level_milli',
  'reorder_qty_milli',
] as const

export async function loadProducts(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  ids: readonly string[],
  opts: { lock?: boolean } = {},
): Promise<Map<string, ProductInfo>> {
  const unique = [...new Set(ids)].sort()
  if (unique.length === 0) return new Map()
  let q = tx
    .selectFrom('products')
    .select(PRODUCT_COLUMNS)
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', 'in', unique)
    .orderBy('id')
  if (opts.lock) q = q.forUpdate()
  const rows = await q.execute()
  const map = new Map(rows.map((r) => [r.id, r]))
  for (const id of unique) if (!map.has(id)) throw notFound('product', id)
  return map
}

/** ProductRef of the contract. */
export function productRef(p: ProductInfo): {
  id: string
  name: string
  name_ta: string | null
  sku: string | null
  unit: string
  pack_size: number
  hsn_code: string | null
  track_batches: boolean
} {
  return {
    id: p.id,
    name: p.name,
    name_ta: p.name_ta,
    sku: p.sku,
    unit: p.unit,
    pack_size: p.pack_size,
    hsn_code: p.hsn_code,
    track_batches: p.track_batches,
  }
}

/** Services, variant templates and deactivated products cannot be bought into stock (422). */
export function assertPurchasable(p: ProductInfo, lineNo: number): void {
  if (p.kind === 'service' || p.kind === 'variant_parent' || !p.track_inventory || !p.is_active) {
    const why =
      p.kind === 'variant_parent'
        ? 'is a variant template; buy its variants'
        : !p.is_active
          ? 'is deactivated'
          : 'does not track stock'
    throw reasonError('UNPROCESSABLE', 'product_not_purchasable', `${p.name} ${why}`, {
      product_id: p.id,
      line_no: lineNo,
    })
  }
}

// ---------------------------------------------------------------------------------------------
// Stock and purchase history
// ---------------------------------------------------------------------------------------------

/** On-hand quantity per product (all batches) at a store. */
export async function stockByProduct(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  storeId: string,
  productIds: readonly string[],
): Promise<Map<string, number>> {
  const ids = [...new Set(productIds)]
  if (ids.length === 0) return new Map()
  const rows = await tx
    .selectFrom('stock_levels')
    .select(['product_id', sql<number>`coalesce(sum(qty_milli), 0)::bigint`.as('qty')])
    .where('tenant_id', '=', ctx.tenantId)
    .where('store_id', '=', storeId)
    .where('product_id', 'in', ids)
    .groupBy('product_id')
    .execute()
  return new Map(rows.map((r) => [r.product_id, Number(r.qty)]))
}

/** On-hand quantity per batch at a store. */
export async function stockByBatch(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  storeId: string,
  batchIds: readonly string[],
): Promise<Map<string, number>> {
  const ids = [...new Set(batchIds)]
  if (ids.length === 0) return new Map()
  const rows = await tx
    .selectFrom('stock_levels')
    .select(['batch_id', 'qty_milli'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('store_id', '=', storeId)
    .where('batch_id', 'in', ids)
    .execute()
  const map = new Map<string, number>()
  for (const r of rows)
    if (r.batch_id) map.set(r.batch_id, (map.get(r.batch_id) ?? 0) + r.qty_milli)
  return map
}

export interface LastPurchase {
  product_id: string
  bill_id: string
  bill_line_id: string
  bill_number: string | null
  supplier_id: string
  supplier_name: string
  supplier_phone: string | null
  received_date: string
  /** Supplier rate per pack (excl. tax, before discount) of that line. */
  unit_cost_paise: number
  landed_unit_cost_paise: number
}

/**
 * The latest posted bill line per product (by received date, then posting time), optionally
 * ignoring one bill (the bill being shown).
 */
export async function lastPurchases(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  productIds: readonly string[],
  opts: { excludeBillId?: string } = {},
): Promise<Map<string, LastPurchase>> {
  const ids = [...new Set(productIds)]
  if (ids.length === 0) return new Map()
  let q = tx
    .selectFrom('purchase_bill_lines as l')
    .innerJoin('purchase_bills as b', (j) =>
      j.onRef('b.tenant_id', '=', 'l.tenant_id').onRef('b.id', '=', 'l.bill_id'),
    )
    .innerJoin('suppliers as s', (j) =>
      j.onRef('s.tenant_id', '=', 'b.tenant_id').onRef('s.id', '=', 'b.supplier_id'),
    )
    .distinctOn('l.product_id')
    .select([
      'l.product_id',
      'b.id as bill_id',
      'l.id as bill_line_id',
      'b.number as bill_number',
      'b.supplier_id',
      's.name as supplier_name',
      's.phone as supplier_phone',
      'b.received_date',
      'l.unit_cost_paise',
      'l.landed_unit_cost_paise',
    ])
    .where('l.tenant_id', '=', ctx.tenantId)
    .where('l.product_id', 'in', ids)
    .where('b.status', '=', 'posted')
  if (opts.excludeBillId) q = q.where('b.id', '<>', opts.excludeBillId)
  const rows = await q
    .orderBy('l.product_id')
    .orderBy('b.received_date', 'desc')
    .orderBy(sql`b.posted_at desc nulls last`)
    .orderBy('l.line_no', 'desc')
    .execute()
  return new Map(rows.map((r) => [r.product_id, r]))
}

// ---------------------------------------------------------------------------------------------
// Users, payments
// ---------------------------------------------------------------------------------------------

/** full_name per user id (ids may be null). */
export async function userNames(
  tx: Tx,
  ids: ReadonlyArray<string | null>,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => x !== null))]
  if (unique.length === 0) return new Map()
  const rows = await tx
    .selectFrom('users')
    .select(['id', 'full_name'])
    .where('id', 'in', unique)
    .execute()
  return new Map(rows.map((r) => [r.id, r.full_name]))
}

export interface PaymentRef {
  payment_id: string
  number: string | null
  method: PaymentMethod
  amount_paise: number
  payment_date: string
  reference: string | null
  status: PaymentStatus
  origin: ReturnType<typeof paymentOriginOf>
}

/** Payments allocated to a document (all statuses; cancelled ones are history). */
export async function paymentsFor(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  targetType: 'purchase_bill' | 'debit_note',
  targetId: string,
): Promise<PaymentRef[]> {
  const rows = await tx
    .selectFrom('payment_allocations as a')
    .innerJoin('payments as p', (j) =>
      j.onRef('p.tenant_id', '=', 'a.tenant_id').onRef('p.id', '=', 'a.payment_id'),
    )
    .select([
      'p.id as payment_id',
      'p.number',
      'p.method',
      'a.amount_paise',
      'p.payment_date',
      'p.reference',
      'p.status',
      'p.client_ref',
    ])
    .where('a.tenant_id', '=', ctx.tenantId)
    .where('a.target_type', '=', targetType)
    .where('a.target_id', '=', targetId)
    .orderBy('p.payment_date')
    .orderBy('p.created_at')
    .execute()
  return rows.map((r) => ({
    payment_id: r.payment_id,
    number: r.number,
    method: r.method as PaymentMethod,
    amount_paise: r.amount_paise,
    payment_date: r.payment_date,
    reference: r.reference,
    status: r.status as PaymentStatus,
    origin: paymentOriginOf(r.client_ref),
  }))
}

/** First not-reversed journal entry of a source document (null when nothing was posted). */
export async function journalEntryOf(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  sourceType: 'purchase_bill' | 'debit_note',
  sourceId: string,
): Promise<string | null> {
  const row = await tx
    .selectFrom('journal_entries')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('source_type', '=', sourceType)
    .where('source_id', '=', sourceId)
    .where('reverses_entry_id', 'is', null)
    .orderBy('created_at')
    .orderBy('id')
    .executeTakeFirst()
  return row?.id ?? null
}

// ---------------------------------------------------------------------------------------------
// Locks, scoping, CSV
// ---------------------------------------------------------------------------------------------

/** Transaction-scoped advisory lock on an arbitrary key (serialises e.g. duplicate checks). */
export async function advisoryLock(tx: Tx, key: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(tx)
}

/**
 * Store filter of a list: the requested store (403 when outside the member's stores) and/or the
 * member's store scope. Returns null when every store is visible.
 */
export function storeFilter(ctx: Ctx, storeId: string | undefined): readonly string[] | null {
  if (storeId) {
    assertStoreAccess(ctx, storeId)
    return [storeId]
  }
  return ctx.storeIds
}

export function sendCsv(reply: FastifyReply, filename: string, csv: string): FastifyReply {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_')
  return reply
    .code(200)
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${safe}"`)
    .send(Buffer.from(csv, 'utf8'))
}

/** Rupees with two decimals for CSV cells (no symbol / grouping, spreadsheet friendly). */
export function csvRupees(paise: number): string {
  const sign = paise < 0 ? '-' : ''
  const abs = Math.abs(paise)
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/**
 * Pagination for queries with aliased tables (core paginate() only accepts un-aliased DB tables):
 * `count(*) over()` in the same round trip; past the end it counts separately.
 */
export async function paginateQuery<D, T extends keyof D, O>(
  qb: SelectQueryBuilder<D, T, O>,
  page: PageParams,
): Promise<PageEnvelope<O>> {
  const rows = (await qb
    .select(sql<number>`count(*) over()`.as('__total'))
    .limit(page.limit)
    .offset(page.offset)
    .execute()) as Array<O & { __total: number | string }>
  let total = 0
  if (rows.length > 0) total = Number(rows[0]!.__total)
  else if (page.offset > 0) {
    const c = (await qb
      .clearSelect()
      .clearOrderBy()
      .select(sql<number>`count(*)`.as('n'))
      .executeTakeFirst()) as { n: number | string } | undefined
    total = Number(c?.n ?? 0)
  }
  const data = rows.map((r) => {
    const { __total: _omit, ...rest } = r
    return rest as unknown as O
  })
  return { data, page: { limit: page.limit, offset: page.offset, total } }
}

/** Maximum rows of a CSV export. */
export const CSV_MAX_ROWS = 50_000
