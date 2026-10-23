/**
 * Sales pricing service — builds a priced document from cart input with the shared engine
 * (`priceCart()` from @kadai/shared/api/sales, identical to the POS), after resolving everything
 * the server is authoritative for:
 *
 *  - products, store price overrides (feature store_pricing), wholesale price tier, batch prices
 *    (resolveUnitPrice), tax slab rules (price-slab GST), active promotions (feature promotions),
 *    loyalty redemption (feature loyalty), the tenant's GST scheme → doc type / tax mode, place of
 *    supply (default: the store's state);
 *  - batch-tracked products without a batch: FEFO auto-pick (core pickBatchesFefo), SPLITTING the
 *    line across batches when one batch is not enough (keys `key`, `key#2`… + a `fefo_split`
 *    warning);
 *  - validations as typed issues: price overrides (sales.price_override unless
 *    settings.pos.allow_price_edit; never below min_sale_price without it), discounts above the
 *    cashier limit (sales.discount_override), expired batches (settings.inventory
 *    .block_expired_sale → EXPIRED_BATCH), schedule H/H1/X without rx (RX_REQUIRED), stock per the
 *    negative-stock policy, serial numbers, tenders (allocateTenders, UPI intents, store credit),
 *    credit (customer + sales.credit + feature khata + credit limit / audited override), back
 *    dating and the open-shift requirement.
 *
 * Severity depends on the mode: `quote` / `commit` treat every rule as blocking; `draft` (held
 * bills) only blocks structural problems; `estimate` skips stock / rx / tenders; `sync` (offline
 * bills that already happened) only blocks what cannot be posted at all and reports the rest as
 * warnings. The caller throws the first blocking issue with {@link assertNoBlocking}.
 */
import {
  type Feature,
  type PromotionLike,
  PromotionSchema,
  type SalesChannel,
  type TaxSlab,
  TaxSlabsSchema,
  allocateProRata,
  mulDiv,
} from '@kadai/shared'
import { loyaltyPointsForAmount } from '@kadai/shared/api/parties'
import type { Address } from '@kadai/shared/api/common'
import {
  type CartLine,
  type CartPricingLine,
  type CartPricingResult,
  type PriceSource,
  type PricedLine,
  type QuoteResult,
  type Rx,
  SALES_BACKDATE_PERMISSION,
  type SalesIssue,
  type SalesIssueCode,
  type Tender,
  type TenderAllocationLine,
  allocateTenders,
  batchExpiryStatus,
  cartLineKey,
  creditCheck,
  discountLimitBp,
  drugScheduleOf,
  lineRequiresRx,
  priceCart,
  qtyIssue,
  resolveUnitPrice,
  salesDocumentModeFor,
  splitLineKey,
} from '@kadai/shared/api/sales'
import type { DrugSchedule } from '@kadai/shared'
import { sql } from 'kysely'
import type { Tx } from '../../db/tenant'
import { invalidField, isAppError } from '../../core/errors'
import { pickBatchesFefo } from '../../core/inventory'
import { storeCreditBalance } from '../../core/payments'
import {
  type CustomerInfo,
  type JsonRecord,
  type OpenShift,
  type RegisterInfo,
  type SalesCtx,
  type SalesEnv,
  type StoreInfo,
  addressOf,
  can,
  loadCustomer,
  loadRegister,
  loadStore,
  openShiftOf,
  recordOf,
  salesEnv,
  stringRecordOf,
} from './common'

export type PricingMode = 'quote' | 'commit' | 'draft' | 'estimate' | 'sync'

export interface CustomerSnapshotIn {
  name: string
  phone?: string | null | undefined
  gstin?: string | null | undefined
  address?: Address | undefined
  state_code?: string | undefined
}

/** Cart of a quote / bill / held bill / estimate / offline bill (parsed request shapes). */
export interface SaleInput {
  store_id: string
  register_id?: string | null | undefined
  customer_id?: string | null | undefined
  customer?: CustomerSnapshotIn | null | undefined
  place_of_supply?: string | null | undefined
  lines: readonly CartLine[]
  bill_discount_bp?: number | undefined
  bill_discount_paise?: number | undefined
  loyalty_redeem_points?: number | undefined
  rx?: Rx | null | undefined
  /** undefined = tenders not evaluated (quote without tenders, drafts, estimates). */
  tenders?: readonly Tender[] | undefined
  credit_limit_override?: boolean | undefined
  invoice_date?: string | null | undefined
  channel?: SalesChannel | undefined
}

export interface PricingOptions {
  mode: PricingMode
  /** Instant promotions are evaluated at (offline bills: their creation instant). */
  now?: Date
  /**
   * Cart line keys whose price and discount were authorised earlier (estimate conversion with
   * keep_prices): no override checks.
   */
  trustedKeys?: ReadonlySet<string>
}

export interface PricedSaleLine extends PricedLine {
  /** Manual discount bp (sales_invoice_lines.discount_bp). */
  discount_bp: number
  promotion_id: string | null
  track_inventory: boolean
  batch_tracked: boolean
  batch_auto: boolean
  /** Current average cost per pack (internal; COGS comes from postStock). */
  avg_cost_paise: number
  meta: JsonRecord
}

export interface SaleSnapshot {
  name: string | null
  phone: string | null
  gstin: string | null
  address: Address | null
  state_code: string | null
}

export interface PricedSale {
  env: SalesEnv
  mode: PricingMode
  store: StoreInfo
  register: RegisterInfo | null
  shift: OpenShift | null
  customer: CustomerInfo | null
  snapshot: SaleSnapshot
  doc_type: 'tax_invoice' | 'bill_of_supply' | 'estimate'
  tax_mode: 'regular' | 'composition' | 'unregistered'
  place_of_supply: string
  is_interstate: boolean
  price_includes_tax: boolean
  invoice_date: string
  lines: PricedSaleLine[]
  totals: CartPricingResult
  /** allocateTenders result (null when tenders were not evaluated). */
  tenders: {
    lines: TenderAllocationLine[]
    paid_paise: number
    change_paise: number
    due_paise: number
  } | null
  due_paise: number
  issues: SalesIssue[]
  quote: QuoteResult
  overrides: {
    price_keys: string[]
    discount_keys: string[]
    bill_discount: boolean
    credit_limit: boolean
    backdated: boolean
  }
  /** Header meta (sales_invoices.meta): what re-pricing a held bill needs. */
  meta: JsonRecord
  rx: Rx | null
}

// ---------------------------------------------------------------------------------------------
// Issue severity
// ---------------------------------------------------------------------------------------------

