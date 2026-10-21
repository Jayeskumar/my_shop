/**
 * Fixtures for the sales module integration tests (real PostgreSQL through app.inject).
 */
import { type TenantSettingsPatch, newId } from '@kadai/shared'
import type { InvoiceCreate } from '@kadai/shared/api/sales'
import type { LightMyRequestResponse } from 'fastify'
import { sql } from 'kysely'
import { expect } from 'vitest'
import { systemContext } from '../../../core/context'
import { postStock } from '../../../core/inventory'
import { adjustPoints } from '../../../core/loyalty'
import { updateSettings } from '../../../core/settings'
import type { TestApp } from '../../../test/helpers'
import type { TestShop, TestShopMember } from '../../../test/tenants'

export const API = '/api/v1'

export interface ProductFixture {
  name?: string
  kind?: 'standard' | 'service' | 'variant_parent'
  unit?: string
  pack_size?: number
  allow_loose?: boolean
  decimal_qty?: boolean
  sale_price_paise?: number
  mrp_paise?: number | null
  wholesale_price_paise?: number | null
  purchase_price_paise?: number
  min_sale_price_paise?: number | null
  max_discount_bp?: number | null
  gst_rate_bp?: number
  cess_rate_bp?: number
  hsn_code?: string | null
  price_includes_tax?: boolean
  track_inventory?: boolean
  track_batches?: boolean
  reorder_level_milli?: number | null
  tax_slab_rule_id?: string | null
  category_id?: string | null
  attributes?: Record<string, unknown>
  is_active?: boolean
}

export async function insertProduct(
  t: Pick<TestApp, 'deps'>,
  shop: TestShop,
  o: ProductFixture = {},
): Promise<string> {
  const id = newId()
  const kind = o.kind ?? 'standard'
  await t.deps.db.systemDb
    .insertInto('products')
    .values({
      id,
      tenant_id: shop.tenant.id,
      kind,
      name: o.name ?? `Item ${id.slice(-5)}`,
      name_ta: `பொருள் ${id.slice(-5)}`,
      unit: o.unit ?? 'PCS',
      pack_size: o.pack_size ?? 1,
      allow_loose: o.allow_loose ?? false,
      decimal_qty: o.decimal_qty ?? false,
      sale_price_paise: o.sale_price_paise ?? 10_000,
      mrp_paise: o.mrp_paise === undefined ? null : o.mrp_paise,
      wholesale_price_paise: o.wholesale_price_paise ?? null,
      purchase_price_paise: o.purchase_price_paise ?? 6_000,
      min_sale_price_paise: o.min_sale_price_paise ?? null,
      max_discount_bp: o.max_discount_bp ?? null,
      gst_rate_bp: o.gst_rate_bp ?? 0,
      cess_rate_bp: o.cess_rate_bp ?? 0,
      hsn_code: o.hsn_code ?? '1006',
      price_includes_tax: o.price_includes_tax ?? true,
      track_inventory: kind === 'service' ? false : (o.track_inventory ?? true),
      track_batches: o.track_batches ?? false,
      reorder_level_milli: o.reorder_level_milli ?? null,
      tax_slab_rule_id: o.tax_slab_rule_id ?? null,
      category_id: o.category_id ?? null,
      attributes: JSON.stringify(o.attributes ?? {}),
      is_active: o.is_active ?? true,
    })
    .execute()
  return id
}

export async function insertBatch(
  t: Pick<TestApp, 'deps'>,
  shop: TestShop,
  productId: string,
  o: {
    batch_no?: string
    expiry_date?: string | null
    mrp_paise?: number | null
    sale_price_paise?: number | null
    purchase_price_paise?: number | null
  } = {},
): Promise<string> {
  const id = newId()
  await t.deps.db.systemDb
    .insertInto('batches')
    .values({
      id,
      tenant_id: shop.tenant.id,
      product_id: productId,
      batch_no: o.batch_no ?? `B${id.slice(-6).toUpperCase()}`,
      expiry_date: o.expiry_date ?? null,
      mrp_paise: o.mrp_paise ?? null,
      sale_price_paise: o.sale_price_paise ?? null,
      purchase_price_paise: o.purchase_price_paise ?? null,
    })
    .execute()
  return id
}

