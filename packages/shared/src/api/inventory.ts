// CONTRACT CHANGELOG (inventory backend; one line per change, newest last)
// - INVENTORY_VALIDATION_KEYS += future_date, received_exceeds_dispatched, unknown_line,
//   received_before_dispatch (server-side rules on post / dispatch / receive bodies).
// - New INVENTORY_ERROR_REASONS: details.reason values of 403/409/422 errors (web: inventory:errors.<reason>).
// - createAdjustment / createTransfer / postAdjustment / cancelAdjustment / dispatchTransfer /
//   receiveTransfer / cancelTransfer are `idempotent: true` (optional Idempotency-Key: a retried
//   post/dispatch/receive replays the first response instead of failing with 409 not_draft).
// - AdjustmentLineInputSchema.unit_cost_paise: documented as the cost of GAINS only — losses are
//   always valued at the current average cost (core postStock); the posted line shows the cost used.
// - TransferReceiveSchema: duplicate line_id → 'duplicate_line'; lines not listed are received in full.
// - Receive semantics documented: received qty → transfer_in at the destination (dispatch cost);
//   the shortfall is returned to the source (transfer_in) and written off there as 'damage'
//   (source cost), so the source store bears the loss; journal Dr inventory(to) / Cr inventory(from)
//   + Dr inventory_writeoff(from).
// - StockAlertsSchema: out_of_stock lists products with qty ≤ 0 that were stocked in the scope
//   before or have a reorder level (never-stocked catalogue items are not alerts).
// - transferAccessStoreId(): which store a member must be able to access for each transfer action.
// - INVENTORY_EXPORT_MAX_ROWS (100 000): CSV exports above it fail with reason export_too_large.
// - Transfer routes also need the multi_store feature (server guard; every plan with
//   stock_transfers has it). Receive journal: the per-movement rounding residue of pack-priced
//   lines (≤ 1 paisa per line) is booked to inventory_adjustment at the source store.
// - (review) INVENTORY_VALIDATION_KEYS += decimal_qty_not_allowed: document quantities (opening,
//   adjustment change / count, transfer, received) must be whole base units unless the product
//   is measured in decimals (products.decimal_qty or a decimal unit such as KG / L / M):
//   qtyAllowed(product, qty_milli).
// - (review) Page links shared by the digest job and the web pages' URL state:
//   BATCH_EXPIRY_TABS, batchExpiryTabFor(days), stockPagePath({store_id, filter}) →
//   /inventory/stock?store=&filter=, batchesPagePath({store_id, tab}) → /inventory/batches?store=&tab=.
// - (review) GET /stock without include_inactive also lists deactivated products that still
//   hold stock (their value is part of the stock valuation); include_inactive=true lists all.

/**
 * Contract for the inventory module — docs/API.md "inventory": stock levels & valuation,
 * movement ledger, batches & expiry, stock adjustments / stock takes / write-offs, opening
 * stock, stock transfers between stores and stock alerts (+ the daily digest job payloads).
 *
 * Quantities are milli base units (signed where stock can go negative); costs are per PACK of
 * `pack_size` base units excluding tax; values = amountForQty(cost, qty, pack_size). Every stock
 * change goes through core postStock (movement types per kind below); journals follow
 * ARCHITECTURE.md §10. Validation messages of custom rules are snake_case keys
 * (INVENTORY_VALIDATION_KEYS).
 */
import { z } from 'zod'
import {
  type AdjustmentKind,
  AdjustmentKindSchema,
  AdjustmentStatusSchema,
  type StockMovementType,
  StockMovementTypeSchema,
  type TransferStatus,
  TransferStatusSchema,
} from '../enums'
import { diffDays } from '../fy'
import { isUuid } from '../ids'
import { amountForQty, isDecimalUnit } from '../units'
import {
  type BilingualLabel,
  dataOf,
  defineRoutes,
  listOf,
  PageQuerySchema,
  sortQuery,
  zBooleanQuery,
  zDateStr,
  zId,
  zPaise,
  zQtyMilli,
  zSearchQuery,
  zSignedPaise,
  zTimestamp,
} from './common'
import {
  ExportFormatSchema,
  zIfUpdatedAt,
  zNullableText,
  zQueryIds,
  zQueryInt,
  zStoreScope,
} from './identity'

// =============================================================================================
// Validation keys (custom rules)
// =============================================================================================

export const INVENTORY_VALIDATION_KEYS = [
  'qty_delta_required',
  'qty_delta_zero',
  'counted_qty_required',
  'loss_must_be_negative',
  'duplicate_line',
  'batch_ambiguous',
  'batch_dates',
  'transfer_same_store',
  'date_order',
  'empty_patch',
  /** Adjustment / opening / transfer / receipt dated after today (tenant timezone). */
  'future_date',
  /** Receipt: received_qty_milli above the dispatched quantity of the line. */
  'received_exceeds_dispatched',
  /** Receipt: line_id that is not a line of this transfer. */
  'unknown_line',
  /** Receipt: received_date before the transfer date. */
  'received_before_dispatch',
  /** A fractional quantity of a product counted in whole units (qtyAllowed). */
  'decimal_qty_not_allowed',
] as const
export type InventoryValidationKey = (typeof INVENTORY_VALIDATION_KEYS)[number]

/** `details.reason` of inventory errors (status in the comment; web: inventory:errors.<reason>). */
export const INVENTORY_ERROR_REASONS = [
  'not_draft', // 409: only drafts can be edited, deleted, posted or dispatched
  'not_posted', // 409: only posted adjustments can be cancelled
  'already_cancelled', // 409: the document is cancelled already
  'not_dispatched', // 409: only dispatched transfers can be received
  'already_received', // 409: a received transfer cannot be cancelled
  'empty_document', // 422: posting / dispatching a document without lines
  'has_movements', // 409: opening stock for products that already moved (details.product_ids; use force)
  'not_stock_item', // 422: service, variant template or product without stock tracking
  'batch_required', // 422: batch-tracked product without a batch
  'batch_not_allowed', // 422: batch given for a product that does not track batches
  'batch_product_mismatch', // 422: the batch belongs to another product
  'store_inactive', // 422: the store is deactivated
  'all_stores_required', // 403: store_id=all needs access to every store
  'expiry_change_forbidden', // 403: expiry / mfg date changes need inventory.adjust
  'export_too_large', // 422: a CSV export above INVENTORY_EXPORT_MAX_ROWS rows (narrow the filters)
] as const
export type InventoryErrorReason = (typeof INVENTORY_ERROR_REASONS)[number]

/** Most rows one CSV export (?format=csv on /stock and /stock/movements) may contain. */
export const INVENTORY_EXPORT_MAX_ROWS = 100_000

const notEmpty = (v: Record<string, unknown>) =>
  Object.entries(v).some(([k, x]) => x !== undefined && k !== 'if_updated_at')

/** Signed milli quantity (stock can be negative when settings allow it). */
const zSignedQty = z.int()

const DateRangeShape = { from: zDateStr.optional(), to: zDateStr.optional() }
const dateOrder = (r: { from?: string | undefined; to?: string | undefined }) =>
  !r.from || !r.to || r.from <= r.to

// =============================================================================================
// Pure helpers (stock status, expiry, values, movement directions)
// =============================================================================================

export const StockStatusSchema = z.enum(['ok', 'low', 'out', 'negative'])
export type StockStatus = z.infer<typeof StockStatusSchema>

