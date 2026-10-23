/**
 * Printable accounting documents through lib/print (hidden iframe, browser print dialog):
 *  - books and statements as A4 tables (day book, ledgers, journal, P&L, balance sheet, trial
 *    balance) with the business header and the period;
 *  - the shift X / Z report on 80 mm thermal paper (counter printer) or A4.
 * Every value is escaped; amounts use Indian grouping, dates dd-MM-yyyy.
 */
import type { ShiftDetail } from '@kadai/shared/api/accounting'
import { DENOMINATION_NOTES } from '@kadai/shared/api/accounting'
import { authStore } from '@/lib/auth'
import { formatDateTime, formatMoney, formatQty } from '@/lib/format'
import { localizedName, translate } from '@/lib/i18n'
import { type PaperSize, printHtml } from '@/lib/print'
import { cashEntryKindLabel, differenceLabel, paymentMethodLabel } from './labels'

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

function businessHeader(storeName?: string | null): string {
  const me = authStore.getState().me
  if (!me) return ''
  const name = localizedName(me.tenant.name, me.tenant.name_ta)
  const parts = [
    `<div class="biz">${escapeHtml(name)}</div>`,
    storeName ? `<div class="muted">${escapeHtml(storeName)}</div>` : '',
    me.tenant.gstin ? `<div class="muted">GSTIN ${escapeHtml(me.tenant.gstin)}</div>` : '',
  ]
  return parts.join('')
}

// ---- tables (A4) -------------------------------------------------------------------------------

export interface PrintColumn {
  label: string
  align?: 'left' | 'right'
}

export interface PrintRow {
  cells: string[]
  /** 'section' = a heading row, 'total' = bold with a rule above. */
  kind?: 'section' | 'total' | 'muted'
}

export interface PrintTableDocument {
  title: string
  /** Period / as-of / account line under the title. */
  subtitle?: string
  /** Label → value facts printed above the table (opening, closing, totals…). */
  facts?: Array<[string, string]>
  columns: PrintColumn[]
  rows: PrintRow[]
  storeName?: string | null
}

const TABLE_CSS = `
  .head { display: flex; justify-content: space-between; gap: 16px; border-bottom: 2px solid #000; padding-bottom: 6px; margin-bottom: 8px; }
  .biz { font-size: 16px; font-weight: 700; }
  .muted { color: #444; font-size: 11px; }
  h1 { font-size: 15px; margin: 0; text-align: right; }
  .sub { text-align: right; font-size: 11px; color: #333; }
  .facts { display: flex; flex-wrap: wrap; gap: 4px 18px; margin: 6px 0 8px; font-size: 11px; }
  .facts b { font-variant-numeric: tabular-nums; }
  th, td { padding: 3px 4px; border-bottom: 1px solid #ccc; vertical-align: top; }
  th { text-align: left; border-bottom: 1.5px solid #000; font-size: 11px; }
  tr.section td { font-weight: 700; background: #f1f1f1; }
  tr.total td { font-weight: 700; border-top: 1.5px solid #000; }
  tr.muted td { color: #555; }
  .foot { margin-top: 10px; font-size: 10px; color: #555; }
`

export function buildTableHtml(doc: PrintTableDocument): string {
  const head = doc.columns
    .map((c) => `<th class="${c.align === 'right' ? 'num' : ''}">${escapeHtml(c.label)}</th>`)
    .join('')
  const body = doc.rows
    .map((r) => {
      const cells = r.cells
        .map((cell, i) => {
          const right = doc.columns[i]?.align === 'right'
          return `<td class="${right ? 'num' : ''}">${escapeHtml(cell)}</td>`
        })
        .join('')
      return `<tr class="${r.kind ?? ''}">${cells}</tr>`
    })
    .join('')
  const facts = doc.facts?.length
    ? `<div class="facts">${doc.facts
        .map(([k, v]) => `<span>${escapeHtml(k)}: <b>${escapeHtml(v)}</b></span>`)
        .join('')}</div>`
    : ''
  return `
    <div class="head">
      <div>${businessHeader(doc.storeName)}</div>
      <div><h1>${escapeHtml(doc.title)}</h1>${
        doc.subtitle ? `<div class="sub">${escapeHtml(doc.subtitle)}</div>` : ''
      }</div>
    </div>
    ${facts}
    <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    <div class="foot">${escapeHtml(
      translate('accounting:print.printed_at', { time: formatDateTime(new Date()) }),
    )}</div>`
}

