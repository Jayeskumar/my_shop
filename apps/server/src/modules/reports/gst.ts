/**
 * GST returns (feature gst_reports, permission reports.gst).
 *
 *  - GSTR-1 for a period and registration (GSTIN): B2B (valid customer GSTIN), B2CL (inter-state
 *    unregistered invoices above B2CL_INVOICE_THRESHOLD_PAISE), B2CS (the rest, aggregated by
 *    supply type + place of supply + rate, net of their credit notes), CDNR / CDNUR, nil / exempt
 *    (0 % lines, reported as exempt), the Table-12 HSN summary split B2B / B2C, Table-13 documents
 *    issued (with cancelled numbers) and data warnings to fix before filing.
 *  - The GST offline-tool JSON / CSV export of that report (buildGstr1PortalJson / gstr1Csv;
 *    layout version GSTR1_PORTAL_SCHEMA_VERSION in the shared contract), audited.
 *  - GSTR-3B: 3.1, 3.2, 4 (ITC from posted purchase bills by received date and expenses, net of
 *    debit notes; blocked credit reversed in 4(B)(1)), 5 and 6.1 (utiliseItc, rule 88A).
 *  - Composition tenants get the CMP-08 quarterly summary; unregistered businesses file nothing.
 *
 * A registration covers the stores whose GSTIN (else the business GSTIN) is that GSTIN. Filing
 * figures must be complete, so the member needs access to every covered store.
 */
import { sql } from 'kysely'
import type { z } from 'zod'
import {
  GST_RATES_BP,
  UNITS,
  addDays,
  addMonths,
  fyOf,
  fyRange,
  isValidGstin,
  isValidStateCode,
  normalizeGstin,
  periodRange,
  periodToFp,
} from '@kadai/shared'
import { documentPath } from '@kadai/shared/api/identity'
import {
  B2CL_INVOICE_THRESHOLD_PAISE,
  COMPOSITION_TRADER_RATE_BP,
  type CompositionSummary,
  GST_DOC_TYPES,
  type GstPeriodQuerySchema,
  type GstRateItem,
  type GstWarning,
  type GstinOption,
  type Gstr1ExportQuerySchema,
  type Gstr1Report,
  type Gstr1Response,
  type Gstr3bReport,
  type Gstr3bResponse,
  type HsnRow,
  type TaxHeads,
  type TaxRow,
  buildGstr1PortalJson,
  compositionTax,
  gstQuarterOf,
  gstr1Csv,
  gstr1ExportFilename,
  gstr3bPayment,
} from '@kadai/shared/api/reports'
import { audit } from '../../core/audit'
import type { Tx } from '../../db/tenant'
import { type Ctx, type ReportEnv, type Sql, inStores, num, reasonError } from './common'

type Out<S extends z.ZodType> = z.output<S>

/** Aggregate turnover above which HSN codes need 6 digits (Notification 78/2020-CT). */
export const HSN_SIX_DIGIT_TURNOVER_PAISE = 5_00_00_000_00
const WARNINGS_PER_KIND = 200
const RATE_SET: ReadonlySet<number> = new Set(GST_RATES_BP)

// =============================================================================================
// Registration (GSTIN) and covered stores
// =============================================================================================

export interface Registration {
  /** '' when the business has no GSTIN at all. */
  gstin: string
  storeIds: string[]
  options: GstinOption[]
}

/**
 * The registration a GST report covers: `gstin` (must be one of the business's registrations →
 * 404 gstin_not_found), else the business GSTIN, else the first store registration. With
 * `requireAllStores` the member must see every covered store (403 all_stores_required).
 */
export async function resolveRegistration(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  gstin: string | undefined,
  opts: { requireAllStores: boolean },
): Promise<Registration> {
  const stores = await tx
    .selectFrom('stores')
    .select(['id', 'name', 'gstin'])
    .where('tenant_id', '=', ctx.tenantId)
    .orderBy('code')
    .execute()
  const effective = (s: { gstin: string | null }) =>
    (s.gstin ? normalizeGstin(s.gstin) : null) ??
    (env.tenant.gstin ? normalizeGstin(env.tenant.gstin) : null)
  const byGstin = new Map<string, GstinOption>()
  for (const s of stores) {
    const g = effective(s)
    if (!g) continue
    const opt = byGstin.get(g) ?? {
      gstin: g,
      state_code: g.slice(0, 2),
      store_ids: [],
      store_names: [],
    }
    opt.store_ids.push(s.id)
    opt.store_names.push(s.name)
    byGstin.set(g, opt)
  }
  const options = [...byGstin.values()]
  const wanted = gstin ? normalizeGstin(gstin) : null
  if (wanted && !byGstin.has(wanted)) {
    throw reasonError(
      'NOT_FOUND',
      'gstin_not_found',
      'This GSTIN is not registered for the business',
      {
        gstin: wanted,
      },
    )
  }
  const selected =
    wanted ??
    (env.tenant.gstin ? normalizeGstin(env.tenant.gstin) : null) ??
    options[0]?.gstin ??
    null
  const storeIds = selected
    ? (byGstin.get(selected)?.store_ids ?? [])
    : stores.filter((s) => effective(s) === null).map((s) => s.id)
  if (opts.requireAllStores && ctx.storeIds !== null) {
    const allowed = new Set(ctx.storeIds)
    if (storeIds.some((id) => !allowed.has(id))) {
      throw reasonError(
        'FORBIDDEN',
        'all_stores_required',
        'GST returns cover every store of the registration; you need access to all of them',
        { gstin: selected },
      )
    }
  }
  return { gstin: selected ?? '', storeIds, options }
}

function header(env: ReportEnv, period: string, reg: Registration) {
  return {
    period,
    fp: periodToFp(period),
    gstin: reg.gstin,
    legal_name: env.tenant.legal_name,
    trade_name: env.tenant.name,
    gstins: reg.options,
    store_ids: reg.storeIds,
    generated_at: env.generatedAt.toISOString(),
  }
}

// =============================================================================================
// Shared SQL
// =============================================================================================

/** unit code → GST UQC (shared units catalogue), as a VALUES CTE `uqc_map(code, uqc)`. */
export function uqcMapCte(): Sql {
  const values = sql.join(UNITS.map((u) => sql`(${u.code}::text, ${u.uqc}::text)`))
  return sql`uqc_map(code, uqc) as (values ${values})`
}

/**
 * Distinct customer GSTINs of the period's documents, split into valid (checksum) and invalid
 * raw values (as stored).
 */
async function customerGstins(
  tx: Tx,
  ctx: Ctx,
  from: string,
  to: string,
  storeIds: readonly string[] | null,
): Promise<{ valid: string[]; invalid: string[] }> {
  const res = await sql<{ g: string }>`
    select distinct i.customer_gstin as g from sales_invoices i
     where i.tenant_id = ${ctx.tenantId} and i.status = 'completed'
       and i.doc_type in ('tax_invoice', 'bill_of_supply')
       and i.invoice_date between ${from}::date and ${to}::date
       and ${inStores('i.store_id', { storeIds })}
       and nullif(trim(i.customer_gstin), '') is not null
    union
    select distinct c.customer_gstin from credit_notes c
     where c.tenant_id = ${ctx.tenantId} and c.status = 'completed'
       and c.note_date between ${from}::date and ${to}::date
       and ${inStores('c.store_id', { storeIds })}
       and nullif(trim(c.customer_gstin), '') is not null`.execute(tx)
  const valid: string[] = []
  const invalid: string[] = []
  for (const r of res.rows) (isValidGstin(normalizeGstin(r.g)) ? valid : invalid).push(r.g)
  return { valid, invalid }
}