/** negative (< 0) / out (= 0) / low (≤ reorder level) / ok. */
export function stockStatus(qty_milli: number, reorder_level_milli: number | null): StockStatus {
  if (qty_milli < 0) return 'negative'
  if (qty_milli === 0) return 'out'
  if (reorder_level_milli !== null && qty_milli <= reorder_level_milli) return 'low'
  return 'ok'
}

export const ExpiryStatusSchema = z.enum(['expired', 'expiring', 'ok', 'none'])
export type ExpiryStatus = z.infer<typeof ExpiryStatusSchema>

/**
 * Expiry status of a batch on `today`: a batch is still sellable ON its expiry date (expired
 * from the next day, matching pickBatchesFefo); 'expiring' within `warning_days`
 * (settings.inventory.expiry_warning_days); 'none' without an expiry date.
 */
export function expiryStatus(
  expiry_date: string | null,
  today: string,
  warning_days: number,
): { status: ExpiryStatus; days_to_expiry: number | null } {
  if (!expiry_date) return { status: 'none', days_to_expiry: null }
  const days = diffDays(today, expiry_date)
  if (days < 0) return { status: 'expired', days_to_expiry: days }
  if (days <= warning_days) return { status: 'expiring', days_to_expiry: days }
  return { status: 'ok', days_to_expiry: days }
}

/** Signed stock value of a quantity at a per-pack cost: amountForQty(cost, qty, pack_size). */
export function stockValuePaise(unit_cost_paise: number, qty_milli: number, pack_size = 1): number {
  return amountForQty(unit_cost_paise, qty_milli, pack_size)
}

/**
 * Whether a document quantity is allowed for the product: whole base units (1 pc, 1 tab), or
 * any milli quantity for goods measured in decimals (products.decimal_qty or a decimal unit
 * such as KG / L / M). Loose tablets of a strip are whole tablets, so they are allowed.
 */
export function qtyAllowed(
  product: { unit: string; decimal_qty?: boolean | undefined },
  qty_milli: number,
): boolean {
  if (product.decimal_qty === true || isDecimalUnit(product.unit)) return true
  return qty_milli % 1000 === 0
}

/** Sign each movement type must have (0 = either), mirrors core/inventory.ts. */
export const MOVEMENT_DIRECTION: Readonly<Record<StockMovementType, 1 | -1 | 0>> = {
  opening: 1,
  purchase: 1,
  purchase_return: -1,
  sale: -1,
  sale_return: 1,
  adjustment: 0,
  stock_take: 0,
  damage: -1,
  expiry_writeoff: -1,
  transfer_out: -1,
  transfer_in: 1,
  sale_cancel: 1,
  purchase_cancel: -1,
}

/** Movement type posted for each adjustment kind. */
export const ADJUSTMENT_MOVEMENT_TYPE: Readonly<Record<AdjustmentKind, StockMovementType>> = {
  adjustment: 'adjustment',
  stock_take: 'stock_take',
  damage: 'damage',
  expiry_writeoff: 'expiry_writeoff',
  opening: 'opening',
}

/** Kinds whose lines are losses only (qty_delta_milli < 0), journalled to inventory_writeoff. */
export const WRITE_OFF_KINDS: readonly AdjustmentKind[] = ['damage', 'expiry_writeoff']

/** stock_take: the delta posted = counted − system quantity (at posting, under lock). */
export function stockTakeDelta(system_qty_milli: number, counted_qty_milli: number): number {
  return counted_qty_milli - system_qty_milli
}

/**
 * Value impact of adjustment lines (signed per line) and the journal it needs (§10):
 * loss → Dr loss_account / Cr inventory; gain → Dr inventory / Cr inventory_adjustment.
 */
export function adjustmentValueSummary(
  kind: AdjustmentKind,
  lines: readonly { qty_delta_milli: number; unit_cost_paise: number; pack_size: number }[],
): {
  gain_paise: number
  loss_paise: number
  net_paise: number
  loss_account: 'inventory_adjustment' | 'inventory_writeoff'
} {
  let gain = 0
  let loss = 0
  for (const l of lines) {
    const v = stockValuePaise(l.unit_cost_paise, l.qty_delta_milli, l.pack_size)
    if (v > 0) gain += v
    else loss -= v
  }
  return {
    gain_paise: gain,
    loss_paise: loss,
    net_paise: gain - loss,
    loss_account: WRITE_OFF_KINDS.includes(kind) ? 'inventory_writeoff' : 'inventory_adjustment',
  }
}

/** Reason suggestions for adjustment lines (stored as text; label keys in inventory:reasons.*). */
export const ADJUSTMENT_REASONS = [
  {
    code: 'count_correction',
    label_en: 'Count correction',
    label_ta: 'எண்ணிக்கை திருத்தம்',
    kinds: ['adjustment', 'stock_take'],
  },
  {
    code: 'damaged',
    label_en: 'Damaged',
    label_ta: 'சேதமடைந்தது',
    kinds: ['damage', 'adjustment'],
  },
  { code: 'expired', label_en: 'Expired', label_ta: 'காலாவதியானது', kinds: ['expiry_writeoff'] },
  {
    code: 'theft',
    label_en: 'Theft / missing',
    label_ta: 'திருட்டு / காணவில்லை',
    kinds: ['adjustment', 'stock_take'],
  },
  { code: 'internal_use', label_en: 'Shop use', label_ta: 'கடை பயன்பாடு', kinds: ['adjustment'] },
  { code: 'sample', label_en: 'Free sample', label_ta: 'இலவச மாதிரி', kinds: ['adjustment'] },
  {
    code: 'found',
    label_en: 'Found extra',
    label_ta: 'கூடுதலாகக் கிடைத்தது',
    kinds: ['adjustment', 'stock_take'],
  },
  { code: 'spoiled', label_en: 'Spoiled / rotten', label_ta: 'கெட்டுப்போனது', kinds: ['damage'] },
  {
    code: 'other',
    label_en: 'Other',
    label_ta: 'மற்றவை',
    kinds: ['adjustment', 'stock_take', 'damage', 'expiry_writeoff'],
  },
] as const satisfies readonly {
  code: string
  label_en: string
  label_ta: string
  kinds: readonly AdjustmentKind[]
}[]

// =============================================================================================
// Bilingual labels (server CSV / print output and every web module use the same words)
// =============================================================================================

export type { BilingualLabel } from './common'

export const MOVEMENT_TYPE_LABELS: Readonly<Record<StockMovementType, BilingualLabel>> = {
  opening: { en: 'Opening stock', ta: 'தொடக்க இருப்பு' },
  purchase: { en: 'Purchase', ta: 'கொள்முதல்' },
  purchase_return: { en: 'Purchase return', ta: 'கொள்முதல் திருப்பம்' },
  sale: { en: 'Sale', ta: 'விற்பனை' },
  sale_return: { en: 'Sales return', ta: 'விற்பனைத் திருப்பம்' },
  adjustment: { en: 'Adjustment', ta: 'சரிசெய்தல்' },
  stock_take: { en: 'Stock take', ta: 'இருப்புச் சரிபார்ப்பு' },
  damage: { en: 'Damage', ta: 'சேதம்' },
  expiry_writeoff: { en: 'Expiry write-off', ta: 'காலாவதி நீக்கம்' },
  transfer_out: { en: 'Transfer out', ta: 'வெளி மாற்றம்' },
  transfer_in: { en: 'Transfer in', ta: 'உள் மாற்றம்' },
  sale_cancel: { en: 'Sale cancelled', ta: 'விற்பனை ரத்து' },
  purchase_cancel: { en: 'Purchase cancelled', ta: 'கொள்முதல் ரத்து' },
}

