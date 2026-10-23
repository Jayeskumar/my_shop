/**
 * Fixtures and invariant checks shared by the inventory module tests: richer product / store /
 * category inserts, request shortcuts and the ledger invariants (Σ movements = stock levels,
 * journals balanced, inventory account = Σ movement values per store).
 */
import type { LightMyRequestResponse } from 'fastify'
import { sql } from 'kysely'
import { expect } from 'vitest'
import { newId } from '@kadai/shared'
import type { TestApp } from '../../../test/helpers'
import type { TestShop, TestShopMember } from '../../../test/tenants'

export const API = '/api/v1'

export interface ProductFixture {
  id: string
  name: string
  pack_size: number
}

export async function makeProduct(
  t: Pick<TestApp, 'deps'>,
  tenantId: string,
  opts: {
    name?: string
    name_ta?: string | null
    sku?: string | null
    unit?: string
    pack_size?: number
    track_batches?: boolean
    track_inventory?: boolean
    kind?: 'standard' | 'variant_parent' | 'service'
    purchase_price_paise?: number
    sale_price_paise?: number
    mrp_paise?: number | null
    reorder_level_milli?: number | null
    reorder_qty_milli?: number | null
    category_id?: string | null
    brand_id?: string | null
    is_active?: boolean
  } = {},
): Promise<ProductFixture> {
  const id = newId()
  const name = opts.name ?? `Item ${id.slice(-6)}`
  const kind = opts.kind ?? 'standard'
  await t.deps.db.systemDb
    .insertInto('products')
    .values({
      id,
      tenant_id: tenantId,
      kind,
      name,
      name_ta: opts.name_ta ?? null,
      sku: opts.sku ?? null,
      unit: opts.unit ?? 'PCS',
      pack_size: opts.pack_size ?? 1,
      track_inventory: kind === 'service' ? false : (opts.track_inventory ?? true),
      track_batches: opts.track_batches ?? false,
      purchase_price_paise: opts.purchase_price_paise ?? 0,
      sale_price_paise: opts.sale_price_paise ?? 0,
      mrp_paise: opts.mrp_paise ?? null,
      reorder_level_milli: opts.reorder_level_milli ?? null,
      reorder_qty_milli: opts.reorder_qty_milli ?? null,
      category_id: opts.category_id ?? null,
      brand_id: opts.brand_id ?? null,
      is_active: opts.is_active ?? true,
    })
    .execute()
  return { id, name, pack_size: opts.pack_size ?? 1 }
}

export async function makeBatch(
  t: Pick<TestApp, 'deps'>,
  tenantId: string,
  productId: string,
  opts: {
    batch_no?: string
    expiry_date?: string | null
    mfg_date?: string | null
    mrp_paise?: number | null
    purchase_price_paise?: number | null
    supplier_id?: string | null
  } = {},
): Promise<{ id: string; batch_no: string }> {
  const id = newId()
  const batchNo = opts.batch_no ?? `B${id.slice(-6).toUpperCase()}`
  await t.deps.db.systemDb
    .insertInto('batches')
    .values({
      id,
      tenant_id: tenantId,
      product_id: productId,
      batch_no: batchNo,
      expiry_date: opts.expiry_date ?? null,
      mfg_date: opts.mfg_date ?? null,
      mrp_paise: opts.mrp_paise ?? null,
      purchase_price_paise: opts.purchase_price_paise ?? null,
      supplier_id: opts.supplier_id ?? null,
    })
    .execute()
  return { id, batch_no: batchNo }
}

export async function makeStore(
  t: Pick<TestApp, 'deps'>,
  tenantId: string,
  code: string,
  opts: { is_active?: boolean; name?: string } = {},
): Promise<{ id: string; code: string }> {
  const id = newId()
  await t.deps.db.systemDb
    .insertInto('stores')
    .values({
      id,
      tenant_id: tenantId,
      code,
      name: opts.name ?? `Branch ${code}`,
      state_code: '33',
      is_active: opts.is_active ?? true,
    })
    .execute()
  return { id, code }
}

export async function makeCategory(
  t: Pick<TestApp, 'deps'>,
  tenantId: string,
  name: string,
  parentId: string | null = null,
): Promise<string> {
  const id = newId()
  await t.deps.db.systemDb
    .insertInto('categories')
    .values({ id, tenant_id: tenantId, name, parent_id: parentId })
    .execute()
  return id
}

