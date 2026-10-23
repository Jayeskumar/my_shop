/**
 * GET /pos/bootstrap — everything a register needs to bill offline (ARCHITECTURE.md §12):
 * sellable products with stock at the store, barcodes, store prices, FEFO batches with stock,
 * active promotions, tax slab rules, categories, quick keys, settings, store / register, the
 * register's invoice series (peekSeries), the open shift, public payment-provider fields and the
 * 200 most recent customers.
 *
 * Delta mode (`since` = the previous cursor): rows changed after the cursor (with a safety
 * overlap for transactions that committed late) plus removed / deactivated ids — deactivations
 * via updated_at, hard deletes via pos_tombstones (migration 0400). An unknown, foreign or too old
 * cursor answers a full bootstrap.
 *
 * Every list is ONE query (no N+1): the catalogue of a 20k-product supermarket is a handful of
 * index scans. Rows carry no tenant_id (the client adds it).
 */
import {
  PaymentProviderCodeSchema,
  PriceTierSchema,
  ProductKindSchema,
  ProviderModeSchema,
  CustomerTypeSchema,
  RegisterSettingsSchema,
  TaxSlabsSchema,
} from '@kadai/shared'
import { AddressSchema } from '@kadai/shared/api/common'
import { PROVIDER_CAPABILITIES } from '@kadai/shared/api/payments'
import { type PosBootstrap, salesDocumentModeFor } from '@kadai/shared/api/sales'
import { sql } from 'kysely'
import type { Tx } from '../../db/tenant'
import { invalidField } from '../../core/errors'
import { peekSeries } from '../../core/numbering'
import {
  type SalesCtx,
  addressOf,
  loadRegister,
  loadStore,
  openShiftOf,
  recordOf,
  salesEnv,
  stringRecordOf,
} from './common'
import { BOOTSTRAP_CUSTOMERS, CURSOR_MAX_AGE_MS, CURSOR_OVERLAP_MS } from './constants'
import { promotionFromRow } from './pricing'

interface Cursor {
  v: 1
  /** Server instant of the bootstrap (ISO). */
  t: string
  /** Store the catalogue was built for. */
  s: string
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url')
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    const c = recordOf(parsed)
    if (c['v'] !== 1 || typeof c['t'] !== 'string' || typeof c['s'] !== 'string') return null
    if (Number.isNaN(Date.parse(c['t']))) return null
    return { v: 1, t: c['t'], s: c['s'] }
  } catch {
    return null
  }
}

