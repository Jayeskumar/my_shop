/**
 * Store prices (feature store_pricing): per-store selling price / MRP overrides. GET lists the
 * store's sellable products with their base prices and override; PUT upserts / deletes overrides
 * in one transaction (audited) and bumps the products for POS delta sync.
 */
import { type RawBuilder, sql } from 'kysely'
import type {
  StorePriceListQuerySchema,
  StorePriceRow,
  StorePricesUpdateSchema,
} from '@kadai/shared/api/catalog'
import type { z } from 'zod'
import { audit } from '../../core/audit'
import { type PageEnvelope, assertStoreAccess, pageResult, parsePage } from '../../core/http'
import type { Tx } from '../../db/tenant'
import { categorySubtreeIds } from './categories'
import {
  type Ctx,
  andAll,
  containsPattern,
  isoOrNull,
  issue,
  searchTokens,
  touchProducts,
} from './shared'

async function assertStore(tx: Tx, ctx: Ctx, storeId: string): Promise<void> {
  assertStoreAccess(ctx, storeId)
  const s = await tx
    .selectFrom('stores')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', storeId)
    .executeTakeFirst()
  if (!s) throw issue('store_id', 'reference_not_found')
}

interface Row {
  product_id: string
  sku: string | null
  name: string
  name_ta: string | null
  unit: string
  pack_size: number
  base_sale_price_paise: number
  base_mrp_paise: number | null
  store_sale_price_paise: number | null
  store_mrp_paise: number | null
  updated_at: Date | null
  __total: number
}

