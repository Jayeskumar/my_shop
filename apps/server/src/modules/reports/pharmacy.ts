/**
 * Pharmacy reports: the Schedule H1 register (Drugs and Cosmetics Rules — date, bill, patient,
 * prescriber with registration number, drug, batch, expiry, quantity) and the scheduled-drug
 * sales summary with prescription capture. The schedule of a line is the snapshot taken at
 * billing (sales_invoice_lines.meta.schedule), else the product's attributes.schedule ('OTC').
 */
import { sql } from 'kysely'
import type { z } from 'zod'
import type { DrugSchedule } from '@kadai/shared'
import {
  type H1RegisterQuerySchema,
  type H1RegisterResponse,
  type ScheduleSalesQuerySchema,
  type ScheduleSalesResponse,
} from '@kadai/shared/api/reports'
import type { Tx } from '../../db/tenant'
import {
  type Ctx,
  type ReportEnv,
  type ReportOutcome,
  type StoreScope,
  iso,
  likePattern,
  num,
  numOrNull,
  orderBy,
  reportMeta,
  reportOutcome,
  runTabular,
} from './common'
import { invoiceWhere, salesFactsCte } from './facts'

type Out<S extends z.ZodType> = z.output<S>

const UUID_RE = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

/** uuid of a jsonb text field, null when absent / malformed. */
const jsonUuid = (expr: string) =>
  sql.raw(`(case when (${expr}) ~ '${UUID_RE}' then (${expr})::uuid end)`)

interface H1Raw {
  date: string
  invoice_id: string
  invoice_number: string
  invoice_at: Date
  patient_name: string | null
  patient_age: string | null
  patient_address: string | null
  doctor_name: string | null
  doctor_reg_no: string | null
  product_id: string | null
  drug_name: string
  generic_name: string | null
  schedule: DrugSchedule
  batch_no: string | null
  expiry_date: string | null
  qty_milli: number
  unit: string
  pack_size: number
  prescription_file_id: string | null
  dispensed_by_name: string | null
}

export async function h1Register(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  scope: StoreScope,
  q: Out<typeof H1RegisterQuerySchema>,
): Promise<ReportOutcome<H1RegisterResponse>> {
  const schedules: DrugSchedule[] = q.schedule?.length ? [...new Set(q.schedule)] : ['H1']
  const search = q.q
    ? sql`(coalesce(patient_name, '') ilike ${likePattern(q.q)}
           or coalesce(doctor_name, '') ilike ${likePattern(q.q)}
           or drug_name ilike ${likePattern(q.q)}
           or coalesce(generic_name, '') ilike ${likePattern(q.q)}
           or invoice_number ilike ${likePattern(q.q)})`
    : sql`true`
  const cte = sql`with recursive
    lines as (
      select i.invoice_date as date, i.id as invoice_id, i.number as invoice_number, i.invoice_at,
             i.rx, coalesce(i.salesperson_id, i.created_by) as dispensed_by,
             l.line_no, l.product_id, coalesce(p.name, l.name) as drug_name,
             nullif(p.attributes ->> 'generic_name', '') as generic_name,
             coalesce(l.meta ->> 'schedule', p.attributes ->> 'schedule', 'OTC') as schedule,
             l.batch_id, (l.qty_milli + l.free_qty_milli)::bigint as qty_milli, l.unit, l.pack_size
        from sales_invoice_lines l
        join sales_invoices i on i.tenant_id = l.tenant_id and i.id = l.invoice_id
        left join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
       where l.tenant_id = ${ctx.tenantId} and ${invoiceWhere(ctx, { from: q.from, to: q.to, scope })}
    ),
    base as (
      select ln.date, ln.invoice_id, ln.invoice_number, ln.invoice_at, ln.line_no,
             nullif(ln.rx ->> 'patient_name', '') as patient_name,
             nullif(ln.rx ->> 'patient_age', '') as patient_age,
             nullif(ln.rx ->> 'patient_address', '') as patient_address,
             coalesce(nullif(ln.rx ->> 'doctor_name', ''), d.name) as doctor_name,
             coalesce(nullif(ln.rx ->> 'doctor_reg_no', ''), d.registration_no) as doctor_reg_no,
             ln.product_id, ln.drug_name, ln.generic_name, ln.schedule,
             b.batch_no, b.expiry_date, ln.qty_milli, ln.unit, ln.pack_size,
             ${jsonUuid("ln.rx ->> 'prescription_file_id'")} as prescription_file_id,
             u.full_name as dispensed_by_name
        from lines ln
        left join batches b on b.tenant_id = ${ctx.tenantId} and b.id = ln.batch_id
        left join doctors d on d.tenant_id = ${ctx.tenantId}
         and d.id = ${jsonUuid("ln.rx ->> 'doctor_id'")}
        left join users u on u.id = ln.dispensed_by
       where ln.schedule = any(${schedules}::text[])
    ),
    rows as (select * from base where ${search})`
  const totals = sql`select count(*)::bigint as entries,
      count(distinct invoice_id)::bigint as invoices,
      count(*) filter (where patient_name is null or doctor_name is null)::bigint as missing_rx
    from rows r`
  const order = orderBy(
    q.sort,
    { date: 'date', drug_name: 'lower(drug_name)', invoice_number: 'invoice_number' },
    'invoice_at, invoice_id, line_no',
  )
  const res = await runTabular<H1Raw, { entries: number; invoices: number; missing_rx: number }>(
    tx,
    { cte, order, totals },
    q,
  )
  const rows = res.rows.map((r) => ({
    date: r.date,
    invoice_id: r.invoice_id,
    invoice_number: r.invoice_number,
    invoice_at: iso(r.invoice_at),
    patient_name: r.patient_name,
    patient_age: r.patient_age,
    patient_address: r.patient_address,
    doctor_name: r.doctor_name,
    doctor_reg_no: r.doctor_reg_no,
    product_id: r.product_id,
    drug_name: r.drug_name,
    generic_name: r.generic_name,
    schedule: r.schedule,
    batch_no: r.batch_no,
    expiry_date: r.expiry_date,
    qty_milli: num(r.qty_milli),
    unit: r.unit,
    pack_size: num(r.pack_size),
    prescription_file_id: r.prescription_file_id,
    dispensed_by_name: r.dispensed_by_name,
  }))
  const totalsOut = {
    entries: num(res.totals.entries),
    invoices: num(res.totals.invoices),
    missing_rx: num(res.totals.missing_rx),
  }
  const meta = reportMeta('h1-register', env, scope, { from: q.from, to: q.to })
  return reportOutcome(tx, ctx, 'h1-register', q, { ...res, rows, totals: totalsOut }, meta, {
    from: q.from,
    to: q.to,
    schedule: schedules,
    store_id: scope.storeId,
  })
}

