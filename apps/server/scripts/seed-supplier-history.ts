/**
 * Demo history for the Supplier Trust Score: past purchase orders of the demo shop's suppliers and
 * the bills that received them, some late, some short, some at a higher rate. Run after
 * seed-demo.ts:
 *
 *   pnpm --filter @kadai/server exec tsx scripts/seed-supplier-history.ts
 *
 * Everything goes through the purchases routes (order → send → bill from order → post → close),
 * the bills are paid in full (core recordPayment) so they leave no dues, and a stock count at the
 * end puts the affected products back to the stock they had before, so only history is added.
 * Refuses to run twice (looks for its marker in purchase order notes).
 */
import { addDays } from '@kadai/shared'
import { buildApp } from '../src/app'
import { loadConfig, loadDotEnv } from '../src/config'
import { systemContext } from '../src/core/context'
import { recordPayment } from '../src/core/payments'
import { withTenant } from '../src/db/tenant'

const DEMO_PHONE = '+919000000001'
const DEMO_PASSWORD = 'KadaiDemo@2026'
const MARKER = '[demo-history]'
const API = '/api/v1'

interface PastOrder {
  /** Days before today the order was placed. */
  ago: number
  /** Days the supplier promised (expected date). */
  promised: number
  /** Days it actually took. */
  took: number
  /** sku → [quantity ordered, share delivered (1 = all), rate ₹ per pack or null = product price] */
  lines: Record<string, [number, number, number | null]>
}

const HISTORY: Record<string, { name: string; orders: PastOrder[] }> = {
  rice: {
    name: 'Kaveri Rice Traders',
    orders: [
      { ago: 70, promised: 3, took: 2, lines: { 'DAL-TOOR-1': [40, 1, null], 'SUGAR-1': [50, 1, null] } },
      { ago: 56, promised: 3, took: 3, lines: { 'RICE-PONNI-25': [10, 1, null], 'DAL-URAD-1': [30, 1, null] } },
      { ago: 42, promised: 3, took: 3, lines: { 'DAL-TOOR-1': [40, 0.95, null], 'DAL-CHANA-500': [30, 1, null] } },
      { ago: 28, promised: 3, took: 2, lines: { 'SUGAR-1': [50, 1, null], 'ATTA-FORTUNE-5': [10, 1, null] } },
      { ago: 18, promised: 3, took: 3, lines: { 'RICE-IDLI-10': [10, 1, null], 'DAL-TOOR-1': [40, 1, null] } },
    ],
  },
  oil: {
    name: 'Idhayam Oil Distributors',
    orders: [
      { ago: 66, promised: 3, took: 7, lines: { 'OIL-SUN-1L': [60, 0.8, 128], 'OIL-GN-1L': [40, 0.8, 172] } },
      { ago: 52, promised: 3, took: 5, lines: { 'OIL-SUN-1L': [60, 0.85, 130], 'OIL-COCO-500': [24, 1, null] } },
      { ago: 38, promised: 3, took: 9, lines: { 'OIL-GN-1L': [40, 0.75, 176], 'OIL-GINGELLY-1L': [24, 0.75, null] } },
      { ago: 24, promised: 3, took: 3, lines: { 'OIL-SUN-1L': [60, 1, 134] } },
      { ago: 15, promised: 3, took: 8, lines: { 'OIL-SUN-1L': [60, 0.8, 136], 'OIL-GN-1L': [40, 0.8, 182] } },
    ],
  },
  fmcg: {
    name: 'Chennai FMCG Agencies',
    orders: [
      { ago: 60, promised: 4, took: 4, lines: { 'SOAP-HAMAM-100': [48, 1, null], 'TEA-TATA-250': [24, 1, null] } },
      { ago: 45, promised: 4, took: 5, lines: { 'PASTE-COLGATE-150': [36, 0.95, null], 'SALT-TATA-1': [60, 1, null] } },
      { ago: 30, promised: 4, took: 3, lines: { 'DET-SURF-1': [24, 1, null], 'COF-BRU-200': [24, 1, null] } },
      { ago: 20, promised: 4, took: 4, lines: { 'SOAP-HAMAM-100': [48, 0.96, null], 'TEA-TATA-250': [24, 1, null] } },
    ],
  },
}