/**
 * Classified documents and their lines for GSTR-1 / 3B / HSN:
 *   invc  completed invoices (b2b = valid customer GSTIN; b2cl = inter-state unregistered above
 *         the threshold);
 *   cnc   completed credit notes (b2b likewise; b2cl = against a B2CL invoice), with the original
 *         invoice number / date;
 *   gl    lines of both (sign −1 for credit notes) with rate, taxes, qty, unit, HSN.
 */
function gstDocsCte(
  ctx: Ctx,
  from: string,
  to: string,
  storeIds: readonly string[] | null,
  valid: string[],
): Sql {
  const isB2b = (col: string) => sql`coalesce(${sql.ref(col)} = any(${valid}::text[]), false)`
  return sql`invc as (
      select i.id, i.number, i.invoice_date, i.total_paise, i.place_of_supply, i.reverse_charge,
             i.is_interstate, i.customer_gstin, i.customer_name, i.customer_id, i.store_id,
             ${isB2b('i.customer_gstin')} as b2b,
             (not ${isB2b('i.customer_gstin')} and i.is_interstate
               and i.total_paise > ${B2CL_INVOICE_THRESHOLD_PAISE}) as b2cl
        from sales_invoices i
       where i.tenant_id = ${ctx.tenantId} and i.status = 'completed'
         and i.doc_type in ('tax_invoice', 'bill_of_supply')
         and i.invoice_date between ${from}::date and ${to}::date
         and ${inStores('i.store_id', { storeIds })}
    ),
    cnc as (
      select c.id, c.number, c.note_date, c.total_paise, c.place_of_supply, c.is_interstate,
             c.customer_gstin, c.customer_name, c.customer_id, c.invoice_id, c.store_id,
             ${isB2b('c.customer_gstin')} as b2b,
             (not ${isB2b('c.customer_gstin')}
               and coalesce(oi.is_interstate and oi.total_paise > ${B2CL_INVOICE_THRESHOLD_PAISE}
                            and not ${isB2b('oi.customer_gstin')}, false)) as b2cl,
             oi.number as original_invoice_number, oi.invoice_date as original_invoice_date
        from credit_notes c
        left join sales_invoices oi on oi.tenant_id = c.tenant_id and oi.id = c.invoice_id
       where c.tenant_id = ${ctx.tenantId} and c.status = 'completed'
         and c.note_date between ${from}::date and ${to}::date
         and ${inStores('c.store_id', { storeIds })}
    ),
    gl as (
      select 'inv'::text as kind, i.id as doc_id, i.b2b, i.b2cl, i.is_interstate, i.place_of_supply,
             1 as sign, l.gst_rate_bp as rate_bp, l.taxable_paise, l.cgst_paise, l.sgst_paise,
             l.igst_paise, l.cess_paise, (l.qty_milli + l.free_qty_milli)::bigint as qty_milli,
             upper(l.unit) as unit, coalesce(nullif(trim(l.hsn_code), ''), p.hsn_code) as hsn_code,
             l.product_id, l.name
        from invc i
        join sales_invoice_lines l on l.tenant_id = ${ctx.tenantId} and l.invoice_id = i.id
        left join products p on p.tenant_id = ${ctx.tenantId} and p.id = l.product_id
      union all
      select 'cn', c.id, c.b2b, c.b2cl, c.is_interstate, c.place_of_supply,
             -1, cl.gst_rate_bp, cl.taxable_paise, cl.cgst_paise, cl.sgst_paise,
             cl.igst_paise, cl.cess_paise, cl.qty_milli,
             upper(cl.unit), coalesce(nullif(trim(cl.hsn_code), ''), p.hsn_code),
             cl.product_id, cl.name
        from cnc c
        join credit_note_lines cl on cl.tenant_id = ${ctx.tenantId} and cl.credit_note_id = c.id
        left join products p on p.tenant_id = ${ctx.tenantId} and p.id = cl.product_id
    )`
}

const SIGNED_TAX_SQL = sql`
  coalesce(sum(sign * taxable_paise), 0)::bigint as taxable_paise,
  coalesce(sum(sign * igst_paise), 0)::bigint as igst_paise,
  coalesce(sum(sign * cgst_paise), 0)::bigint as cgst_paise,
  coalesce(sum(sign * sgst_paise), 0)::bigint as sgst_paise,
  coalesce(sum(sign * cess_paise), 0)::bigint as cess_paise`

interface TaxRaw {
  taxable_paise: number
  igst_paise: number
  cgst_paise: number
  sgst_paise: number
  cess_paise: number
}

function taxRow(r: Partial<TaxRaw> | undefined): TaxRow {
  return {
    taxable_paise: num(r?.taxable_paise),
    igst_paise: num(r?.igst_paise),
    cgst_paise: num(r?.cgst_paise),
    sgst_paise: num(r?.sgst_paise),
    cess_paise: num(r?.cess_paise),
  }
}

function heads(r: Partial<TaxRaw> | undefined): TaxHeads {
  const t = taxRow(r)
  return {
    igst_paise: t.igst_paise,
    cgst_paise: t.cgst_paise,
    sgst_paise: t.sgst_paise,
    cess_paise: t.cess_paise,
  }
}

const ZERO_HEADS: TaxHeads = { igst_paise: 0, cgst_paise: 0, sgst_paise: 0, cess_paise: 0 }
const ZERO_ROW: TaxRow = { taxable_paise: 0, ...ZERO_HEADS }

function addHeads(a: TaxHeads, b: TaxHeads, sign = 1): TaxHeads {
  return {
    igst_paise: a.igst_paise + sign * b.igst_paise,
    cgst_paise: a.cgst_paise + sign * b.cgst_paise,
    sgst_paise: a.sgst_paise + sign * b.sgst_paise,
    cess_paise: a.cess_paise + sign * b.cess_paise,
  }
}

const taxOf = (t: TaxHeads) => t.igst_paise + t.cgst_paise + t.sgst_paise + t.cess_paise

// =============================================================================================
// Warnings
// =============================================================================================

function warning(
  code: GstWarning['code'],
  severity: GstWarning['severity'],
  section: string | null,
  ref: { type: GstWarning['ref_type']; id: string | null; label: string | null },
  details: GstWarning['details'] = {},
): GstWarning {
  const path =
    ref.type === 'tenant'
      ? '/settings/business'
      : ref.type === 'expense'
        ? ref.id
          ? `/accounting/expenses?id=${encodeURIComponent(ref.id)}`
          : null
        : documentPath(ref.type, ref.id)
  return {
    code,
    severity,
    section,
    ref_type: ref.type,
    ref_id: ref.id,
    label: ref.label,
    path,
    details,
  }
}

function businessGstinWarning(reg: Registration): GstWarning[] {
  return reg.gstin
    ? []
    : [warning('business_gstin_missing', 'error', null, { type: 'tenant', id: null, label: null })]
}

