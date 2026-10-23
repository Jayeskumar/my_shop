/**
 * Supplier Trust Score (GET /purchases/supplier-trust, and the learned lead times StockSense plans
 * with): each supplier's deliveries over the last SUPPLIER_TRUST_WINDOW_DAYS — order date →
 * first posted bill against the order, ordered vs received quantity — and its rate changes over
 * SUPPLIER_PRICE_WINDOW_DAYS, scored by supplierTrust (@kadai/shared/supplier-trust).
 */
import { sql } from 'kysely'
import {
  SUPPLIER_PRICE_WINDOW_DAYS,
  SUPPLIER_TRUST_MIN_ORDERS,
  SUPPLIER_TRUST_WINDOW_DAYS,
  type SupplierDelivery,
  type SupplierPricePoint,
  type SupplierTrust,
  addDays,
  supplierTrust,
} from '@kadai/shared'
import type { SupplierTrustResponse } from '@kadai/shared/api/purchases'
import type { Tx } from '../../db/tenant'
import { type Ctx, businessToday, iso } from './common'

export type SupplierTrustWithDate = SupplierTrust & { last_delivery_date: string | null }

export async function supplierTrustMap(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId' | 'storeIds'>,
  today: string,
): Promise<Map<string, SupplierTrustWithDate>> {
  const t = ctx.tenantId
  const stores = ctx.storeIds
  const storeFilter = stores ? sql`and o.store_id = any(${stores}::uuid[])` : sql``
  const billStoreFilter = stores ? sql`and b.store_id = any(${stores}::uuid[])` : sql``
  const from = addDays(today, -SUPPLIER_TRUST_WINDOW_DAYS)
  const priceFrom = addDays(today, -SUPPLIER_PRICE_WINDOW_DAYS)

  const [orders, prices] = await Promise.all([
    sql<{
      supplier_id: string
      order_date: string
      expected_date: string | null
      first_received_date: string | null
      ordered_milli: string
      received_milli: string
    }>`
      select o.supplier_id,
             o.order_date::text as order_date,
             o.expected_date::text as expected_date,
             (select min(b.received_date)::text from purchase_bills b
               where b.tenant_id = o.tenant_id and b.purchase_order_id = o.id
                 and b.status = 'posted') as first_received_date,
             (select coalesce(sum(l.qty_milli), 0) from purchase_order_lines l
               where l.tenant_id = o.tenant_id and l.purchase_order_id = o.id) as ordered_milli,
             (select coalesce(sum(least(l.received_qty_milli, l.qty_milli)), 0)
                from purchase_order_lines l
               where l.tenant_id = o.tenant_id and l.purchase_order_id = o.id) as received_milli
        from purchase_orders o
       where o.tenant_id = ${t}
         and o.status in ('partially_received', 'received', 'closed')
         and o.order_date >= ${from}::date
         ${storeFilter}`.execute(tx),
    sql<{
      supplier_id: string
      product_id: string
      date: string
      unit_cost_paise: string
      amount_paise: string
    }>`
      select b.supplier_id, l.product_id, b.received_date::text as date,
             l.unit_cost_paise, l.taxable_paise as amount_paise
        from purchase_bill_lines l
        join purchase_bills b on b.tenant_id = l.tenant_id and b.id = l.bill_id
       where l.tenant_id = ${t}
         and b.status = 'posted'
         and b.received_date >= ${priceFrom}::date
         ${billStoreFilter}`.execute(tx),
  ])

  const deliveries = new Map<string, SupplierDelivery[]>()
  for (const r of orders.rows) {
    if (!r.first_received_date) continue
    const list = deliveries.get(r.supplier_id) ?? []
    list.push({
      order_date: r.order_date,
      expected_date: r.expected_date,
      first_received_date: r.first_received_date,
      ordered_milli: Number(r.ordered_milli),
      received_milli: Number(r.received_milli),
    })
    deliveries.set(r.supplier_id, list)
  }
  const pricePoints = new Map<string, SupplierPricePoint[]>()
  for (const r of prices.rows) {
    const list = pricePoints.get(r.supplier_id) ?? []
    list.push({
      product_id: r.product_id,
      date: r.date,
      unit_cost_paise: Number(r.unit_cost_paise),
      amount_paise: Number(r.amount_paise),
    })
    pricePoints.set(r.supplier_id, list)
  }

  const out = new Map<string, SupplierTrustWithDate>()
  for (const id of new Set([...deliveries.keys(), ...pricePoints.keys()])) {
    const d = deliveries.get(id) ?? []
    const last = d.reduce<string | null>(
      (m, x) => (m === null || x.first_received_date > m ? x.first_received_date : m),
      null,
    )
    out.set(id, { ...supplierTrust(d, pricePoints.get(id) ?? []), last_delivery_date: last })
  }
  return out
}

export async function supplierTrustReport(tx: Tx, ctx: Ctx): Promise<SupplierTrustResponse> {
  const cal = await businessToday(tx, ctx)
  const [stats, suppliers] = await Promise.all([
    supplierTrustMap(tx, ctx, cal.today),
    tx
      .selectFrom('suppliers')
      .select(['id', 'name', 'phone'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('is_active', '=', true)
      .orderBy('name')
      .execute(),
  ])
  const empty = supplierTrust([])
  const rows = suppliers.map((s) => {
    const st = stats.get(s.id) ?? { ...empty, last_delivery_date: null }
    return {
      supplier_id: s.id,
      name: s.name,
      phone: s.phone,
      orders_measured: st.orders_measured,
      avg_lead_days: st.avg_lead_days,
      sd_lead_days: st.sd_lead_days,
      avg_promised_days: st.avg_promised_days,
      on_time_bp: st.on_time_bp,
      fill_rate_bp: st.fill_rate_bp,
      price_change_bp: st.price_change_bp,
      trust: st.trust,
      level: st.level,
      learned_lead_days: st.learned_lead_days,
      alerts: st.alerts,
      last_delivery_date: st.last_delivery_date,
    }
  })
  // Scored suppliers first (lowest trust first: they need attention), then the ones still learning.
  rows.sort((a, b) =>
    a.trust === null && b.trust === null
      ? a.name.localeCompare(b.name, 'en')
      : a.trust === null
        ? 1
        : b.trust === null
          ? -1
          : a.trust - b.trust,
  )
  return {
    generated_at: iso(new Date()),
    window_days: SUPPLIER_TRUST_WINDOW_DAYS,
    min_orders: SUPPLIER_TRUST_MIN_ORDERS,
    suppliers: rows,
  }
}
