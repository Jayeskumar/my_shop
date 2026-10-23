/**
 * A4 print of a report (lib/print hidden iframe): the shop header (business, store, GSTIN,
 * address), the report title, period and active filters, every row of the report and the totals
 * row — landscape or portrait as the REPORTS catalogue says. Texts follow the UI language.
 */
import type { MeResponse } from '@kadai/shared/api/auth'
import type { ReportColumnDef, ReportDef } from '@kadai/shared/api/reports'
import { getState } from '@kadai/shared/gst'
import i18next from 'i18next'
import { formatDateTime, formatPhone } from '@/lib/format'
import type { Language } from '@/lib/i18n'
import { printHtml } from '@/lib/print'
import { cellText, type ReportRow, totalValue } from './cells'

function esc(text: string | null | undefined): string {
  return (text ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

const CSS = `
  .head { display: flex; justify-content: space-between; gap: 16px; border-bottom: 2px solid #000; padding-bottom: 6px; margin-bottom: 8px; }
  .shop { font-size: 16px; font-weight: 700; }
  .shop-ta { font-size: 13px; font-weight: 600; }
  .muted { color: #333; font-size: 10px; }
  .title { text-align: right; }
  .title h1 { margin: 0 0 2px; font-size: 16px; }
  .filters { margin: 0 0 8px; font-size: 10px; color: #222; }
  table.report { font-size: 9.5px; }
  table.report th, table.report td { border: 1px solid #999; padding: 3px 4px; vertical-align: top; }
  table.report thead th { background: #eee; text-align: left; font-size: 9px; }
  table.report thead { display: table-header-group; }
  table.report tr { break-inside: avoid; }
  table.report tfoot td { font-weight: 700; background: #f3f3f3; }
  .num { text-align: right; white-space: nowrap; }
  .foot { margin-top: 8px; font-size: 9px; color: #444; display: flex; justify-content: space-between; }
`

export interface PrintReportInput {
  def: ReportDef
  me: MeResponse
  title: string
  columns: readonly ReportColumnDef[]
  rows: readonly ReportRow[]
  totals: ReportRow | null
  /** "Period: …", "Store: …", "Group by: …" lines already in the UI language. */
  filterLines: readonly string[]
  storeName: string | null
  generatedAt: string
  /** The server cut the rows (more than REPORT_PAGE_MAX). */
  truncated: boolean
  lng: Language
}

export function buildReportHtml(input: PrintReportInput): string {
  const { me, columns, rows, totals, lng } = input
  const t = (key: string, options?: Record<string, unknown>): string =>
    (
      i18next.getFixedT(lng, 'reports') as unknown as (
        k: string,
        o?: Record<string, unknown>,
      ) => string
    )(key, options)
  const tenant = me.tenant
  const address = tenant.address
  const state = address.state_code ? getState(address.state_code)?.name_en : undefined
  const addressLine = [
    address.line1,
    address.line2,
    address.city,
    [state, address.pincode].filter(Boolean).join(' – '),
  ]
    .filter((p): p is string => Boolean(p && p.trim()))
    .join(', ')
  const isNum = (c: ReportColumnDef): boolean => c.align === 'right'
  const head = columns
    .map(
      (c) =>
        `<th class="${isNum(c) ? 'num' : ''}">${esc(lng === 'ta' ? c.label.ta : c.label.en)}</th>`,
    )
    .join('')
  const body = rows
    .map(
      (row) =>
        `<tr>${columns
          .map((c) => `<td class="${isNum(c) ? 'num' : ''}">${esc(cellText(c, row, lng))}</td>`)
          .join('')}</tr>`,
    )
    .join('')
  const foot =
    input.def.totals && totals && columns.some((c) => c.total)
      ? `<tfoot><tr>${columns
          .map((c, i) => {
            const v = totalValue(c, totals)
            const text =
              v !== undefined
                ? cellText(c, { ...totals, [c.key]: v }, lng)
                : i === 0
                  ? t('viewer.total')
                  : ''
            return `<td class="${isNum(c) ? 'num' : ''}">${esc(text)}</td>`
          })
          .join('')}</tr></tfoot>`
      : ''
  return `
  <div class="head">
    <div>
      <div class="shop">${esc(tenant.name)}</div>
      ${tenant.name_ta && tenant.name_ta !== tenant.name ? `<div class="shop-ta">${esc(tenant.name_ta)}</div>` : ''}
      <div class="muted">${esc(addressLine)}</div>
      <div class="muted">${[
        tenant.gstin ? `GSTIN: ${esc(tenant.gstin)}` : '',
        tenant.phone ? esc(formatPhone(tenant.phone)) : '',
        input.storeName ? esc(input.storeName) : '',
      ]
        .filter(Boolean)
        .join(' · ')}</div>
    </div>
    <div class="title">
      <h1>${esc(input.title)}</h1>
      <div class="muted">${esc(t('print.generated', { at: formatDateTime(input.generatedAt) }))}</div>
    </div>
  </div>
  ${input.filterLines.length ? `<p class="filters">${input.filterLines.map(esc).join(' · ')}</p>` : ''}
  <table class="report"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table>
  <div class="foot">
    <span>${esc(t('print.rows', { count: rows.length }))}${input.truncated ? ` · ${esc(t('notes.truncated'))}` : ''}</span>
    <span>${esc(t('print.footer'))}</span>
  </div>`
}

export function printReport(input: PrintReportInput): Promise<void> {
  const orientation = input.def.orientation === 'landscape' ? 'A4 landscape' : 'A4 portrait'
  return printHtml(buildReportHtml(input), {
    paper: 'a4',
    title: input.title,
    css: `${CSS}\n@page { size: ${orientation}; margin: 10mm 8mm; }`,
  })
}