/** Previous-FY aggregate turnover of the registration (taxable value net of credit notes). */
async function previousFyTurnover(
  tx: Tx,
  ctx: Ctx,
  period: string,
  storeIds: string[],
): Promise<number> {
  const current = fyRange(fyOf(periodRange(period).from, 4), 4)
  const prev = { from: addMonths(current.from, -12), to: addDays(current.from, -1) }
  const res = await sql<{ t: number }>`
    select (coalesce((select sum(i.taxable_paise) from sales_invoices i
                       where i.tenant_id = ${ctx.tenantId} and i.status = 'completed'
                         and i.doc_type in ('tax_invoice', 'bill_of_supply')
                         and i.invoice_date between ${prev.from}::date and ${prev.to}::date
                         and i.store_id = any(${storeIds}::uuid[])), 0)
          - coalesce((select sum(c.taxable_paise) from credit_notes c
                       where c.tenant_id = ${ctx.tenantId} and c.status = 'completed'
                         and c.note_date between ${prev.from}::date and ${prev.to}::date
                         and c.store_id = any(${storeIds}::uuid[])), 0))::bigint as t`.execute(tx)
  return num(res.rows[0]?.t)
}

async function gstr1Warnings(
  tx: Tx,
  ctx: Ctx,
  docs: Sql,
  invalidGstins: string[],
  sixDigitHsn: boolean,
): Promise<GstWarning[]> {
  const out: GstWarning[] = []
  if (invalidGstins.length) {
    const bad = await sql<{ kind: 'inv' | 'cn'; id: string; number: string; gstin: string }>`
      with recursive ${docs}
      select 'inv' as kind, id, number, customer_gstin as gstin from invc
       where customer_gstin = any(${invalidGstins}::text[])
      union all
      select 'cn', id, number, customer_gstin from cnc where customer_gstin = any(${invalidGstins}::text[])
      order by 3 limit ${WARNINGS_PER_KIND}`.execute(tx)
    for (const r of bad.rows) {
      out.push(
        warning(
          'invalid_customer_gstin',
          'warning',
          r.kind === 'inv' ? 'b2b' : 'cdnr',
          { type: r.kind === 'inv' ? 'sales_invoice' : 'credit_note', id: r.id, label: r.number },
          { gstin: r.gstin },
        ),
      )
    }
  }
  // A registered customer (GSTIN on the customer) billed without the GSTIN → reported as B2C.
  const missing = await sql<{ kind: 'inv' | 'cn'; id: string; number: string; gstin: string }>`
    with recursive ${docs}
    select 'inv' as kind, d.id, d.number, cu.gstin from invc d
      join customers cu on cu.tenant_id = ${ctx.tenantId} and cu.id = d.customer_id
     where nullif(trim(d.customer_gstin), '') is null and cu.gstin is not null
    union all
    select 'cn', d.id, d.number, cu.gstin from cnc d
      join customers cu on cu.tenant_id = ${ctx.tenantId} and cu.id = d.customer_id
     where nullif(trim(d.customer_gstin), '') is null and cu.gstin is not null
     order by 3 limit ${WARNINGS_PER_KIND}`.execute(tx)
  for (const r of missing.rows) {
    out.push(
      warning(
        'invalid_customer_gstin',
        'warning',
        r.kind === 'inv' ? 'b2b' : 'cdnr',
        { type: r.kind === 'inv' ? 'sales_invoice' : 'credit_note', id: r.id, label: r.number },
        { gstin: null, customer_gstin: r.gstin },
      ),
    )
  }
  const hsn = await sql<{
    product_id: string | null
    name: string
    hsn_code: string | null
    doc_id: string
    kind: 'inv' | 'cn'
    problem: 'missing_hsn' | 'invalid_hsn' | 'hsn_too_short'
  }>`
    with recursive ${docs},
    probs as (
      select gl.product_id, gl.name, gl.hsn_code, gl.doc_id, gl.kind,
             case when gl.hsn_code is null then 'missing_hsn'
                  when gl.hsn_code !~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$' then 'invalid_hsn'
                  when ${sixDigitHsn} and length(gl.hsn_code) < 6 then 'hsn_too_short' end as problem
        from gl
    )
    select distinct on (problem, coalesce(product_id::text, name))
           product_id, name, hsn_code, doc_id, kind, problem
      from probs where problem is not null
     order by problem, coalesce(product_id::text, name), doc_id
     limit ${WARNINGS_PER_KIND * 3}`.execute(tx)
  for (const r of hsn.rows) {
    const ref = r.product_id
      ? { type: 'product' as const, id: r.product_id, label: r.name }
      : {
          type: r.kind === 'inv' ? ('sales_invoice' as const) : ('credit_note' as const),
          id: r.doc_id,
          label: r.name,
        }
    out.push(warning(r.problem, 'error', 'hsn', ref, { hsn_code: r.hsn_code }))
  }
  const rates = await sql<{
    product_id: string | null
    name: string
    rate_bp: number
    doc_id: string
    kind: 'inv' | 'cn'
  }>`
    with recursive ${docs}
    select distinct on (rate_bp, coalesce(product_id::text, name))
           product_id, name, rate_bp, doc_id, kind
      from gl where not (rate_bp = any(${[...RATE_SET]}::int[]))
     order by rate_bp, coalesce(product_id::text, name), doc_id
     limit ${WARNINGS_PER_KIND}`.execute(tx)
  for (const r of rates.rows) {
    const ref = r.product_id
      ? { type: 'product' as const, id: r.product_id, label: r.name }
      : {
          type: r.kind === 'inv' ? ('sales_invoice' as const) : ('credit_note' as const),
          id: r.doc_id,
          label: r.name,
        }
    out.push(warning('invalid_gst_rate', 'error', null, ref, { rate_bp: num(r.rate_bp) }))
  }
  // Place of supply: validate the distinct codes, then list the documents with a bad one.
  const posValues = await sql<{ pos: string | null }>`
    with recursive ${docs}
    select distinct place_of_supply as pos from invc
    union select distinct place_of_supply from cnc`.execute(tx)
  const badPos = posValues.rows.map((r) => r.pos ?? '').filter((v) => !isValidStateCode(v))
  if (badPos.length) {
    const bad = await sql<{ kind: 'inv' | 'cn'; id: string; number: string; pos: string | null }>`
      with recursive ${docs}
      select 'inv' as kind, id, number, place_of_supply as pos from invc
       where coalesce(place_of_supply, '') = any(${badPos}::text[])
      union all
      select 'cn', id, number, place_of_supply from cnc
       where coalesce(place_of_supply, '') = any(${badPos}::text[])
      order by 3 limit ${WARNINGS_PER_KIND}`.execute(tx)
    for (const r of bad.rows) {
      const ref = {
        type: r.kind === 'inv' ? ('sales_invoice' as const) : ('credit_note' as const),
        id: r.id,
        label: r.number,
      }
      out.push(
        r.pos
          ? warning('invalid_place_of_supply', 'error', null, ref, { place_of_supply: r.pos })
          : warning('missing_place_of_supply', 'error', null, ref),
      )
    }
  }
  const orphan = await sql<{ id: string; number: string }>`
    with recursive ${docs}
    select id, number from cnc where b2b and invoice_id is null order by number
     limit ${WARNINGS_PER_KIND}`.execute(tx)
  for (const r of orphan.rows) {
    out.push(
      warning('credit_note_without_invoice', 'warning', 'cdnr', {
        type: 'credit_note',
        id: r.id,
        label: r.number,
      }),
    )
  }
  return out
}