/** JSON body of a response (typed loosely for assertions). */
export function body<T = Record<string, unknown>>(res: LightMyRequestResponse): T {
  return res.json<T>()
}

/** `{data}` of a successful response, failing with the error body otherwise. */
export function dataOf<T = Record<string, unknown>>(res: LightMyRequestResponse, status = 200): T {
  if (res.statusCode !== status) {
    throw new Error(`expected ${String(status)}, got ${String(res.statusCode)}: ${res.body}`)
  }
  return res.json<{ data: T }>().data
}

export function errorOf(res: LightMyRequestResponse): {
  code: string
  message: string
  details?: Record<string, unknown> & {
    reason?: string
    issues?: { path: string; message: string }[]
  }
} {
  return res.json<{ error: ReturnType<typeof errorOf> }>().error
}

export function req(
  shop: TestShop,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  opts: { as?: TestShopMember | null; headers?: Record<string, string> } = {},
): Promise<LightMyRequestResponse> {
  return shop.inject({
    method,
    url: `${API}${url}`,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    ...(opts.headers ? { headers: opts.headers } : {}),
    ...(opts.as === undefined ? {} : { as: opts.as }),
  })
}

/** POST /stock/opening (asserts 201) and returns the result data. */
export async function openStock(
  shop: TestShop,
  storeId: string,
  lines: unknown[],
  extra: Record<string, unknown> = {},
): Promise<{
  adjustment: { id: string; number: string; total_value_paise: number }
  total_value_paise: number
  journal_entry_id: string | null
  batches_created: { product_id: string; batch_id: string; batch_no: string }[]
}> {
  const res = await req(shop, 'POST', '/stock/opening', { store_id: storeId, lines, ...extra })
  return dataOf(res, 201)
}

/** Current balance of a stock row (null batch = the unbatched row; omitted = all rows). */
export async function levelOf(
  t: Pick<TestApp, 'deps'>,
  tenantId: string,
  storeId: string,
  productId: string,
  batchId?: string | null,
): Promise<number> {
  let q = t.deps.db.systemDb
    .selectFrom('stock_levels')
    .select(sql<string>`coalesce(sum(qty_milli), 0)`.as('qty'))
    .where('tenant_id', '=', tenantId)
    .where('store_id', '=', storeId)
    .where('product_id', '=', productId)
  if (batchId === null) q = q.where('batch_id', 'is', null)
  else if (batchId !== undefined) q = q.where('batch_id', '=', batchId)
  const row = await q.executeTakeFirstOrThrow()
  return Number(row.qty)
}

/** Σ movements per (store, product, batch) equals the stock_levels balance for the tenant. */
export async function assertLevelsMatchMovements(
  t: Pick<TestApp, 'deps'>,
  tenantId: string,
): Promise<void> {
  const res = await sql<{ level: string; moved: string }>`
    select l.qty_milli as level,
           coalesce((select sum(m.qty_milli) from stock_movements m
                      where m.tenant_id = l.tenant_id and m.store_id = l.store_id
                        and m.product_id = l.product_id
                        and m.batch_id is not distinct from l.batch_id), 0) as moved
      from stock_levels l where l.tenant_id = ${tenantId}`.execute(t.deps.db.systemDb)
  for (const r of res.rows) expect(Number(r.moved)).toBe(Number(r.level))
  // …and no movement without its stock row.
  const orphans = await sql<{ n: string }>`
    select count(*) as n from stock_movements m
     where m.tenant_id = ${tenantId} and not exists (
       select 1 from stock_levels l where l.tenant_id = m.tenant_id and l.store_id = m.store_id
          and l.product_id = m.product_id and l.batch_id is not distinct from m.batch_id)`.execute(
    t.deps.db.systemDb,
  )
  expect(Number(orphans.rows[0]?.n ?? 0)).toBe(0)
}

