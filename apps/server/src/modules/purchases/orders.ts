/**
 * Purchase orders (docs/API.md "purchases"): numbered (PO…) on create, edited / deleted while
 * draft, sent to the supplier (optional WhatsApp / SMS through the notification outbox, template
 * po_to_supplier), cancelled or closed. Received quantities and the received statuses are
 * maintained by posted / cancelled purchase bills through {@link applyOrderReceipts}.
 */
import { sql } from 'kysely'
import {
  type PurchaseOrderStatus,
  computePurchaseLine,
  formatDateDisplay,
  formatINR,
  formatPacksAndLoose,
  newId,
  roundDiv,
} from '@kadai/shared'
import { toCsv } from '@kadai/shared/api/identity'
import { renderNotification, waMeUrl } from '@kadai/shared/api/notifications'
import {
  PO_TO_SUPPLIER_TEMPLATE,
  type PurchaseOrderCreateSchema,
  type PurchaseOrderDetail,
  type PurchaseOrderListQuerySchema,
  type PurchaseOrderListRow,
  type PurchaseOrderSendSchema,
  type PurchaseOrderUpdateSchema,
  formatPurchaseOrderText,
  purchaseOrderStatusAfterReceipt,
} from '@kadai/shared/api/purchases'
import type { z } from 'zod'
import { audit } from '../../core/audit'
import { assertFeature } from '../../core/entitlements'
import { assertNotStale, notFound } from '../../core/errors'
import { type PageEnvelope, type PageParams, assertStoreAccess } from '../../core/http'
import { enqueueNotification } from '../../core/notify'
import { nextNumber } from '../../core/numbering'
import type { Tx } from '../../db/tenant'
import {
  CSV_MAX_ROWS,
  type Ctx,
  type ProductInfo,
  assertPurchasable,
  businessToday,
  csvRupees,
  fieldIssue,
  iso,
  lastPurchases,
  loadProducts,
  loadStore,
  loadSupplier,
  loadTenant,
  paginateQuery,
  productRef,
  reasonError,
  stockByProduct,
  storeFilter,
  supplierRef,
  supplyIsInterstate,
  userNames,
} from './common'

type OrderCreate = z.output<typeof PurchaseOrderCreateSchema>
type OrderUpdate = z.output<typeof PurchaseOrderUpdateSchema>
type OrderSend = z.output<typeof PurchaseOrderSendSchema>
type OrderListQuery = z.output<typeof PurchaseOrderListQuerySchema>

/** ILIKE pattern for a user search term (wildcards escaped). */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

// ---------------------------------------------------------------------------------------------
// Line pricing
// ---------------------------------------------------------------------------------------------

interface PricedOrderLine {
  product: ProductInfo
  qty_milli: number
  unit_cost_paise: number
  gst_rate_bp: number
  taxable_paise: number
  tax_paise: number
  total_paise: number
  notes: string | null
}

interface OrderLineSource {
  product_id: string
  qty_milli: number
  unit_cost_paise?: number | undefined
  gst_rate_bp?: number | undefined
  notes?: string | null | undefined
}

/** Prices PO lines (defaults: the product's purchase price and GST rate; cess from the product). */
async function priceOrderLines(
  tx: Tx,
  ctx: Ctx,
  lines: readonly OrderLineSource[],
  isInterstate: boolean,
): Promise<PricedOrderLine[]> {
  const products = await loadProducts(
    tx,
    ctx,
    lines.map((l) => l.product_id),
  )
  return lines.map((l, i) => {
    const product = products.get(l.product_id)!
    assertPurchasable(product, i + 1)
    const unitCost = l.unit_cost_paise ?? product.purchase_price_paise
    const gstRate = l.gst_rate_bp ?? product.gst_rate_bp
    const r = computePurchaseLine({
      unit_cost_paise: unitCost,
      qty_milli: l.qty_milli,
      pack_size: product.pack_size,
      gst_rate_bp: gstRate,
      cess_rate_bp: product.cess_rate_bp,
      is_interstate: isInterstate,
    })
    return {
      product,
      qty_milli: l.qty_milli,
      unit_cost_paise: unitCost,
      gst_rate_bp: gstRate,
      taxable_paise: r.taxable_paise,
      tax_paise: r.tax_paise,
      total_paise: r.total_paise,
      notes: l.notes?.trim() ? l.notes.trim() : null,
    }
  })
}