loadDotEnv()
const config = loadConfig({
  ...process.env,
  KADAI_SERVE_WEB: 'false',
  KADAI_EMBEDDED_WORKER: 'false',
  KADAI_MIGRATE_ON_BOOT: 'false',
  LOG_LEVEL: 'warn',
  RATE_LIMIT_GLOBAL_MAX: '100000',
})
const app = await buildApp(config)
await app.ready()
const { systemDb, appDb } = app.kadai.db

const user = await systemDb.selectFrom('users').select('id').where('phone', '=', DEMO_PHONE).executeTakeFirst()
if (!user) throw new Error('Demo shop not found: run scripts/seed-demo.ts first')
const membership = await systemDb
  .selectFrom('memberships')
  .select('tenant_id')
  .where('user_id', '=', user.id)
  .executeTakeFirstOrThrow()
const tenantId = membership.tenant_id
const already = await systemDb
  .selectFrom('purchase_orders')
  .select('id')
  .where('tenant_id', '=', tenantId)
  .where('notes', 'like', `%${MARKER}%`)
  .executeTakeFirst()
if (already) {
  console.log('Supplier history already present; nothing to do.')
  await app.close()
  process.exit(0)
}
const store = await systemDb
  .selectFrom('stores')
  .select('id')
  .where('tenant_id', '=', tenantId)
  .orderBy('code')
  .executeTakeFirstOrThrow()
const storeId = store.id

const login = await app.inject({
  method: 'POST',
  url: `${API}/auth/login`,
  headers: { 'x-kadai-token-delivery': 'body' },
  payload: { identifier: DEMO_PHONE, password: DEMO_PASSWORD },
})
if (login.statusCode !== 200) throw new Error(`login failed: ${login.body}`)
const token = login.json<{ data: { access_token: string } }>().data.access_token