/** Every journal entry of the tenant balances. */
export async function assertJournalsBalanced(
  t: Pick<TestApp, 'deps'>,
  tenantId: string,
): Promise<void> {
  const res = await sql<{ entry_id: string; dr: string; cr: string }>`
    select entry_id, sum(debit_paise) as dr, sum(credit_paise) as cr
      from journal_lines where tenant_id = ${tenantId} group by entry_id`.execute(
    t.deps.db.systemDb,
  )
  for (const r of res.rows) expect(Number(r.dr)).toBe(Number(r.cr))
}

/** Inventory account balance (Dr − Cr) per store vs Σ signed movement values at cost per store. */
export async function inventoryBalances(
  t: Pick<TestApp, 'deps'>,
  tenantId: string,
): Promise<{ gl: Map<string, number>; stock: Map<string, number> }> {
  const gl = await sql<{ store_id: string; bal: string }>`
    select coalesce(l.store_id::text, '-') as store_id, sum(l.debit_paise - l.credit_paise) as bal
      from journal_lines l
      join accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
     where l.tenant_id = ${tenantId} and a.subtype = 'inventory'
     group by 1`.execute(t.deps.db.systemDb)
  const stock = await sql<{ store_id: string; val: string }>`
    select m.store_id::text as store_id,
           sum(case when m.qty_milli > 0
                    then round(m.unit_cost_paise::numeric * m.qty_milli / (p.pack_size * 1000))
                    else -round(m.unit_cost_paise::numeric * (-m.qty_milli) / (p.pack_size * 1000))
               end) as val
      from stock_movements m
      join products p on p.tenant_id = m.tenant_id and p.id = m.product_id
     where m.tenant_id = ${tenantId}
     group by 1`.execute(t.deps.db.systemDb)
  return {
    gl: new Map(gl.rows.map((r) => [r.store_id, Number(r.bal)])),
    stock: new Map(stock.rows.map((r) => [r.store_id, Number(r.val)])),
  }
}

export async function assertInventoryAccountMatchesStock(
  t: Pick<TestApp, 'deps'>,
  tenantId: string,
): Promise<void> {
  const { gl, stock } = await inventoryBalances(t, tenantId)
  const stores = new Set([...gl.keys(), ...stock.keys()])
  for (const s of stores)
    expect({ store: s, value: gl.get(s) ?? 0 }).toEqual({ store: s, value: stock.get(s) ?? 0 })
}

export interface JournalLineView {
  entry_id: string
  reverses_entry_id: string | null
  entry_date: string
  subtype: string | null
  debit_paise: number
  credit_paise: number
  store_id: string | null
}

/** Journal lines of a document source (all entries, oldest first). */
export async function journalOf(
  t: Pick<TestApp, 'deps'>,
  tenantId: string,
  sourceType: string,
  sourceId: string,
): Promise<JournalLineView[]> {
  const rows = await t.deps.db.systemDb
    .selectFrom('journal_lines as l')
    .innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
    .innerJoin('accounts as a', 'a.id', 'l.account_id')
    .select([
      'l.entry_id',
      'e.reverses_entry_id',
      'e.entry_date',
      'a.subtype',
      'l.debit_paise',
      'l.credit_paise',
      'l.store_id',
    ])
    .where('l.tenant_id', '=', tenantId)
    .where('e.source_type', '=', sourceType)
    .where('e.source_id', '=', sourceId)
    .orderBy('e.created_at')
    .orderBy('l.id')
    .execute()
  return rows.map((r) => ({
    ...r,
    debit_paise: Number(r.debit_paise),
    credit_paise: Number(r.credit_paise),
  }))
}

/** Net (Dr − Cr) per account subtype of journal lines. */
export function netBySubtype(lines: readonly JournalLineView[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const l of lines) {
    const k = l.subtype ?? '-'
    out[k] = (out[k] ?? 0) + l.debit_paise - l.credit_paise
  }
  for (const k of Object.keys(out)) if (out[k] === 0) delete out[k]
  return out
}

/** Audit actions recorded for an entity (oldest first). */
export async function auditActions(
  t: Pick<TestApp, 'deps'>,
  tenantId: string,
  entityId: string,
): Promise<string[]> {
  const rows = await t.deps.db.systemDb
    .selectFrom('audit_logs')
    .select('action')
    .where('tenant_id', '=', tenantId)
    .where('entity_id', '=', entityId)
    .orderBy('id')
    .execute()
  return rows.map((r) => r.action)
}
