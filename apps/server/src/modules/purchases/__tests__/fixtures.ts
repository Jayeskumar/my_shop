/**
 * Fixtures and invariant checks shared by the purchases module tests: master data inserts
 * (products, suppliers, batches, stores), request shortcuts, response helpers and the ledger
 * invariants (journals balanced, supplier balance = AP ledger, Σ movements = stock levels).
 */
import type { LightMyRequestResponse } from 'fastify'
import { sql } from 'kysely'
import { expect } from 'vitest'
import { newId } from '@kadai/shared'
import type { TestApp } from '../../../test/helpers'
import { randomGstin, type TestShop, type TestShopMember } from '../../../test/tenants'

export const API = '/api/v1'

type Deps = Pick<TestApp, 'deps'>

export interface ProductFixture {
  id: string
  name: string
  pack_size: number
}

export async function makeProduct(
  t: Deps,
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
    gst_rate_bp?: number
    cess_rate_bp?: number
    hsn_code?: string | null
    price_includes_tax?: boolean
    reorder_level_milli?: number | null
    reorder_qty_milli?: number | null
    category_id?: string | null
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
      gst_rate_bp: opts.gst_rate_bp ?? 1800,
      cess_rate_bp: opts.cess_rate_bp ?? 0,
      hsn_code: opts.hsn_code ?? null,
      price_includes_tax: opts.price_includes_tax ?? true,
      reorder_level_milli: opts.reorder_level_milli ?? null,
      reorder_qty_milli: opts.reorder_qty_milli ?? null,
      category_id: opts.category_id ?? null,
      is_active: opts.is_active ?? true,
    })
    .execute()
  return { id, name, pack_size: opts.pack_size ?? 1 }
}

export async function makeSupplier(
  t: Deps,
  tenantId: string,
  opts: {
    name?: string
    state_code?: string | null
    gstin?: string | null
    phone?: string | null
    payment_terms_days?: number | null
    is_active?: boolean
  } = {},
): Promise<{ id: string; name: string }> {
  const id = newId()
  const name = opts.name ?? `Supplier ${id.slice(-6)}`
  const state = opts.state_code === undefined ? '33' : opts.state_code
  await t.deps.db.systemDb
    .insertInto('suppliers')
    .values({
      id,
      tenant_id: tenantId,
      name,
      state_code: state,
      gstin: opts.gstin === undefined ? (state ? randomGstin(state) : null) : opts.gstin,
      phone: opts.phone ?? null,
      payment_terms_days: opts.payment_terms_days ?? null,
      is_active: opts.is_active ?? true,
    })
    .execute()
  return { id, name }
}

export async function makeBatch(
  t: Deps,
  tenantId: string,
  productId: string,
  opts: {
    batch_no?: string
    expiry_date?: string | null
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
      mrp_paise: opts.mrp_paise ?? null,
      purchase_price_paise: opts.purchase_price_paise ?? null,
      supplier_id: opts.supplier_id ?? null,
    })
    .execute()
  return { id, batch_no: batchNo }
}

export async function makeStore(
  t: Deps,
  tenantId: string,
  code: string,
  opts: { state_code?: string; is_active?: boolean } = {},
): Promise<{ id: string; code: string }> {
  const id = newId()
  await t.deps.db.systemDb
    .insertInto('stores')
    .values({
      id,
      tenant_id: tenantId,
      code,
      name: `Branch ${code}`,
      state_code: opts.state_code ?? '33',
      is_active: opts.is_active ?? true,
    })
    .execute()
  return { id, code }
}

/** `{data}` of a successful response, failing with the body otherwise. */
export function dataOf<T = Record<string, unknown>>(res: LightMyRequestResponse, status = 200): T {
  if (res.statusCode !== status) {
    throw new Error(`expected ${String(status)}, got ${String(res.statusCode)}: ${res.body}`)
  }
  return res.json<{ data: T }>().data
}

export interface ErrorView {
  code: string
  message: string
  details?: Record<string, unknown> & {
    reason?: string
    issues?: { path: string; message: string }[]
  }
}

export function errorOf(res: LightMyRequestResponse): ErrorView {
  return res.json<{ error: ErrorView }>().error
}