export async function listStorePrices(
  tx: Tx,
  ctx: Ctx,
  q: z.output<typeof StorePriceListQuerySchema>,
): Promise<PageEnvelope<StorePriceRow>> {
  await assertStore(tx, ctx, q.store_id)
  const page = parsePage(q)
  const conds: RawBuilder<unknown>[] = [
    sql`p.tenant_id = ${ctx.tenantId}`,
    sql`p.kind <> 'variant_parent'`,
  ]
  if (q.q) {
    const words = searchTokens(q.q).map((w) => sql`p.search_text LIKE ${containsPattern(w)}`)
    conds.push(sql`(${andAll(words)} OR lower(p.sku) = lower(${q.q}))`)
  }
  if (q.category_id) {
    const ids = await categorySubtreeIds(tx, ctx, q.category_id)
    conds.push(ids.length ? sql`p.category_id = ANY(${ids}::uuid[])` : sql`FALSE`)
  }
  if (q.overrides_only) conds.push(sql`sp.product_id IS NOT NULL`)
  const dir = q.sort.direction === 'desc' ? sql`DESC` : sql`ASC`
  const order =
    q.sort.field === 'updated_at'
      ? sql`sp.updated_at ${dir} NULLS LAST, lower(p.name), p.id`
      : sql`lower(p.name) ${dir}, p.id`
  const res = await sql<Row>`
    SELECT p.id AS product_id, p.sku, p.name, p.name_ta, p.unit, p.pack_size,
           p.sale_price_paise AS base_sale_price_paise, p.mrp_paise AS base_mrp_paise,
           sp.sale_price_paise AS store_sale_price_paise, sp.mrp_paise AS store_mrp_paise,
           sp.updated_at, count(*) OVER () AS __total
      FROM products p
      LEFT JOIN store_product_prices sp
        ON sp.tenant_id = p.tenant_id AND sp.product_id = p.id AND sp.store_id = ${q.store_id}
     WHERE ${andAll(conds)}
     ORDER BY ${order}
     LIMIT ${page.limit} OFFSET ${page.offset}`.execute(tx)
  let total = res.rows[0] ? Number(res.rows[0].__total) : 0
  if (!res.rows[0] && page.offset > 0) {
    const c = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM products p
        LEFT JOIN store_product_prices sp
          ON sp.tenant_id = p.tenant_id AND sp.product_id = p.id AND sp.store_id = ${q.store_id}
       WHERE ${andAll(conds)}`.execute(tx)
    total = Number(c.rows[0]?.n ?? 0)
  }
  return pageResult(
    res.rows.map((r) => ({
      store_id: q.store_id,
      product_id: r.product_id,
      sku: r.sku,
      name: r.name,
      name_ta: r.name_ta,
      unit: r.unit,
      pack_size: r.pack_size,
      base_sale_price_paise: Number(r.base_sale_price_paise),
      base_mrp_paise: r.base_mrp_paise === null ? null : Number(r.base_mrp_paise),
      store_sale_price_paise:
        r.store_sale_price_paise === null ? null : Number(r.store_sale_price_paise),
      store_mrp_paise: r.store_mrp_paise === null ? null : Number(r.store_mrp_paise),
      updated_at: isoOrNull(r.updated_at),
    })),
    page,
    total,
  )
}

export async function updateStorePrices(
  tx: Tx,
  ctx: Ctx,
  body: z.output<typeof StorePricesUpdateSchema>,
): Promise<{ upserted: number; deleted: number }> {
  await assertStore(tx, ctx, body.store_id)
  const ids = body.upserts.map((u) => u.product_id)
  const products = ids.length
    ? await tx
        .selectFrom('products')
        .select(['id', 'kind', 'mrp_paise', 'name'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', 'in', ids)
        .execute()
    : []
  const byId = new Map(products.map((p) => [p.id, p]))
  body.upserts.forEach((u, i) => {
    const p = byId.get(u.product_id)
    if (!p || p.kind === 'variant_parent')
      throw issue(`upserts.${String(i)}.product_id`, 'reference_not_found')
    const mrp = u.mrp_paise ?? p.mrp_paise
    if (mrp !== null && mrp < u.sale_price_paise)
      throw issue(`upserts.${String(i)}.sale_price_paise`, 'mrp_below_sale_price')
  })
  const before = await tx
    .selectFrom('store_product_prices')
    .select(['product_id', 'sale_price_paise', 'mrp_paise'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('store_id', '=', body.store_id)
    // The contract requires at least one upsert or delete.
    .where('product_id', 'in', [...ids, ...body.deletes])
    .execute()
  const beforeById = new Map(before.map((b) => [b.product_id, b]))

  let upserted = 0
  if (body.upserts.length) {
    const rows = await tx
      .insertInto('store_product_prices')
      .values(
        body.upserts.map((u) => ({
          tenant_id: ctx.tenantId,
          store_id: body.store_id,
          product_id: u.product_id,
          sale_price_paise: u.sale_price_paise,
          mrp_paise: u.mrp_paise,
        })),
      )
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'store_id', 'product_id']).doUpdateSet((eb) => ({
          sale_price_paise: eb.ref('excluded.sale_price_paise'),
          mrp_paise: eb.ref('excluded.mrp_paise'),
          updated_at: sql<Date>`now()`,
        })),
      )
      .returning('product_id')
      .execute()
    upserted = rows.length
  }
  let deleted = 0
  if (body.deletes.length) {
    const rows = await tx
      .deleteFrom('store_product_prices')
      .where('tenant_id', '=', ctx.tenantId)
      .where('store_id', '=', body.store_id)
      .where('product_id', 'in', body.deletes)
      .returning('product_id')
      .execute()
    deleted = rows.length
  }
  await touchProducts(tx, ctx, [...ids, ...body.deletes])
  const changes = [
    ...body.upserts.map((u) => ({
      product_id: u.product_id,
      before: beforeById.get(u.product_id) ?? null,
      after: { sale_price_paise: u.sale_price_paise, mrp_paise: u.mrp_paise },
    })),
    ...body.deletes
      .filter((d) => beforeById.has(d))
      .map((d) => ({ product_id: d, before: beforeById.get(d) ?? null, after: null })),
  ]
  if (changes.length) {
    await audit(tx, ctx, {
      action: 'store_price.update',
      entity_type: 'store',
      entity_id: body.store_id,
      summary: `Store prices: ${String(upserted)} set, ${String(deleted)} removed`,
      changes: { products: changes },
    })
  }
  return { upserted, deleted }
}
