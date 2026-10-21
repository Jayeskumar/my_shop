/**
 * Sales fact CTEs shared by the sales reports, the dashboard and the pharmacy reports.
 *
 *   inv   completed sales documents (tax invoices / bills of supply — never estimates, held bills,
 *         drafts or cancelled bills) dated in the range, in the store scope;
 *   cn    completed credit notes dated in the range (returns reduce sales by note date);
 *   f     line facts: invoice lines (+) and credit-note lines (returns columns), one row each,
 *         with the cost of sales (credit-note lines carry the restocked cost as a negative cost);
 *   ff    f joined with the product, category and brand, after the product filters.
 *
 * Metric definitions are the contract's (packages/shared/src/api/reports.ts module doc).
 */
import { sql } from 'kysely'
import type { Ctx, Sql, StoreScope } from './common'
import { eqOpt, inCategoryTree, inStores, likePattern } from './common'

export interface DocFilter {
  from: string
  to: string
  scope: Pick<StoreScope, 'storeIds'>
  /** Billed / returned by (invoices.created_by, credit_notes.created_by). */
  userId?: string | undefined
  registerId?: string | undefined
  channel?: string | undefined
}

export interface ProductFilter {
  categoryId?: string | undefined
  brandId?: string | undefined
  productId?: string | undefined
  q?: string | undefined
}

/** WHERE of completed sales documents (alias i). */
export function invoiceWhere(ctx: Ctx, f: DocFilter): Sql {
  return sql`i.tenant_id = ${ctx.tenantId}
    and i.status = 'completed' and i.doc_type <> 'estimate'
    and i.invoice_date between ${f.from}::date and ${f.to}::date
    and ${inStores('i.store_id', f.scope)}
    and ${eqOpt('i.created_by', f.userId)}
    and ${eqOpt('i.register_id', f.registerId)}
    and ${eqOpt('i.channel', f.channel)}`
}

/** WHERE of completed credit notes (alias c); a channel filter uses the original bill's channel. */
export function creditNoteWhere(ctx: Ctx, f: DocFilter): Sql {
  const channel = f.channel
    ? sql`exists (select 1 from sales_invoices oi
                   where oi.tenant_id = c.tenant_id and oi.id = c.invoice_id
                     and oi.channel = ${f.channel})`
    : sql`true`
  return sql`c.tenant_id = ${ctx.tenantId}
    and c.status = 'completed'
    and c.note_date between ${f.from}::date and ${f.to}::date
    and ${inStores('c.store_id', f.scope)}
    and ${eqOpt('c.created_by', f.userId)}
    and ${eqOpt('c.register_id', f.registerId)}
    and ${channel}`
}

/**
 * `inv`, `cn`, `f` and `ff` CTEs (no leading WITH; the caller writes `with recursive`).
 * ff columns: product_id, product_key ('adhoc' for ad-hoc lines), name, name_ta, sku, unit,
 * pack_size, hsn_code, category_id, brand_id, inv_id, cn_id, doc_date, qty_milli,
 * free_qty_milli, returned_qty_milli, gross_paise, discount_paise, taxable_paise, tax_paise,
 * sales_paise, returns_paise, returns_taxable_paise, cost_paise, zero_cost (sale line without
 * cost), attributes, meta_schedule, rx_ok (the bill carries patient + doctor details).
 */
