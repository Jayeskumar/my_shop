/**
 * GST registers of the generic report viewer: HSN summary (Table 12 for any range), the
 * invoice-wise sales register (credit notes negative) and the bill-wise purchase register
 * (posted bills by received date, debit notes negative, expenses with GST). `period` or
 * from / to; `gstin` limits the stores to that registration; store scope as everywhere.
 */
import { sql } from 'kysely'
import type { z } from 'zod'
import {
  type HsnSummaryQuerySchema,
  type HsnSummaryResponse,
  type PurchaseRegisterQuerySchema,
  type PurchaseRegisterResponse,
  type SalesRegisterQuerySchema,
  type SalesRegisterResponse,
  gstQueryRange,
} from '@kadai/shared/api/reports'
import type { Tx } from '../../db/tenant'
import {
  type Ctx,
  type ReportEnv,
  type ReportOutcome,
  type StoreScope,
  eqOpt,
  inStores,
  likePattern,
  num,
  orderBy,
  reportMeta,
  reportOutcome,
  runTabular,
} from './common'
import { HSN_GROUP_SQL, customerGstins, gstDocsCte, resolveRegistration, uqcMapCte } from './gst'

type Out<S extends z.ZodType> = z.output<S>

/** Store ids of the request scope, narrowed to a registration when `gstin` is given. */
async function registerStores(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  scope: StoreScope,
  gstin: string | undefined,
): Promise<{ storeIds: readonly string[] | null }> {
  if (!gstin) return { storeIds: scope.storeIds }
  const reg = await resolveRegistration(tx, ctx, env, gstin, { requireAllStores: false })
  const allowed = scope.storeIds === null ? null : new Set(scope.storeIds)
  return { storeIds: reg.storeIds.filter((id) => allowed === null || allowed.has(id)) }
}

interface GstTotalsRaw {
  documents: number
  taxable_paise: number
  igst_paise: number
  cgst_paise: number
  sgst_paise: number
  cess_paise: number
  total_paise: number
}

function gstTotals(t: GstTotalsRaw) {
  return {
    documents: num(t.documents),
    taxable_paise: num(t.taxable_paise),
    igst_paise: num(t.igst_paise),
    cgst_paise: num(t.cgst_paise),
    sgst_paise: num(t.sgst_paise),
    cess_paise: num(t.cess_paise),
    total_paise: num(t.total_paise),
  }
}

// =============================================================================================
// HSN summary
// =============================================================================================

interface HsnRaw {
  supply: 'b2b' | 'b2c'
  hsn_code: string | null
  description: string | null
  uqc: string
  qty_milli: number
  rate_bp: number
  taxable_paise: number
  igst_paise: number
  cgst_paise: number
  sgst_paise: number
  cess_paise: number
  total_value_paise: number
}

export async function hsnSummary(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  scope: StoreScope,
  q: Out<typeof HsnSummaryQuerySchema>,
): Promise<ReportOutcome<HsnSummaryResponse>> {
  const range = gstQueryRange(q)
  const stores = await registerStores(tx, ctx, env, scope, q.gstin)
  const gstins = await customerGstins(tx, ctx, range.from, range.to, stores.storeIds)
  const docs = gstDocsCte(ctx, range.from, range.to, stores.storeIds, gstins.valid)
  const supply = q.supply ? sql`supply = ${q.supply}` : sql`true`
  const glSupply = q.supply
    ? sql`(case when gl.b2b then 'b2b' else 'b2c' end) = ${q.supply}`
    : sql`true`
  const cte = sql`with recursive ${docs}, ${uqcMapCte()},
    hsn as (${HSN_GROUP_SQL}),
    rows as (select * from hsn where ${supply})`
  const totals = sql`select
      (select count(distinct (gl.kind, gl.doc_id)) from gl where ${glSupply})::bigint as documents,
      coalesce(sum(taxable_paise), 0)::bigint as taxable_paise,
      coalesce(sum(igst_paise), 0)::bigint as igst_paise,
      coalesce(sum(cgst_paise), 0)::bigint as cgst_paise,
      coalesce(sum(sgst_paise), 0)::bigint as sgst_paise,
      coalesce(sum(cess_paise), 0)::bigint as cess_paise,
      coalesce(sum(total_value_paise), 0)::bigint as total_paise
    from rows r`
  const order = orderBy(
    q.sort,
    { hsn_code: 'hsn_code', taxable_paise: 'taxable_paise', rate_bp: 'rate_bp' },
    'supply, hsn_code nulls last, uqc, rate_bp',
  )
  const res = await runTabular<HsnRaw, GstTotalsRaw>(tx, { cte, order, totals }, q)
  const rows = res.rows.map((r) => ({
    supply: r.supply,
    hsn_code: r.hsn_code,
    description: r.description,
    uqc: r.uqc,
    qty_milli: num(r.qty_milli),
    rate_bp: num(r.rate_bp),
    taxable_paise: num(r.taxable_paise),
    igst_paise: num(r.igst_paise),
    cgst_paise: num(r.cgst_paise),
    sgst_paise: num(r.sgst_paise),
    cess_paise: num(r.cess_paise),
    total_value_paise: num(r.total_value_paise),
  }))
  const meta = reportMeta('hsn-summary', env, scope, { from: range.from, to: range.to })
  return reportOutcome(
    tx,
    ctx,
    'hsn-summary',
    q,
    { ...res, rows, totals: gstTotals(res.totals) },
    meta,
    {
      from: range.from,
      to: range.to,
      gstin: q.gstin ?? null,
      supply: q.supply ?? null,
      store_id: scope.storeId,
    },
  )
}