// =============================================================================================
// GSTR-1
// =============================================================================================

interface DocItemRaw extends TaxRaw {
  doc_id: string
  number: string
  date: string
  value_paise: number
  place_of_supply: string
  reverse_charge: boolean
  ctin: string | null
  customer_name: string | null
  b2b: boolean
  rate_bp: number
  original_invoice_number?: string | null
  original_invoice_date?: string | null
}

function rateItem(r: DocItemRaw): GstRateItem {
  return { rate_bp: num(r.rate_bp), ...taxRow(r) }
}

/** Groups (document × rate) rows into documents with their rate items, in row order. */
function groupDocs<T extends DocItemRaw>(rows: T[]): Array<{ first: T; items: GstRateItem[] }> {
  const map = new Map<string, { first: T; items: GstRateItem[] }>()
  for (const r of rows) {
    const d = map.get(r.doc_id) ?? { first: r, items: [] }
    d.items.push(rateItem(r))
    map.set(r.doc_id, d)
  }
  return [...map.values()]
}

function sumItems(items: readonly GstRateItem[]): TaxRow {
  return items.reduce<TaxRow>(
    (a, it) => ({
      taxable_paise: a.taxable_paise + it.taxable_paise,
      igst_paise: a.igst_paise + it.igst_paise,
      cgst_paise: a.cgst_paise + it.cgst_paise,
      sgst_paise: a.sgst_paise + it.sgst_paise,
      cess_paise: a.cess_paise + it.cess_paise,
    }),
    { ...ZERO_ROW },
  )
}

