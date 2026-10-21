/**
 * Customer summary (khata page header & insights): lifetime sales, last 12 months, average bill,
 * last visit, top items, current due / overdue, credit headroom, loyalty and open payment links.
 *
 * Sales figures (lifetime, monthly, top items, first/last visit) and payment links are limited to
 * the member's stores; balance, overdue and loyalty are party-level (the khata is per business).
 * Overdue is capped at the current due, like the customer list.
 * Sales = completed tax invoices / bills of supply (estimates, held and cancelled bills excluded).
 */
import { addPeriods, periodOf, roundDiv } from '@kadai/shared'
import {
  type CustomerSummary,
  effectiveCreditDays,
  invoiceDueDate,
  loyaltyValuePaise,
  monthlySeries,
} from '@kadai/shared/api/parties'
import type { PaymentIntentStatus } from '@kadai/shared'
import { type SqlBool, sql } from 'kysely'
import type { Tx } from '../../db/tenant'
import type { RequestContext } from '../../core/context'
import { notFound } from '../../core/errors'
import { getSettings } from '../../core/settings'
import { iso, isoOrNull, storeScopeSql, tenantToday } from './common'

const TOP_ITEMS = 10

export async function customerSummary(
  tx: Tx,
  ctx: RequestContext,
  customerId: string,
): Promise<CustomerSummary> {
  const customer = await tx
    .selectFrom('customers')
    .select(['id', 'balance_paise', 'credit_limit_paise', 'credit_days', 'loyalty_points'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', customerId)
    .executeTakeFirst()
  if (!customer) throw notFound('customer', customerId)
  const settings = await getSettings(tx, ctx)
  const today = await tenantToday(tx, ctx)
  const creditDays = effectiveCreditDays(customer.credit_days, settings)
  const scope = storeScopeSql('si.store_id', ctx)
  const live = sql`si.tenant_id = ${ctx.tenantId} and si.customer_id = ${customerId}
    and si.status = 'completed' and si.doc_type <> 'estimate'`

  const totals = await sql<{
    sales: number
    count: number
    first_at: Date | null
    last_at: Date | null
  }>`select coalesce(sum(si.total_paise), 0)::bigint as sales, count(*)::int as count,
        min(si.invoice_at) as first_at, max(si.invoice_at) as last_at
      from sales_invoices si where ${live} ${scope}`.execute(tx)
  const t = totals.rows[0] ?? { sales: 0, count: 0, first_at: null, last_at: null }

  const returns = await sql<{
    total: number
  }>`select coalesce(sum(cn.total_paise), 0)::bigint as total
      from credit_notes cn
     where cn.tenant_id = ${ctx.tenantId} and cn.customer_id = ${customerId}
       and cn.status = 'completed' ${storeScopeSql('cn.store_id', ctx)}`.execute(tx)

  const endPeriod = periodOf(today)
  const startPeriod = addPeriods(endPeriod, -11)
  const monthly = await sql<{ period: string; sales_paise: number; invoice_count: number }>`
    select to_char(si.invoice_date, 'YYYY-MM') as period,
           coalesce(sum(si.total_paise), 0)::bigint as sales_paise, count(*)::int as invoice_count
      from sales_invoices si
     where ${live} ${scope} and si.invoice_date >= ${`${startPeriod}-01`}::date
     group by 1`.execute(tx)

  const top = await sql<{
    product_id: string | null
    name: string
    name_ta: string | null
    unit: string
    qty_milli: number
    amount_paise: number
    invoice_count: number
  }>`select l.product_id,
            coalesce(max(p.name), max(l.name)) as name,
            coalesce(max(p.name_ta), max(l.name_ta)) as name_ta,
            coalesce(max(p.unit), max(l.unit)) as unit,
            coalesce(sum(l.qty_milli), 0)::bigint as qty_milli,
            coalesce(sum(l.total_paise), 0)::bigint as amount_paise,
            count(distinct l.invoice_id)::int as invoice_count
       from sales_invoice_lines l
       join sales_invoices si on si.tenant_id = l.tenant_id and si.id = l.invoice_id
       left join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
      where ${live} ${scope}
      group by l.product_id, case when l.product_id is null then l.name end
      order by amount_paise desc, invoice_count desc, name
      limit ${TOP_ITEMS}`.execute(tx)

  const dues = await sql<{ overdue: number; overdue_count: number; oldest: string | null }>`
    select coalesce(sum(si.due_paise) filter (where si.invoice_date < ${today}::date - ${creditDays}::int), 0)::bigint as overdue,
           (count(*) filter (where si.invoice_date < ${today}::date - ${creditDays}::int))::int as overdue_count,
           to_char(min(si.invoice_date), 'YYYY-MM-DD') as oldest
      from sales_invoices si
     where ${live} and si.due_paise > 0`.execute(tx)
  const d = dues.rows[0] ?? { overdue: 0, overdue_count: 0, oldest: null }

  const links = await tx
    .selectFrom('payment_intents as pi')
    .select([
      'pi.id',
      'pi.amount_paise',
      'pi.status',
      'pi.short_url',
      'pi.reference_code',
      'pi.created_at',
      'pi.expires_at',
    ])
    .where('pi.tenant_id', '=', ctx.tenantId)
    .where('pi.customer_id', '=', customerId)
    .where('pi.kind', '=', 'link')
    .where('pi.status', 'in', ['created', 'pending'])
    .where((eb) => eb.or([eb('pi.expires_at', 'is', null), eb('pi.expires_at', '>', new Date())]))
    .$if(ctx.storeIds !== null, (q) =>
      q.where(sql<SqlBool>`pi.store_id = any(${[...(ctx.storeIds ?? [])]}::uuid[])`),
    )
    .orderBy('pi.created_at', 'desc')
    .limit(20)
    .execute()

  const sales = Number(t.sales)
  const count = Number(t.count)
  // Overdue never exceeds what the customer owes now (an unallocated advance offsets it).
  const overdue = Math.min(Number(d.overdue), Math.max(0, customer.balance_paise))
  return {
    customer_id: customer.id,
    lifetime_sales_paise: sales,
    invoice_count: count,
    returns_paise: Number(returns.rows[0]?.total ?? 0),
    average_bill_paise: count > 0 ? roundDiv(sales, count) : 0,
    first_invoice_at: isoOrNull(t.first_at),
    last_invoice_at: isoOrNull(t.last_at),
    monthly: monthlySeries(
      monthly.rows.map((r) => ({
        period: r.period,
        sales_paise: Number(r.sales_paise),
        invoice_count: Number(r.invoice_count),
      })),
      endPeriod,
    ),
    top_items: top.rows.map((r) => ({
      product_id: r.product_id,
      name: r.name,
      name_ta: r.name_ta,
      unit: r.unit,
      qty_milli: Number(r.qty_milli),
      amount_paise: Number(r.amount_paise),
      invoice_count: Number(r.invoice_count),
    })),
    balance_paise: customer.balance_paise,
    overdue_paise: overdue,
    overdue_invoice_count: overdue > 0 ? Number(d.overdue_count) : 0,
    oldest_due_date: d.oldest ? invoiceDueDate(d.oldest, creditDays) : null,
    credit_limit_paise: customer.credit_limit_paise,
    credit_available_paise:
      customer.credit_limit_paise === null
        ? null
        : customer.credit_limit_paise - customer.balance_paise,
    credit_days: creditDays,
    loyalty_points: customer.loyalty_points,
    loyalty_value_paise: loyaltyValuePaise(customer.loyalty_points, settings.loyalty),
    open_payment_links: links.map((l) => ({
      id: l.id,
      amount_paise: l.amount_paise,
      status: l.status as PaymentIntentStatus,
      short_url: l.short_url,
      reference_code: l.reference_code,
      created_at: iso(l.created_at),
      expires_at: isoOrNull(l.expires_at),
    })),
  }
}