export function salesFactsCte(ctx: Ctx, f: DocFilter, p: ProductFilter = {}): Sql {
  const q = p.q
    ? sql`(coalesce(pr.name, f.line_name) ilike ${likePattern(p.q)}
           or coalesce(pr.name_ta, '') ilike ${likePattern(p.q)}
           or coalesce(pr.sku, '') ilike ${likePattern(p.q)})`
    : sql`true`
  return sql`inv as (
      select i.id, i.invoice_date, i.created_by, i.store_id, i.rx
        from sales_invoices i
       where ${invoiceWhere(ctx, f)}
    ),
    cn as (
      select c.id, c.note_date, c.created_by, c.store_id
        from credit_notes c
       where ${creditNoteWhere(ctx, f)}
    ),
    f as (
      select l.product_id, l.name as line_name, l.name_ta as line_name_ta, l.unit as line_unit,
             l.pack_size as line_pack_size, l.hsn_code as line_hsn,
             l.invoice_id as inv_id, null::uuid as cn_id, inv.invoice_date as doc_date,
             l.qty_milli, l.free_qty_milli, 0::bigint as returned_qty_milli,
             l.gross_paise, l.discount_paise, l.taxable_paise,
             (l.cgst_paise + l.sgst_paise + l.igst_paise + l.cess_paise) as tax_paise,
             l.total_paise as sales_paise, 0::bigint as returns_paise,
             0::bigint as returns_taxable_paise, l.cost_paise,
             (l.cost_paise = 0 and l.qty_milli > 0 and l.product_id is not null) as zero_cost,
             l.meta ->> 'schedule' as meta_schedule,
             (nullif(inv.rx ->> 'patient_name', '') is not null
               and nullif(inv.rx ->> 'doctor_name', '') is not null) as rx_ok
        from sales_invoice_lines l
        join inv on inv.id = l.invoice_id
       where l.tenant_id = ${ctx.tenantId}
      union all
      select cl.product_id, cl.name, null, cl.unit, cl.pack_size, cl.hsn_code,
             null::uuid, cl.credit_note_id, cn.note_date,
             0::bigint, 0::bigint, cl.qty_milli,
             0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint,
             cl.total_paise, cl.taxable_paise, -cl.cost_paise,
             false, null, null
        from credit_note_lines cl
        join cn on cn.id = cl.credit_note_id
       where cl.tenant_id = ${ctx.tenantId}
    ),
    ff as (
      select f.*,
             coalesce(f.product_id::text, 'adhoc') as product_key,
             coalesce(pr.name, f.line_name) as name,
             coalesce(pr.name_ta, f.line_name_ta) as name_ta,
             pr.sku, coalesce(pr.unit, f.line_unit) as unit,
             coalesce(pr.pack_size, f.line_pack_size, 1) as pack_size,
             coalesce(pr.hsn_code, f.line_hsn) as hsn_code,
             pr.category_id, pr.brand_id, pr.attributes
        from f
        left join products pr on pr.tenant_id = ${ctx.tenantId} and pr.id = f.product_id
       where ${inCategoryTree('pr.category_id', ctx, p.categoryId)}
         and ${eqOpt('pr.brand_id', p.brandId)}
         and ${eqOpt('f.product_id', p.productId)}
         and ${q}
    )`
}

/** Aggregate SELECT list of the sales metrics over `ff` rows (paise, bigint). */
export const SALES_METRICS_SQL = sql`
  count(distinct ff.inv_id)::bigint as bills,
  coalesce(sum(ff.gross_paise), 0)::bigint as gross_paise,
  coalesce(sum(ff.discount_paise), 0)::bigint as discount_paise,
  coalesce(sum(ff.taxable_paise), 0)::bigint as taxable_paise,
  coalesce(sum(ff.tax_paise), 0)::bigint as tax_paise,
  coalesce(sum(ff.sales_paise), 0)::bigint as sales_paise,
  count(distinct ff.cn_id)::bigint as returns_count,
  coalesce(sum(ff.returns_paise), 0)::bigint as returns_paise,
  coalesce(sum(ff.returns_taxable_paise), 0)::bigint as returns_taxable_paise,
  coalesce(sum(ff.sales_paise - ff.returns_paise), 0)::bigint as net_sales_paise,
  coalesce(sum(ff.taxable_paise - ff.returns_taxable_paise), 0)::bigint as net_taxable_paise,
  coalesce(sum(ff.cost_paise), 0)::bigint as cost_paise,
  coalesce(sum(ff.taxable_paise - ff.returns_taxable_paise - ff.cost_paise), 0)::bigint
    as gross_profit_paise,
  bool_or(ff.zero_cost) as any_zero_cost`

/** Margin (bp, half away from zero) of a profit over a sales column — for ORDER BY / filters. */
export function marginSql(profit: string, sales: string): string {
  return `(case when ${sales} > 0 then round(${profit}::numeric * 10000 / ${sales}) end)`
}