async function call<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
): Promise<T> {
  const res = await app.inject({
    method,
    url: `${API}${url}`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  })
  if (res.statusCode >= 300) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`)
  return res.json<{ data: T }>().data
}

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
const d = (offset: number): string => addDays(today, offset)

const skus = [...new Set(Object.values(HISTORY).flatMap((s) => s.orders.flatMap((o) => Object.keys(o.lines))))]
const products = await systemDb
  .selectFrom('products')
  .select(['id', 'sku', 'track_batches'])
  .where('tenant_id', '=', tenantId)
  .where('sku', 'in', skus)
  .execute()
const pid = new Map(products.map((p) => [p.sku!, p.id]))
for (const p of products) if (p.track_batches) throw new Error(`${p.sku} is batch-tracked; history uses unbatched items only`)

// Stock before, to restore at the end (history must not change today's stock).
const levels = await systemDb
  .selectFrom('stock_levels')
  .select(['product_id', 'qty_milli'])
  .where('tenant_id', '=', tenantId)
  .where('store_id', '=', storeId)
  .where('batch_id', 'is', null)
  .where('product_id', 'in', [...pid.values()])
  .execute()
const before = new Map(levels.map((l) => [l.product_id, Number(l.qty_milli)]))

const suppliers = await systemDb
  .selectFrom('suppliers')
  .select(['id', 'name'])
  .where('tenant_id', '=', tenantId)
  .execute()
const sid = (name: string): string => {
  const s = suppliers.find((x) => x.name === name)
  if (!s) throw new Error(`supplier ${name} not found`)
  return s.id
}

interface BillDetail {
  id: string
  updated_at: string
  total_paise: number
  lines: { product_id: string; purchase_order_line_id: string | null; qty_milli: number; unit_cost_paise: number; gst_rate_bp: number }[]
}

const ctx = systemContext(tenantId, { userId: user.id, locale: 'en' })
let n = 0
for (const [key, sup] of Object.entries(HISTORY)) {
  const supplierId = sid(sup.name)
  for (const o of sup.orders) {
    n += 1
    const orderDate = d(-o.ago)
    const received = d(Math.min(0, -o.ago + o.took))
    const order = await call<{ id: string }>('POST', '/purchase-orders', {
      store_id: storeId,
      supplier_id: supplierId,
      order_date: orderDate,
      expected_date: d(-o.ago + o.promised),
      notes: `${MARKER} weekly order`,
      lines: Object.entries(o.lines).map(([sku, [qty, , rate]]) => ({
        product_id: pid.get(sku)!,
        qty_milli: qty * 1000,
        ...(rate !== null ? { unit_cost_paise: Math.round(rate * 100) } : {}),
      })),
    })
    await call('POST', `/purchase-orders/${order.id}/send`, {})
    const draft = await call<BillDetail>('POST', `/purchase-bills/from-order/${order.id}`, {
      supplier_invoice_no: `HIST-${key.toUpperCase()}-${String(n).padStart(3, '0')}`,
      supplier_invoice_date: received,
      received_date: received,
    })
    // Short supply: the bill receives only part of each line.
    const short = draft.lines.some((l) => {
      const sku = products.find((p) => p.id === l.product_id)!.sku!
      return o.lines[sku]![1] < 1
    })
    let bill = draft
    if (short) {
      bill = await call<BillDetail>('PATCH', `/purchase-bills/${draft.id}`, {
        if_updated_at: draft.updated_at,
        lines: draft.lines.map((l) => {
          const sku = products.find((p) => p.id === l.product_id)!.sku!
          const share = o.lines[sku]![1]
          return {
            product_id: l.product_id,
            ...(l.purchase_order_line_id ? { purchase_order_line_id: l.purchase_order_line_id } : {}),
            qty_milli: Math.max(1, Math.floor((l.qty_milli / 1000) * share)) * 1000,
            unit_cost_paise: l.unit_cost_paise,
            gst_rate_bp: l.gst_rate_bp,
          }
        }),
      })
    }
    await call('POST', `/purchase-bills/${bill.id}/post`, { if_updated_at: bill.updated_at, update_prices: false })
    const posted = await call<BillDetail>('GET', `/purchase-bills/${bill.id}`)
    if (short) await call('POST', `/purchase-orders/${order.id}/close`, { reason: 'Supplier sent less than ordered' })
    await withTenant(appDb, ctx, (tx) =>
      recordPayment(tx, ctx, {
        direction: 'out',
        store_id: storeId,
        method: 'bank_transfer',
        amount_paise: posted.total_paise,
        payment_date: received,
        party: { type: 'supplier', id: supplierId },
        reference: `NEFT ${MARKER}`,
        allocations: [{ target_type: 'purchase_bill', target_id: bill.id, amount_paise: posted.total_paise }],
        number: true,
      }),
    )
  }
  console.log(`${sup.name}: ${String(sup.orders.length)} past orders`)
}

// Put today's stock back where it was: history only.
const lines = [...pid.values()].map((productId) => ({
  product_id: productId,
  batch_id: null,
  counted_qty_milli: Math.max(0, before.get(productId) ?? 0),
  reason: 'Demo history: restore current count',
}))
const adj = await call<{ id: string; updated_at: string }>('POST', '/stock-adjustments', {
  store_id: storeId,
  kind: 'stock_take',
  notes: `${MARKER} keep today’s stock`,
  lines,
})
await call('POST', `/stock-adjustments/${adj.id}/post`, { if_updated_at: adj.updated_at })

await app.close()
console.log(`Done: ${String(n)} past orders received and paid; today’s stock unchanged.`)