function orderTotals(lines: readonly PricedOrderLine[]): {
  taxable_paise: number
  tax_paise: number
  total_paise: number
} {
  return lines.reduce(
    (t, l) => ({
      taxable_paise: t.taxable_paise + l.taxable_paise,
      tax_paise: t.tax_paise + l.tax_paise,
      total_paise: t.total_paise + l.total_paise,
    }),
    { taxable_paise: 0, tax_paise: 0, total_paise: 0 },
  )
}

async function insertOrderLines(
  tx: Tx,
  ctx: Ctx,
  orderId: string,
  lines: readonly PricedOrderLine[],
): Promise<void> {
  await tx
    .insertInto('purchase_order_lines')
    .values(
      lines.map((l, i) => ({
        id: newId(),
        tenant_id: ctx.tenantId,
        purchase_order_id: orderId,
        line_no: i + 1,
        product_id: l.product.id,
        qty_milli: l.qty_milli,
        unit_cost_paise: l.unit_cost_paise,
        gst_rate_bp: l.gst_rate_bp,
        taxable_paise: l.taxable_paise,
        tax_paise: l.tax_paise,
        total_paise: l.total_paise,
        notes: l.notes,
      })),
    )
    .execute()
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

interface OrderRow {
  id: string
  tenant_id: string
  store_id: string
  supplier_id: string
  number: string
  fy: string
  order_date: string
  expected_date: string | null
  status: string
  is_interstate: boolean
  taxable_paise: number
  tax_paise: number
  total_paise: number
  notes: string | null
  terms: string | null
  sent_at: Date | null
  created_by: string | null
  created_at: Date
  updated_at: Date
}

/** Loads (optionally locks) a purchase order the member may see (403 for other stores). */
export async function loadOrder(
  tx: Tx,
  ctx: Ctx,
  id: string,
  opts: { forUpdate?: boolean } = {},
): Promise<OrderRow> {
  let q = tx
    .selectFrom('purchase_orders')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
  if (opts.forUpdate) q = q.forUpdate()
  const row = await q.executeTakeFirst()
  if (!row) throw notFound('purchase_order', id)
  assertStoreAccess(ctx, row.store_id)
  return row
}

function ratioBp(ordered: number, received: number): number {
  if (ordered <= 0) return 0
  return Math.min(10_000, roundDiv(received * 10_000, ordered))
}

/**
 * How much of the order has arrived, in bp: weighted by the lines' taxable value (25 kg rice
 * bags and 1 kg salt packets must not count alike), by quantity when the order has no prices.
 */
function receivedBp(totals: {
  ordered_value: number
  received_value: number
  ordered_milli: number
  received_milli: number
}): number {
  return totals.ordered_value > 0
    ? ratioBp(totals.ordered_value, totals.received_value)
    : ratioBp(totals.ordered_milli, totals.received_milli)
}

export async function orderDetail(tx: Tx, ctx: Ctx, id: string): Promise<PurchaseOrderDetail> {
  const o = await loadOrder(tx, ctx, id)
  const [supplier, lines, bills] = await Promise.all([
    loadSupplier(tx, ctx, o.supplier_id),
    tx
      .selectFrom('purchase_order_lines')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantId)
      .where('purchase_order_id', '=', o.id)
      .orderBy('line_no')
      .execute(),
    tx
      .selectFrom('purchase_bills')
      .select(['id', 'number', 'supplier_invoice_no', 'received_date', 'status', 'total_paise'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('purchase_order_id', '=', o.id)
      .orderBy('received_date')
      .orderBy('created_at')
      .execute(),
  ])
  const productIds = lines.map((l) => l.product_id)
  const [products, stock, last, names] = await Promise.all([
    loadProducts(tx, ctx, productIds),
    stockByProduct(tx, ctx, o.store_id, productIds),
    lastPurchases(tx, ctx, productIds),
    userNames(tx, [o.created_by]),
  ])
  const progress = { ordered_value: 0, received_value: 0, ordered_milli: 0, received_milli: 0 }
  for (const l of lines) {
    const got = Math.min(l.qty_milli, l.received_qty_milli)
    progress.ordered_milli += l.qty_milli
    progress.received_milli += got
    progress.ordered_value += l.taxable_paise
    progress.received_value += Math.floor((l.taxable_paise * got) / l.qty_milli)
  }
  return {
    id: o.id,
    number: o.number,
    fy: o.fy,
    order_date: o.order_date,
    expected_date: o.expected_date,
    status: o.status as PurchaseOrderStatus,
    store_id: o.store_id,
    supplier_id: o.supplier_id,
    supplier_name: supplier.name,
    line_count: lines.length,
    taxable_paise: o.taxable_paise,
    tax_paise: o.tax_paise,
    total_paise: o.total_paise,
    received_bp: receivedBp(progress),
    sent_at: o.sent_at ? iso(o.sent_at) : null,
    created_at: iso(o.created_at),
    updated_at: iso(o.updated_at),
    is_interstate: o.is_interstate,
    notes: o.notes,
    terms: o.terms,
    supplier: supplierRef(supplier),
    lines: lines.map((l) => {
      const p = products.get(l.product_id)!
      return {
        id: l.id,
        line_no: l.line_no,
        product: productRef(p),
        product_id: l.product_id,
        qty_milli: l.qty_milli,
        received_qty_milli: l.received_qty_milli,
        pending_qty_milli: Math.max(0, l.qty_milli - l.received_qty_milli),
        unit_cost_paise: l.unit_cost_paise,
        gst_rate_bp: l.gst_rate_bp,
        taxable_paise: l.taxable_paise,
        tax_paise: l.tax_paise,
        total_paise: l.total_paise,
        notes: l.notes,
        current_stock_milli: stock.get(l.product_id) ?? 0,
        last_cost_paise: last.get(l.product_id)?.unit_cost_paise ?? null,
      }
    }),
    bills: bills.map((b) => ({
      id: b.id,
      number: b.number,
      supplier_invoice_no: b.supplier_invoice_no,
      received_date: b.received_date,
      status: b.status as 'draft' | 'posted' | 'cancelled',
      total_paise: b.total_paise,
    })),
    created_by: o.created_by,
    created_by_name: o.created_by ? (names.get(o.created_by) ?? null) : null,
  }
}

function filteredOrders(tx: Tx, ctx: Ctx, q: OrderListQuery) {
  let qb = tx
    .selectFrom('purchase_orders as o')
    .innerJoin('suppliers as s', (j) =>
      j.onRef('s.tenant_id', '=', 'o.tenant_id').onRef('s.id', '=', 'o.supplier_id'),
    )
    .where('o.tenant_id', '=', ctx.tenantId)
  const stores = storeFilter(ctx, q.store_id)
  if (stores)
    qb = stores.length ? qb.where('o.store_id', 'in', stores) : qb.where(sql<boolean>`false`)
  if (q.supplier_id) qb = qb.where('o.supplier_id', '=', q.supplier_id)
  if (q.status?.length) qb = qb.where('o.status', 'in', q.status)
  if (q.from) qb = qb.where('o.order_date', '>=', q.from)
  if (q.to) qb = qb.where('o.order_date', '<=', q.to)
  if (q.q) {
    const pattern = likePattern(q.q)
    qb = qb.where((eb) => eb.or([eb('o.number', 'ilike', pattern), eb('s.name', 'ilike', pattern)]))
  }
  return qb
}

const ORDER_SORT: Record<OrderListQuery['sort']['field'], `o.${string}`> = {
  order_date: 'o.order_date',
  number: 'o.number',
  total_paise: 'o.total_paise',
  expected_date: 'o.expected_date',
  created_at: 'o.created_at',
}

function orderListSelect(qb: ReturnType<typeof filteredOrders>, q: OrderListQuery) {
  const sort = ORDER_SORT[q.sort.field] as 'o.order_date'
  return qb
    .select([
      'o.id',
      'o.number',
      'o.fy',
      'o.order_date',
      'o.expected_date',
      'o.status',
      'o.store_id',
      'o.supplier_id',
      's.name as supplier_name',
      'o.taxable_paise',
      'o.tax_paise',
      'o.total_paise',
      'o.sent_at',
      'o.created_at',
      'o.updated_at',
      sql<number>`(select count(*) from purchase_order_lines l where l.tenant_id = o.tenant_id and l.purchase_order_id = o.id)::int`.as(
        'line_count',
      ),
      sql<number>`(select coalesce(sum(l.qty_milli), 0) from purchase_order_lines l where l.tenant_id = o.tenant_id and l.purchase_order_id = o.id)::bigint`.as(
        'ordered_milli',
      ),
      sql<number>`(select coalesce(sum(least(l.received_qty_milli, l.qty_milli)), 0) from purchase_order_lines l where l.tenant_id = o.tenant_id and l.purchase_order_id = o.id)::bigint`.as(
        'received_milli',
      ),
      sql<number>`(select coalesce(sum(l.taxable_paise), 0) from purchase_order_lines l where l.tenant_id = o.tenant_id and l.purchase_order_id = o.id)::bigint`.as(
        'ordered_value',
      ),
      sql<number>`(select coalesce(sum(l.taxable_paise * least(l.received_qty_milli, l.qty_milli) / l.qty_milli), 0) from purchase_order_lines l where l.tenant_id = o.tenant_id and l.purchase_order_id = o.id)::bigint`.as(
        'received_value',
      ),
    ])
    .orderBy(sql`${sql.ref(sort)} ${sql.raw(q.sort.direction)} nulls last`)
    .orderBy('o.created_at', 'desc')
    .orderBy('o.id', 'desc')
}

type OrderListDbRow = {
  id: string
  number: string
  fy: string
  order_date: string
  expected_date: string | null
  status: string
  store_id: string
  supplier_id: string
  supplier_name: string
  taxable_paise: number
  tax_paise: number
  total_paise: number
  sent_at: Date | null
  created_at: Date
  updated_at: Date
  line_count: number
  ordered_milli: number
  received_milli: number
  ordered_value: number
  received_value: number
}

function toOrderListRow(r: OrderListDbRow): PurchaseOrderListRow {
  return {
    id: r.id,
    number: r.number,
    fy: r.fy,
    order_date: r.order_date,
    expected_date: r.expected_date,
    status: r.status as PurchaseOrderStatus,
    store_id: r.store_id,
    supplier_id: r.supplier_id,
    supplier_name: r.supplier_name,
    line_count: Number(r.line_count),
    taxable_paise: r.taxable_paise,
    tax_paise: r.tax_paise,
    total_paise: r.total_paise,
    received_bp: receivedBp({
      ordered_value: Number(r.ordered_value),
      received_value: Number(r.received_value),
      ordered_milli: Number(r.ordered_milli),
      received_milli: Number(r.received_milli),
    }),
    sent_at: r.sent_at ? iso(r.sent_at) : null,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  }
}

export async function listOrders(
  tx: Tx,
  ctx: Ctx,
  q: OrderListQuery,
  page: PageParams,
): Promise<PageEnvelope<PurchaseOrderListRow>> {
  const result = await paginateQuery(orderListSelect(filteredOrders(tx, ctx, q), q), page)
  return { data: result.data.map((r) => toOrderListRow(r as OrderListDbRow)), page: result.page }
}

export async function ordersCsv(
  tx: Tx,
  ctx: Ctx,
  q: OrderListQuery,
): Promise<{ csv: string; rows: number }> {
  const rows = (await orderListSelect(filteredOrders(tx, ctx, q), q)
    .limit(CSV_MAX_ROWS)
    .execute()) as OrderListDbRow[]
  const out = rows.map((r) => {
    const row = toOrderListRow(r)
    return [
      row.number,
      row.order_date,
      row.expected_date,
      row.supplier_name,
      row.status,
      row.line_count,
      csvRupees(row.taxable_paise),
      csvRupees(row.tax_paise),
      csvRupees(row.total_paise),
      (row.received_bp / 100).toFixed(2),
      row.sent_at,
    ]
  })
  return {
    csv: toCsv([
      [
        'PO number',
        'Order date',
        'Expected date',
        'Supplier',
        'Status',
        'Lines',
        'Taxable (₹)',
        'Tax (₹)',
        'Total (₹)',
        'Received %',
        'Sent at',
      ],
      ...out,
    ]),
    rows: out.length,
  }
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

export async function createOrder(
  tx: Tx,
  ctx: Ctx,
  body: OrderCreate,
): Promise<PurchaseOrderDetail> {
  const store = await loadStore(tx, ctx, body.store_id, { requireActive: true })
  const supplier = await loadSupplier(tx, ctx, body.supplier_id, { requireActive: true })
  const { today } = await businessToday(tx, ctx)
  const orderDate = body.order_date ?? today
  if (body.expected_date && body.expected_date < orderDate) {
    throw fieldIssue(['expected_date'], 'date_order')
  }
  const interstate = supplyIsInterstate(store, supplier)
  const lines = await priceOrderLines(tx, ctx, body.lines, interstate)
  const totals = orderTotals(lines)
  const numbered = await nextNumber(tx, ctx, {
    docType: 'purchase_order',
    storeId: store.id,
    date: orderDate,
  })
  const id = newId()
  await tx
    .insertInto('purchase_orders')
    .values({
      id,
      tenant_id: ctx.tenantId,
      store_id: store.id,
      supplier_id: supplier.id,
      number: numbered.number,
      fy: numbered.fy,
      order_date: orderDate,
      expected_date: body.expected_date ?? null,
      status: 'draft',
      is_interstate: interstate,
      ...totals,
      notes: body.notes?.trim() ? body.notes.trim() : null,
      terms: body.terms?.trim() ? body.terms.trim() : null,
      created_by: ctx.userId,
    })
    .execute()
  await insertOrderLines(tx, ctx, id, lines)
  return orderDetail(tx, ctx, id)
}

function assertDraft(o: OrderRow): void {
  if (o.status !== 'draft') {
    throw reasonError(
      'CONFLICT',
      'order_not_draft',
      `Purchase order ${o.number} is ${o.status}; only drafts can be changed`,
      { purchase_order_id: o.id, status: o.status },
    )
  }
}

export async function updateOrder(
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: OrderUpdate,
): Promise<PurchaseOrderDetail> {
  const o = await loadOrder(tx, ctx, id, { forUpdate: true })
  assertNotStale(o.updated_at, body.if_updated_at, 'purchase_order', o.id)
  assertDraft(o)
  // Bills (drafts) made from the order point at its lines, which an edit replaces.
  const bills = await openBillsOf(tx, ctx, o.id, ['draft', 'posted'])
  if (bills.length) {
    throw reasonError(
      'CONFLICT',
      'order_has_bills',
      'Purchase bills refer to this order; delete them before editing it',
      { purchase_order_id: o.id, bill_ids: bills },
    )
  }
  const store = await loadStore(tx, ctx, o.store_id)
  const supplier =
    body.supplier_id && body.supplier_id !== o.supplier_id
      ? await loadSupplier(tx, ctx, body.supplier_id, { requireActive: true })
      : await loadSupplier(tx, ctx, o.supplier_id)
  const orderDate = body.order_date ?? o.order_date
  const expected = body.expected_date === undefined ? o.expected_date : body.expected_date
  if (expected && expected < orderDate) throw fieldIssue(['expected_date'], 'date_order')
  const interstate = supplyIsInterstate(store, supplier)

  let lines: PricedOrderLine[]
  if (body.lines) {
    lines = await priceOrderLines(tx, ctx, body.lines, interstate)
  } else {
    const existing = await tx
      .selectFrom('purchase_order_lines')
      .select(['product_id', 'qty_milli', 'unit_cost_paise', 'gst_rate_bp', 'notes'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('purchase_order_id', '=', o.id)
      .orderBy('line_no')
      .execute()
    lines = await priceOrderLines(tx, ctx, existing, interstate)
  }
  const totals = orderTotals(lines)
  await tx
    .deleteFrom('purchase_order_lines')
    .where('tenant_id', '=', ctx.tenantId)
    .where('purchase_order_id', '=', o.id)
    .execute()
  await insertOrderLines(tx, ctx, o.id, lines)
  await tx
    .updateTable('purchase_orders')
    .set({
      supplier_id: supplier.id,
      order_date: orderDate,
      expected_date: expected,
      is_interstate: interstate,
      ...totals,
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      ...(body.terms !== undefined ? { terms: body.terms } : {}),
      updated_at: new Date(),
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', o.id)
    .execute()
  return orderDetail(tx, ctx, o.id)
}

/** Draft / posted bills referencing the order (blocks delete, cancel and close). */
async function openBillsOf(
  tx: Tx,
  ctx: Ctx,
  orderId: string,
  statuses: string[],
): Promise<string[]> {
  const rows = await tx
    .selectFrom('purchase_bills')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('purchase_order_id', '=', orderId)
    .where('status', 'in', statuses)
    .execute()
  return rows.map((r) => r.id)
}

export async function deleteOrder(tx: Tx, ctx: Ctx, id: string): Promise<void> {
  const o = await loadOrder(tx, ctx, id, { forUpdate: true })
  assertDraft(o)
  const bills = await openBillsOf(tx, ctx, o.id, ['draft', 'posted', 'cancelled'])
  if (bills.length) {
    throw reasonError(
      'CONFLICT',
      'order_has_bills',
      'Purchase bills refer to this order; delete them first',
      { purchase_order_id: o.id, bill_ids: bills },
    )
  }
  await tx
    .deleteFrom('purchase_orders')
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', o.id)
    .execute()
  await audit(tx, ctx, {
    action: 'purchase_order.delete',
    entity_type: 'purchase_order',
    entity_id: o.id,
    summary: `Draft purchase order ${o.number} deleted`,
    changes: { number: o.number, supplier_id: o.supplier_id, total_paise: o.total_paise },
  })
}

/** po_to_supplier params and the item lines of an order (localised quantities). */
async function orderMessage(
  tx: Tx,
  ctx: Ctx,
  o: OrderRow,
  supplierName: string,
  extra: string | undefined,
): Promise<Record<string, string | null>> {
  const tenant = await loadTenant(tx, ctx)
  const lines = await tx
    .selectFrom('purchase_order_lines as l')
    .innerJoin('products as p', (j) =>
      j.onRef('p.tenant_id', '=', 'l.tenant_id').onRef('p.id', '=', 'l.product_id'),
    )
    .select(['p.name', 'p.name_ta', 'p.unit', 'p.pack_size', 'l.qty_milli'])
    .where('l.tenant_id', '=', ctx.tenantId)
    .where('l.purchase_order_id', '=', o.id)
    .orderBy('l.line_no')
    .execute()
  const locale = ctx.locale
  const items = formatPurchaseOrderText(
    lines.map((l) => ({
      name: locale === 'ta' && l.name_ta ? l.name_ta : l.name,
      qty_display: formatPacksAndLoose(l.qty_milli, l.pack_size, l.unit, 'PACK', locale),
    })),
  )
  return {
    shop_name: tenant.name,
    supplier_name: supplierName,
    number: o.number,
    date: formatDateDisplay(o.order_date),
    items: extra ? `${items}\n${extra}` : items,
    total: o.total_paise > 0 ? formatINR(o.total_paise) : null,
  }
}

export async function sendOrder(
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: OrderSend,
): Promise<{
  order: PurchaseOrderDetail
  notification_id: string | null
  message: string
  wa_me_url: string | null
}> {
  const o = await loadOrder(tx, ctx, id, { forUpdate: true })
  if (o.status !== 'draft' && o.status !== 'sent') {
    throw reasonError(
      'CONFLICT',
      'order_not_sendable',
      `Purchase order ${o.number} is ${o.status}; only draft or sent orders can be sent`,
      { purchase_order_id: o.id, status: o.status },
    )
  }
  const supplier = await loadSupplier(tx, ctx, o.supplier_id)
  const params = await orderMessage(tx, ctx, o, supplier.name, body.message)
  const channel = body.via ?? 'whatsapp'
  const override = await tx
    .selectFrom('notification_templates')
    .select(['subject', 'body', 'provider_template_id', 'is_active'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('code', '=', PO_TO_SUPPLIER_TEMPLATE)
    .where('channel', '=', channel)
    .where('locale', '=', ctx.locale)
    .executeTakeFirst()
  const rendered = renderNotification({
    code: PO_TO_SUPPLIER_TEMPLATE,
    channel,
    locale: ctx.locale,
    params,
    override: override ?? null,
  })
  const message = rendered?.body ?? params.items ?? ''
  const phone = body.phone ?? supplier.phone

  let notificationId: string | null = null
  if (body.via) {
    await assertFeature(ctx, 'notifications')
    if (!phone) {
      throw reasonError(
        'UNPROCESSABLE',
        'recipient_phone_required',
        'The supplier has no phone number; enter one to send the order',
        { supplier_id: supplier.id },
      )
    }
    const queued = await enqueueNotification(tx, ctx, {
      channel: body.via,
      template_code: PO_TO_SUPPLIER_TEMPLATE,
      to: phone,
      recipient_name: supplier.name,
      params,
      ref_type: 'purchase_order',
      ref_id: o.id,
    })
    notificationId = queued.id
  }
  await tx
    .updateTable('purchase_orders')
    .set({ status: 'sent', sent_at: new Date(), updated_at: new Date() })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', o.id)
    .execute()
  await audit(tx, ctx, {
    action: 'purchase_order.send',
    entity_type: 'purchase_order',
    entity_id: o.id,
    summary: `Purchase order ${o.number} sent to ${supplier.name}${body.via ? ` by ${body.via}` : ''}`,
    changes: { via: body.via ?? null, notification_id: notificationId },
  })
  return {
    order: await orderDetail(tx, ctx, o.id),
    notification_id: notificationId,
    message,
    wa_me_url: phone ? waMeUrl(phone, message) : null,
  }
}

async function receivedAny(tx: Tx, ctx: Ctx, orderId: string): Promise<boolean> {
  const row = await tx
    .selectFrom('purchase_order_lines')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('purchase_order_id', '=', orderId)
    .where('received_qty_milli', '>', 0)
    .limit(1)
    .executeTakeFirst()
  return row !== undefined
}

export async function cancelOrder(
  tx: Tx,
  ctx: Ctx,
  id: string,
  reason: string | undefined,
): Promise<PurchaseOrderDetail> {
  const o = await loadOrder(tx, ctx, id, { forUpdate: true })
  if (
    o.status === 'partially_received' ||
    o.status === 'received' ||
    (await receivedAny(tx, ctx, o.id))
  ) {
    throw reasonError(
      'CONFLICT',
      'order_has_receipts',
      `Goods were received against ${o.number}; close the order instead`,
      { purchase_order_id: o.id, status: o.status },
    )
  }
  if (o.status !== 'draft' && o.status !== 'sent') {
    throw reasonError(
      'CONFLICT',
      'order_not_cancellable',
      `Purchase order ${o.number} is ${o.status}`,
      {
        purchase_order_id: o.id,
        status: o.status,
      },
    )
  }
  const drafts = await openBillsOf(tx, ctx, o.id, ['draft'])
  if (drafts.length) {
    throw reasonError(
      'CONFLICT',
      'order_has_bills',
      'Draft purchase bills refer to this order; delete them first',
      { purchase_order_id: o.id, bill_ids: drafts },
    )
  }
  await tx
    .updateTable('purchase_orders')
    .set({ status: 'cancelled', updated_at: new Date() })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', o.id)
    .execute()
  await audit(tx, ctx, {
    action: 'purchase_order.cancel',
    entity_type: 'purchase_order',
    entity_id: o.id,
    summary: `Purchase order ${o.number} cancelled${reason ? `: ${reason}` : ''}`,
    changes: { status: { before: o.status, after: 'cancelled' }, reason: reason ?? null },
  })
  return orderDetail(tx, ctx, o.id)
}

export async function closeOrder(
  tx: Tx,
  ctx: Ctx,
  id: string,
  reason: string | undefined,
): Promise<PurchaseOrderDetail> {
  const o = await loadOrder(tx, ctx, id, { forUpdate: true })
  if (o.status !== 'sent' && o.status !== 'partially_received') {
    throw reasonError(
      'CONFLICT',
      'order_not_closable',
      `Purchase order ${o.number} is ${o.status}; only sent or partially received orders can be closed`,
      { purchase_order_id: o.id, status: o.status },
    )
  }
  const drafts = await openBillsOf(tx, ctx, o.id, ['draft'])
  if (drafts.length) {
    throw reasonError(
      'CONFLICT',
      'order_has_bills',
      'Draft purchase bills refer to this order; post or delete them first',
      { purchase_order_id: o.id, bill_ids: drafts },
    )
  }
  await tx
    .updateTable('purchase_orders')
    .set({ status: 'closed', updated_at: new Date() })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', o.id)
    .execute()
  await audit(tx, ctx, {
    action: 'purchase_order.close',
    entity_type: 'purchase_order',
    entity_id: o.id,
    summary: `Purchase order ${o.number} closed${reason ? `: ${reason}` : ''}`,
    changes: { status: { before: o.status, after: 'closed' }, reason: reason ?? null },
  })
  return orderDetail(tx, ctx, o.id)
}

/**
 * Adds (posting) or removes (cancellation) received quantities on PO lines and moves the order
 * to partially_received / received (or back to sent). Closed / cancelled orders keep their status.
 */
export async function applyOrderReceipts(
  tx: Tx,
  ctx: Ctx,
  orderId: string,
  deltas: ReadonlyMap<string, number>,
): Promise<void> {
  if (deltas.size === 0) return
  const o = await tx
    .selectFrom('purchase_orders')
    .select(['id', 'status'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', orderId)
    .forUpdate()
    .executeTakeFirst()
  if (!o) throw notFound('purchase_order', orderId)
  for (const [lineId, delta] of [...deltas.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (delta === 0) continue
    await tx
      .updateTable('purchase_order_lines')
      .set((eb) => ({
        received_qty_milli: sql<number>`greatest(0, ${eb.ref('received_qty_milli')} + ${delta})`,
      }))
      .where('tenant_id', '=', ctx.tenantId)
      .where('purchase_order_id', '=', orderId)
      .where('id', '=', lineId)
      .execute()
  }
  const lines = await tx
    .selectFrom('purchase_order_lines')
    .select(['qty_milli', 'received_qty_milli'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('purchase_order_id', '=', orderId)
    .execute()
  const next = purchaseOrderStatusAfterReceipt(o.status as PurchaseOrderStatus, lines)
  if (next !== o.status) {
    await tx
      .updateTable('purchase_orders')
      .set({ status: next, updated_at: new Date() })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', orderId)
      .execute()
  }
}