export function printTable(doc: PrintTableDocument): Promise<void> {
  return printHtml(buildTableHtml(doc), { paper: 'a4', title: doc.title, css: TABLE_CSS })
}

// ---- shift X / Z report ------------------------------------------------------------------------

const SHIFT_CSS = `
  .c { text-align: center; }
  .biz { font-size: 15px; font-weight: 700; }
  .muted { color: #333; font-size: 0.92em; }
  h1 { font-size: 1.15em; margin: 6px 0 2px; text-align: center; letter-spacing: 0.02em; }
  h2 { font-size: 1em; margin: 8px 0 2px; border-bottom: 1px dashed #000; padding-bottom: 2px; }
  td { padding: 1px 0; vertical-align: top; }
  tr.total td { font-weight: 700; border-top: 1px dashed #000; padding-top: 2px; }
  .sections { display: block; }
  .a4 .sections { columns: 2; column-gap: 28px; }
  .a4 section { break-inside: avoid; }
  .a4 { font-size: 12px; }
`

type Line = [string, string, ('total' | '')?]

function section(title: string, lines: Line[]): string {
  if (!lines.length) return ''
  const rows = lines
    .map(
      ([label, value, kind]) =>
        `<tr class="${kind ?? ''}"><td>${escapeHtml(label)}</td><td class="num">${escapeHtml(value)}</td></tr>`,
    )
    .join('')
  return `<section><h2>${escapeHtml(title)}</h2><table>${rows}</table></section>`
}

const m = (paise: number): string => formatMoney(paise)
const tr = (key: string, options?: Record<string, unknown>): string =>
  translate(`accounting:${key}` as Parameters<typeof translate>[0], options)