export const ADJUSTMENT_KIND_LABELS: Readonly<Record<AdjustmentKind, BilingualLabel>> = {
  adjustment: { en: 'Adjustment', ta: 'சரிசெய்தல்' },
  stock_take: { en: 'Stock take', ta: 'இருப்புச் சரிபார்ப்பு' },
  damage: { en: 'Damage', ta: 'சேதம்' },
  expiry_writeoff: { en: 'Expiry write-off', ta: 'காலாவதி நீக்கம்' },
  opening: { en: 'Opening stock', ta: 'தொடக்க இருப்பு' },
}

export const TRANSFER_STATUS_LABELS: Readonly<Record<TransferStatus, BilingualLabel>> = {
  draft: { en: 'Draft', ta: 'வரைவு' },
  dispatched: { en: 'Dispatched', ta: 'அனுப்பப்பட்டது' },
  received: { en: 'Received', ta: 'பெறப்பட்டது' },
  cancelled: { en: 'Cancelled', ta: 'ரத்து செய்யப்பட்டது' },
}

export const STOCK_STATUS_LABELS: Readonly<Record<StockStatus, BilingualLabel>> = {
  ok: { en: 'In stock', ta: 'இருப்பில் உள்ளது' },
  low: { en: 'Low stock', ta: 'இருப்பு குறைவு' },
  out: { en: 'Out of stock', ta: 'இருப்பு இல்லை' },
  negative: { en: 'Negative stock', ta: 'எதிர்மறை இருப்பு' },
}

export const EXPIRY_STATUS_LABELS: Readonly<Record<ExpiryStatus, BilingualLabel>> = {
  expired: { en: 'Expired', ta: 'காலாவதியானது' },
  expiring: { en: 'Expiring soon', ta: 'விரைவில் காலாவதி' },
  ok: { en: 'Good', ta: 'நன்று' },
  none: { en: 'No expiry', ta: 'காலாவதி இல்லை' },
}

// =============================================================================================
// Stock levels
// =============================================================================================

export const StockGroupSchema = z.enum(['product', 'batch'])

export const StockRowSchema = z.object({
  /** null when aggregated over all stores (store_id=all). */
  store_id: zId.nullable(),
  product_id: zId,
  sku: z.string().nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  allow_loose: z.boolean(),
  track_batches: z.boolean(),
  category_id: zId.nullable(),
  category_name: z.string().nullable(),
  brand_name: z.string().nullable(),
  /** group=batch only (null otherwise / unbatched stock). */
  batch_id: zId.nullable(),
  batch_no: z.string().nullable(),
  expiry_date: zDateStr.nullable(),
  qty_milli: zSignedQty,
  /** Weighted average cost per pack (excl. tax) of the rows aggregated. */
  avg_cost_paise: zPaise,
  value_cost_paise: zSignedPaise,
  /** Batch MRP (group=batch) else product MRP. */
  mrp_paise: zPaise.nullable(),
  value_mrp_paise: zSignedPaise.nullable(),
  sale_price_paise: zPaise,
  reorder_level_milli: z.int().min(0).nullable(),
  reorder_qty_milli: z.int().min(0).nullable(),
  status: StockStatusSchema,
  /** Batches with non-zero stock. */
  batch_count: z.int().min(0),
  nearest_expiry: zDateStr.nullable(),
  last_movement_at: zTimestamp.nullable(),
})
export type StockRow = z.output<typeof StockRowSchema>

export const StockTotalsSchema = z.object({
  item_count: z.int().min(0),
  value_cost_paise: zSignedPaise,
  value_mrp_paise: zSignedPaise,
  low_stock_count: z.int().min(0),
  out_of_stock_count: z.int().min(0),
  negative_count: z.int().min(0),
})
export type StockTotals = z.output<typeof StockTotalsSchema>

/** GET /stock response: the list envelope plus totals over the whole filtered result. */
export const StockListResponseSchema = listOf(StockRowSchema).extend({ totals: StockTotalsSchema })
export type StockListResponse = z.output<typeof StockListResponseSchema>

export const StockListQuerySchema = PageQuerySchema.extend({
  store_id: zStoreScope.optional().describe("Default: the device / member's store"),
  q: zSearchQuery.optional().describe('Name / SKU / barcode'),
  category_id: zId.optional().describe('Includes descendant categories'),
  brand_id: zId.optional(),
  low_stock: zBooleanQuery.optional(),
  out_of_stock: zBooleanQuery.optional().describe('qty ≤ 0'),
  in_stock: zBooleanQuery.optional().describe('qty > 0'),
  track_batches: zBooleanQuery.optional(),
  include_inactive: zBooleanQuery.default(false),
  group: StockGroupSchema.default('product'),
  sort: sortQuery(['name', 'qty', 'value', 'sku', 'last_movement_at', 'expiry'] as const).prefault(
    'name',
  ),
  format: ExportFormatSchema.default('json').describe(
    'csv → text/csv of the whole filtered result',
  ),
})
export type StockListQuery = z.input<typeof StockListQuerySchema>

export const BatchStockSchema = z.object({
  batch_id: zId.nullable(),
  batch_no: z.string().nullable(),
  expiry_date: zDateStr.nullable(),
  mfg_date: zDateStr.nullable(),
  mrp_paise: zPaise.nullable(),
  sale_price_paise: zPaise.nullable(),
  qty_milli: zSignedQty,
  avg_cost_paise: zPaise,
  value_cost_paise: zSignedPaise,
  expiry_status: ExpiryStatusSchema,
  days_to_expiry: z.int().nullable(),
})
export type BatchStock = z.output<typeof BatchStockSchema>

// =============================================================================================
// Movements
// =============================================================================================

export const MovementRowSchema = z.object({
  id: zId,
  created_at: zTimestamp,
  store_id: zId,
  store_code: z.string(),
  product_id: zId,
  product_name: z.string(),
  product_name_ta: z.string().nullable(),
  sku: z.string().nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  batch_id: zId.nullable(),
  batch_no: z.string().nullable(),
  movement_type: StockMovementTypeSchema,
  /** Signed: + in, − out. */
  qty_milli: zSignedQty,
  unit_cost_paise: zPaise.nullable(),
  /** Signed value at unit cost. */
  value_paise: zSignedPaise.nullable(),
  /** Balance of the (store, product, batch) stock row after this movement. */
  balance_after_milli: zSignedQty,
  ref_type: z.string().nullable(),
  ref_id: zId.nullable(),
  ref_line_id: zId.nullable(),
  /** Number of the source document (resolved from ref_type/ref_id); web link via documentPath. */
  ref_number: z.string().nullable(),
  reason: z.string().nullable(),
  created_by: zId.nullable(),
  user_name: z.string().nullable(),
})
export type MovementRow = z.output<typeof MovementRowSchema>

const MovementTypesQuery = z
  .union([StockMovementTypeSchema, z.array(StockMovementTypeSchema)])
  .transform((v) => (Array.isArray(v) ? v : [v]))

export const MovementListQuerySchema = PageQuerySchema.extend({
  product_id: zId.optional(),
  store_id: zId.optional(),
  batch_id: zId.optional(),
  type: MovementTypesQuery.optional().describe('One or more movement types (?type=a&type=b)'),
  ref_type: z
    .string()
    .trim()
    .regex(/^[a-z_]{2,40}$/)
    .optional(),
  ref_id: zId.optional(),
  user_id: zId.optional(),
  ...DateRangeShape,
  sort: sortQuery(['created_at'] as const).prefault('-created_at'),
  format: ExportFormatSchema.default('json'),
}).refine(dateOrder, { message: 'date_order', path: ['to'] })
export type MovementListQuery = z.input<typeof MovementListQuerySchema>