type IssueClass = 'structural' | 'qty' | 'payment' | 'override' | 'policy' | 'warning'

const ISSUE_CLASS: Readonly<Record<SalesIssueCode, IssueClass>> = {
  empty_cart: 'structural',
  product_not_found: 'structural',
  not_sellable: 'structural',
  batch_not_found: 'structural',
  product_inactive: 'qty',
  decimal_qty_not_allowed: 'qty',
  loose_not_allowed: 'qty',
  tender_exceeds_due: 'payment',
  cash_tender_not_needed: 'payment',
  payment_intent_invalid: 'payment',
  store_credit_insufficient: 'payment',
  loyalty_disabled: 'payment',
  loyalty_insufficient: 'payment',
  loyalty_below_minimum: 'payment',
  price_override_required: 'override',
  below_min_price: 'override',
  discount_override_required: 'override',
  expired_batch: 'policy',
  insufficient_stock: 'policy',
  serial_numbers_required: 'policy',
  rx_required: 'policy',
  credit_permission_required: 'policy',
  customer_required_for_credit: 'policy',
  credit_not_in_plan: 'policy',
  credit_limit_exceeded: 'policy',
  backdate_not_allowed: 'policy',
  shift_required: 'policy',
  near_expiry: 'warning',
  low_stock: 'warning',
  negative_stock: 'warning',
  price_above_mrp: 'warning',
  price_below_cost: 'warning',
  fefo_split: 'warning',
  over_credit_limit: 'warning',
  offline_negative_stock: 'warning',
}

function severityOf(code: SalesIssueCode, mode: PricingMode): 'error' | 'warning' {
  const c = ISSUE_CLASS[code]
  if (c === 'warning') return 'warning'
  if (c === 'structural') return 'error'
  switch (mode) {
    case 'quote':
    case 'commit':
      return 'error'
    case 'draft':
      return c === 'qty' ? 'error' : 'warning'
    case 'estimate':
      return c === 'policy' ? 'warning' : 'error'
    case 'sync':
      return c === 'payment' ? 'error' : 'warning'
  }
}

type ParamValue = string | number | boolean | null

class IssueList {
  readonly list: SalesIssue[] = []
  private readonly seen = new Set<string>()
  constructor(private readonly mode: PricingMode) {}
  add(code: SalesIssueCode, lineKey: string | null, params: Record<string, ParamValue> = {}): void {
    const id = `${code}|${lineKey ?? ''}`
    if (this.seen.has(id)) return
    this.seen.add(id)
    this.list.push({ code, severity: severityOf(code, this.mode), line_key: lineKey, params })
  }
  has(code: SalesIssueCode, severity?: 'error' | 'warning'): boolean {
    return this.list.some((i) => i.code === code && (!severity || i.severity === severity))
  }
}

// ---------------------------------------------------------------------------------------------
// Catalogue data
// ---------------------------------------------------------------------------------------------

export interface ProductRow {
  id: string
  kind: string
  name: string
  name_ta: string | null
  hsn_code: string | null
  unit: string
  pack_size: number
  allow_loose: boolean
  decimal_qty: boolean
  gst_rate_bp: number
  cess_rate_bp: number
  tax_slab_rule_id: string | null
  category_tax_slab_rule_id: string | null
  price_includes_tax: boolean
  mrp_paise: number | null
  sale_price_paise: number
  wholesale_price_paise: number | null
  purchase_price_paise: number
  min_sale_price_paise: number | null
  max_discount_bp: number | null
  track_inventory: boolean
  track_batches: boolean
  reorder_level_milli: number | null
  variant_attributes: unknown
  attributes: unknown
  is_active: boolean
  category_id: string | null
  brand_id: string | null
}

export async function loadProducts(
  tx: Tx,
  ctx: Pick<SalesCtx, 'tenantId'>,
  ids: readonly string[],
): Promise<Map<string, ProductRow>> {
  if (ids.length === 0) return new Map()
  const rows = await tx
    .selectFrom('products as p')
    .leftJoin('categories as c', (j) =>
      j.onRef('c.tenant_id', '=', 'p.tenant_id').onRef('c.id', '=', 'p.category_id'),
    )
    .select([
      'p.id',
      'p.kind',
      'p.name',
      'p.name_ta',
      'p.hsn_code',
      'p.unit',
      'p.pack_size',
      'p.allow_loose',
      'p.decimal_qty',
      'p.gst_rate_bp',
      'p.cess_rate_bp',
      'p.tax_slab_rule_id',
      'c.tax_slab_rule_id as category_tax_slab_rule_id',
      'p.price_includes_tax',
      'p.mrp_paise',
      'p.sale_price_paise',
      'p.wholesale_price_paise',
      'p.purchase_price_paise',
      'p.min_sale_price_paise',
      'p.max_discount_bp',
      'p.track_inventory',
      'p.track_batches',
      'p.reorder_level_milli',
      'p.variant_attributes',
      'p.attributes',
      'p.is_active',
      'p.category_id',
      'p.brand_id',
    ])
    .where('p.tenant_id', '=', ctx.tenantId)
    .where('p.id', 'in', [...new Set(ids)])
    .execute()
  return new Map(rows.map((r) => [r.id, r]))
}

export interface BatchRow {
  id: string
  product_id: string
  batch_no: string
  expiry_date: string | null
  mrp_paise: number | null
  sale_price_paise: number | null
  purchase_price_paise: number | null
  is_active: boolean
}

async function loadBatches(
  tx: Tx,
  ctx: Pick<SalesCtx, 'tenantId'>,
  ids: readonly string[],
  into: Map<string, BatchRow>,
): Promise<void> {
  const missing = [...new Set(ids)].filter((id) => !into.has(id))
  if (missing.length === 0) return
  const rows = await tx
    .selectFrom('batches')
    .select([
      'id',
      'product_id',
      'batch_no',
      'expiry_date',
      'mrp_paise',
      'sale_price_paise',
      'purchase_price_paise',
      'is_active',
    ])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', 'in', missing)
    .execute()
  for (const r of rows) into.set(r.id, r)
}

interface StockRow {
  qty: number
  avg: number
}

const stockKey = (productId: string, batchId: string | null): string =>
  `${productId}:${batchId ?? ''}`