export async function buildGstr1(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  period: string,
  reg: Registration,
): Promise<Gstr1Report> {
  const { from, to } = periodRange(period)
  const storeIds = reg.storeIds
  const gstins = await customerGstins(tx, ctx, from, to, storeIds)
  const docs = gstDocsCte(ctx, from, to, storeIds, gstins.valid)

  // ---- B2B / B2CL invoices (document-wise, items by rate; 0 % lines go to NIL) --------------
  const invRows = await sql<DocItemRaw & { b2cl: boolean }>`
    with recursive ${docs}
    select i.id as doc_id, i.number, i.invoice_date as date, i.total_paise as value_paise,
           i.place_of_supply, i.reverse_charge, upper(trim(i.customer_gstin)) as ctin,
           i.customer_name, i.b2b, i.b2cl, gl.rate_bp,
           sum(gl.taxable_paise)::bigint as taxable_paise, sum(gl.igst_paise)::bigint as igst_paise,
           sum(gl.cgst_paise)::bigint as cgst_paise, sum(gl.sgst_paise)::bigint as sgst_paise,
           sum(gl.cess_paise)::bigint as cess_paise
      from invc i join gl on gl.kind = 'inv' and gl.doc_id = i.id
     where (i.b2b or i.b2cl) and gl.rate_bp > 0
     group by i.id, i.number, i.invoice_date, i.total_paise, i.place_of_supply, i.reverse_charge,
              i.customer_gstin, i.customer_name, i.b2b, i.b2cl, gl.rate_bp
     order by i.invoice_date, i.number, gl.rate_bp`.execute(tx)
  const b2bMap = new Map<string, Gstr1Report['b2b'][number]>()
  const b2clMap = new Map<string, Gstr1Report['b2cl'][number]>()
  for (const d of groupDocs(invRows.rows)) {
    const r = d.first
    const invoice = {
      invoice_id: r.doc_id,
      number: r.number,
      date: r.date,
      value_paise: num(r.value_paise),
      place_of_supply: r.place_of_supply,
      reverse_charge: r.reverse_charge,
      invoice_type: 'R' as const,
      customer_name: r.customer_name,
      items: d.items,
    }
    if (r.b2b) {
      const ctin = r.ctin ?? ''
      const party = b2bMap.get(ctin) ?? { ctin, receiver_name: r.customer_name, invoices: [] }
      party.invoices.push(invoice)
      b2bMap.set(ctin, party)
    } else {
      const party = b2clMap.get(r.place_of_supply) ?? {
        place_of_supply: r.place_of_supply,
        invoices: [],
      }
      party.invoices.push(invoice)
      b2clMap.set(r.place_of_supply, party)
    }
  }
  const b2b = [...b2bMap.values()].sort((a, b) => a.ctin.localeCompare(b.ctin))
  const b2cl = [...b2clMap.values()].sort((a, b) =>
    a.place_of_supply.localeCompare(b.place_of_supply),
  )

  // ---- CDNR / CDNUR ----------------------------------------------------------------------
  const noteRows = await sql<DocItemRaw & { b2cl: boolean }>`
    with recursive ${docs}
    select c.id as doc_id, c.number, c.note_date as date, c.total_paise as value_paise,
           c.place_of_supply, false as reverse_charge, upper(trim(c.customer_gstin)) as ctin,
           c.customer_name, c.b2b, c.b2cl, c.original_invoice_number, c.original_invoice_date,
           gl.rate_bp,
           sum(gl.taxable_paise)::bigint as taxable_paise, sum(gl.igst_paise)::bigint as igst_paise,
           sum(gl.cgst_paise)::bigint as cgst_paise, sum(gl.sgst_paise)::bigint as sgst_paise,
           sum(gl.cess_paise)::bigint as cess_paise
      from cnc c join gl on gl.kind = 'cn' and gl.doc_id = c.id
     where (c.b2b or c.b2cl) and gl.rate_bp > 0
     group by c.id, c.number, c.note_date, c.total_paise, c.place_of_supply, c.customer_gstin,
              c.customer_name, c.b2b, c.b2cl, c.original_invoice_number, c.original_invoice_date,
              gl.rate_bp
     order by c.note_date, c.number, gl.rate_bp`.execute(tx)
  const cdnrMap = new Map<string, Gstr1Report['cdnr'][number]>()
  const cdnur: Gstr1Report['cdnur'] = []
  for (const d of groupDocs(noteRows.rows)) {
    const r = d.first
    const note = {
      credit_note_id: r.doc_id,
      number: r.number,
      date: r.date,
      note_type: 'C' as const,
      value_paise: num(r.value_paise),
      place_of_supply: r.place_of_supply,
      reverse_charge: false,
      original_invoice_number: r.original_invoice_number ?? null,
      original_invoice_date: r.original_invoice_date ?? null,
      customer_name: r.customer_name,
      items: d.items,
    }
    if (r.b2b) {
      const ctin = r.ctin ?? ''
      const party = cdnrMap.get(ctin) ?? { ctin, receiver_name: r.customer_name, notes: [] }
      party.notes.push(note)
      cdnrMap.set(ctin, party)
    } else {
      cdnur.push({ ...note, type: 'B2CL' as const })
    }
  }
  const cdnr = [...cdnrMap.values()].sort((a, b) => a.ctin.localeCompare(b.ctin))

  // ---- B2CS (net of their credit notes) ----------------------------------------------------
  const b2csRows = await sql<TaxRaw & { inter: boolean; place_of_supply: string; rate_bp: number }>`
    with recursive ${docs}
    select is_interstate as inter, place_of_supply, rate_bp, ${SIGNED_TAX_SQL}
      from gl where not b2b and not b2cl and rate_bp > 0
     group by is_interstate, place_of_supply, rate_bp
     order by is_interstate, place_of_supply, rate_bp`.execute(tx)
  const b2cs: Gstr1Report['b2cs'] = b2csRows.rows.map((r) => ({
    supply_type: r.inter ? ('INTER' as const) : ('INTRA' as const),
    place_of_supply: r.place_of_supply,
    rate_bp: num(r.rate_bp),
    type: 'OE' as const,
    ...taxRow(r),
  }))

  // ---- NIL (0 % lines as exempt) -------------------------------------------------------------
  const nilRows = await sql<{ b2b: boolean; inter: boolean; amount: number }>`
    with recursive ${docs}
    select b2b, is_interstate as inter, coalesce(sum(sign * taxable_paise), 0)::bigint as amount
      from gl where rate_bp = 0 group by b2b, is_interstate`.execute(tx)
  const nilOf = (b2bFlag: boolean, inter: boolean) => {
    const amount = num(nilRows.rows.find((r) => r.b2b === b2bFlag && r.inter === inter)?.amount)
    return { nil_rated_paise: 0, exempt_paise: amount, non_gst_paise: 0 }
  }
  const nil = {
    inter_b2b: nilOf(true, true),
    intra_b2b: nilOf(true, false),
    inter_b2c: nilOf(false, true),
    intra_b2c: nilOf(false, false),
  }

  // ---- HSN (Table 12, split B2B / B2C) -----------------------------------------------------------
  const hsnRows = await hsnAggregate(tx, docs)
  const hsn = {
    b2b: hsnRows.filter((r) => r.supply === 'b2b').map(stripSupply),
    b2c: hsnRows.filter((r) => r.supply === 'b2c').map(stripSupply),
  }

  // ---- Documents issued (Table 13) ---------------------------------------------------------------
  const docRows = await sql<{
    doc_num: 1 | 5
    prefix: string
    total: number
    cancelled: number
    from_no: string
    to_no: string
  }>`
    with d as (
      select 1 as doc_num, i.number, i.status, substring(i.number from '[0-9]+$')::numeric as seq
        from sales_invoices i
       where i.tenant_id = ${ctx.tenantId} and i.status in ('completed', 'cancelled')
         and i.doc_type in ('tax_invoice', 'bill_of_supply') and i.number is not null
         and i.invoice_date between ${from}::date and ${to}::date
         and i.store_id = any(${storeIds}::uuid[])
      union all
      select 5, c.number, c.status, substring(c.number from '[0-9]+$')::numeric
        from credit_notes c
       where c.tenant_id = ${ctx.tenantId} and c.status in ('completed', 'cancelled')
         and c.note_date between ${from}::date and ${to}::date
         and c.store_id = any(${storeIds}::uuid[])
    )
    select doc_num, regexp_replace(number, '[0-9]+$', '') as prefix, count(*)::bigint as total,
           count(*) filter (where status = 'cancelled')::bigint as cancelled,
           (array_agg(number order by seq nulls first, number))[1] as from_no,
           (array_agg(number order by seq desc nulls last, number desc))[1] as to_no
      from d group by doc_num, regexp_replace(number, '[0-9]+$', '')
     order by doc_num, prefix`.execute(tx)
  const docIssue: Gstr1Report['doc_issue'] = ([1, 5] as const).map((docNum) => ({
    doc_num: docNum,
    doc_type: GST_DOC_TYPES[docNum],
    series: docRows.rows
      .filter((r) => num(r.doc_num) === docNum)
      .map((r) => ({
        prefix: r.prefix,
        from: r.from_no,
        to: r.to_no,
        total: num(r.total),
        cancelled: num(r.cancelled),
        net_issued: num(r.total) - num(r.cancelled),
      })),
  }))

  // ---- warnings ------------------------------------------------------------------------------
  const sixDigit =
    storeIds.length > 0 &&
    (await previousFyTurnover(tx, ctx, period, storeIds)) > HSN_SIX_DIGIT_TURNOVER_PAISE
  const warnings = [
    ...businessGstinWarning(reg),
    ...(storeIds.length ? await gstr1Warnings(tx, ctx, docs, gstins.invalid, sixDigit) : []),
  ]

  // ---- section summary -----------------------------------------------------------------------
  const invoicesOf = <T extends { invoices: Gstr1Report['b2b'][number]['invoices'] }>(xs: T[]) =>
    xs.flatMap((x) => x.invoices)
  const docSummary = (
    section: Gstr1Report['summary'][number]['section'],
    list: Array<{ value_paise: number; items: GstRateItem[] }>,
  ) => ({
    section,
    count: list.length,
    value_paise: list.reduce((s, d) => s + d.value_paise, 0),
    ...sumItems(list.flatMap((d) => d.items)),
  })
  const rowSummary = (
    section: Gstr1Report['summary'][number]['section'],
    rows: TaxRow[],
    values: number[],
  ) => ({
    section,
    count: rows.length,
    value_paise: values.reduce((s, v) => s + v, 0),
    ...rows.reduce<TaxRow>(
      (a, r) => ({
        taxable_paise: a.taxable_paise + r.taxable_paise,
        igst_paise: a.igst_paise + r.igst_paise,
        cgst_paise: a.cgst_paise + r.cgst_paise,
        sgst_paise: a.sgst_paise + r.sgst_paise,
        cess_paise: a.cess_paise + r.cess_paise,
      }),
      { ...ZERO_ROW },
    ),
  })
  const nilList = [nil.inter_b2b, nil.intra_b2b, nil.inter_b2c, nil.intra_b2c].filter(
    (n) => n.exempt_paise !== 0,
  )
  const summary: Gstr1Report['summary'] = [
    docSummary('b2b', invoicesOf(b2b)),
    docSummary('b2cl', invoicesOf(b2cl)),
    rowSummary(
      'b2cs',
      b2cs,
      b2cs.map((r) => r.taxable_paise + taxOf(r)),
    ),
    docSummary(
      'cdnr',
      cdnr.flatMap((p) => p.notes),
    ),
    docSummary('cdnur', cdnur),
    {
      section: 'nil',
      count: nilList.length,
      value_paise: nilList.reduce((s, n) => s + n.exempt_paise, 0),
      taxable_paise: nilList.reduce((s, n) => s + n.exempt_paise, 0),
      ...ZERO_HEADS,
    },
    rowSummary(
      'hsn_b2b',
      hsn.b2b,
      hsn.b2b.map((r) => r.total_value_paise),
    ),
    rowSummary(
      'hsn_b2c',
      hsn.b2c,
      hsn.b2c.map((r) => r.total_value_paise),
    ),
    {
      section: 'doc_issue',
      count: docIssue.reduce((s, d) => s + d.series.reduce((x, r) => x + r.net_issued, 0), 0),
      value_paise: 0,
      ...ZERO_ROW,
    },
  ]

  return {
    kind: 'gstr1',
    ...header(env, period, reg),
    summary,
    b2b,
    b2cl,
    b2cs,
    cdnr,
    cdnur,
    nil,
    hsn,
    doc_issue: docIssue,
    warnings,
  }
}