interface ScheduleRaw {
  schedule: DrugSchedule
  product_id: string | null
  name: string | null
  name_ta: string | null
  unit: string | null
  pack_size: number | null
  qty_milli: number | null
  bills: number
  net_sales_paise: number
  rx_captured: number
  rx_missing: number
}

export async function scheduleSales(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  scope: StoreScope,
  q: Out<typeof ScheduleSalesQuerySchema>,
): Promise<ReportOutcome<ScheduleSalesResponse>> {
  const schedules: DrugSchedule[] = q.schedule?.length ? [...new Set(q.schedule)] : ['H', 'H1', 'X']
  const byProduct = q.group_by === 'product'
  const cte = sql`with recursive ${salesFactsCte(ctx, { from: q.from, to: q.to, scope })},
    sf as (
      select ff.*, coalesce(ff.meta_schedule, ff.attributes ->> 'schedule', 'OTC') as schedule
        from ff
    ),
    rows as (
      select sf.schedule,
             ${byProduct ? sql`sf.product_id` : sql`null::uuid`} as product_id,
             ${byProduct ? sql`min(sf.name)` : sql`null::text`} as name,
             ${byProduct ? sql`min(sf.name_ta)` : sql`null::text`} as name_ta,
             ${byProduct ? sql`min(sf.unit)` : sql`null::text`} as unit,
             ${byProduct ? sql`min(sf.pack_size)` : sql`null::int`} as pack_size,
             ${
               byProduct
                 ? sql`sum(sf.qty_milli + sf.free_qty_milli - sf.returned_qty_milli)::bigint`
                 : sql`null::bigint`
             } as qty_milli,
             count(distinct sf.inv_id)::bigint as bills,
             coalesce(sum(sf.sales_paise - sf.returns_paise), 0)::bigint as net_sales_paise,
             count(distinct sf.inv_id) filter (where sf.rx_ok)::bigint as rx_captured,
             count(distinct sf.inv_id) filter (where not sf.rx_ok)::bigint as rx_missing
        from sf
       where sf.schedule = any(${schedules}::text[])
       group by sf.schedule${byProduct ? sql`, sf.product_id` : sql``}
    )`
  const totals = sql`select
      (select count(distinct inv_id) from sf where schedule = any(${schedules}::text[]))::bigint as bills,
      coalesce(sum(net_sales_paise), 0)::bigint as net_sales_paise,
      (select count(distinct inv_id) from sf
        where schedule = any(${schedules}::text[]) and rx_ok)::bigint as rx_captured,
      (select count(distinct inv_id) from sf
        where schedule = any(${schedules}::text[]) and not rx_ok)::bigint as rx_missing
    from rows r`
  const order = orderBy(
    q.sort,
    { net_sales_paise: 'net_sales_paise', bills: 'bills', name: 'lower(coalesce(name, schedule))' },
    'schedule, product_id nulls first',
  )
  const res = await runTabular<
    ScheduleRaw,
    { bills: number; net_sales_paise: number; rx_captured: number; rx_missing: number }
  >(tx, { cte, order, totals }, q)
  const rows = res.rows.map((r) => ({
    schedule: r.schedule,
    product_id: r.product_id,
    name: r.name,
    name_ta: r.name_ta,
    unit: r.unit,
    pack_size: numOrNull(r.pack_size),
    qty_milli: numOrNull(r.qty_milli),
    bills: num(r.bills),
    net_sales_paise: num(r.net_sales_paise),
    rx_captured: num(r.rx_captured),
    rx_missing: num(r.rx_missing),
  }))
  const totalsOut = {
    bills: num(res.totals.bills),
    net_sales_paise: num(res.totals.net_sales_paise),
    rx_captured: num(res.totals.rx_captured),
    rx_missing: num(res.totals.rx_missing),
  }
  const meta = reportMeta('schedule-sales', env, scope, {
    from: q.from,
    to: q.to,
    group_by: q.group_by,
  })
  return reportOutcome(tx, ctx, 'schedule-sales', q, { ...res, rows, totals: totalsOut }, meta, {
    from: q.from,
    to: q.to,
    schedule: schedules,
    store_id: scope.storeId,
  })
}