/** Asserts an error status / code (and reason) and returns the error. */
export function expectError(
  res: LightMyRequestResponse,
  status: number,
  code: string,
  reason?: string,
): ErrorView {
  if (res.statusCode !== status) {
    throw new Error(
      `expected ${String(status)} ${code}, got ${String(res.statusCode)}: ${res.body}`,
    )
  }
  const err = errorOf(res)
  expect(err.code).toBe(code)
  if (reason !== undefined) expect(err.details?.reason).toBe(reason)
  return err
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

/** Current balance of a stock row (null batch = the unbatched row; omitted = all rows). */
export async function levelOf(
  t: Deps,
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

/** Every journal entry of the tenant balances. */
export async function assertJournalsBalanced(t: Deps, tenantId: string): Promise<void> {
  const res = await sql<{ entry_id: string; dr: string; cr: string }>`
    select entry_id, sum(debit_paise) as dr, sum(credit_paise) as cr
      from journal_lines where tenant_id = ${tenantId} group by entry_id`.execute(
    t.deps.db.systemDb,
  )
  for (const r of res.rows) expect(Number(r.dr)).toBe(Number(r.cr))
}

/** suppliers.balance_paise = Σ (credit − debit) of payable lines with the supplier as party. */
export async function assertSupplierBalanceMatchesLedger(
  t: Deps,
  tenantId: string,
  supplierId: string,
): Promise<number> {
  const supplier = await t.deps.db.systemDb
    .selectFrom('suppliers')
    .select(['balance_paise', 'opening_balance_paise'])
    .where('tenant_id', '=', tenantId)
    .where('id', '=', supplierId)
    .executeTakeFirstOrThrow()
  const res = await sql<{ bal: string | null }>`
    select coalesce(sum(l.credit_paise - l.debit_paise), 0) as bal
      from journal_lines l join accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
     where l.tenant_id = ${tenantId} and a.subtype = 'payable'
       and l.party_type = 'supplier' and l.party_id = ${supplierId}`.execute(t.deps.db.systemDb)
  expect(Number(supplier.balance_paise)).toBe(Number(res.rows[0]?.bal ?? 0))
  return Number(supplier.balance_paise)
}

/** Σ movements per (store, product, batch) equals the stock_levels balance for the tenant. */
export async function assertLevelsMatchMovements(t: Deps, tenantId: string): Promise<void> {
  const res = await sql<{ level: string; moved: string }>`
    select l.qty_milli as level,
           coalesce((select sum(m.qty_milli) from stock_movements m
                      where m.tenant_id = l.tenant_id and m.store_id = l.store_id
                        and m.product_id = l.product_id
                        and m.batch_id is not distinct from l.batch_id), 0) as moved
      from stock_levels l where l.tenant_id = ${tenantId}`.execute(t.deps.db.systemDb)
  for (const r of res.rows) expect(Number(r.moved)).toBe(Number(r.level))
}

export interface JournalLineView {
  entry_id: string
  reverses_entry_id: string | null
  entry_date: string
  subtype: string | null
  debit_paise: number
  credit_paise: number
  party_id: string | null
}

/** Journal lines of a document source (all entries, oldest first). */
export async function journalOf(
  t: Deps,
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
      'l.party_id',
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

/** Net debit (Dr − Cr) per account subtype of the original (non-reversal) entries. */
export function netBySubtype(lines: readonly JournalLineView[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const l of lines) {
    if (l.reverses_entry_id) continue
    const k = l.subtype ?? '?'
    out[k] = (out[k] ?? 0) + l.debit_paise - l.credit_paise
  }
  return out
}

/** Audit actions of an entity, oldest first. */
export async function auditActions(t: Deps, tenantId: string, entityId: string): Promise<string[]> {
  const rows = await t.deps.db.systemDb
    .selectFrom('audit_logs')
    .select(['action'])
    .where('tenant_id', '=', tenantId)
    .where('entity_id', '=', entityId)
    .orderBy('created_at')
    .orderBy('id')
    .execute()
  return rows.map((r) => r.action)
}

/** Stock movements of a document, in insertion order. */
export async function movementsOf(
  t: Deps,
  tenantId: string,
  refType: string,
  refId: string,
): Promise<
  {
    product_id: string
    batch_id: string | null
    movement_type: string
    qty_milli: number
    unit_cost_paise: number | null
  }[]
> {
  const rows = await t.deps.db.systemDb
    .selectFrom('stock_movements')
    .select(['product_id', 'batch_id', 'movement_type', 'qty_milli', 'unit_cost_paise'])
    .where('tenant_id', '=', tenantId)
    .where('ref_type', '=', refType)
    .where('ref_id', '=', refId)
    .orderBy('created_at')
    .orderBy('id')
    .execute()
  return rows.map((r) => ({ ...r, qty_milli: Number(r.qty_milli) }))
}