// =============================================================================================
// Sales register
// =============================================================================================

interface SalesRegisterRaw {
  kind: 'invoice' | 'credit_note'
  document_id: string
  number: string
  date: string
  doc_type: 'tax_invoice' | 'bill_of_supply' | null
  status: 'completed' | 'cancelled'
  customer_id: string | null
  customer_name: string | null
  customer_gstin: string | null
  place_of_supply: string
  is_interstate: boolean
  original_invoice_number: string | null
  taxable_paise: number
  igst_paise: number
  cgst_paise: number
  sgst_paise: number
  cess_paise: number
  round_off_paise: number
  total_paise: number
}

export async function salesRegister(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  scope: StoreScope,
  q: Out<typeof SalesRegisterQuerySchema>,
): Promise<ReportOutcome<SalesRegisterResponse>> {
  const range = gstQueryRange(q)
  const stores = await registerStores(tx, ctx, env, scope, q.gstin)
  const statuses = q.include_cancelled ? ['completed', 'cancelled'] : ['completed']
  const search = (alias: string) =>
    q.q
      ? sql`(${sql.ref(`${alias}.number`)} ilike ${likePattern(q.q)}
             or coalesce(${sql.ref(`${alias}.customer_name`)}, '') ilike ${likePattern(q.q)}
             or coalesce(${sql.ref(`${alias}.customer_gstin`)}, '') ilike ${likePattern(q.q)})`
      : sql`true`
  const b2b = (alias: string) =>
    q.b2b_only
      ? sql`nullif(trim(${sql.ref(`${alias}.customer_gstin`)}), '') is not null`
      : sql`true`
  const cte = sql`with recursive
    inv as (
      select 'invoice'::text as kind, i.id as document_id, i.number, i.invoice_date as date,
             i.doc_type, i.status, i.customer_id, i.customer_name,
             nullif(trim(i.customer_gstin), '') as customer_gstin, i.place_of_supply,
             i.is_interstate, null::text as original_invoice_number,
             i.taxable_paise, i.igst_paise, i.cgst_paise, i.sgst_paise, i.cess_paise,
             i.round_off_paise, i.total_paise
        from sales_invoices i
       where i.tenant_id = ${ctx.tenantId} and i.status = any(${statuses}::text[])
         and i.doc_type in ('tax_invoice', 'bill_of_supply') and i.number is not null
         and i.invoice_date between ${range.from}::date and ${range.to}::date
         and ${inStores('i.store_id', stores)} and ${search('i')} and ${b2b('i')}
    ),
    cn as (
      select 'credit_note'::text, c.id, c.number, c.note_date, null::text, c.status,
             c.customer_id, c.customer_name, nullif(trim(c.customer_gstin), ''),
             c.place_of_supply, c.is_interstate, oi.number,
             -c.taxable_paise, -c.igst_paise, -c.cgst_paise, -c.sgst_paise, -c.cess_paise,
             -c.round_off_paise, -c.total_paise
        from credit_notes c
        left join sales_invoices oi on oi.tenant_id = c.tenant_id and oi.id = c.invoice_id
       where c.tenant_id = ${ctx.tenantId} and c.status = any(${statuses}::text[])
         and ${q.include_credit_notes ? sql`true` : sql`false`}
         and c.note_date between ${range.from}::date and ${range.to}::date
         and ${inStores('c.store_id', stores)} and ${search('c')} and ${b2b('c')}
    ),
    rows as (select * from inv union all select * from cn)`
  const totals = sql`select count(*) filter (where status = 'completed')::bigint as documents,
      coalesce(sum(taxable_paise) filter (where status = 'completed'), 0)::bigint as taxable_paise,
      coalesce(sum(igst_paise) filter (where status = 'completed'), 0)::bigint as igst_paise,
      coalesce(sum(cgst_paise) filter (where status = 'completed'), 0)::bigint as cgst_paise,
      coalesce(sum(sgst_paise) filter (where status = 'completed'), 0)::bigint as sgst_paise,
      coalesce(sum(cess_paise) filter (where status = 'completed'), 0)::bigint as cess_paise,
      coalesce(sum(total_paise) filter (where status = 'completed'), 0)::bigint as total_paise
    from rows r`
  const order = orderBy(
    q.sort,
    { date: 'date', number: 'number', total_paise: 'total_paise' },
    'kind, number, document_id',
  )
  const res = await runTabular<SalesRegisterRaw, GstTotalsRaw>(tx, { cte, order, totals }, q)
  const rows = res.rows.map((r) => ({
    ...r,
    taxable_paise: num(r.taxable_paise),
    igst_paise: num(r.igst_paise),
    cgst_paise: num(r.cgst_paise),
    sgst_paise: num(r.sgst_paise),
    cess_paise: num(r.cess_paise),
    round_off_paise: num(r.round_off_paise),
    total_paise: num(r.total_paise),
  }))
  const meta = reportMeta('sales-register', env, scope, { from: range.from, to: range.to })
  return reportOutcome(
    tx,
    ctx,
    'sales-register',
    q,
    { ...res, rows, totals: gstTotals(res.totals) },
    meta,
    { from: range.from, to: range.to, gstin: q.gstin ?? null, store_id: scope.storeId },
  )
}