/** Body HTML of the X (open) / Z (closed) report. */
export function buildShiftReportHtml(shift: ShiftDetail, paper: 'thermal_80' | 'a4'): string {
  const s = shift.summary
  const cash = s.cash
  const isZ = s.report === 'Z'
  const header = `
    <div class="c">
      ${businessHeader(shift.store_name)}
      <h1>${escapeHtml(tr(isZ ? 'shift_report.z_title' : 'shift_report.x_title'))}</h1>
      <div class="muted">${escapeHtml(`${shift.register_code} · ${shift.register_name}`)}</div>
      <div class="muted">${escapeHtml(tr('shift_report.cashier', { name: shift.opened_by_name ?? '—' }))}</div>
      <div class="muted">${escapeHtml(tr('shift_report.opened', { time: formatDateTime(shift.opened_at) }))}</div>
      ${
        shift.closed_at
          ? `<div class="muted">${escapeHtml(tr('shift_report.closed', { time: formatDateTime(shift.closed_at) }))}</div>`
          : `<div class="muted">${escapeHtml(tr('shift_report.as_of', { time: formatDateTime(s.generated_at) }))}</div>`
      }
    </div>`

  const sales = section(tr('shift_report.sales'), [
    [tr('shift_report.bills'), String(s.bills.count)],
    [tr('shift_report.gross'), m(s.bills.gross_paise)],
    [tr('shift_report.discounts'), m(s.bills.discount_paise)],
    [tr('shift_report.taxable'), m(s.bills.taxable_paise)],
    [tr('shift_report.tax'), m(s.bills.tax_paise)],
    [tr('shift_report.round_off'), m(s.bills.round_off_paise)],
    [tr('shift_report.net_sales'), m(s.bills.total_paise), 'total'],
    [tr('shift_report.avg_bill'), m(s.bills.avg_bill_paise)],
    [tr('shift_report.credit_given'), m(s.bills.credit_paise)],
  ])
  const paymentsIn = section(
    tr('shift_report.payments_in'),
    s.payments_in.map((p) => [`${paymentMethodLabel(p.method)} (${p.count})`, m(p.amount_paise)]),
  )
  const paymentsOut = section(
    tr('shift_report.payments_out'),
    s.payments_out.map((p) => [`${paymentMethodLabel(p.method)} (${p.count})`, m(p.amount_paise)]),
  )
  const other = section(tr('shift_report.other'), [
    [tr('shift_report.dues_collected'), m(s.dues_collected_paise)],
    [tr('shift_report.returns', { count: s.returns.count }), m(s.returns.total_paise)],
    [
      tr('shift_report.cancelled', { count: s.cancelled_bills.count }),
      m(s.cancelled_bills.total_paise),
    ],
    [tr('shift_report.expenses', { count: s.expenses.count }), m(s.expenses.cash_paise)],
  ])
  const cancelled = section(
    tr('shift_report.cancelled_list'),
    s.cancelled_bills.items.map((c) => [
      [c.number ?? '—', c.reason].filter(Boolean).join(' · '),
      m(c.total_paise),
    ]),
  )
  const drawerLines: Line[] = [
    [tr('shifts.cash.opening'), m(cash.opening_cash_paise)],
    [`+ ${tr('shifts.cash.receipts')}`, m(cash.cash_receipts_paise)],
    [`− ${tr('shifts.cash.payments')}`, m(cash.cash_payments_paise)],
    [`+ ${tr('shifts.cash.pay_ins')}`, m(cash.pay_ins_paise)],
    [`− ${tr('shifts.cash.pay_outs')}`, m(cash.pay_outs_paise)],
    [`− ${tr('shifts.cash.expenses')}`, m(cash.cash_expenses_paise)],
    [tr('shifts.cash.expected'), m(cash.expected_cash_paise), 'total'],
  ]
  if (cash.counted_cash_paise !== null) {
    drawerLines.push([tr('shifts.cash.counted'), m(cash.counted_cash_paise)])
  }
  if (cash.difference_paise !== null) {
    const status =
      cash.difference_paise < 0 ? 'short' : cash.difference_paise > 0 ? 'excess' : 'balanced'
    drawerLines.push([
      `${tr('shifts.cash.difference')} (${differenceLabel(status)})`,
      m(cash.difference_paise),
      'total',
    ])
  }
  const drawer = section(tr('shift_report.drawer'), drawerLines)
  const d = shift.denominations
  const denominations = d
    ? section(tr('shift_report.denominations'), [
        ...DENOMINATION_NOTES.filter((n) => (d[`${n}`] ?? 0) > 0).map((n): Line => [
          `₹${n} × ${d[`${n}`]}`,
          m(d[`${n}`] * n * 100),
        ]),
        ...(d.coins > 0 ? [[tr('denominations.coins'), m(d.coins)] as Line] : []),
      ])
    : ''
  const entries = section(
    tr('shift_report.cash_entries'),
    shift.cash_entries.map((e) => [
      `${cashEntryKindLabel(e.kind)} · ${e.reason}`,
      `${e.kind === 'pay_out' ? '−' : '+'}${m(e.amount_paise)}`,
    ]),
  )
  const top = section(
    tr('shift_report.top_items'),
    s.top_items.map((i) => [
      `${localizedName(i.name, i.name_ta)} × ${formatQty(i.qty_milli, i.unit)}`,
      m(i.total_paise),
    ]),
  )
  const notes = shift.notes
    ? `<section><h2>${escapeHtml(tr('fields.notes'))}</h2><div>${escapeHtml(shift.notes)}</div></section>`
    : ''
  const footer = `<div class="c muted" style="margin-top:8px">${escapeHtml(
    tr('print.printed_at', { time: formatDateTime(new Date()) }),
  )}</div>`
  return `<div class="${paper === 'a4' ? 'a4' : 'thermal'}">${header}<div class="sections">${[
    sales,
    paymentsIn,
    paymentsOut,
    other,
    cancelled,
    drawer,
    denominations,
    entries,
    top,
    notes,
  ].join('')}</div>${footer}</div>`
}

export function printShiftReport(
  shift: ShiftDetail,
  paper: Extract<PaperSize, 'thermal_80' | 'a4'>,
) {
  const title = `${shift.summary.report}-${shift.register_code}-${formatDateTime(shift.opened_at)}`
  return printHtml(buildShiftReportHtml(shift, paper), { paper, title, css: SHIFT_CSS })
}