type HsnAggRow = HsnRow & { supply: 'b2b' | 'b2c' }

function stripSupply(r: HsnAggRow): HsnRow {
  const { supply: _omit, ...rest } = r
  return rest
}

interface HsnRaw extends TaxRaw {
  supply: 'b2b' | 'b2c'
  hsn_code: string | null
  uqc: string
  qty_milli: number
  rate_bp: number
  total_value_paise: number
}

const HSN_GROUP_SQL = sql`
  select case when gl.b2b then 'b2b' else 'b2c' end as supply, gl.hsn_code,
         null::text as description, coalesce(um.uqc, 'OTH') as uqc,
         coalesce(sum(gl.sign * gl.qty_milli), 0)::bigint as qty_milli, gl.rate_bp,
         coalesce(sum(gl.sign * gl.taxable_paise), 0)::bigint as taxable_paise,
         coalesce(sum(gl.sign * gl.igst_paise), 0)::bigint as igst_paise,
         coalesce(sum(gl.sign * gl.cgst_paise), 0)::bigint as cgst_paise,
         coalesce(sum(gl.sign * gl.sgst_paise), 0)::bigint as sgst_paise,
         coalesce(sum(gl.sign * gl.cess_paise), 0)::bigint as cess_paise,
         coalesce(sum(gl.sign * (gl.taxable_paise + gl.igst_paise + gl.cgst_paise + gl.sgst_paise
                                 + gl.cess_paise)), 0)::bigint as total_value_paise
    from gl left join uqc_map um on um.code = gl.unit
   group by 1, gl.hsn_code, 4, gl.rate_bp
  having sum(gl.sign * gl.qty_milli) <> 0 or sum(gl.sign * gl.taxable_paise) <> 0
      or sum(gl.sign * (gl.igst_paise + gl.cgst_paise + gl.sgst_paise + gl.cess_paise)) <> 0`

/** HSN rows (supply × HSN × UQC × rate) of the classified documents. */
async function hsnAggregate(tx: Tx, docs: Sql): Promise<HsnAggRow[]> {
  const res = await sql<HsnRaw>`
    with recursive ${docs}, ${uqcMapCte()}
    ${HSN_GROUP_SQL}
    order by 1, 2 nulls last, 4, 6`.execute(tx)
  return res.rows.map((r) => ({
    supply: r.supply,
    hsn_code: r.hsn_code,
    description: null,
    uqc: r.uqc,
    qty_milli: num(r.qty_milli),
    rate_bp: num(r.rate_bp),
    ...taxRow(r),
    total_value_paise: num(r.total_value_paise),
  }))
}

// =============================================================================================
// Composition (CMP-08 / GSTR-4 style)
// =============================================================================================

const QUARTER_SQL = (col: string) =>
  sql.raw(`(case when extract(month from ${col}) between 4 and 6 then 'Q1'
                 when extract(month from ${col}) between 7 and 9 then 'Q2'
                 when extract(month from ${col}) between 10 and 12 then 'Q3' else 'Q4' end)`)

export async function buildComposition(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  period: string,
  reg: Registration,
): Promise<CompositionSummary> {
  const fy = fyOf(periodRange(period).from, 4)
  const range = fyRange(fy, 4)
  const storeIds = reg.storeIds
  const res = await sql<{
    q: 'Q1' | 'Q2' | 'Q3' | 'Q4'
    bills: number
    outward: number
    exempt: number
    rcm_taxable: number
    rcm_tax: number
  }>`
    with inv as (
      select ${QUARTER_SQL('i.invoice_date')} as q, i.id, i.taxable_paise
        from sales_invoices i
       where i.tenant_id = ${ctx.tenantId} and i.status = 'completed'
         and i.doc_type in ('tax_invoice', 'bill_of_supply')
         and i.invoice_date between ${range.from}::date and ${range.to}::date
         and i.store_id = any(${storeIds}::uuid[])
    ),
    cn as (
      select ${QUARTER_SQL('c.note_date')} as q, c.id, c.taxable_paise
        from credit_notes c
       where c.tenant_id = ${ctx.tenantId} and c.status = 'completed'
         and c.note_date between ${range.from}::date and ${range.to}::date
         and c.store_id = any(${storeIds}::uuid[])
    ),
    ex as (
      select inv.q, l.taxable_paise as amount
        from inv join sales_invoice_lines l on l.tenant_id = ${ctx.tenantId} and l.invoice_id = inv.id
        join products p on p.tenant_id = ${ctx.tenantId} and p.id = l.product_id
       where p.gst_rate_bp = 0
      union all
      select cn.q, -cl.taxable_paise
        from cn join credit_note_lines cl on cl.tenant_id = ${ctx.tenantId} and cl.credit_note_id = cn.id
        join products p on p.tenant_id = ${ctx.tenantId} and p.id = cl.product_id
       where p.gst_rate_bp = 0
    ),
    rcm as (
      select ${QUARTER_SQL('b.received_date')} as q, b.taxable_paise,
             (b.cgst_paise + b.sgst_paise + b.igst_paise + b.cess_paise) as tax
        from purchase_bills b
       where b.tenant_id = ${ctx.tenantId} and b.status = 'posted' and b.reverse_charge
         and b.received_date between ${range.from}::date and ${range.to}::date
         and b.store_id = any(${storeIds}::uuid[])
    ),
    qs(q) as (values ('Q1'), ('Q2'), ('Q3'), ('Q4'))
    select qs.q,
           (select count(*) from inv where inv.q = qs.q)::bigint as bills,
           (coalesce((select sum(taxable_paise) from inv where inv.q = qs.q), 0)
             - coalesce((select sum(taxable_paise) from cn where cn.q = qs.q), 0))::bigint as outward,
           coalesce((select sum(amount) from ex where ex.q = qs.q), 0)::bigint as exempt,
           coalesce((select sum(taxable_paise) from rcm where rcm.q = qs.q), 0)::bigint as rcm_taxable,
           coalesce((select sum(tax) from rcm where rcm.q = qs.q), 0)::bigint as rcm_tax
      from qs order by qs.q`.execute(tx)
  const startYear = Number(range.from.slice(0, 4))
  const quarterRange = (q: 'Q1' | 'Q2' | 'Q3' | 'Q4') => {
    const start = {
      Q1: `${startYear}-04-01`,
      Q2: `${startYear}-07-01`,
      Q3: `${startYear}-10-01`,
      Q4: `${startYear + 1}-01-01`,
    }[q]
    const end = {
      Q1: `${startYear}-06-30`,
      Q2: `${startYear}-09-30`,
      Q3: `${startYear}-12-31`,
      Q4: `${startYear + 1}-03-31`,
    }[q]
    return { from: start, to: end }
  }
  const quarters = res.rows.map((r) => {
    const outward = num(r.outward)
    const taxable = outward - num(r.exempt)
    const tax = compositionTax(taxable, COMPOSITION_TRADER_RATE_BP)
    return {
      quarter: r.q,
      ...quarterRange(r.q),
      bills: num(r.bills),
      outward_turnover_paise: outward,
      taxable_turnover_paise: taxable,
      cgst_paise: tax.cgst_paise,
      sgst_paise: tax.sgst_paise,
      inward_rcm_taxable_paise: num(r.rcm_taxable),
      inward_rcm_tax_paise: num(r.rcm_tax),
    }
  })
  return {
    kind: 'composition',
    ...header(env, period, reg),
    fy,
    rate_bp: COMPOSITION_TRADER_RATE_BP,
    quarter: gstQuarterOf(period),
    quarters,
    warnings: businessGstinWarning(reg),
  }
}