// =============================================================================================
// Purchase register
// =============================================================================================

interface PurchaseRegisterRaw {
  kind: 'bill' | 'debit_note' | 'expense'
  document_id: string
  number: string | null
  supplier_invoice_no: string | null
  supplier_invoice_date: string | null
  date: string
  supplier_id: string | null
  supplier_name: string | null
  supplier_gstin: string | null
  is_interstate: boolean
  reverse_charge: boolean
  itc_eligible: boolean
  taxable_paise: number
  igst_paise: number
  cgst_paise: number
  sgst_paise: number
  cess_paise: number
  other_charges_paise: number
  total_paise: number
  itc_paise: number
}

export async function purchaseRegister(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  scope: StoreScope,
  q: Out<typeof PurchaseRegisterQuerySchema>,
): Promise<ReportOutcome<PurchaseRegisterResponse>> {
  const range = gstQueryRange(q)
  const stores = await registerStores(tx, ctx, env, scope, q.gstin)
  const search = q.q
    ? sql`(coalesce(number, '') ilike ${likePattern(q.q)}
           or coalesce(supplier_invoice_no, '') ilike ${likePattern(q.q)}
           or coalesce(supplier_name, '') ilike ${likePattern(q.q)}
           or coalesce(supplier_gstin, '') ilike ${likePattern(q.q)})`
    : sql`true`
  const cte = sql`with recursive
    bills as (
      select 'bill'::text as kind, b.id as document_id, b.number, b.supplier_invoice_no,
             b.supplier_invoice_date, b.received_date as date, b.supplier_id, s.name as supplier_name,
             coalesce(nullif(trim(b.supplier_gstin), ''), s.gstin) as supplier_gstin,
             b.is_interstate, b.reverse_charge, b.itc_eligible,
             b.taxable_paise, b.igst_paise, b.cgst_paise, b.sgst_paise, b.cess_paise,
             b.other_charges_paise, b.total_paise,
             (case when b.itc_eligible
                   then b.igst_paise + b.cgst_paise + b.sgst_paise + b.cess_paise else 0 end)::bigint
               as itc_paise
        from purchase_bills b
        join suppliers s on s.tenant_id = b.tenant_id and s.id = b.supplier_id
       where b.tenant_id = ${ctx.tenantId} and b.status = 'posted'
         and b.received_date between ${range.from}::date and ${range.to}::date
         and ${inStores('b.store_id', stores)} and ${eqOpt('b.supplier_id', q.supplier_id)}
    ),
    dns as (
      select 'debit_note'::text, d.id, d.number, ob.supplier_invoice_no, ob.supplier_invoice_date,
             d.note_date, d.supplier_id, s.name,
             coalesce(nullif(trim(ob.supplier_gstin), ''), s.gstin),
             d.is_interstate, coalesce(ob.reverse_charge, false), coalesce(ob.itc_eligible, true),
             -d.taxable_paise, -d.igst_paise, -d.cgst_paise, -d.sgst_paise, -d.cess_paise,
             0::bigint, -d.total_paise,
             (case when coalesce(ob.itc_eligible, true)
                   then -(d.igst_paise + d.cgst_paise + d.sgst_paise + d.cess_paise) else 0 end)::bigint
        from debit_notes d
        join suppliers s on s.tenant_id = d.tenant_id and s.id = d.supplier_id
        left join purchase_bills ob on ob.tenant_id = d.tenant_id and ob.id = d.bill_id
       where d.tenant_id = ${ctx.tenantId} and d.status = 'completed'
         and ${q.include_debit_notes ? sql`true` : sql`false`}
         and d.note_date between ${range.from}::date and ${range.to}::date
         and ${inStores('d.store_id', stores)} and ${eqOpt('d.supplier_id', q.supplier_id)}
    ),
    exps as (
      select 'expense'::text, e.id, e.number, e.reference, null::date, e.expense_date,
             e.supplier_id, coalesce(s.name, e.description), s.gstin,
             e.igst_paise > 0, false, e.itc_eligible,
             e.taxable_paise, e.igst_paise, e.cgst_paise, e.sgst_paise, 0::bigint,
             0::bigint, e.total_paise,
             (case when e.itc_eligible then e.igst_paise + e.cgst_paise + e.sgst_paise else 0 end)::bigint
        from expenses e
        left join suppliers s on s.tenant_id = e.tenant_id and s.id = e.supplier_id
       where e.tenant_id = ${ctx.tenantId} and e.status = 'posted'
         and ${q.include_expenses ? sql`true` : sql`false`}
         and (e.igst_paise + e.cgst_paise + e.sgst_paise) > 0
         and e.expense_date between ${range.from}::date and ${range.to}::date
         and ${inStores('e.store_id', stores)} and ${eqOpt('e.supplier_id', q.supplier_id)}
    ),
    alls as (select * from bills union all select * from dns union all select * from exps),
    rows as (
      select * from alls
       where ${search} and ${q.itc_only ? sql`itc_paise <> 0` : sql`true`}
    )`
  const totals = sql`select count(*)::bigint as documents,
      coalesce(sum(taxable_paise), 0)::bigint as taxable_paise,
      coalesce(sum(igst_paise), 0)::bigint as igst_paise,
      coalesce(sum(cgst_paise), 0)::bigint as cgst_paise,
      coalesce(sum(sgst_paise), 0)::bigint as sgst_paise,
      coalesce(sum(cess_paise), 0)::bigint as cess_paise,
      coalesce(sum(total_paise), 0)::bigint as total_paise,
      coalesce(sum(itc_paise), 0)::bigint as itc_paise
    from rows r`
  const order = orderBy(
    q.sort,
    { date: 'date', number: 'number', total_paise: 'total_paise' },
    'kind, number, document_id',
  )
  const res = await runTabular<PurchaseRegisterRaw, GstTotalsRaw & { itc_paise: number }>(
    tx,
    { cte, order, totals },
    q,
  )
  const rows = res.rows.map((r) => ({
    ...r,
    taxable_paise: num(r.taxable_paise),
    igst_paise: num(r.igst_paise),
    cgst_paise: num(r.cgst_paise),
    sgst_paise: num(r.sgst_paise),
    cess_paise: num(r.cess_paise),
    other_charges_paise: num(r.other_charges_paise),
    total_paise: num(r.total_paise),
    itc_paise: num(r.itc_paise),
  }))
  const meta = reportMeta('purchase-register', env, scope, { from: range.from, to: range.to })
  return reportOutcome(
    tx,
    ctx,
    'purchase-register',
    q,
    {
      ...res,
      rows,
      totals: { ...gstTotals(res.totals), itc_paise: num(res.totals.itc_paise) },
    },
    meta,
    { from: range.from, to: range.to, gstin: q.gstin ?? null, store_id: scope.storeId },
  )
}