async function loadStock(
  tx: Tx,
  ctx: Pick<SalesCtx, 'tenantId'>,
  storeId: string,
  productIds: readonly string[],
): Promise<Map<string, StockRow>> {
  const out = new Map<string, StockRow>()
  if (productIds.length === 0) return out
  const rows = await tx
    .selectFrom('stock_levels')
    .select(['product_id', 'batch_id', 'qty_milli', 'avg_cost_paise'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('store_id', '=', storeId)
    .where('product_id', 'in', [...new Set(productIds)])
    .execute()
  for (const r of rows) {
    out.set(stockKey(r.product_id, r.batch_id), { qty: r.qty_milli, avg: r.avg_cost_paise })
  }
  return out
}

function productStock(stock: Map<string, StockRow>, productId: string): number {
  let total = 0
  for (const [k, v] of stock) if (k.startsWith(`${productId}:`)) total += v.qty
  return total
}

async function loadSlabRules(
  tx: Tx,
  ctx: Pick<SalesCtx, 'tenantId'>,
  ids: readonly string[],
): Promise<Map<string, TaxSlab[]>> {
  const out = new Map<string, TaxSlab[]>()
  const unique = [...new Set(ids)]
  if (unique.length === 0) return out
  const rows = await tx
    .selectFrom('tax_slab_rules')
    .select(['id', 'slabs'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', 'in', unique)
    .where('is_active', '=', true)
    .execute()
  for (const r of rows) {
    const parsed = TaxSlabsSchema.safeParse(r.slabs)
    if (parsed.success) out.set(r.id, parsed.data)
  }
  return out
}

/** Active promotions of a store at an instant (parsed; invalid rows are ignored). */
export async function loadActivePromotions(
  tx: Tx,
  ctx: Pick<SalesCtx, 'tenantId'>,
  storeId: string,
  now: Date,
): Promise<Array<PromotionLike & { name_ta?: string | null | undefined }>> {
  const rows = await tx
    .selectFrom('promotions')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('is_active', '=', true)
    .where((eb) => eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', now)]))
    .where((eb) => eb.or([eb('starts_at', 'is', null), eb('starts_at', '<=', now)]))
    .where((eb) =>
      eb.or([
        eb('store_ids', 'is', null),
        eb(sql<string>`${storeId}::uuid`, '=', sql<string>`any(store_ids)`),
      ]),
    )
    .execute()
  const out: Array<PromotionLike & { name_ta?: string | null | undefined }> = []
  for (const r of rows) {
    const parsed = promotionFromRow(r)
    if (parsed) out.push(parsed)
  }
  return out
}

export function promotionFromRow(r: {
  id: string
  name: string
  name_ta: string | null
  kind: string
  rules: unknown
  store_ids: string[] | null
  starts_at: Date | null
  ends_at: Date | null
  days_of_week: number[] | null
  priority: number
  stackable: boolean
  is_active: boolean
}): (PromotionLike & { name_ta?: string | null | undefined }) | null {
  const parsed = PromotionSchema.safeParse({
    id: r.id,
    name: r.name,
    name_ta: r.name_ta,
    kind: r.kind,
    rules: r.rules,
    store_ids: r.store_ids,
    starts_at: r.starts_at ? r.starts_at.toISOString() : null,
    ends_at: r.ends_at ? r.ends_at.toISOString() : null,
    days_of_week: r.days_of_week,
    priority: r.priority,
    stackable: r.stackable,
    is_active: r.is_active,
  })
  return parsed.success ? parsed.data : null
}

// ---------------------------------------------------------------------------------------------
// The pricing service
// ---------------------------------------------------------------------------------------------

interface Part {
  key: string
  source_key: string
  line: CartLine
  product: ProductRow | null
  batch: BatchRow | null
  batch_auto: boolean
  qty_milli: number
  discount_paise: number
  serial_numbers: string[]
  unit_price_paise: number
  resolved_price_paise: number
  price_source: PriceSource
  mrp_paise: number | null
  avg_cost_paise: number
  available_qty_milli: number | null
  tax_slab_rule_id: string | null
  tax_slabs: TaxSlab[] | null
}

const isBatchTracked = (p: ProductRow): boolean => p.track_inventory && p.track_batches

/** Prices a cart (see the module comment). It never writes; commit/sync lock the customer row. */
export async function priceSale(
  tx: Tx,
  ctx: SalesCtx,
  input: SaleInput,
  opts: PricingOptions,
): Promise<PricedSale> {
  const { mode } = opts
  const env = await salesEnv(tx, ctx)
  const { settings, features } = env
  const issues = new IssueList(mode)
  const now = opts.now ?? new Date()
  const trusted = opts.trustedKeys ?? new Set<string>()
  const stockMode = mode !== 'estimate'

  const store = await loadStore(tx, ctx, input.store_id)
  const register = input.register_id
    ? await loadRegister(tx, ctx, input.register_id, store.id, {
        requireActive: mode !== 'sync',
      })
    : null
  // Posting locks the customer first: concurrent credit sales of one customer serialise on it
  // (credit limit, loyalty), before any series or stock row is locked.
  const customer = input.customer_id
    ? await loadCustomer(tx, ctx, input.customer_id, {
        requireActive: mode !== 'sync',
        forUpdate: mode === 'commit' || mode === 'sync',
      })
    : null

  const docMode = salesDocumentModeFor(env.tenant.gst_scheme)
  const docType = mode === 'estimate' ? 'estimate' : docMode.doc_type
  const placeOfSupply = input.place_of_supply ?? store.state_code
  const isInterstate = placeOfSupply !== store.state_code
  const invoiceDate = input.invoice_date ?? env.today

  // ---- master data in bulk ---------------------------------------------------------------
  const productIds = input.lines.flatMap((l) => (l.product_id ? [l.product_id] : []))
  const products = await loadProducts(tx, ctx, productIds)
  const batches = new Map<string, BatchRow>()
  await loadBatches(
    tx,
    ctx,
    input.lines.flatMap((l) => (l.batch_id ? [l.batch_id] : [])),
    batches,
  )
  const stock = stockMode ? await loadStock(tx, ctx, store.id, productIds) : new Map()
  const storePrices = new Map<string, { sale_price_paise: number; mrp_paise: number | null }>()
  if (features.has('store_pricing') && productIds.length) {
    const rows = await tx
      .selectFrom('store_product_prices')
      .select(['product_id', 'sale_price_paise', 'mrp_paise'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('store_id', '=', store.id)
      .where('product_id', 'in', [...new Set(productIds)])
      .execute()
    for (const r of rows) storePrices.set(r.product_id, r)
  }
  const slabRules = await loadSlabRules(
    tx,
    ctx,
    [...products.values()].flatMap((p) => {
      const id = p.tax_slab_rule_id ?? p.category_tax_slab_rule_id
      return id ? [id] : []
    }),
  )
  const promotions = features.has('promotions')
    ? await loadActivePromotions(tx, ctx, store.id, now)
    : []

  // ---- lines → parts (FEFO split) ----------------------------------------------------------
  const parts: Part[] = []
  const demand = new Map<string, number>()
  const priceTier = customer?.price_tier ?? 'retail'

  for (const [index, line] of input.lines.entries()) {
    const sourceKey = cartLineKey(line, index)
    if (line.item) {
      parts.push({
        key: sourceKey,
        source_key: sourceKey,
        line,
        product: null,
        batch: null,
        batch_auto: false,
        qty_milli: line.qty_milli,
        discount_paise: line.discount_paise ?? 0,
        serial_numbers: line.serial_numbers ?? [],
        unit_price_paise: line.unit_price_paise ?? 0,
        resolved_price_paise: line.unit_price_paise ?? 0,
        price_source: 'ad_hoc',
        mrp_paise: null,
        avg_cost_paise: 0,
        available_qty_milli: null,
        tax_slab_rule_id: null,
        tax_slabs: null,
      })
      continue
    }
    const productId = line.product_id!
    const product = products.get(productId)
    if (!product) {
      issues.add('product_not_found', sourceKey, { product_id: productId })
      continue
    }
    if (product.kind === 'variant_parent') {
      issues.add('not_sellable', sourceKey, { product_id: productId, kind: product.kind })
      continue
    }
    if (!product.is_active) issues.add('product_inactive', sourceKey, { product_id: productId })
    const qi = qtyIssue(product, line.qty_milli)
    if (qi) issues.add(qi, sourceKey, { unit: product.unit, pack_size: product.pack_size })

    // Batches: explicit, FEFO auto-pick (split), or none.
    let picks: Array<{ batch: BatchRow | null; qty: number; auto: boolean }>
    if (line.batch_id) {
      const batch = batches.get(line.batch_id)
      if (!isBatchTracked(product) || !batch || batch.product_id !== product.id) {
        issues.add('batch_not_found', sourceKey, {
          batch_id: line.batch_id,
          product_id: product.id,
        })
        continue
      }
      picks = [{ batch, qty: line.qty_milli, auto: false }]
    } else if (isBatchTracked(product) && stockMode) {
      picks = await fefoPicks(tx, ctx, {
        mode,
        product,
        storeId: store.id,
        qty: line.qty_milli,
        today: env.today,
        sourceKey,
        issues,
        batches,
      })
    } else {
      picks = [{ batch: null, qty: line.qty_milli, auto: false }]
    }
    if (picks.length > 1) {
      issues.add('fefo_split', sourceKey, { source_key: sourceKey, parts: picks.length })
    }
    const discounts =
      picks.length > 1
        ? allocateProRata(
            line.discount_paise ?? 0,
            picks.map((p) => p.qty),
          )
        : [line.discount_paise ?? 0]
    const serials = [...(line.serial_numbers ?? [])]

    const slabRuleId = product.tax_slab_rule_id ?? product.category_tax_slab_rule_id
    for (const [n, pick] of picks.entries()) {
      const key = splitLineKey(sourceKey, n + 1)
      const resolved = resolveUnitPrice({
        product: {
          sale_price_paise: product.sale_price_paise,
          mrp_paise: product.mrp_paise,
          wholesale_price_paise: product.wholesale_price_paise,
        },
        store_price: storePrices.get(product.id) ?? null,
        batch: pick.batch
          ? { sale_price_paise: pick.batch.sale_price_paise, mrp_paise: pick.batch.mrp_paise }
          : null,
        price_tier: priceTier,
      })
      const manual =
        line.unit_price_paise !== undefined && line.unit_price_paise !== resolved.unit_price_paise
      const unitPrice = manual ? line.unit_price_paise! : resolved.unit_price_paise
      const sKey = stockKey(product.id, pick.batch?.id ?? null)
      const level: StockRow | undefined = stock.get(sKey)
      const avgCost =
        level && level.avg > 0
          ? level.avg
          : (pick.batch?.purchase_price_paise ?? product.purchase_price_paise)
      const unitsHere = n === picks.length - 1 ? serials.length : Math.floor(pick.qty / 1000)
      parts.push({
        key,
        source_key: sourceKey,
        line,
        product,
        batch: pick.batch,
        batch_auto: pick.auto,
        qty_milli: pick.qty,
        discount_paise: discounts[n] ?? 0,
        serial_numbers: serials.splice(0, unitsHere),
        unit_price_paise: unitPrice,
        resolved_price_paise: resolved.unit_price_paise,
        price_source: manual ? 'manual' : resolved.source,
        mrp_paise: resolved.mrp_paise,
        avg_cost_paise: avgCost,
        available_qty_milli: !product.track_inventory
          ? null
          : pick.batch || !isBatchTracked(product)
            ? (level?.qty ?? 0)
            : productStock(stock, product.id),
        tax_slab_rule_id: slabRuleId,
        tax_slabs: slabRuleId ? (slabRules.get(slabRuleId) ?? null) : null,
      })

      if (stockMode) {
        checkStockAndExpiry({
          mode,
          env,
          product,
          batch: pick.batch,
          auto: pick.auto,
          qty: pick.qty,
          key: sourceKey,
          level,
          demand,
          sKey,
          stock,
          issues,
        })
      }
    }
  }
  if (parts.length === 0 && issues.list.length === 0) issues.add('empty_cart', null)

  // ---- per source line rules: price overrides, rx, serials -----------------------------------
  const overrides: PricedSale['overrides'] = {
    price_keys: [],
    discount_keys: [],
    bill_discount: false,
    credit_limit: false,
    backdated: false,
  }
  const canPrice = can(ctx, 'sales.price_override')
  for (const part of parts) {
    if (!part.product || part.price_source !== 'manual' || trusted.has(part.source_key)) continue
    const p = part.product
    const below = p.min_sale_price_paise !== null && part.unit_price_paise < p.min_sale_price_paise
    if (below && !canPrice) {
      issues.add('below_min_price', part.source_key, {
        min_sale_price_paise: p.min_sale_price_paise,
        unit_price_paise: part.unit_price_paise,
      })
    } else if (!settings.pos.allow_price_edit && !canPrice) {
      issues.add('price_override_required', part.source_key, {
        resolved_price_paise: part.resolved_price_paise,
        unit_price_paise: part.unit_price_paise,
      })
    } else if (!overrides.price_keys.includes(part.source_key)) {
      overrides.price_keys.push(part.source_key)
    }
  }
  for (const part of parts) {
    if (!part.product) continue
    if (part.mrp_paise !== null && part.unit_price_paise > part.mrp_paise) {
      issues.add('price_above_mrp', part.source_key, {
        mrp_paise: part.mrp_paise,
        unit_price_paise: part.unit_price_paise,
      })
    }
    const exclusive = part.product.price_includes_tax
      ? mulDiv(part.unit_price_paise, 10_000, 10_000 + part.product.gst_rate_bp)
      : part.unit_price_paise
    if (part.avg_cost_paise > 0 && exclusive < part.avg_cost_paise) {
      issues.add('price_below_cost', part.source_key, {})
    }
  }
  const rxNeeded = stockMode && mode !== 'draft'
  const rxSchedules = settings.pharmacy.require_rx_for_schedules
  for (const part of parts) {
    if (!part.product) continue
    const attrs = recordOf(part.product.attributes)
    if (rxNeeded && !input.rx && lineRequiresRx(attrs, rxSchedules)) {
      issues.add('rx_required', part.source_key, { schedule: drugScheduleOf(attrs) })
    }
    if (rxNeeded && attrs['serial_tracked'] === true) {
      const units = Math.floor(part.line.qty_milli / 1000)
      const given = part.line.serial_numbers?.length ?? 0
      if (given !== units || part.line.qty_milli % 1000 !== 0) {
        issues.add('serial_numbers_required', part.source_key, { required: units, given })
      }
    }
  }

  // ---- loyalty -------------------------------------------------------------------------------
  const redeemPoints = mode === 'estimate' ? 0 : (input.loyalty_redeem_points ?? 0)
  let loyalty: {
    redeem_points: number
    available_points: number
    settings: typeof settings.loyalty
  } | null = null
  if (redeemPoints > 0) {
    if (!features.has('loyalty')) {
      issues.add('loyalty_disabled', null, { feature: 'loyalty' satisfies Feature })
    } else if (!customer) {
      issues.add('loyalty_insufficient', null, { available_points: 0 })
    } else {
      loyalty = {
        redeem_points: redeemPoints,
        available_points: customer.loyalty_points,
        settings: settings.loyalty,
      }
    }
  }

  // ---- the shared engine -------------------------------------------------------------------
  const cartLines: CartPricingLine[] = parts.map((p) => ({
    key: p.key,
    product_id: p.product?.id ?? null,
    category_id: p.product?.category_id ?? null,
    brand_id: p.product?.brand_id ?? null,
    unit_price_paise: p.unit_price_paise,
    qty_milli: p.qty_milli,
    pack_size: p.product?.pack_size ?? 1,
    price_includes_tax: p.product
      ? p.product.price_includes_tax
      : (p.line.item?.price_includes_tax ?? settings.invoice.default_price_includes_tax),
    gst_rate_bp: p.product ? p.product.gst_rate_bp : (p.line.item?.gst_rate_bp ?? 0),
    cess_rate_bp: p.product ? p.product.cess_rate_bp : (p.line.item?.cess_rate_bp ?? 0),
    tax_slabs: p.tax_slabs,
    mrp_paise: p.mrp_paise,
    discount_bp: p.line.discount_bp ?? 0,
    discount_paise: p.discount_paise,
  }))
  let totals: CartPricingResult
  try {
    totals = priceCart({
      lines: cartLines,
      tax_mode: docMode.tax_mode,
      is_interstate: isInterstate,
      round_off: settings.invoice.round_off,
      bill_discount_bp: input.bill_discount_bp ?? 0,
      bill_discount_paise: input.bill_discount_paise ?? 0,
      promotions,
      promotion_context: { store_id: store.id, now, timezone: env.timezone },
      loyalty,
    })
  } catch (err) {
    if (err instanceof RangeError) throw invalidField('lines', err.message)
    throw err
  }
  if (totals.loyalty_issue) issues.add(totals.loyalty_issue, null, { requested: redeemPoints })

  // ---- discount limits ---------------------------------------------------------------------
  const canDiscount = can(ctx, 'sales.discount_override')
  const cashierLimit = settings.pos.max_discount_bp_without_override
  for (const part of parts) {
    if (trusted.has(part.source_key)) continue
    const limit = discountLimitBp(cashierLimit, part.product?.max_discount_bp)
    const bp = totals.manual_discount_bp[part.key] ?? 0
    if (bp > limit) {
      if (canDiscount) {
        if (!overrides.discount_keys.includes(part.source_key)) {
          overrides.discount_keys.push(part.source_key)
        }
      } else {
        issues.add('discount_override_required', part.source_key, {
          limit_bp: limit,
          discount_bp: bp,
        })
      }
    }
  }
  if (totals.manual_bill_discount_bp > cashierLimit) {
    if (canDiscount) overrides.bill_discount = true
    else {
      issues.add('discount_override_required', null, {
        limit_bp: cashierLimit,
        discount_bp: totals.manual_bill_discount_bp,
      })
    }
  }

  // ---- back dating & shift -------------------------------------------------------------------
  if (mode === 'quote' || mode === 'commit') {
    if (invoiceDate > env.today) {
      issues.add('backdate_not_allowed', null, { invoice_date: invoiceDate, today: env.today })
    } else if (invoiceDate < env.today) {
      if (input.channel === 'pos' || !can(ctx, SALES_BACKDATE_PERMISSION)) {
        issues.add('backdate_not_allowed', null, { invoice_date: invoiceDate, today: env.today })
      } else {
        overrides.backdated = true
      }
    }
  }
  const shift = register ? await openShiftOf(tx, ctx, register.id) : null
  if (
    (mode === 'quote' || mode === 'commit') &&
    register &&
    !shift &&
    features.has('shifts') &&
    settings.pos.require_open_shift
  ) {
    issues.add('shift_required', null, { register_id: register.id })
  }

  // ---- tenders & credit ----------------------------------------------------------------------
  const evaluateTenders = input.tenders !== undefined && mode !== 'draft' && mode !== 'estimate'
  let tenders: PricedSale['tenders'] = null
  let due = 0
  let creditInfo: QuoteResult['credit'] = null
  if (evaluateTenders) {
    const list = input.tenders ?? []
    const alloc = allocateTenders(totals.total_paise, list)
    tenders = {
      lines: alloc.lines,
      paid_paise: alloc.paid_paise,
      change_paise: alloc.change_paise,
      due_paise: alloc.due_paise,
    }
    if (alloc.issue) issues.add(alloc.issue.code, null, { index: alloc.issue.index })
    due = alloc.due_paise
    await checkTenders(tx, ctx, { list, alloc: alloc.lines, store, customer, issues })

    if (due > 0) {
      if (!features.has('khata')) issues.add('credit_not_in_plan', null, { feature: 'khata' })
      if (!customer && settings.pos.require_customer_for_credit) {
        issues.add('customer_required_for_credit', null, { due_paise: due })
      }
      if (!can(ctx, 'sales.credit')) issues.add('credit_permission_required', null, {})
      const cc = creditCheck({
        due_paise: due,
        balance_paise: customer?.balance_paise ?? 0,
        credit_limit_paise: customer?.credit_limit_paise ?? null,
        block_over_limit: settings.credit.block_over_limit,
        override: input.credit_limit_override === true && can(ctx, 'sales.credit'),
      })
      if (cc.blocked) {
        issues.add('credit_limit_exceeded', null, {
          credit_limit_paise: customer?.credit_limit_paise ?? null,
          balance_paise: customer?.balance_paise ?? 0,
          new_balance_paise: cc.new_balance_paise,
        })
      } else if (cc.over_limit) {
        issues.add('over_credit_limit', null, {
          credit_limit_paise: customer?.credit_limit_paise ?? null,
          new_balance_paise: cc.new_balance_paise,
        })
        if (input.credit_limit_override === true && settings.credit.block_over_limit) {
          overrides.credit_limit = true
        }
      }
      creditInfo = {
        due_paise: due,
        balance_paise: customer?.balance_paise ?? 0,
        new_balance_paise: cc.new_balance_paise,
        credit_limit_paise: customer?.credit_limit_paise ?? null,
        over_limit: cc.over_limit,
        blocked: cc.blocked,
      }
    }
  }

  // ---- result --------------------------------------------------------------------------------
  const canCost = can(ctx, 'reports.read')
  const pharmacy = env.tenant.business_type === 'pharmacy'
  const lines: PricedSaleLine[] = parts.map((p, i) => {
    const r = totals.lines[i]!
    const promo = totals.line_promotions[p.key] ?? { discount_paise: 0, promotion_ids: [] }
    const attrs = p.product ? recordOf(p.product.attributes) : {}
    const schedule: DrugSchedule | null =
      p.product && (pharmacy || attrs['schedule'] !== undefined) ? drugScheduleOf(attrs) : null
    const variant = p.product ? stringRecordOf(p.product.variant_attributes) : {}
    const meta: JsonRecord = {
      price_source: p.price_source,
      resolved_price_paise: p.resolved_price_paise,
      source_key: p.source_key,
      price_includes_tax: cartLines[i]!.price_includes_tax,
      ...(schedule && schedule !== 'OTC' ? { schedule } : {}),
      ...(Object.keys(variant).length ? { variant } : {}),
      ...(p.line.scanned_code ? { scanned_code: p.line.scanned_code } : {}),
      ...(p.line.note ? { note: p.line.note } : {}),
      ...(p.batch_auto ? { batch_auto: true } : {}),
      ...(p.discount_paise ? { manual_discount_paise: p.discount_paise } : {}),
      ...(promo.promotion_ids.length ? { promotion_ids: promo.promotion_ids } : {}),
      ...(p.line.item ? { item: p.line.item } : {}),
    }
    return {
      key: p.key,
      source_key: p.source_key,
      line_no: i + 1,
      product_id: p.product?.id ?? null,
      batch_id: p.batch?.id ?? null,
      batch_no: p.batch?.batch_no ?? null,
      expiry_date: p.batch?.expiry_date ?? null,
      name: p.product?.name ?? p.line.item!.name,
      name_ta: p.product?.name_ta ?? p.line.item?.name_ta ?? null,
      hsn_code: p.product?.hsn_code ?? p.line.item?.hsn_code ?? null,
      unit: p.product?.unit ?? p.line.item!.unit,
      pack_size: p.product?.pack_size ?? 1,
      qty_milli: p.qty_milli,
      mrp_paise: p.mrp_paise,
      unit_price_paise: p.unit_price_paise,
      resolved_price_paise: p.resolved_price_paise,
      price_source: p.price_source,
      price_includes_tax: cartLines[i]!.price_includes_tax,
      manual_discount_bp: p.line.discount_bp ?? 0,
      manual_discount_paise: p.discount_paise,
      item_discount_paise: r.item_discount_paise,
      promotion_discount_paise: promo.discount_paise,
      promotion_ids: promo.promotion_ids,
      bill_discount_paise: r.bill_discount_paise,
      gross_paise: r.gross_paise,
      discount_paise: r.discount_paise,
      taxable_paise: r.taxable_paise,
      gst_rate_bp: r.gst_rate_bp,
      cgst_paise: r.cgst_paise,
      sgst_paise: r.sgst_paise,
      igst_paise: r.igst_paise,
      cess_rate_bp: r.cess_rate_bp,
      cess_paise: r.cess_paise,
      total_paise: r.total_paise,
      mrp_savings_paise: r.mrp_savings_paise,
      tax_slab_rule_id: p.tax_slabs ? p.tax_slab_rule_id : null,
      schedule,
      requires_rx: p.product ? lineRequiresRx(attrs, rxSchedules) : false,
      serial_numbers: p.serial_numbers,
      available_qty_milli: p.available_qty_milli,
      unit_cost_paise: canCost && p.product ? p.avg_cost_paise : null,
      discount_bp: p.line.discount_bp ?? 0,
      promotion_id: promo.promotion_ids[0] ?? null,
      track_inventory: p.product?.track_inventory ?? false,
      batch_tracked: p.product ? isBatchTracked(p.product) : false,
      batch_auto: p.batch_auto,
      avg_cost_paise: p.avg_cost_paise,
      meta,
    }
  })

  const snapshot: SaleSnapshot = {
    name: input.customer?.name ?? customer?.name ?? null,
    phone: input.customer?.phone ?? customer?.phone ?? null,
    gstin: input.customer?.gstin ?? customer?.gstin ?? null,
    address: input.customer?.address ?? addressOf(customer?.address),
    state_code: input.customer?.state_code ?? customer?.state_code ?? null,
  }

  const promoNames = new Map(promotions.map((p) => [p.id, p]))
  const billKinds = new Set(['bill_percent', 'bill_flat'])
  const allPricesInclusive = cartLines.length > 0 && cartLines.every((l) => l.price_includes_tax)
  const loyaltyEnabled = features.has('loyalty') && settings.loyalty.enabled && customer !== null
  const issueList = issues.list
  const blocking = issueList.filter((i) => i.severity === 'error')
  const quote: QuoteResult = {
    doc_type: docType,
    tax_mode: docMode.tax_mode,
    place_of_supply: placeOfSupply,
    is_interstate: isInterstate,
    price_includes_tax: allPricesInclusive,
    lines: lines.map(toPricedLine),
    gross_paise: totals.gross_paise,
    item_discount_paise: totals.item_discount_paise,
    bill_discount_paise: totals.bill_discount_paise,
    taxable_paise: totals.taxable_paise,
    cgst_paise: totals.cgst_paise,
    sgst_paise: totals.sgst_paise,
    igst_paise: totals.igst_paise,
    cess_paise: totals.cess_paise,
    tax_paise: totals.tax_paise,
    round_off_paise: totals.round_off_paise,
    total_paise: totals.total_paise,
    manual_bill_discount_paise: totals.manual_bill_discount_paise,
    promotion_bill_discount_paise: totals.promotion_bill_discount_paise,
    loyalty_redeem_paise: totals.loyalty_redeem_paise,
    loyalty_points_redeemed: totals.loyalty_points_redeemed,
    mrp_savings_paise: totals.mrp_savings_paise,
    tax_breakup: totals.tax_breakup,
    applied_promotions: totals.applied_promotions.map((a) => {
      const p = promoNames.get(a.promotion_id)
      return {
        promotion_id: a.promotion_id,
        name: a.name,
        name_ta: p?.name_ta ?? null,
        level: p && billKinds.has(p.kind) ? ('bill' as const) : ('item' as const),
        discount_paise: a.discount_paise,
      }
    }),
    customer: customer
      ? {
          id: customer.id,
          name: customer.name,
          name_ta: customer.name_ta,
          phone: customer.phone,
          gstin: customer.gstin,
          state_code: customer.state_code,
          price_tier: customer.price_tier,
          balance_paise: customer.balance_paise,
          credit_limit_paise: customer.credit_limit_paise,
          loyalty_points: customer.loyalty_points,
        }
      : null,
    tenders: tenders,
    credit: creditInfo,
    loyalty: loyaltyEnabled
      ? {
          points_available: customer.loyalty_points,
          points_redeemed: totals.loyalty_points_redeemed,
          redeem_paise: totals.loyalty_redeem_paise,
          points_to_earn: loyaltyPointsForAmount(totals.total_paise, settings.loyalty),
        }
      : null,
    issues: issueList,
    can_complete: blocking.length === 0,
    requires: {
      rx: blocking.some((i) => i.code === 'rx_required'),
      price_override: blocking.some(
        (i) => i.code === 'price_override_required' || i.code === 'below_min_price',
      ),
      discount_override: blocking.some((i) => i.code === 'discount_override_required'),
      credit: blocking.some((i) => i.code === 'credit_permission_required'),
    },
  }

  return {
    env,
    mode,
    store,
    register,
    shift,
    customer,
    snapshot,
    doc_type: docType,
    tax_mode: docMode.tax_mode,
    place_of_supply: placeOfSupply,
    is_interstate: isInterstate,
    price_includes_tax:
      cartLines.length === 0 ? settings.invoice.default_price_includes_tax : allPricesInclusive,
    invoice_date: invoiceDate,
    lines,
    totals,
    tenders,
    due_paise: evaluateTenders ? due : 0,
    issues: issueList,
    quote,
    overrides,
    meta: {
      bill_discount_bp: input.bill_discount_bp ?? 0,
      bill_discount_paise: input.bill_discount_paise ?? 0,
      loyalty_redeem_points: redeemPoints,
      applied_promotions: quote.applied_promotions,
    },
    rx: input.rx ?? null,
  }
}

/** The public PricedLine shape (drops the internal fields). */
export function toPricedLine(l: PricedSaleLine): PricedLine {
  return {
    key: l.key,
    source_key: l.source_key,
    line_no: l.line_no,
    product_id: l.product_id,
    batch_id: l.batch_id,
    batch_no: l.batch_no,
    expiry_date: l.expiry_date,
    name: l.name,
    name_ta: l.name_ta,
    hsn_code: l.hsn_code,
    unit: l.unit,
    pack_size: l.pack_size,
    qty_milli: l.qty_milli,
    mrp_paise: l.mrp_paise,
    unit_price_paise: l.unit_price_paise,
    resolved_price_paise: l.resolved_price_paise,
    price_source: l.price_source,
    price_includes_tax: l.price_includes_tax,
    manual_discount_bp: l.manual_discount_bp,
    manual_discount_paise: l.manual_discount_paise,
    item_discount_paise: l.item_discount_paise,
    promotion_discount_paise: l.promotion_discount_paise,
    promotion_ids: l.promotion_ids,
    bill_discount_paise: l.bill_discount_paise,
    gross_paise: l.gross_paise,
    discount_paise: l.discount_paise,
    taxable_paise: l.taxable_paise,
    gst_rate_bp: l.gst_rate_bp,
    cgst_paise: l.cgst_paise,
    sgst_paise: l.sgst_paise,
    igst_paise: l.igst_paise,
    cess_rate_bp: l.cess_rate_bp,
    cess_paise: l.cess_paise,
    total_paise: l.total_paise,
    mrp_savings_paise: l.mrp_savings_paise,
    tax_slab_rule_id: l.tax_slab_rule_id,
    schedule: l.schedule,
    requires_rx: l.requires_rx,
    serial_numbers: l.serial_numbers,
    available_qty_milli: l.available_qty_milli,
    unit_cost_paise: l.unit_cost_paise,
  }
}

// ---------------------------------------------------------------------------------------------
// FEFO, stock and expiry
// ---------------------------------------------------------------------------------------------

async function fefoPicks(
  tx: Tx,
  ctx: SalesCtx,
  a: {
    mode: PricingMode
    product: ProductRow
    storeId: string
    qty: number
    today: string
    sourceKey: string
    issues: IssueList
    batches: Map<string, BatchRow>
  },
): Promise<Array<{ batch: BatchRow | null; qty: number; auto: boolean }>> {
  try {
    const picks = await pickBatchesFefo(tx, ctx, {
      store_id: a.storeId,
      product_id: a.product.id,
      qty_milli: a.qty,
      today: a.today,
      ...(a.mode === 'sync' ? { allowNegative: true } : {}),
    })
    await loadBatches(
      tx,
      ctx,
      picks.flatMap((p) => (p.batch_id ? [p.batch_id] : [])),
      a.batches,
    )
    return picks.map((p) => ({
      batch: p.batch_id ? (a.batches.get(p.batch_id) ?? null) : null,
      qty: p.qty_milli,
      auto: true,
    }))
  } catch (err) {
    if (!isAppError(err) || err.code !== 'INSUFFICIENT_STOCK') throw err
    const available =
      typeof err.details?.['available_milli'] === 'number' ? err.details['available_milli'] : 0
    if (a.mode === 'sync') {
      // Offline bill of a product without sellable stock here: post it on the latest batch.
      const latest = await tx
        .selectFrom('batches')
        .select('id')
        .where('tenant_id', '=', ctx.tenantId)
        .where('product_id', '=', a.product.id)
        .where('is_active', '=', true)
        .orderBy(sql`expiry_date desc nulls first`)
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst()
      if (latest) {
        await loadBatches(tx, ctx, [latest.id], a.batches)
        a.issues.add('offline_negative_stock', a.sourceKey, {
          product_id: a.product.id,
          available_qty_milli: available,
        })
        return [{ batch: a.batches.get(latest.id) ?? null, qty: a.qty, auto: true }]
      }
      a.issues.add('batch_not_found', a.sourceKey, { product_id: a.product.id })
      return []
    }
    a.issues.add('insufficient_stock', a.sourceKey, {
      product_id: a.product.id,
      available_qty_milli: available,
      requested_qty_milli: a.qty,
    })
    return [{ batch: null, qty: a.qty, auto: true }]
  }
}

function checkStockAndExpiry(a: {
  mode: PricingMode
  env: SalesEnv
  product: ProductRow
  batch: BatchRow | null
  auto: boolean
  qty: number
  key: string
  level: StockRow | undefined
  demand: Map<string, number>
  sKey: string
  stock: Map<string, StockRow>
  issues: IssueList
}): void {
  const { product, batch, issues, env } = a
  const inv = env.settings.inventory
  if (batch) {
    const status = batchExpiryStatus(batch.expiry_date, env.today, inv.expiry_warning_days)
    if (status === 'expired') {
      if (inv.block_expired_sale) {
        issues.add('expired_batch', a.key, {
          batch_id: batch.id,
          batch_no: batch.batch_no,
          expiry_date: batch.expiry_date,
        })
      } else {
        issues.add('near_expiry', a.key, {
          batch_no: batch.batch_no,
          expiry_date: batch.expiry_date,
          expired: true,
        })
      }
    } else if (status === 'near_expiry') {
      issues.add('near_expiry', a.key, {
        batch_no: batch.batch_no,
        expiry_date: batch.expiry_date,
        expired: false,
      })
    }
    if (!batch.is_active && !a.auto) {
      issues.add('batch_not_found', a.key, { batch_id: batch.id, reason: 'inactive' })
    }
  }
  if (!product.track_inventory) return
  if (isBatchTracked(product) && !batch) return // insufficient_stock already reported

  const before = a.level?.qty ?? 0
  const used = a.demand.get(a.sKey) ?? 0
  a.demand.set(a.sKey, used + a.qty)
  const left = before - used
  if (a.qty > left) {
    if (a.mode === 'sync') {
      issues.add('offline_negative_stock', a.key, {
        product_id: product.id,
        available_qty_milli: Math.max(0, left),
      })
    } else if (inv.allow_negative_stock) {
      issues.add('negative_stock', a.key, {
        product_id: product.id,
        available_qty_milli: left,
        requested_qty_milli: a.qty,
      })
    } else if (!a.auto) {
      issues.add('insufficient_stock', a.key, {
        product_id: product.id,
        available_qty_milli: Math.max(0, left),
        requested_qty_milli: a.qty,
      })
    }
  }
  if (product.reorder_level_milli !== null) {
    const total = productStock(a.stock, product.id)
    const after = total - (a.demand.get(a.sKey) ?? 0)
    if (after <= product.reorder_level_milli) {
      issues.add('low_stock', a.key, {
        product_id: product.id,
        stock_after_milli: after,
        reorder_level_milli: product.reorder_level_milli,
      })
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Tenders: UPI intents and store credit
// ---------------------------------------------------------------------------------------------

async function checkTenders(
  tx: Tx,
  ctx: SalesCtx,
  a: {
    list: readonly Tender[]
    alloc: readonly TenderAllocationLine[]
    store: StoreInfo
    customer: CustomerInfo | null
    issues: IssueList
  },
): Promise<void> {
  const intentIds = a.list.flatMap((t) => (t.payment_intent_id ? [t.payment_intent_id] : []))
  if (new Set(intentIds).size !== intentIds.length) {
    a.issues.add('payment_intent_invalid', null, { reason: 'intent_repeated' })
  }
  if (intentIds.length) {
    const rows = await tx
      .selectFrom('payment_intents')
      .select([
        'id',
        'status',
        'payment_id',
        'store_id',
        'amount_paise',
        'paid_amount_paise',
        'customer_id',
        'purpose',
      ])
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', 'in', intentIds)
      .execute()
    const byId = new Map(rows.map((r) => [r.id, r]))
    for (const [index, t] of a.list.entries()) {
      if (!t.payment_intent_id) continue
      const intent = byId.get(t.payment_intent_id)
      let reason: string | null = null
      if (!intent) reason = 'intent_not_found'
      else if (intent.status !== 'paid') reason = 'intent_not_paid'
      else if (intent.payment_id) reason = 'intent_used'
      else if (intent.store_id !== a.store.id) reason = 'intent_store'
      else if ((intent.paid_amount_paise ?? intent.amount_paise) !== t.amount_paise)
        reason = 'intent_amount_mismatch'
      else if (
        intent.customer_id &&
        intent.customer_id !== a.customer?.id &&
        !(intent.purpose === 'pos_sale' && !a.customer)
      )
        reason = 'intent_customer'
      else if ((a.alloc[index]?.applied_paise ?? 0) !== t.amount_paise)
        reason = 'intent_unallocated'
      if (reason) a.issues.add('payment_intent_invalid', null, { index, reason })
    }
  }
  const storeCredit = a.alloc
    .filter((l) => l.method === 'store_credit')
    .reduce((s, l) => s + l.applied_paise, 0)
  if (storeCredit > 0) {
    if (!a.customer) {
      a.issues.add('store_credit_insufficient', null, { available_paise: 0 })
    } else {
      const available = await storeCreditBalance(tx, ctx, a.customer.id)
      if (storeCredit > available) {
        a.issues.add('store_credit_insufficient', null, {
          available_paise: available,
          requested_paise: storeCredit,
        })
      }
    }
  }
}