/** GET /stock/products/:productId — per store and batch, plus the last 20 movements. */
export const ProductStockSchema = z.object({
  product: z.object({
    id: zId,
    sku: z.string().nullable(),
    name: z.string(),
    name_ta: z.string().nullable(),
    unit: z.string(),
    pack_size: z.int().min(1),
    allow_loose: z.boolean(),
    track_inventory: z.boolean(),
    track_batches: z.boolean(),
    reorder_level_milli: z.int().min(0).nullable(),
    reorder_qty_milli: z.int().min(0).nullable(),
    mrp_paise: zPaise.nullable(),
    sale_price_paise: zPaise,
    purchase_price_paise: zPaise,
  }),
  stores: z.array(
    z.object({
      store_id: zId,
      store_code: z.string(),
      store_name: z.string(),
      qty_milli: zSignedQty,
      avg_cost_paise: zPaise,
      value_cost_paise: zSignedPaise,
      status: StockStatusSchema,
      batches: z.array(BatchStockSchema),
    }),
  ),
  total_qty_milli: zSignedQty,
  total_value_cost_paise: zSignedPaise,
  recent_movements: z.array(MovementRowSchema),
})
export type ProductStock = z.output<typeof ProductStockSchema>

export const ProductStockQuerySchema = z.object({
  store_id: zId.optional().describe('Default: every store the member can access'),
})

// =============================================================================================
// Batches
// =============================================================================================

