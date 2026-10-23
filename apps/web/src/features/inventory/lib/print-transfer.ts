/**
 * Printable stock transfer note (delivery note between two stores of the same business) built
 * as HTML for lib/print (A4 / A5). Pure: labels are passed in, so the note prints in the UI
 * language while product names show both Tamil and English. Every value is HTML-escaped.
 */
import type { StockTransferDetail } from '@kadai/shared/api/inventory'
import { formatDateDisplay } from '@kadai/shared/fy'
import { formatINR } from '@kadai/shared/money'
import { formatPacksAndLoose } from '@kadai/shared/units'
import { packUnitFor } from './labels'

export interface TransferStoreInfo {
  code: string
  name: string
  name_ta?: string | null
  gstin?: string | null
  address?: string | null
  phone?: string | null
}

export interface TransferNoteLabels {
  title: string
  number: string
  date: string
  status: string
  from: string
  to: string
  sno: string
  product: string
  batch: string
  expiry: string
  qty: string
  received: string
  rate: string
  value: string
  total: string
  shortfall: string
  notes: string
  dispatched_by: string
  received_by: string
  not_invoice: string
  draft: string
}

function esc(value: string | null | undefined): string {
  return (value ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

function storeBlock(label: string, s: TransferStoreInfo): string {
  const lines = [
    `<div class="lbl">${esc(label)}</div>`,
    `<div class="bold">${esc(s.code)} · ${esc(s.name)}</div>`,
    s.name_ta && s.name_ta !== s.name ? `<div>${esc(s.name_ta)}</div>` : '',
    s.address ? `<div>${esc(s.address)}</div>` : '',
    s.gstin ? `<div>GSTIN: ${esc(s.gstin)}</div>` : '',
    s.phone ? `<div>${esc(s.phone)}</div>` : '',
  ]
  return `<div class="party">${lines.join('')}</div>`
}

export const TRANSFER_NOTE_CSS = `
  h1 { font-size: 18px; margin: 0 0 4px; text-align: center; }
  .sub { text-align: center; font-size: 11px; margin-bottom: 10px; }
  .meta { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
  .party { border: 1px solid #000; padding: 6px 8px; }
  .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
  table.lines th, table.lines td { border: 1px solid #000; padding: 4px 5px; vertical-align: top; }
  table.lines th { background: #eee; font-size: 11px; }
  .ta { font-size: 10px; }
  .totals td { font-weight: 700; }
  .notes { margin-top: 10px; }
  .sign { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 48px; }
  .sign div { border-top: 1px solid #000; padding-top: 4px; text-align: center; }
`

/** Body HTML of the transfer note. */
export function buildTransferNote(
  transfer: StockTransferDetail,
  stores: { from: TransferStoreInfo; to: TransferStoreInfo },
  labels: TransferNoteLabels,
  language: 'en' | 'ta',
  statusText: string,
): string {
  const received = transfer.status === 'received'
  const rows = transfer.lines
    .map((l, i) => {
      const packUnit = packUnitFor(l.unit)
      const qty = formatPacksAndLoose(l.qty_milli, l.pack_size, l.unit, packUnit, language)
      const got =
        l.received_qty_milli === null
          ? ''
          : formatPacksAndLoose(l.received_qty_milli, l.pack_size, l.unit, packUnit, language)
      const other = l.product_name_ta && l.product_name_ta !== l.product_name
      return `<tr>
        <td class="center">${i + 1}</td>
        <td>${esc(l.product_name)}${other ? `<div class="ta">${esc(l.product_name_ta)}</div>` : ''}${
          l.sku ? `<div class="ta">${esc(l.sku)}</div>` : ''
        }</td>
        <td>${esc(l.batch_no)}</td>
        <td>${l.expiry_date ? esc(formatDateDisplay(l.expiry_date)) : ''}</td>
        <td class="num">${esc(qty)}</td>
        ${received ? `<td class="num">${esc(got)}</td>` : ''}
        <td class="num">${esc(formatINR(l.unit_cost_paise))}</td>
        <td class="num">${esc(formatINR(l.value_paise))}</td>
      </tr>`
    })
    .join('')
  const span = received ? 7 : 6
  return `
    <h1>${esc(labels.title)}</h1>
    <div class="sub">${esc(labels.not_invoice)}</div>
    <div class="meta">
      <div><span class="lbl">${esc(labels.number)}</span><div class="bold">${esc(
        transfer.number ?? labels.draft,
      )}</div></div>
      <div><span class="lbl">${esc(labels.date)}</span><div class="bold">${esc(
        formatDateDisplay(transfer.transfer_date),
      )}</div></div>
      <div><span class="lbl">${esc(labels.status)}</span><div class="bold">${esc(statusText)}</div></div>
    </div>
    <div class="parties">
      ${storeBlock(labels.from, stores.from)}
      ${storeBlock(labels.to, stores.to)}
    </div>
    <table class="lines">
      <thead><tr>
        <th>${esc(labels.sno)}</th><th>${esc(labels.product)}</th><th>${esc(labels.batch)}</th>
        <th>${esc(labels.expiry)}</th><th>${esc(labels.qty)}</th>
        ${received ? `<th>${esc(labels.received)}</th>` : ''}
        <th>${esc(labels.rate)}</th><th>${esc(labels.value)}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot class="totals">
        <tr><td colspan="${span}" class="right">${esc(labels.total)}</td><td class="num">${esc(
          formatINR(transfer.total_value_paise),
        )}</td></tr>
        ${
          transfer.shortfall_value_paise > 0
            ? `<tr><td colspan="${span}" class="right">${esc(labels.shortfall)}</td><td class="num">${esc(
                formatINR(transfer.shortfall_value_paise),
              )}</td></tr>`
            : ''
        }
      </tfoot>
    </table>
    ${transfer.notes ? `<div class="notes"><span class="lbl">${esc(labels.notes)}</span><div>${esc(transfer.notes)}</div></div>` : ''}
    <div class="sign">
      <div>${esc(labels.dispatched_by)}${transfer.dispatched_by_name ? ` — ${esc(transfer.dispatched_by_name)}` : ''}</div>
      <div>${esc(labels.received_by)}${transfer.received_by_name ? ` — ${esc(transfer.received_by_name)}` : ''}</div>
    </div>`
}