// =============================================================================================
// GSTR-3B
// =============================================================================================

export async function buildGstr3b(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  period: string,
  reg: Registration,
): Promise<Gstr3bReport> {
  const { from, to } = periodRange(period)
  const storeIds = reg.storeIds
  const gstins = await customerGstins(tx, ctx, from, to, storeIds)
  const docs = gstDocsCte(ctx, from, to, storeIds, gstins.valid)

  // 3.1 (a) taxable / (c) nil-exempt outward supplies, net of credit notes.
  const outward = await sql<TaxRaw & { taxed: boolean }>`
    with recursive ${docs}
    select rate_bp > 0 as taxed, ${SIGNED_TAX_SQL} from gl group by rate_bp > 0`.execute(tx)
  const taxed = taxRow(outward.rows.find((r) => r.taxed))
  const nilExempt = taxRow(outward.rows.find((r) => !r.taxed))

  // 3.2 inter-state supplies to unregistered persons, by place of supply.
  const inter = await sql<{ place_of_supply: string; taxable_paise: number; igst_paise: number }>`
    with recursive ${docs}
    select place_of_supply, coalesce(sum(sign * taxable_paise), 0)::bigint as taxable_paise,
           coalesce(sum(sign * igst_paise), 0)::bigint as igst_paise
      from gl where not b2b and is_interstate and rate_bp > 0
     group by place_of_supply order by place_of_supply`.execute(tx)

  // Inward: posted bills by received date, debit notes by note date, expenses with GST.
  const bills = await sql<TaxRaw & { rcm: boolean; itc: boolean; n: number }>`
    select b.reverse_charge as rcm, b.itc_eligible as itc, count(*)::bigint as n,
           coalesce(sum(b.taxable_paise), 0)::bigint as taxable_paise,
           coalesce(sum(b.igst_paise), 0)::bigint as igst_paise,
           coalesce(sum(b.cgst_paise), 0)::bigint as cgst_paise,
           coalesce(sum(b.sgst_paise), 0)::bigint as sgst_paise,
           coalesce(sum(b.cess_paise), 0)::bigint as cess_paise
      from purchase_bills b
     where b.tenant_id = ${ctx.tenantId} and b.status = 'posted'
       and b.received_date between ${from}::date and ${to}::date
       and b.store_id = any(${storeIds}::uuid[])
     group by 1, 2`.execute(tx)
  const debits = await sql<TaxRaw & { rcm: boolean; itc: boolean; n: number }>`
    select coalesce(b.reverse_charge, false) as rcm, coalesce(b.itc_eligible, true) as itc,
           count(*)::bigint as n,
           coalesce(sum(d.taxable_paise), 0)::bigint as taxable_paise,
           coalesce(sum(d.igst_paise), 0)::bigint as igst_paise,
           coalesce(sum(d.cgst_paise), 0)::bigint as cgst_paise,
           coalesce(sum(d.sgst_paise), 0)::bigint as sgst_paise,
           coalesce(sum(d.cess_paise), 0)::bigint as cess_paise
      from debit_notes d
      left join purchase_bills b on b.tenant_id = d.tenant_id and b.id = d.bill_id
     where d.tenant_id = ${ctx.tenantId} and d.status = 'completed'
       and d.note_date between ${from}::date and ${to}::date
       and d.store_id = any(${storeIds}::uuid[])
     group by 1, 2`.execute(tx)
  const expenses = await sql<TaxRaw & { itc: boolean; n: number }>`
    select e.itc_eligible as itc, count(*)::bigint as n,
           coalesce(sum(e.taxable_paise), 0)::bigint as taxable_paise,
           coalesce(sum(e.igst_paise), 0)::bigint as igst_paise,
           coalesce(sum(e.cgst_paise), 0)::bigint as cgst_paise,
           coalesce(sum(e.sgst_paise), 0)::bigint as sgst_paise,
           0::bigint as cess_paise
      from expenses e
     where e.tenant_id = ${ctx.tenantId} and e.status = 'posted'
       and e.expense_date between ${from}::date and ${to}::date
       and e.store_id = any(${storeIds}::uuid[])
       and (e.cgst_paise + e.sgst_paise + e.igst_paise) > 0
     group by 1`.execute(tx)

  const sumWhere = <T extends TaxRaw>(rows: T[], pred: (r: T) => boolean): TaxHeads =>
    rows.filter(pred).reduce<TaxHeads>((a, r) => addHeads(a, heads(r)), { ...ZERO_HEADS })
  const taxableWhere = <T extends TaxRaw>(rows: T[], pred: (r: T) => boolean): number =>
    rows.filter(pred).reduce((a, r) => a + num(r.taxable_paise), 0)

  const rcmHeads = addHeads(
    sumWhere(bills.rows, (r) => r.rcm),
    sumWhere(debits.rows, (r) => r.rcm),
    -1,
  )
  const rcmTaxable =
    taxableWhere(bills.rows, (r) => r.rcm) - taxableWhere(debits.rows, (r) => r.rcm)
  const allOther = addHeads(
    addHeads(
      sumWhere(bills.rows, (r) => !r.rcm),
      sumWhere(debits.rows, (r) => !r.rcm),
      -1,
    ),
    sumWhere(expenses.rows, () => true),
  )
  const blocked = addHeads(
    addHeads(
      sumWhere(bills.rows, (r) => !r.itc),
      sumWhere(debits.rows, (r) => !r.itc),
      -1,
    ),
    sumWhere(expenses.rows, (r) => !r.itc),
  )
  const available = addHeads(allOther, rcmHeads)
  const net = addHeads(available, blocked, -1)

  // 5: nil / exempt inward supplies (0 % bill lines, net of 0 % debit-note lines).
  const exemptIn = await sql<{ inter: boolean; amount: number }>`
    select x.inter, coalesce(sum(x.amount), 0)::bigint as amount from (
      select b.is_interstate as inter, l.taxable_paise as amount
        from purchase_bills b
        join purchase_bill_lines l on l.tenant_id = b.tenant_id and l.bill_id = b.id
       where b.tenant_id = ${ctx.tenantId} and b.status = 'posted'
         and b.received_date between ${from}::date and ${to}::date
         and b.store_id = any(${storeIds}::uuid[]) and l.gst_rate_bp = 0
      union all
      select d.is_interstate, -dl.taxable_paise
        from debit_notes d
        join debit_note_lines dl on dl.tenant_id = d.tenant_id and dl.debit_note_id = d.id
       where d.tenant_id = ${ctx.tenantId} and d.status = 'completed'
         and d.note_date between ${from}::date and ${to}::date
         and d.store_id = any(${storeIds}::uuid[]) and dl.gst_rate_bp = 0
    ) x group by x.inter`.execute(tx)

  const sources = await sql<{ si: number; cn: number }>`
    with recursive ${docs}
    select (select count(*) from invc)::bigint as si, (select count(*) from cnc)::bigint as cn`.execute(
    tx,
  )
  const count = <T extends { n: number }>(rows: T[]) => rows.reduce((a, r) => a + num(r.n), 0)

  const payment = gstr3bPayment(heads(taxed), rcmHeads, net)

  return {
    kind: 'gstr3b',
    ...header(env, period, reg),
    outward: {
      taxable: taxed,
      zero_rated: { ...ZERO_ROW },
      nil_exempt: { ...nilExempt, ...ZERO_HEADS },
      inward_rcm: { taxable_paise: rcmTaxable, ...rcmHeads },
      non_gst: { ...ZERO_ROW },
    },
    inter_state_unregistered: inter.rows.map((r) => ({
      place_of_supply: r.place_of_supply,
      taxable_paise: num(r.taxable_paise),
      igst_paise: num(r.igst_paise),
    })),
    itc: {
      import_goods: { ...ZERO_HEADS },
      import_services: { ...ZERO_HEADS },
      inward_rcm: rcmHeads,
      isd: { ...ZERO_HEADS },
      all_other: allOther,
      reversed_rules: blocked,
      reversed_others: { ...ZERO_HEADS },
      net,
      ineligible_16_4: { ...ZERO_HEADS },
      ineligible_pos: { ...ZERO_HEADS },
    },
    exempt_inward: {
      composition_exempt_nil: {
        inter_paise: num(exemptIn.rows.find((r) => r.inter)?.amount),
        intra_paise: num(exemptIn.rows.find((r) => !r.inter)?.amount),
      },
      non_gst: { inter_paise: 0, intra_paise: 0 },
    },
    payment,
    sources: {
      sales_invoices: num(sources.rows[0]?.si),
      credit_notes: num(sources.rows[0]?.cn),
      purchase_bills: count(bills.rows),
      debit_notes: count(debits.rows),
      expenses: count(expenses.rows),
    },
    warnings: [
      ...businessGstinWarning(reg),
      ...(storeIds.length ? await purchaseWarnings(tx, ctx, from, to, storeIds) : []),
    ],
  }
}