export const BatchRowSchema = z.object({
  id: zId,
  product_id: zId,
  product_name: z.string(),
  product_name_ta: z.string().nullable(),
  sku: z.string().nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  batch_no: z.string(),
  mfg_date: zDateStr.nullable(),
  expiry_date: zDateStr.nullable(),
  mrp_paise: zPaise.nullable(),
  purchase_price_paise: zPaise.nullable(),
  sale_price_paise: zPaise.nullable(),
  supplier_id: zId.nullable(),
  supplier_name: z.string().nullable(),
  is_active: z.boolean(),
  /** In ?store_id, else summed over the stores the member can access. */
  qty_milli: zSignedQty,
  value_cost_paise: zSignedPaise,
  expiry_status: ExpiryStatusSchema,
  days_to_expiry: z.int().nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type BatchRow = z.output<typeof BatchRowSchema>

export const BatchListQuerySchema = PageQuerySchema.extend({
  product_id: zId.optional(),
  store_id: zId.optional(),
  supplier_id: zId.optional(),
  q: zSearchQuery.optional().describe('Batch number or product name'),
  expiring_within_days: zQueryInt(0, 730)
    .optional()
    .describe('Not yet expired and expiring within N days (tabs ≤30 / ≤60 / ≤90)'),
  expired: zBooleanQuery.optional().describe('Expired before today'),
  with_stock_only: zBooleanQuery.default(false),
  is_active: zBooleanQuery.optional(),
  ids: zQueryIds.optional(),
  sort: sortQuery(['expiry_date', 'product_name', 'qty', 'created_at'] as const).prefault(
    'expiry_date',
  ),
})
export type BatchListQuery = z.input<typeof BatchListQuerySchema>

/**
 * PATCH /batches/:id (audited). Prices need inventory.adjust or catalog.write; expiry / mfg
 * changes need inventory.adjust.
 */
export const BatchUpdateSchema = z
  .object({
    mrp_paise: zPaise.nullable().optional(),
    sale_price_paise: zPaise.nullable().optional(),
    purchase_price_paise: zPaise.nullable().optional(),
    expiry_date: zDateStr.nullable().optional(),
    mfg_date: zDateStr.nullable().optional(),
    is_active: z.boolean().optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .refine((v) => !v.mfg_date || !v.expiry_date || v.mfg_date <= v.expiry_date, {
    message: 'batch_dates',
    path: ['expiry_date'],
  })
  .refine(notEmpty, { message: 'empty_patch' })
export type BatchUpdate = z.input<typeof BatchUpdateSchema>

// =============================================================================================
// Stock adjustments (adjustment, stock take, damage, expiry write-off)
// =============================================================================================

/** Kinds created through /stock-adjustments ('opening' comes from POST /stock/opening). */
export const EditableAdjustmentKindSchema = AdjustmentKindSchema.exclude(['opening'])
export type EditableAdjustmentKind = z.infer<typeof EditableAdjustmentKindSchema>

export const AdjustmentLineInputSchema = z.object({
  product_id: zId,
  /** Required for batch-tracked products; null for others. */
  batch_id: zId.nullable().default(null),
  /** adjustment: ± change; damage / expiry_writeoff: < 0. Not used by stock_take. */
  qty_delta_milli: z.int().min(-1e12).max(1e12).optional(),
  /** stock_take: physically counted quantity (system quantity is read at posting). */
  counted_qty_milli: z.int().min(0).max(1e12).optional(),
  /**
   * Per pack excl. tax, for GAINS (default: the current average cost of the stock row). Losses
   * are always valued at the current average cost (core postStock); the posted line shows the
   * cost actually used.
   */
  unit_cost_paise: zPaise.optional(),
  reason: zNullableText(200),
})
export type AdjustmentLineInput = z.input<typeof AdjustmentLineInputSchema>

type LineRuleInput = {
  product_id: string
  batch_id: string | null
  qty_delta_milli?: number | undefined
  counted_qty_milli?: number | undefined
}

/** Line rules per kind (create / update bodies; the server re-checks before posting). */
export function adjustmentLineIssues(
  kind: EditableAdjustmentKind,
  lines: readonly LineRuleInput[],
): { path: (string | number)[]; code: InventoryValidationKey }[] {
  const issues: { path: (string | number)[]; code: InventoryValidationKey }[] = []
  const seen = new Set<string>()
  lines.forEach((l, i) => {
    const key = `${l.product_id}:${l.batch_id ?? '-'}`
    if (seen.has(key)) issues.push({ path: ['lines', i, 'product_id'], code: 'duplicate_line' })
    seen.add(key)
    if (kind === 'stock_take') {
      if (l.counted_qty_milli === undefined)
        issues.push({ path: ['lines', i, 'counted_qty_milli'], code: 'counted_qty_required' })
      return
    }
    if (l.qty_delta_milli === undefined)
      issues.push({ path: ['lines', i, 'qty_delta_milli'], code: 'qty_delta_required' })
    else if (l.qty_delta_milli === 0)
      issues.push({ path: ['lines', i, 'qty_delta_milli'], code: 'qty_delta_zero' })
    else if (WRITE_OFF_KINDS.includes(kind) && l.qty_delta_milli > 0)
      issues.push({ path: ['lines', i, 'qty_delta_milli'], code: 'loss_must_be_negative' })
  })
  return issues
}

const MAX_ADJUSTMENT_LINES = 2000

/** POST /stock-adjustments — a draft (may start empty; stock takes are often built over time). */
export const AdjustmentCreateSchema = z
  .object({
    store_id: zId,
    kind: EditableAdjustmentKindSchema.default('adjustment'),
    adjustment_date: zDateStr.optional().describe('Default: today (tenant timezone)'),
    notes: zNullableText(1000),
    lines: z.array(AdjustmentLineInputSchema).max(MAX_ADJUSTMENT_LINES).default([]),
  })
  .superRefine((v, ctx) => {
    for (const issue of adjustmentLineIssues(v.kind, v.lines))
      ctx.addIssue({ code: 'custom', path: issue.path, message: issue.code })
  })
export type AdjustmentCreate = z.input<typeof AdjustmentCreateSchema>

/** PATCH /stock-adjustments/:id (draft only) — `lines` replaces every line. */
export const AdjustmentUpdateSchema = z
  .object({
    store_id: zId.optional(),
    kind: EditableAdjustmentKindSchema.optional(),
    adjustment_date: zDateStr.optional(),
    notes: zNullableText(1000),
    lines: z.array(AdjustmentLineInputSchema).max(MAX_ADJUSTMENT_LINES).optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .superRefine((v, ctx) => {
    if (v.kind && v.lines)
      for (const issue of adjustmentLineIssues(v.kind, v.lines))
        ctx.addIssue({ code: 'custom', path: issue.path, message: issue.code })
  })
  .refine(notEmpty, { message: 'empty_patch' })
export type AdjustmentUpdate = z.input<typeof AdjustmentUpdateSchema>

/** POST /stock-adjustments/:id/cancel (posted only, once) — reverses stock and journal. */
export const AdjustmentCancelSchema = z.object({ reason: z.string().trim().min(1).max(200) })
export type AdjustmentCancel = z.input<typeof AdjustmentCancelSchema>

export const StockAdjustmentSchema = z.object({
  id: zId,
  /** Assigned on posting ('stock_adjustment' series, e.g. ADJS1/2627/00012). */
  number: z.string().nullable(),
  fy: z.string().nullable(),
  store_id: zId,
  store_code: z.string(),
  store_name: z.string(),
  adjustment_date: zDateStr,
  kind: AdjustmentKindSchema,
  status: AdjustmentStatusSchema,
  notes: z.string().nullable(),
  /** Signed value impact at cost (gain − loss); computed live for drafts. */
  total_value_paise: zSignedPaise,
  line_count: z.int().min(0),
  posted_at: zTimestamp.nullable(),
  posted_by: zId.nullable(),
  posted_by_name: z.string().nullable(),
  created_by: zId.nullable(),
  created_by_name: z.string().nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type StockAdjustment = z.output<typeof StockAdjustmentSchema>

export const AdjustmentLineSchema = z.object({
  id: zId,
  line_no: z.int().min(1),
  product_id: zId,
  product_name: z.string(),
  product_name_ta: z.string().nullable(),
  sku: z.string().nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  track_batches: z.boolean(),
  batch_id: zId.nullable(),
  batch_no: z.string().nullable(),
  expiry_date: zDateStr.nullable(),
  /** stock_take: system quantity snapshotted at posting (drafts: null). */
  system_qty_milli: zSignedQty.nullable(),
  counted_qty_milli: z.int().min(0).nullable(),
  /** Change applied (stock_take drafts: counted − current quantity, live). */
  qty_delta_milli: zSignedQty,
  unit_cost_paise: zPaise,
  value_paise: zSignedPaise,
  reason: z.string().nullable(),
  /** Drafts: live stock of the (store, product, batch) row; posted: null. */
  current_qty_milli: zSignedQty.nullable(),
})
export type AdjustmentLine = z.output<typeof AdjustmentLineSchema>

export const StockAdjustmentDetailSchema = StockAdjustmentSchema.extend({
  lines: z.array(AdjustmentLineSchema),
  gain_value_paise: zPaise,
  loss_value_paise: zPaise,
  /** Movements posted for this adjustment (and its reversal when cancelled). */
  movements: z.array(MovementRowSchema),
  journal_entry_id: zId.nullable(),
  cancelled_at: zTimestamp.nullable(),
  cancelled_by_name: z.string().nullable(),
  cancel_reason: z.string().nullable(),
})
export type StockAdjustmentDetail = z.output<typeof StockAdjustmentDetailSchema>

export const AdjustmentListQuerySchema = PageQuerySchema.extend({
  store_id: zId.optional(),
  kind: AdjustmentKindSchema.optional(),
  status: AdjustmentStatusSchema.optional(),
  q: zSearchQuery.optional().describe('Number or notes'),
  ...DateRangeShape,
  sort: sortQuery(['adjustment_date', 'created_at', 'number'] as const).prefault(
    '-adjustment_date',
  ),
}).refine(dateOrder, { message: 'date_order', path: ['to'] })
export type AdjustmentListQuery = z.input<typeof AdjustmentListQuerySchema>

// =============================================================================================
// Opening stock
// =============================================================================================

export const OpeningBatchInputSchema = z
  .object({
    batch_no: z.string().trim().min(1).max(40),
    expiry_date: zDateStr.nullable().default(null),
    mfg_date: zDateStr.nullable().default(null),
    mrp_paise: zPaise.nullable().default(null),
    sale_price_paise: zPaise.nullable().default(null),
  })
  .refine((b) => !b.mfg_date || !b.expiry_date || b.mfg_date <= b.expiry_date, {
    message: 'batch_dates',
    path: ['expiry_date'],
  })

export const OpeningStockLineSchema = z
  .object({
    product_id: zId,
    qty_milli: zQtyMilli,
    /** Per pack excl. tax. */
    unit_cost_paise: zPaise,
    /** An existing batch … */
    batch_id: zId.optional(),
    /** … or a batch to create / reuse by batch_no (batch-tracked products need one of the two). */
    batch: OpeningBatchInputSchema.optional(),
  })
  .refine((l) => !(l.batch_id && l.batch), { message: 'batch_ambiguous', path: ['batch'] })
export type OpeningStockLine = z.input<typeof OpeningStockLineSchema>

/**
 * POST /stock/opening — posts 'opening' movements and Dr inventory / Cr opening_balance as a
 * posted adjustment of kind 'opening'. Products that already have movements in the store are
 * refused (409 {product_ids}) unless `force` (audited).
 */
export const OpeningStockSchema = z
  .object({
    store_id: zId,
    date: zDateStr.optional().describe('Default: today'),
    notes: zNullableText(1000),
    force: z.boolean().default(false),
    lines: z.array(OpeningStockLineSchema).min(1).max(MAX_ADJUSTMENT_LINES),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>()
    v.lines.forEach((l, i) => {
      const key = `${l.product_id}:${l.batch_id ?? l.batch?.batch_no.toUpperCase() ?? '-'}`
      if (seen.has(key))
        ctx.addIssue({
          code: 'custom',
          path: ['lines', i, 'product_id'],
          message: 'duplicate_line',
        })
      seen.add(key)
    })
  })
export type OpeningStock = z.input<typeof OpeningStockSchema>

export const OpeningStockResultSchema = z.object({
  adjustment: StockAdjustmentDetailSchema,
  total_value_paise: zPaise,
  journal_entry_id: zId.nullable(),
  /** Batches created for this opening (batch_no → id). */
  batches_created: z.array(z.object({ product_id: zId, batch_id: zId, batch_no: z.string() })),
})
export type OpeningStockResult = z.output<typeof OpeningStockResultSchema>

// =============================================================================================
// Stock transfers (features stock_transfers + multi_store)
// =============================================================================================

export const TransferLineInputSchema = z.object({
  product_id: zId,
  batch_id: zId.nullable().default(null),
  qty_milli: zQtyMilli,
})

function transferLineIssues(
  lines: readonly { product_id: string; batch_id: string | null }[],
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>()
  lines.forEach((l, i) => {
    const key = `${l.product_id}:${l.batch_id ?? '-'}`
    if (seen.has(key))
      ctx.addIssue({ code: 'custom', path: ['lines', i, 'product_id'], message: 'duplicate_line' })
    seen.add(key)
  })
}

/** POST /stock-transfers — a draft. */
export const TransferCreateSchema = z
  .object({
    from_store_id: zId,
    to_store_id: zId,
    transfer_date: zDateStr.optional().describe('Default: today'),
    notes: zNullableText(1000),
    lines: z.array(TransferLineInputSchema).min(1).max(500),
  })
  .superRefine((v, ctx) => {
    if (v.from_store_id === v.to_store_id)
      ctx.addIssue({ code: 'custom', path: ['to_store_id'], message: 'transfer_same_store' })
    transferLineIssues(v.lines, ctx)
  })
export type TransferCreate = z.input<typeof TransferCreateSchema>

/** PATCH /stock-transfers/:id (draft only) — `lines` replaces every line. */
export const TransferUpdateSchema = z
  .object({
    from_store_id: zId.optional(),
    to_store_id: zId.optional(),
    transfer_date: zDateStr.optional(),
    notes: zNullableText(1000),
    lines: z.array(TransferLineInputSchema).min(1).max(500).optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .superRefine((v, ctx) => {
    if (v.from_store_id && v.from_store_id === v.to_store_id)
      ctx.addIssue({ code: 'custom', path: ['to_store_id'], message: 'transfer_same_store' })
    if (v.lines) transferLineIssues(v.lines, ctx)
  })
  .refine(notEmpty, { message: 'empty_patch' })
export type TransferUpdate = z.input<typeof TransferUpdateSchema>

/**
 * POST /stock-transfers/:id/receive (destination store access). Omitted `lines` (or a line not
 * listed) = received in full. The received quantity is posted as transfer_in at the destination
 * at the dispatch cost; a line's shortfall (dispatched − received) is returned to the source
 * (transfer_in) and written off there as 'damage' at the source cost, so the source store bears
 * the loss. Journal: Dr inventory (to) / Cr inventory (from) for the received value and
 * Dr inventory_writeoff / Cr inventory (from) for the shortfall (rounding residue of pack-priced
 * lines → inventory_adjustment), so each store's inventory account equals its stock movements.
 */
export const TransferReceiveSchema = z
  .object({
    lines: z
      .array(z.object({ line_id: zId, received_qty_milli: z.int().min(0) }))
      .max(500)
      .optional(),
    received_date: zDateStr.optional(),
    shortfall_reason: zNullableText(200),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>()
    v.lines?.forEach((l, i) => {
      if (seen.has(l.line_id))
        ctx.addIssue({ code: 'custom', path: ['lines', i, 'line_id'], message: 'duplicate_line' })
      seen.add(l.line_id)
    })
  })
export type TransferReceive = z.input<typeof TransferReceiveSchema>

/**
 * POST /stock-transfers/:id/cancel — a draft becomes 'cancelled' (no number, no stock); a
 * dispatched-not-received transfer reverses its transfer_out. Received transfers → 409.
 */
export const TransferCancelSchema = z.object({ reason: z.string().trim().min(1).max(200) })
export type TransferCancel = z.input<typeof TransferCancelSchema>

export const StockTransferSchema = z.object({
  id: zId,
  /** Assigned on dispatch ('stock_transfer' series of the source store, e.g. TRS1/2627/00003). */
  number: z.string().nullable(),
  fy: z.string().nullable(),
  from_store_id: zId,
  from_store_code: z.string(),
  from_store_name: z.string(),
  to_store_id: zId,
  to_store_code: z.string(),
  to_store_name: z.string(),
  transfer_date: zDateStr,
  status: TransferStatusSchema,
  notes: z.string().nullable(),
  line_count: z.int().min(0),
  /** Σ qty × unit cost (dispatched lines; drafts at current average cost). */
  total_value_paise: zPaise,
  /** Σ shortfall value posted on receipt. */
  shortfall_value_paise: zPaise,
  dispatched_at: zTimestamp.nullable(),
  dispatched_by_name: z.string().nullable(),
  received_at: zTimestamp.nullable(),
  received_by_name: z.string().nullable(),
  created_by_name: z.string().nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type StockTransfer = z.output<typeof StockTransferSchema>

export const TransferLineSchema = z.object({
  id: zId,
  line_no: z.int().min(1),
  product_id: zId,
  product_name: z.string(),
  product_name_ta: z.string().nullable(),
  sku: z.string().nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  track_batches: z.boolean(),
  batch_id: zId.nullable(),
  batch_no: z.string().nullable(),
  expiry_date: zDateStr.nullable(),
  qty_milli: zQtyMilli,
  received_qty_milli: z.int().min(0).nullable(),
  shortfall_qty_milli: z.int().min(0),
  /** Per pack: the source cost fixed at dispatch (drafts: current average). */
  unit_cost_paise: zPaise,
  value_paise: zPaise,
  /** Drafts: stock available at the source store. */
  available_qty_milli: zSignedQty.nullable(),
})
export type TransferLine = z.output<typeof TransferLineSchema>

export const TransferEventSchema = z.object({
  event: z.enum(['created', 'dispatched', 'received', 'cancelled']),
  at: zTimestamp,
  user_id: zId.nullable(),
  user_name: z.string().nullable(),
  note: z.string().nullable(),
})

export const StockTransferDetailSchema = StockTransferSchema.extend({
  lines: z.array(TransferLineSchema),
  /** Status timeline, oldest first. */
  timeline: z.array(TransferEventSchema),
})
export type StockTransferDetail = z.output<typeof StockTransferDetailSchema>

export const TransferListQuerySchema = PageQuerySchema.extend({
  store_id: zId.optional().describe('Transfers from or to this store'),
  direction: z.enum(['in', 'out']).optional().describe('With store_id: incoming / outgoing only'),
  from_store_id: zId.optional(),
  to_store_id: zId.optional(),
  status: TransferStatusSchema.optional(),
  q: zSearchQuery.optional().describe('Number or notes'),
  ...DateRangeShape,
  sort: sortQuery(['transfer_date', 'created_at', 'number'] as const).prefault('-transfer_date'),
}).refine(dateOrder, { message: 'date_order', path: ['to'] })
export type TransferListQuery = z.input<typeof TransferListQuerySchema>

export type TransferAction = 'create' | 'update' | 'dispatch' | 'receive' | 'cancel'

/**
 * The store a member must be able to access (membership store scope) for a transfer action:
 * receiving needs the destination store, everything else the source store.
 */
export function transferAccessStoreId(
  action: TransferAction,
  transfer: { from_store_id: string; to_store_id: string },
): string {
  return action === 'receive' ? transfer.to_store_id : transfer.from_store_id
}

/** Shortfall of a line on receipt: dispatched − received (never negative). */
export function transferShortfall(qty_milli: number, received_qty_milli: number | null): number {
  return received_qty_milli === null ? 0 : Math.max(0, qty_milli - received_qty_milli)
}

// =============================================================================================
// Alerts & digest
// =============================================================================================

export const StockAlertsQuerySchema = z.object({
  store_id: zStoreScope.optional(),
  limit: zQueryInt(1, 50).default(10).describe('Top items per list'),
})
export type StockAlertsQuery = z.input<typeof StockAlertsQuerySchema>

export const StockAlertItemSchema = z.object({
  store_id: zId.nullable(),
  product_id: zId,
  sku: z.string().nullable(),
  name: z.string(),
  name_ta: z.string().nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  qty_milli: zSignedQty,
  reorder_level_milli: z.int().min(0).nullable(),
  reorder_qty_milli: z.int().min(0).nullable(),
})
export type StockAlertItem = z.output<typeof StockAlertItemSchema>

export const ExpiryAlertItemSchema = z.object({
  store_id: zId.nullable(),
  batch_id: zId,
  batch_no: z.string(),
  product_id: zId,
  name: z.string(),
  name_ta: z.string().nullable(),
  unit: z.string(),
  pack_size: z.int().min(1),
  expiry_date: zDateStr,
  days_to_expiry: z.int(),
  qty_milli: zSignedQty,
  value_cost_paise: zSignedPaise,
})
export type ExpiryAlertItem = z.output<typeof ExpiryAlertItemSchema>

/**
 * GET /stock/alerts — counts and top items (expiring = within settings.inventory.expiry_warning_days).
 * low_stock: 0 < qty ≤ reorder level; out_of_stock: qty ≤ 0 (negative first) for active products
 * that were stocked in the scope before or have a reorder level (never-stocked catalogue items are
 * not alerts); counts.out_of_stock / counts.negative split that list by qty = 0 / qty < 0.
 * Expiry lists only batches with stock.
 */
export const StockAlertsSchema = z.object({
  store_id: zId.nullable(),
  as_of: zDateStr,
  expiry_warning_days: z.int().min(0),
  counts: z.object({
    low_stock: z.int().min(0),
    out_of_stock: z.int().min(0),
    negative: z.int().min(0),
    expiring: z.int().min(0),
    expired: z.int().min(0),
  }),
  low_stock: z.array(StockAlertItemSchema),
  out_of_stock: z.array(StockAlertItemSchema),
  expiring: z.array(ExpiryAlertItemSchema),
  /** Expired batches that still have stock. */
  expired: z.array(ExpiryAlertItemSchema),
  expiring_value_paise: zSignedPaise,
  expired_value_paise: zSignedPaise,
})
export type StockAlerts = z.output<typeof StockAlertsSchema>

/** Notification template codes used by the inventory.alerts job (notifications module). */
export const INVENTORY_DIGEST_TEMPLATES = {
  low_stock: 'low_stock_digest',
  expiry: 'expiry_digest',
} as const

/** Flat params of the low_stock_digest template ({{placeholders}}; values pre-formatted). */
export const LowStockDigestParamsSchema = z.object({
  shop_name: z.string(),
  store_name: z.string(),
  date: z.string().describe('dd-MM-yyyy'),
  low_stock_count: z.int().min(0),
  out_of_stock_count: z.int().min(0),
  /** One item per line: "Ponni Rice 1 kg — 3 pcs". */
  items_text: z.string(),
  link: z.string(),
})
export type LowStockDigestParams = z.output<typeof LowStockDigestParamsSchema>

export const ExpiryDigestParamsSchema = z.object({
  shop_name: z.string(),
  store_name: z.string(),
  date: z.string().describe('dd-MM-yyyy'),
  expiring_count: z.int().min(0),
  expired_count: z.int().min(0),
  /** Formatted ₹ value at risk. */
  value_text: z.string(),
  items_text: z.string(),
  link: z.string(),
})
export type ExpiryDigestParams = z.output<typeof ExpiryDigestParamsSchema>

/** Data of the inventory.alerts job (one run per tenant; the cron fan-out enqueues these). */
export const InventoryAlertsJobSchema = z.object({ tenant_id: zId, date: zDateStr })

// =============================================================================================
// Cross-module navigation (prefilled forms opened from inventory pages)
// =============================================================================================

function withQuery(
  path: string,
  params: Record<string, string | readonly string[] | undefined>,
): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue
    const value = typeof v === 'string' ? v : v.join(',')
    if (value !== '') parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(value)}`)
  }
  return parts.length ? `${path}?${parts.join('&')}` : path
}

/** Minimal query-string parser (no DOM / Node globals in shared): '?a=1&b=x%2Cy' → {a:'1', b:'x,y'}. */
function parseQueryString(search: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of search.replace(/^\?/, '').split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const rawKey = eq === -1 ? part : part.slice(0, eq)
    const rawValue = eq === -1 ? '' : part.slice(eq + 1)
    try {
      const key = decodeURIComponent(rawKey.replace(/\+/g, ' '))
      if (!out.has(key)) out.set(key, decodeURIComponent(rawValue.replace(/\+/g, ' ')))
    } catch {
      // malformed escape: ignore the pair
    }
  }
  return out
}

/** /purchases/returns/new?store_id=&supplier_id=&batch_ids=a,b — return expiring batches to the supplier. */
export function purchaseReturnPrefillPath(p: {
  batch_ids: readonly string[]
  store_id?: string
  supplier_id?: string
}): string {
  return withQuery('/purchases/returns/new', {
    store_id: p.store_id,
    supplier_id: p.supplier_id,
    batch_ids: p.batch_ids,
  })
}

/** /purchases/orders/new?source=reorder&store_id=&product_ids= — from low-stock items. */
export function reorderPrefillPath(
  p: { store_id?: string; product_ids?: readonly string[] } = {},
): string {
  return withQuery('/purchases/orders/new', {
    source: 'reorder',
    store_id: p.store_id,
    product_ids: p.product_ids,
  })
}

/** /inventory/adjustments/new?kind=&store_id=&batch_ids=&product_ids= (e.g. expiry write-off). */
export function adjustmentPrefillPath(p: {
  kind: EditableAdjustmentKind
  store_id?: string
  batch_ids?: readonly string[]
  product_ids?: readonly string[]
}): string {
  return withQuery('/inventory/adjustments/new', {
    kind: p.kind,
    store_id: p.store_id,
    batch_ids: p.batch_ids,
    product_ids: p.product_ids,
  })
}

/** /inventory/transfers/new?from_store_id=&product_ids= */
export function transferPrefillPath(p: {
  from_store_id?: string
  product_ids?: readonly string[]
}): string {
  return withQuery('/inventory/transfers/new', {
    from_store_id: p.from_store_id,
    product_ids: p.product_ids,
  })
}

/** Expiry windows of the Batches & expiry page (?tab=): expired, ≤ 30 / 60 / 90 days, all. */
export const BATCH_EXPIRY_TABS = ['expired', 'd30', 'd60', 'd90', 'all'] as const
export type BatchExpiryTab = (typeof BATCH_EXPIRY_TABS)[number]

/** Days of a `dNN` tab (null for expired / all). */
export function batchExpiryTabDays(tab: BatchExpiryTab): number | null {
  return tab === 'd30' ? 30 : tab === 'd60' ? 60 : tab === 'd90' ? 90 : null
}

/** The narrowest expiry tab that covers `days` (settings.inventory.expiry_warning_days). */
export function batchExpiryTabFor(days: number): BatchExpiryTab {
  if (days <= 30) return 'd30'
  if (days <= 60) return 'd60'
  if (days <= 90) return 'd90'
  return 'all'
}

/** Stock page filter chips (?filter=). */
export type StockPageFilter = 'low' | 'out' | 'in'

/** /inventory/stock?store=&filter= — the stock page's URL state (digest links, dashboards). */
export function stockPagePath(p: { store_id?: string; filter?: StockPageFilter } = {}): string {
  return withQuery('/inventory/stock', { store: p.store_id, filter: p.filter })
}

/** /inventory/batches?store=&tab= — the Batches & expiry page's URL state. */
export function batchesPagePath(p: { store_id?: string; tab?: BatchExpiryTab } = {}): string {
  return withQuery('/inventory/batches', { store: p.store_id, tab: p.tab })
}

export interface InventoryPrefill {
  store_id: string | null
  from_store_id: string | null
  supplier_id: string | null
  kind: EditableAdjustmentKind | null
  source: string | null
  batch_ids: string[]
  product_ids: string[]
}

/** Parses the query (location.search) of a prefilled form; invalid ids are dropped. */
export function parseInventoryPrefill(search: string): InventoryPrefill {
  const params = parseQueryString(search)
  const id = (k: string) => {
    const v = params.get(k)
    return v && isUuid(v) ? v : null
  }
  const ids = (k: string) =>
    (params.get(k) ?? '')
      .split(',')
      .map((v: string) => v.trim())
      .filter(isUuid)
  const kind = EditableAdjustmentKindSchema.safeParse(params.get('kind'))
  return {
    store_id: id('store_id'),
    from_store_id: id('from_store_id'),
    supplier_id: id('supplier_id'),
    kind: kind.success ? kind.data : null,
    source: params.get('source') ?? null,
    batch_ids: ids('batch_ids'),
    product_ids: ids('product_ids'),
  }
}

// =============================================================================================
// Route catalogue (docs/API.md "inventory")
// =============================================================================================

const IdParams = z.object({ id: zId })

export const inventoryRoutes = defineRoutes({
  // ---- stock ---------------------------------------------------------------------------------
  listStock: {
    method: 'GET',
    path: '/stock',
    permission: 'inventory.read',
    query: StockListQuerySchema,
    response: StockListResponseSchema,
    summary: 'Stock levels with value at cost and MRP, status flags and totals (?format=csv)',
  },
  stockAlerts: {
    method: 'GET',
    path: '/stock/alerts',
    permission: 'inventory.read',
    query: StockAlertsQuerySchema,
    response: dataOf(StockAlertsSchema),
  },
  listMovements: {
    method: 'GET',
    path: '/stock/movements',
    permission: 'inventory.read',
    query: MovementListQuerySchema,
    response: listOf(MovementRowSchema),
    summary: 'Stock movement ledger with balances and document references (?format=csv)',
  },
  productStock: {
    method: 'GET',
    path: '/stock/products/:productId',
    permission: 'inventory.read',
    params: z.object({ productId: zId }),
    query: ProductStockQuerySchema,
    response: dataOf(ProductStockSchema),
  },
  postOpeningStock: {
    method: 'POST',
    path: '/stock/opening',
    permission: 'inventory.adjust',
    idempotent: true,
    body: OpeningStockSchema,
    response: dataOf(OpeningStockResultSchema),
    status: 201,
    summary:
      'Opening stock (Dr inventory / Cr opening balance); refuses stocked products unless force',
  },

  // ---- batches -------------------------------------------------------------------------------
  listBatches: {
    method: 'GET',
    path: '/batches',
    permission: 'inventory.read',
    query: BatchListQuerySchema,
    response: listOf(BatchRowSchema),
  },
  updateBatch: {
    method: 'PATCH',
    path: '/batches/:id',
    permission: ['inventory.adjust', 'catalog.write'],
    params: IdParams,
    body: BatchUpdateSchema,
    response: dataOf(BatchRowSchema),
    summary: 'Edit batch MRP / prices / dates (expiry changes need inventory.adjust; audited)',
  },

  // ---- adjustments ---------------------------------------------------------------------------
  listAdjustments: {
    method: 'GET',
    path: '/stock-adjustments',
    permission: 'inventory.adjust',
    query: AdjustmentListQuerySchema,
    response: listOf(StockAdjustmentSchema),
  },
  createAdjustment: {
    method: 'POST',
    idempotent: true,
    path: '/stock-adjustments',
    permission: 'inventory.adjust',
    body: AdjustmentCreateSchema,
    response: dataOf(StockAdjustmentDetailSchema),
    status: 201,
  },
  getAdjustment: {
    method: 'GET',
    path: '/stock-adjustments/:id',
    permission: 'inventory.adjust',
    params: IdParams,
    response: dataOf(StockAdjustmentDetailSchema),
  },
  updateAdjustment: {
    method: 'PATCH',
    path: '/stock-adjustments/:id',
    permission: 'inventory.adjust',
    params: IdParams,
    body: AdjustmentUpdateSchema,
    response: dataOf(StockAdjustmentDetailSchema),
  },
  deleteAdjustment: {
    method: 'DELETE',
    path: '/stock-adjustments/:id',
    permission: 'inventory.adjust',
    params: IdParams,
    summary: 'Delete a draft (posted adjustments are cancelled instead)',
  },
  postAdjustment: {
    method: 'POST',
    idempotent: true,
    path: '/stock-adjustments/:id/post',
    permission: 'inventory.adjust',
    params: IdParams,
    response: dataOf(StockAdjustmentDetailSchema),
    summary: 'Number, post stock (stock takes: counted − system under lock) and journal (audited)',
  },
  cancelAdjustment: {
    method: 'POST',
    idempotent: true,
    path: '/stock-adjustments/:id/cancel',
    permission: 'inventory.adjust',
    params: IdParams,
    body: AdjustmentCancelSchema,
    response: dataOf(StockAdjustmentDetailSchema),
    summary: 'Reverse a posted adjustment (once; audited)',
  },

  // ---- transfers -----------------------------------------------------------------------------
  listTransfers: {
    method: 'GET',
    path: '/stock-transfers',
    permission: 'inventory.read',
    feature: 'stock_transfers',
    query: TransferListQuerySchema,
    response: listOf(StockTransferSchema),
  },
  createTransfer: {
    method: 'POST',
    idempotent: true,
    path: '/stock-transfers',
    permission: 'inventory.transfer',
    feature: 'stock_transfers',
    body: TransferCreateSchema,
    response: dataOf(StockTransferDetailSchema),
    status: 201,
  },
  getTransfer: {
    method: 'GET',
    path: '/stock-transfers/:id',
    permission: 'inventory.read',
    feature: 'stock_transfers',
    params: IdParams,
    response: dataOf(StockTransferDetailSchema),
  },
  updateTransfer: {
    method: 'PATCH',
    path: '/stock-transfers/:id',
    permission: 'inventory.transfer',
    feature: 'stock_transfers',
    params: IdParams,
    body: TransferUpdateSchema,
    response: dataOf(StockTransferDetailSchema),
  },
  dispatchTransfer: {
    method: 'POST',
    idempotent: true,
    path: '/stock-transfers/:id/dispatch',
    permission: 'inventory.transfer',
    feature: 'stock_transfers',
    params: IdParams,
    response: dataOf(StockTransferDetailSchema),
    summary: 'Number the transfer and post transfer_out at the source (source store access)',
  },
  receiveTransfer: {
    method: 'POST',
    idempotent: true,
    path: '/stock-transfers/:id/receive',
    permission: 'inventory.transfer',
    feature: 'stock_transfers',
    params: IdParams,
    body: TransferReceiveSchema.prefault({}),
    response: dataOf(StockTransferDetailSchema),
    summary: 'Post transfer_in at dispatch cost; shortfall → damage at source (destination access)',
  },
  cancelTransfer: {
    method: 'POST',
    idempotent: true,
    path: '/stock-transfers/:id/cancel',
    permission: 'inventory.transfer',
    feature: 'stock_transfers',
    params: IdParams,
    body: TransferCancelSchema,
    response: dataOf(StockTransferDetailSchema),
  },
})

/** Adjustment kind of a movement type, for linking a movement to its document type. */
export function adjustmentKindOfMovement(type: StockMovementType): AdjustmentKind | null {
  const entry = (
    Object.entries(ADJUSTMENT_MOVEMENT_TYPE) as Array<[AdjustmentKind, StockMovementType]>
  ).find(([, t]) => t === type)
  return entry ? entry[0] : null
}