export async function posBootstrap(
  tx: Tx,
  ctx: SalesCtx,
  q: {
    register_id?: string | undefined
    store_id?: string | undefined
    since?: string | undefined
  },
  /** overlapMs: how far before the cursor changes are re-sent (default CURSOR_OVERLAP_MS). */
  opts: { overlapMs?: number } = {},
): Promise<PosBootstrap> {
  const t = ctx.tenantId
  const registerId = q.register_id ?? ctx.registerId
  const register = registerId
    ? await loadRegister(tx, ctx, registerId, q.store_id ?? null, { requireActive: true })
    : null
  const storeId = register?.store_id ?? q.store_id
  if (!storeId) throw invalidField('register_id', 'register_id or store_id is required')
  const store = await loadStore(tx, ctx, storeId)
  const env = await salesEnv(tx, ctx)
  const { settings, features } = env

  const nowRow = await sql<{ now: Date }>`select now() as now`.execute(tx)
  const serverTime = nowRow.rows[0]!.now
  const cursor = decodeCursor(q.since)
  const delta =
    cursor !== null &&
    cursor.s === store.id &&
    serverTime.getTime() - Date.parse(cursor.t) <= CURSOR_MAX_AGE_MS &&
    Date.parse(cursor.t) <= serverTime.getTime()
  const since = delta
    ? new Date(Date.parse(cursor.t) - (opts.overlapMs ?? CURSOR_OVERLAP_MS))
    : null

  // ---- products (with stock at the store) ------------------------------------------------
  const stockAgg = tx
    .selectFrom('stock_levels')
    .select(['product_id', sql<number>`sum(qty_milli)::bigint`.as('qty')])
    .where('tenant_id', '=', t)
    .where('store_id', '=', store.id)
    .groupBy('product_id')
    .as('st')
  let productQ = tx
    .selectFrom('products as p')
    .leftJoin(stockAgg, 'st.product_id', 'p.id')
    .leftJoin('categories as c', (j) =>
      j.onRef('c.tenant_id', '=', 'p.tenant_id').onRef('c.id', '=', 'p.category_id'),
    )
    .select([
      'p.id',
      'p.parent_id',
      'p.kind',
      'p.sku',
      'p.name',
      'p.name_ta',
      'p.aliases',
      'p.category_id',
      'p.brand_id',
      'p.unit',
      'p.pack_size',
      'p.allow_loose',
      'p.decimal_qty',
      'p.hsn_code',
      'p.gst_rate_bp',
      'p.cess_rate_bp',
      sql<string | null>`coalesce(p.tax_slab_rule_id, c.tax_slab_rule_id)`.as('tax_slab_rule_id'),
      'p.price_includes_tax',
      'p.mrp_paise',
      'p.sale_price_paise',
      'p.wholesale_price_paise',
      'p.min_sale_price_paise',
      'p.max_discount_bp',
      'p.track_inventory',
      'p.track_batches',
      'p.is_weighed',
      'p.scale_plu',
      'p.variant_attributes',
      'p.variant_axes',
      'p.attributes',
      'st.qty as stock_qty',
      'p.reorder_level_milli',
      'p.is_active',
      'p.updated_at',
    ])
    .where('p.tenant_id', '=', t)
  if (since) {
    productQ = productQ.where((eb) =>
      eb.or([
        eb('p.updated_at', '>', since),
        eb(
          'p.id',
          'in',
          eb
            .selectFrom('stock_levels')
            .select('product_id')
            .where('tenant_id', '=', t)
            .where('store_id', '=', store.id)
            .where('updated_at', '>', since),
        ),
        // The effective slab rule comes from the category when the product has none.
        eb(
          'p.category_id',
          'in',
          eb
            .selectFrom('categories')
            .select('id')
            .where('tenant_id', '=', t)
            .where('updated_at', '>', since),
        ),
      ]),
    )
  } else {
    productQ = productQ.where('p.is_active', '=', true)
  }
  const productRows = await productQ.orderBy('p.id').execute()
  const products: PosBootstrap['products'] = []
  const removedProducts: string[] = []
  for (const p of productRows) {
    if (!p.is_active) {
      removedProducts.push(p.id)
      continue
    }
    products.push({
      id: p.id,
      parent_id: p.parent_id,
      kind: ProductKindSchema.parse(p.kind),
      sku: p.sku,
      name: p.name,
      name_ta: p.name_ta,
      aliases: p.aliases,
      category_id: p.category_id,
      brand_id: p.brand_id,
      unit: p.unit,
      pack_size: p.pack_size,
      allow_loose: p.allow_loose,
      decimal_qty: p.decimal_qty,
      hsn_code: p.hsn_code,
      gst_rate_bp: p.gst_rate_bp,
      cess_rate_bp: p.cess_rate_bp,
      tax_slab_rule_id: p.tax_slab_rule_id,
      price_includes_tax: p.price_includes_tax,
      mrp_paise: p.mrp_paise,
      sale_price_paise: p.sale_price_paise,
      wholesale_price_paise: p.wholesale_price_paise,
      min_sale_price_paise: p.min_sale_price_paise,
      max_discount_bp: p.max_discount_bp,
      track_inventory: p.track_inventory,
      track_batches: p.track_batches,
      is_weighed: p.is_weighed,
      scale_plu: p.scale_plu,
      variant_attributes: stringRecordOf(p.variant_attributes),
      variant_axes: p.variant_axes,
      attributes: recordOf(p.attributes),
      stock_qty_milli: p.track_inventory ? Number(p.stock_qty ?? 0) : null,
      reorder_level_milli: p.reorder_level_milli,
      is_active: true,
      updated_at: p.updated_at.toISOString(),
    })
  }
  const changedIds = since ? products.map((p) => p.id) : null

  // ---- barcodes & store prices ---------------------------------------------------------
  let barcodes: PosBootstrap['barcodes'] = []
  if (!changedIds || changedIds.length) {
    let bq = tx
      .selectFrom('product_barcodes as b')
      .innerJoin('products as p', (j) =>
        j.onRef('p.tenant_id', '=', 'b.tenant_id').onRef('p.id', '=', 'b.product_id'),
      )
      .select(['b.barcode', 'b.product_id', 'b.qty_milli'])
      .where('b.tenant_id', '=', t)
      .where('p.is_active', '=', true)
    if (changedIds) bq = bq.where('b.product_id', 'in', changedIds)
    barcodes = await bq.orderBy('b.barcode').execute()
  }
  let storePrices: PosBootstrap['store_prices'] = []
  if (features.has('store_pricing') && (!changedIds || changedIds.length)) {
    let sq = tx
      .selectFrom('store_product_prices as sp')
      .innerJoin('products as p', (j) =>
        j.onRef('p.tenant_id', '=', 'sp.tenant_id').onRef('p.id', '=', 'sp.product_id'),
      )
      .select(['sp.store_id', 'sp.product_id', 'sp.sale_price_paise', 'sp.mrp_paise'])
      .where('sp.tenant_id', '=', t)
      .where('sp.store_id', '=', store.id)
      .where('p.is_active', '=', true)
    if (changedIds) sq = sq.where('sp.product_id', 'in', changedIds)
    storePrices = await sq.execute()
  }

  // ---- batches (FEFO order, stock at the store) -----------------------------------------
  let batchQ = tx
    .selectFrom('batches as b')
    .innerJoin('products as p', (j) =>
      j.onRef('p.tenant_id', '=', 'b.tenant_id').onRef('p.id', '=', 'b.product_id'),
    )
    .leftJoin('stock_levels as sl', (j) =>
      j
        .onRef('sl.tenant_id', '=', 'b.tenant_id')
        .onRef('sl.batch_id', '=', 'b.id')
        .on('sl.store_id', '=', store.id),
    )
    .select([
      'b.id',
      'b.product_id',
      'b.batch_no',
      'b.expiry_date',
      'b.mrp_paise',
      'b.sale_price_paise',
      'b.is_active',
      'p.is_active as product_active',
      sql<number>`coalesce(sl.qty_milli, 0)`.as('qty_milli'),
      sql<Date>`greatest(b.updated_at, coalesce(sl.updated_at, b.updated_at))`.as('updated_at'),
    ])
    .where('b.tenant_id', '=', t)
    .where('p.track_batches', '=', true)
  if (since) {
    batchQ = batchQ.where((eb) =>
      eb.or([eb('b.updated_at', '>', since), eb('sl.updated_at', '>', since)]),
    )
  } else {
    batchQ = batchQ
      .where('b.is_active', '=', true)
      .where('p.is_active', '=', true)
      .where('sl.qty_milli', '>', 0)
  }
  const fefo = settings.inventory.fefo
  const batchRows = await (
    fefo
      ? batchQ
          .orderBy(sql`b.expiry_date asc nulls last`)
          .orderBy('b.created_at')
          .orderBy('b.id')
      : batchQ.orderBy('b.created_at').orderBy('b.id')
  ).execute()
  const batches: PosBootstrap['batches'] = []
  const removedBatches: string[] = []
  for (const b of batchRows) {
    const qty = Number(b.qty_milli)
    if (!b.is_active || !b.product_active || qty <= 0) {
      removedBatches.push(b.id)
      continue
    }
    batches.push({
      id: b.id,
      product_id: b.product_id,
      batch_no: b.batch_no,
      expiry_date: b.expiry_date,
      mrp_paise: b.mrp_paise,
      sale_price_paise: b.sale_price_paise,
      qty_milli: qty,
      updated_at: new Date(b.updated_at).toISOString(),
    })
  }

  // ---- promotions -------------------------------------------------------------------------
  const promotions: PosBootstrap['promotions'] = []
  const removedPromotions: string[] = []
  {
    let pq = tx.selectFrom('promotions').selectAll().where('tenant_id', '=', t)
    if (since && features.has('promotions')) pq = pq.where('updated_at', '>', since)
    const rows = await pq.orderBy('priority', 'desc').orderBy('id').execute()
    for (const r of rows) {
      const appliesHere = r.store_ids === null || r.store_ids.includes(store.id)
      const ended = r.ends_at !== null && r.ends_at.getTime() <= serverTime.getTime()
      const parsed = promotionFromRow(r)
      if (!features.has('promotions') || !r.is_active || !appliesHere || ended || !parsed) {
        if (since || !features.has('promotions')) removedPromotions.push(r.id)
        continue
      }
      promotions.push({
        id: r.id,
        data: {
          ...parsed,
          starts_at: r.starts_at ? r.starts_at.toISOString() : null,
          ends_at: r.ends_at ? r.ends_at.toISOString() : null,
        },
        updated_at: r.updated_at.toISOString(),
      })
    }
  }

  // ---- tombstones (hard deletes) ------------------------------------------------------------
  const removedBarcodes: string[] = []
  if (since) {
    const tomb = await tx
      .selectFrom('pos_tombstones')
      .select(['kind', 'ref'])
      .where('tenant_id', '=', t)
      .where('deleted_at', '>', since)
      .execute()
    for (const r of tomb) {
      if (r.kind === 'product') removedProducts.push(r.ref)
      else if (r.kind === 'batch') removedBatches.push(r.ref)
      else if (r.kind === 'promotion') removedPromotions.push(r.ref)
      else if (r.kind === 'barcode') removedBarcodes.push(r.ref)
    }
  }
  // A barcode deleted and re-added (or moved to another product) is not removed.
  const liveBarcodes = new Set(barcodes.map((b) => b.barcode))

  // ---- small complete lists -----------------------------------------------------------------
  const categories = await tx
    .selectFrom('categories')
    .select(['id', 'parent_id', 'name', 'name_ta', 'sort_order', 'is_active'])
    .where('tenant_id', '=', t)
    .orderBy('sort_order')
    .orderBy('name')
    .execute()
  const slabRules = await tx
    .selectFrom('tax_slab_rules')
    .select(['id', 'name', 'slabs', 'is_active'])
    .where('tenant_id', '=', t)
    .orderBy('name')
    .execute()
  const providers = await tx
    .selectFrom('payment_provider_accounts')
    .select([
      'id',
      'store_id',
      'provider',
      'display_name',
      'mode',
      'vpa',
      'payee_name',
      'merchant_code',
      'is_default',
    ])
    .where('tenant_id', '=', t)
    .where('is_active', '=', true)
    .where((eb) => eb.or([eb('store_id', 'is', null), eb('store_id', '=', store.id)]))
    .orderBy('is_default', 'desc')
    .orderBy('display_name')
    .execute()
  // Most recent customers: the latest buyers (bounded scan of the last year's bills) merged with
  // the latest created / edited customers — two bounded queries instead of a per-customer lookup.
  const buyers = await sql<{ id: string; at: Date }>`
    select si.customer_id as id, max(si.invoice_at) as at
      from sales_invoices si
     where si.tenant_id = ${t} and si.customer_id is not null and si.status = 'completed'
       and si.invoice_at > now() - interval '365 days'
     group by si.customer_id
     order by max(si.invoice_at) desc
     limit ${BOOTSTRAP_CUSTOMERS}`.execute(tx)
  const edited = await tx
    .selectFrom('customers')
    .select(['id', 'updated_at as at'])
    .where('tenant_id', '=', t)
    .where('is_active', '=', true)
    .orderBy('updated_at', 'desc')
    .limit(BOOTSTRAP_CUSTOMERS)
    .execute()
  const latest = new Map<string, number>()
  for (const r of [...buyers.rows, ...edited]) {
    const at = new Date(r.at).getTime()
    if ((latest.get(r.id) ?? -Infinity) < at) latest.set(r.id, at)
  }
  const customerIds = [...latest.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, BOOTSTRAP_CUSTOMERS)
    .map(([id]) => id)
  const customers = customerIds.length
    ? await tx
        .selectFrom('customers')
        .select([
          'id',
          'name',
          'name_ta',
          'phone',
          'customer_type',
          'price_tier',
          'gstin',
          'state_code',
          'balance_paise',
          'credit_limit_paise',
          'loyalty_points',
        ])
        .where('tenant_id', '=', t)
        .where('id', 'in', customerIds)
        .where('is_active', '=', true)
        .execute()
    : []
  const customerOrder = new Map(customerIds.map((id, i) => [id, i]))
  customers.sort((a, b) => (customerOrder.get(a.id) ?? 0) - (customerOrder.get(b.id) ?? 0))

  const docMode = salesDocumentModeFor(env.tenant.gst_scheme)
  const series = register
    ? await peekSeries(tx, ctx, {
        docType: docMode.series,
        storeId: store.id,
        registerId: register.id,
        date: env.today,
      })
    : null
  const shift = register ? await openShiftOf(tx, ctx, register.id) : null
  const registerSettings = RegisterSettingsSchema.safeParse(recordOf(register?.settings))

  return {
    mode: delta ? 'delta' : 'full',
    cursor: encodeCursor({ v: 1, t: serverTime.toISOString(), s: store.id }),
    server_time: serverTime.toISOString(),
    tenant: {
      id: env.tenant.id,
      name: env.tenant.name,
      name_ta: env.tenant.name_ta,
      legal_name: env.tenant.legal_name,
      business_type: env.tenant.business_type as PosBootstrap['tenant']['business_type'],
      gst_scheme: env.tenant.gst_scheme,
      gstin: env.tenant.gstin,
      state_code: env.tenant.state_code,
      timezone: env.tenant.timezone,
      fy_start_month: env.tenant.fy_start_month,
      logo_url: env.tenant.logo_file_id ? `/api/v1/files/${env.tenant.logo_file_id}/content` : null,
    },
    store: {
      id: store.id,
      code: store.code,
      name: store.name,
      name_ta: store.name_ta,
      state_code: store.state_code,
      gstin: store.gstin ?? env.tenant.gstin,
      address: addressOf(store.address) ?? AddressSchema.parse({}),
      phone: store.phone,
      drug_license_numbers: store.drug_license_numbers,
      fssai_number: store.fssai_number,
    },
    register: register
      ? {
          id: register.id,
          code: register.code,
          name: register.name,
          settings: registerSettings.success
            ? registerSettings.data
            : RegisterSettingsSchema.parse({}),
        }
      : null,
    doc_type: docMode.doc_type,
    tax_mode: docMode.tax_mode,
    settings,
    features: [...features].sort(),
    series: series ? { doc_type: docMode.series, ...series } : null,
    open_shift: shift
      ? {
          id: shift.id,
          opened_at: shift.opened_at.toISOString(),
          opened_by: shift.opened_by,
          opened_by_name: shift.opened_by_name,
          opening_cash_paise: shift.opening_cash_paise,
        }
      : null,
    shift_required: features.has('shifts') && settings.pos.require_open_shift,
    quick_keys: settings.pos.quick_keys,
    categories,
    products,
    barcodes,
    barcode_product_ids: changedIds ?? [],
    store_prices: storePrices,
    store_price_product_ids: changedIds ?? [],
    batches,
    promotions,
    tax_slab_rules: slabRules.flatMap((r) => {
      const slabs = TaxSlabsSchema.safeParse(r.slabs)
      return slabs.success
        ? [{ id: r.id, name: r.name, slabs: slabs.data, is_active: r.is_active }]
        : []
    }),
    payment_providers: providers.flatMap((p) => {
      const code = PaymentProviderCodeSchema.safeParse(p.provider)
      if (!code.success) return []
      return [
        {
          id: p.id,
          store_id: p.store_id,
          provider: code.data,
          display_name: p.display_name,
          mode: ProviderModeSchema.parse(p.mode),
          vpa: p.vpa,
          payee_name: p.payee_name,
          merchant_code: p.merchant_code,
          is_default: p.is_default,
          capabilities: { ...PROVIDER_CAPABILITIES[code.data] },
        },
      ]
    }),
    customers: customers.map((c) => ({
      id: c.id,
      name: c.name,
      name_ta: c.name_ta,
      phone: c.phone,
      customer_type: CustomerTypeSchema.parse(c.customer_type),
      price_tier: PriceTierSchema.parse(c.price_tier),
      gstin: c.gstin,
      state_code: c.state_code,
      balance_paise: c.balance_paise,
      credit_limit_paise: c.credit_limit_paise,
      loyalty_points: c.loyalty_points,
    })),
    removed_product_ids: [...new Set(removedProducts)],
    removed_barcodes: [...new Set(removedBarcodes)].filter((b) => !liveBarcodes.has(b)),
    removed_batch_ids: [...new Set(removedBatches)],
    removed_promotion_ids: [...new Set(removedPromotions)],
  }
}