/** Opening stock through the core posting service (as the owner). */
export async function addStock(
  shop: TestShop,
  o: {
    product_id: string
    qty_milli: number
    unit_cost_paise?: number
    batch_id?: string | null
    store_id?: string
  },
): Promise<void> {
  await shop.tx((tx) =>
    postStock(tx, shop.ctx, [
      {
        store_id: o.store_id ?? shop.store.id,
        product_id: o.product_id,
        batch_id: o.batch_id ?? null,
        qty_milli: o.qty_milli,
        movement_type: 'opening',
        unit_cost_paise: o.unit_cost_paise ?? 6_000,
      },
    ]),
  )
}

export async function insertCustomer(
  t: Pick<TestApp, 'deps'>,
  shop: TestShop,
  o: {
    name?: string
    phone?: string | null
    credit_limit_paise?: number | null
    credit_days?: number | null
    price_tier?: 'retail' | 'wholesale'
    gstin?: string | null
    state_code?: string | null
    loyalty_points?: number
  } = {},
): Promise<string> {
  const id = newId()
  await t.deps.db.systemDb
    .insertInto('customers')
    .values({
      id,
      tenant_id: shop.tenant.id,
      name: o.name ?? `Customer ${id.slice(-5)}`,
      phone: o.phone ?? null,
      credit_limit_paise: o.credit_limit_paise ?? null,
      credit_days: o.credit_days ?? null,
      price_tier: o.price_tier ?? 'retail',
      customer_type: o.price_tier === 'wholesale' ? 'wholesale' : 'retail',
      gstin: o.gstin ?? null,
      state_code: o.state_code ?? null,
    })
    .execute()
  if (o.loyalty_points) {
    await shop.tx((tx) =>
      adjustPoints(tx, shop.ctx, { customer_id: id, points: o.loyalty_points!, notes: 'test' }),
    )
  }
  return id
}

export async function setSettings(shop: TestShop, patch: TenantSettingsPatch): Promise<void> {
  await shop.tx((tx) =>
    updateSettings(tx, systemContext(shop.tenant.id), patch).then(() => undefined),
  )
}

export function clientRef(): string {
  return `pos-${newId()}`
}

export function line(productId: string, qty = 1000, extra: Record<string, unknown> = {}) {
  return { product_id: productId, qty_milli: qty, ...extra }
}

export async function createSale(
  shop: TestShop,
  body: Partial<InvoiceCreate> & Record<string, unknown>,
  as?: TestShopMember,
): Promise<LightMyRequestResponse> {
  return shop.inject({
    method: 'POST',
    url: `${API}/sales/invoices`,
    payload: {
      store_id: shop.store.id,
      register_id: shop.register.id,
      client_ref: clientRef(),
      ...body,
    },
    ...(as ? { as } : {}),
  })
}

export interface SaleData {
  invoice: {
    id: string
    number: string | null
    status: string
    total_paise: number
    paid_paise: number
    due_paise: number
    cost_paise: number
    payment_status: string
    lines: Array<Record<string, unknown> & { id: string; qty_milli: number; total_paise: number }>
    [k: string]: unknown
  }
  tenders: Array<{ payment_id: string | null; applied_paise: number; change_paise: number }>
  change_paise: number
  warnings: Array<{ code: string }>
}

export function dataOf<T>(res: LightMyRequestResponse, status = 200): T {
  if (res.statusCode !== status) {
    throw new Error(`expected ${status}, got ${res.statusCode}: ${res.body}`)
  }
  return (res.json() as { data: T }).data
}

export async function sell(
  shop: TestShop,
  body: Partial<InvoiceCreate> & Record<string, unknown>,
  as?: TestShopMember,
): Promise<SaleData> {
  return dataOf<SaleData>(await createSale(shop, body, as), 201)
}