/**
 * ITC claimed on bills / expenses without a valid supplier GSTIN (reverse-charge bills are
 * self-invoiced and excluded).
 */
async function purchaseWarnings(
  tx: Tx,
  ctx: Ctx,
  from: string,
  to: string,
  storeIds: string[],
): Promise<GstWarning[]> {
  const candidates = sql`claims as (
      select 'bill'::text as kind, b.id, coalesce(b.number, b.supplier_invoice_no) as label,
             coalesce(nullif(trim(b.supplier_gstin), ''), s.gstin) as gstin
        from purchase_bills b
        left join suppliers s on s.tenant_id = b.tenant_id and s.id = b.supplier_id
       where b.tenant_id = ${ctx.tenantId} and b.status = 'posted' and b.itc_eligible
         and not b.reverse_charge
         and (b.cgst_paise + b.sgst_paise + b.igst_paise + b.cess_paise) > 0
         and b.received_date between ${from}::date and ${to}::date
         and b.store_id = any(${storeIds}::uuid[])
      union all
      select 'expense', e.id, coalesce(e.number, e.description), s.gstin
        from expenses e
        left join suppliers s on s.tenant_id = e.tenant_id and s.id = e.supplier_id
       where e.tenant_id = ${ctx.tenantId} and e.status = 'posted' and e.itc_eligible
         and (e.cgst_paise + e.sgst_paise + e.igst_paise) > 0
         and e.expense_date between ${from}::date and ${to}::date
         and e.store_id = any(${storeIds}::uuid[])
    )`
  const gstins = await sql<{ g: string }>`
    with ${candidates} select distinct gstin as g from claims where gstin is not null`.execute(tx)
  const invalid = gstins.rows.map((r) => r.g).filter((g) => !isValidGstin(normalizeGstin(g)))
  const rows = await sql<{
    kind: 'bill' | 'expense'
    id: string
    label: string | null
    gstin: string | null
  }>`
    with ${candidates}
    select kind, id, label, gstin from claims
     where gstin is null or gstin = any(${invalid}::text[])
     order by label, id limit ${WARNINGS_PER_KIND}`.execute(tx)
  return rows.rows.map((r) =>
    warning(
      'missing_purchase_gstin',
      'error',
      'itc',
      { type: r.kind === 'bill' ? 'purchase_bill' : 'expense', id: r.id, label: r.label },
      { gstin: r.gstin },
    ),
  )
}

// =============================================================================================
// Route handlers
// =============================================================================================

export async function gstr1Report(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  q: Out<typeof GstPeriodQuerySchema>,
): Promise<Gstr1Response> {
  if (env.tenant.gst_scheme === 'unregistered') return { kind: 'unregistered', period: q.period }
  const reg = await resolveRegistration(tx, ctx, env, q.gstin, { requireAllStores: true })
  if (env.tenant.gst_scheme === 'composition') return buildComposition(tx, ctx, env, q.period, reg)
  return buildGstr1(tx, ctx, env, q.period, reg)
}

export async function gstr3bReport(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  q: Out<typeof GstPeriodQuerySchema>,
): Promise<Gstr3bResponse> {
  if (env.tenant.gst_scheme === 'unregistered') return { kind: 'unregistered', period: q.period }
  const reg = await resolveRegistration(tx, ctx, env, q.gstin, { requireAllStores: true })
  if (env.tenant.gst_scheme === 'composition') return buildComposition(tx, ctx, env, q.period, reg)
  return buildGstr3b(tx, ctx, env, q.period, reg)
}

export interface ExportFile {
  filename: string
  contentType: string
  body: string
}

/** GSTR-1 offline-tool JSON / CSV for a regular registration; audited as a data export. */
export async function gstr1Export(
  tx: Tx,
  ctx: Ctx,
  env: ReportEnv,
  q: Out<typeof Gstr1ExportQuerySchema>,
): Promise<ExportFile> {
  if (env.tenant.gst_scheme !== 'regular') {
    throw reasonError(
      'UNPROCESSABLE',
      'gst_not_registered',
      'GSTR-1 is filed only by regular GST registrations',
      { gst_scheme: env.tenant.gst_scheme },
    )
  }
  const reg = await resolveRegistration(tx, ctx, env, q.gstin, { requireAllStores: true })
  if (!reg.gstin) {
    throw reasonError('UNPROCESSABLE', 'gst_not_registered', 'Add the business GSTIN first', {
      gst_scheme: env.tenant.gst_scheme,
    })
  }
  const report = await buildGstr1(tx, ctx, env, q.period, reg)
  const filename = gstr1ExportFilename(reg.gstin, q.period, q.format, q.section)
  const body =
    q.format === 'json' ? JSON.stringify(buildGstr1PortalJson(report)) : gstr1Csv(report, q.section)
  await audit(tx, ctx, {
    action: 'gst.gstr1_export',
    entity_type: 'gst_return',
    summary: `GSTR-1 ${q.period} ${reg.gstin} exported as ${q.format}${q.section ? ` (${q.section})` : ''}`,
    changes: {
      period: q.period,
      gstin: reg.gstin,
      format: q.format,
      section: q.section ?? null,
      warnings: report.warnings.length,
    },
  })
  return {
    filename,
    contentType:
      q.format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
    body,
  }
}

export { HSN_GROUP_SQL, customerGstins, gstDocsCte, taxRow }