export function errorOf(res: LightMyRequestResponse): {
  code: string
  details?: Record<string, unknown>
} {
  return (res.json() as { error: { code: string; details?: Record<string, unknown> } }).error
}

// ---------------------------------------------------------------------------------------------
// Ledger / stock assertions (system pool: assertions only)
// ---------------------------------------------------------------------------------------------

export async function journalOf(
  t: Pick<TestApp, 'deps'>,
  tenantId: string,
  sourceType: string,
  sourceId: string,
): Promise<
  Array<{ subtype: string | null; debit: number; credit: number; party_id: string | null }>
> {
  return t.deps.db.systemDb
    .selectFrom('journal_lines as l')
    .innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
    .innerJoin('accounts as a', 'a.id', 'l.account_id')
    .select(['a.subtype', 'l.debit_paise as debit', 'l.credit_paise as credit', 'l.party_id'])
    .where('e.tenant_id', '=', tenantId)
    .where('e.source_type', '=', sourceType)
    .where('e.source_id', '=', sourceId)
    .execute()
}

/** Net (debit − credit) per account subtype over a source's entries (reversals included). */
export function netBySubtype(
  lines: ReadonlyArray<{ subtype: string | null; debit: number; credit: number }>,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const l of lines) {
    const k = l.subtype ?? 'other'
    out[k] = (out[k] ?? 0) + l.debit - l.credit
  }
  return out
}

export async function expectLedgerBalanced(t: Pick<TestApp, 'deps'>, tenantId: string) {
  const r = await t.deps.db.systemDb
    .selectFrom('journal_lines')
    .select([
      sql<number>`coalesce(sum(debit_paise), 0)::bigint`.as('d'),
      sql<number>`coalesce(sum(credit_paise), 0)::bigint`.as('c'),
    ])
    .where('tenant_id', '=', tenantId)
    .executeTakeFirstOrThrow()
  expect(Number(r.d)).toBe(Number(r.c))
}

/** Σ stock_movements = stock_levels for every row of the tenant. */
export async function expectStockConsistent(t: Pick<TestApp, 'deps'>, tenantId: string) {
  const rows = await sql<{ diff: number }>`
    select count(*)::int as diff from (
      select l.id
        from stock_levels l
        left join (
          select store_id, product_id, batch_id, sum(qty_milli) as q
            from stock_movements where tenant_id = ${tenantId}
           group by store_id, product_id, batch_id
        ) m on m.store_id = l.store_id and m.product_id = l.product_id
           and m.batch_id is not distinct from l.batch_id
       where l.tenant_id = ${tenantId} and l.qty_milli <> coalesce(m.q, 0)
    ) x`.execute(t.deps.db.systemDb)
  expect(rows.rows[0]!.diff).toBe(0)
}

export async function stockOf(
  t: Pick<TestApp, 'deps'>,
  tenantId: string,
  productId: string,
  batchId: string | null = null,
  storeId?: string,
): Promise<number> {
  let q = t.deps.db.systemDb
    .selectFrom('stock_levels')
    .select(sql<number>`coalesce(sum(qty_milli), 0)::bigint`.as('q'))
    .where('tenant_id', '=', tenantId)
    .where('product_id', '=', productId)
  if (storeId) q = q.where('store_id', '=', storeId)
  q = batchId === null ? q.where('batch_id', 'is', null) : q.where('batch_id', '=', batchId)
  const r = await q.executeTakeFirstOrThrow()
  return Number(r.q)
}

export async function customerBalance(
  t: Pick<TestApp, 'deps'>,
  customerId: string,
): Promise<{ balance_paise: number; loyalty_points: number }> {
  return t.deps.db.systemDb
    .selectFrom('customers')
    .select(['balance_paise', 'loyalty_points'])
    .where('id', '=', customerId)
    .executeTakeFirstOrThrow()
}
