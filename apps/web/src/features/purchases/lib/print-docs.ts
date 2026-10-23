/**
 * Bilingual (English + Tamil) A4 print documents of the purchases module, printed through
 * lib/print (hidden iframe): the purchase order sent to the supplier, the debit note (purchase
 * return — a GST document the supplier keeps) and the goods receipt note of a posted bill.
 *
 * Labels come from the purchases locale files in BOTH languages (i18next fixed-language `t`), so
 * the paper reads the same whatever the UI language is; master-data names print in English with
 * the Tamil name underneath when there is one.
 */
import type { MeResponse } from '@kadai/shared/api/auth'
import type {
  DebitNoteDetail,
  PurchaseBillDetail,
  PurchaseOrderDetail,
} from '@kadai/shared/api/purchases'
import {
  DEBIT_NOTE_REASON_LABELS,
  DEBIT_NOTE_SETTLEMENT_LABELS,
  PURCHASE_DOC_TITLES,
} from '@kadai/shared/api/purchases'
import type { Address } from '@kadai/shared/api/common'
import { getState, splitGst } from '@kadai/shared/gst'
import i18next from 'i18next'
import {
  amountInWords,
  formatBp,
  formatDate,
  formatMoney,
  formatPackQty,
  formatPhone,
  formatQty,
} from '@/lib/format'
import { type PaperSize, printHtml } from '@/lib/print'
import { packUnitFor } from './labels'

type Lng = 'en' | 'ta'

function esc(text: string | null | undefined): string {
  return (text ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

/** One print label in both languages: purchases:print.<key>. */
function label(key: string, options?: Record<string, unknown>): { en: string; ta: string } {
  const at = (lng: Lng): string =>
    (
      i18next.getFixedT(lng, 'purchases') as unknown as (
        k: string,
        o?: Record<string, unknown>,
      ) => string
    )(`print.${key}`, options)
  return { en: at('en'), ta: at('ta') }
}

/** "English<br><small>தமிழ்</small>" (stacked header cell / caption). */
function bi(key: string, options?: Record<string, unknown>): string {
  const l = label(key, options)
  return l.en === l.ta ? esc(l.en) : `${esc(l.en)}<span class="ta">${esc(l.ta)}</span>`
}

/** "English / தமிழ்" on one line. */
function biInline(key: string, options?: Record<string, unknown>): string {
  const l = label(key, options)
  return l.en === l.ta ? esc(l.en) : `${esc(l.en)} / ${esc(l.ta)}`
}

function names(name: string, nameTa: string | null | undefined): string {
  return nameTa && nameTa !== name
    ? `${esc(name)}<span class="ta">${esc(nameTa)}</span>`
    : esc(name)
}

function addressLines(address: Partial<Address> | null | undefined): string {
  if (!address) return ''
  const state = address.state_code ? getState(address.state_code)?.name_en : undefined
  return [
    address.line1,
    address.line2,
    [address.city, address.district].filter(Boolean).join(', '),
    [state, address.pincode].filter(Boolean).join(' – '),
  ]
    .filter((l): l is string => Boolean(l && l.trim()))
    .map(esc)
    .join('<br>')
}

function qtyText(milli: number, unit: string, packSize: number): string {
  return packSize > 1
    ? formatPackQty(milli, packSize, unit, packUnitFor(unit), 'en')
    : formatQty(milli, unit, 'en')
}

const money = (paise: number): string => formatMoney(paise)

const CSS = `
  .doc { color: #000; }
  table { font-size: inherit; }
  .head { display: flex; justify-content: space-between; gap: 16px; border-bottom: 2px solid #000; padding-bottom: 8px; }
  .shop-name { font-size: 18px; font-weight: 700; }
  .title { text-align: right; }
  .title h1 { margin: 0; font-size: 18px; letter-spacing: .5px; }
  .ta { display: block; font-size: 90%; color: #333; }
  .muted { color: #444; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 10px 0; }
  .box { border: 1px solid #999; border-radius: 4px; padding: 6px 8px; }
  .box h2 { margin: 0 0 4px; font-size: 11px; text-transform: uppercase; color: #333; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; }
  .kv dt { color: #333; }
  .kv dd { margin: 0; font-weight: 600; }
  table.lines th, table.lines td { border: 1px solid #999; padding: 4px 5px; vertical-align: top; }
  table.lines th { background: #eee; font-size: 10px; text-align: left; }
  table.lines th.num { text-align: right; }
  .totals { display: flex; justify-content: flex-end; margin-top: 8px; }
  .totals table { width: 320px; }
  .totals td { padding: 3px 5px; }
  .totals tr.grand td { border-top: 2px solid #000; font-weight: 700; font-size: 14px; }
  .words { margin-top: 6px; font-style: italic; }
  .notes { margin-top: 10px; white-space: pre-wrap; }
  .sign { display: flex; justify-content: space-between; margin-top: 48px; }
  .sign div { min-width: 180px; border-top: 1px solid #000; padding-top: 4px; text-align: center; }
  .small { font-size: 10px; }
`

interface ShopInfo {
  name: string
  name_ta: string | null
  gstin: string | null
  phone: string | null
  address: Partial<Address> | null
}

function shopOf(me: MeResponse | null, storeId: string): ShopInfo {
  const store = me?.stores.find((s) => s.id === storeId)
  return {
    name: me?.tenant.name ?? '',
    name_ta: me?.tenant.name_ta ?? null,
    gstin: store?.gstin ?? me?.tenant.gstin ?? null,
    phone: me?.tenant.phone ?? null,
    address: me?.tenant.address ?? null,
  }
}

function header(
  shop: ShopInfo,
  title: { en: string; ta: string },
  number: string,
  date: string,
): string {
  return `<div class="head">
  <div>
    <div class="shop-name">${names(shop.name, shop.name_ta)}</div>
    <div class="muted small">${addressLines(shop.address)}</div>
    ${shop.phone ? `<div class="small">${biInline('phone')}: ${esc(formatPhone(shop.phone, true))}</div>` : ''}
    ${shop.gstin ? `<div class="small"><b>GSTIN:</b> ${esc(shop.gstin)}</div>` : ''}
  </div>
  <div class="title">
    <h1>${esc(title.en)}</h1>
    <div class="ta">${esc(title.ta)}</div>
    <div style="margin-top:6px"><b>${esc(number)}</b></div>
    <div>${esc(formatDate(date))}</div>
  </div>
</div>`
}

function partyBox(
  titleKey: string,
  p: {
    name: string
    gstin: string | null
    phone: string | null
    address: Partial<Address> | null
    drug_license_no?: string | null
  },
): string {
  return `<div class="box">
  <h2>${biInline(titleKey)}</h2>
  <div class="bold">${esc(p.name)}</div>
  <div class="small">${addressLines(p.address)}</div>
  ${p.phone ? `<div class="small">${biInline('phone')}: ${esc(formatPhone(p.phone, true))}</div>` : ''}
  <div class="small"><b>GSTIN:</b> ${p.gstin ? esc(p.gstin) : biInline('unregistered')}</div>
  ${p.drug_license_no ? `<div class="small">${biInline('drug_license')}: ${esc(p.drug_license_no)}</div>` : ''}
</div>`
}

function kv(rows: readonly (readonly [string, string] | null)[]): string {
  return `<dl class="kv">${rows
    .filter((r): r is readonly [string, string] => r !== null)
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('')}</dl>`
}

interface TaxTotals {
  taxable_paise: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
  cess_paise: number
  round_off_paise?: number
  other_charges_paise?: number
  discount_paise?: number
  total_paise: number
}

function totalsTable(t: TaxTotals, interstate: boolean): string {
  const row = (key: string, paise: number): string =>
    `<tr><td>${biInline(key)}</td><td class="num">${esc(money(paise))}</td></tr>`
  return `<div class="totals"><table>
  ${row('taxable', t.taxable_paise)}
  ${interstate ? row('igst', t.igst_paise) : `${row('cgst', t.cgst_paise)}${row('sgst', t.sgst_paise)}`}
  ${t.cess_paise > 0 ? row('cess', t.cess_paise) : ''}
  ${t.other_charges_paise ? row('other_charges', t.other_charges_paise) : ''}
  ${t.round_off_paise ? row('round_off', t.round_off_paise) : ''}
  <tr class="grand"><td>${biInline('total')}</td><td class="num">${esc(money(t.total_paise))}</td></tr>
</table></div>
<div class="words">${esc(amountInWords(t.total_paise, 'en'))}<span class="ta">${esc(amountInWords(t.total_paise, 'ta'))}</span></div>`
}

/** Signature lines; a purchase order is only signed by the shop. */
function signatures(opts: { receiver: boolean } = { receiver: true }): string {
  const receiver = opts.receiver ? `<div>${bi('received_by')}</div>` : '<span></span>'
  return `<div class="sign">${receiver}<div>${bi('authorised_signatory')}</div></div>`
}

function wrap(body: string): string {
  return `<div class="doc">${body}</div>`
}

// ---------------------------------------------------------------------------------------------
// Purchase order
// ---------------------------------------------------------------------------------------------

/** CGST / SGST split per line (splitGst, like the stored bill lines), IGST when interstate. */
function orderTaxTotals(order: PurchaseOrderDetail): TaxTotals {
  let cgst = 0
  let sgst = 0
  for (const l of order.lines) {
    if (order.is_interstate) continue
    const split = splitGst(l.tax_paise)
    cgst += split.cgst_paise
    sgst += split.sgst_paise
  }
  return {
    taxable_paise: order.taxable_paise,
    cgst_paise: cgst,
    sgst_paise: sgst,
    igst_paise: order.is_interstate ? order.tax_paise : 0,
    cess_paise: 0,
    total_paise: order.total_paise,
  }
}

export function purchaseOrderHtml(order: PurchaseOrderDetail, me: MeResponse | null): string {
  const shop = shopOf(me, order.store_id)
  const rows = order.lines
    .map(
      (l) => `<tr>
  <td class="num">${l.line_no}</td>
  <td>${names(l.product.name, l.product.name_ta)}${l.product.sku ? `<div class="small muted">${esc(l.product.sku)}</div>` : ''}${l.notes ? `<div class="small">${esc(l.notes)}</div>` : ''}</td>
  <td>${esc(l.product.hsn_code ?? '')}</td>
  <td class="num">${esc(qtyText(l.qty_milli, l.product.unit, l.product.pack_size))}</td>
  <td class="num">${esc(money(l.unit_cost_paise))}</td>
  <td class="num">${esc(formatBp(l.gst_rate_bp))}</td>
  <td class="num">${esc(money(l.total_paise))}</td>
</tr>`,
    )
    .join('')
  const body = `${header(shop, PURCHASE_DOC_TITLES.purchase_order, order.number, order.order_date)}
<div class="meta">
  ${partyBox('to_supplier', order.supplier)}
  <div class="box">${kv([
    [biInline('order_no'), esc(order.number)],
    [biInline('order_date'), esc(formatDate(order.order_date))],
    order.expected_date ? [biInline('expected_date'), esc(formatDate(order.expected_date))] : null,
    [biInline('items'), String(order.lines.length)],
  ])}</div>
</div>
<table class="lines">
  <thead><tr>
    <th class="num">#</th><th>${bi('item')}</th><th>${bi('hsn')}</th><th class="num">${bi('qty')}</th>
    <th class="num">${bi('rate')}</th><th class="num">${bi('gst')}</th><th class="num">${bi('amount')}</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
${totalsTable(orderTaxTotals(order), order.is_interstate)}
<p class="small muted">${biInline('rates_note')}</p>
${order.notes ? `<div class="notes"><b>${biInline('notes')}:</b> ${esc(order.notes)}</div>` : ''}
${order.terms ? `<div class="notes"><b>${biInline('terms')}:</b> ${esc(order.terms)}</div>` : ''}
${signatures({ receiver: false })}`
  return wrap(body)
}

// ---------------------------------------------------------------------------------------------
// Debit note
// ---------------------------------------------------------------------------------------------

export function debitNoteHtml(note: DebitNoteDetail, me: MeResponse | null): string {
  const shop = shopOf(me, note.store_id)
  const reason = DEBIT_NOTE_REASON_LABELS[note.reason]
  const settlement = DEBIT_NOTE_SETTLEMENT_LABELS[note.settlement]
  const rows = note.lines
    .map(
      (l) => `<tr>
  <td class="num">${l.line_no}</td>
  <td>${names(l.product.name, l.product.name_ta)}</td>
  <td>${esc(l.hsn_code ?? '')}</td>
  <td>${esc(l.batch_no ?? '')}${l.expiry_date ? `<div class="small">${esc(formatDate(l.expiry_date))}</div>` : ''}</td>
  <td class="num">${esc(qtyText(l.qty_milli, l.unit, l.pack_size))}</td>
  <td class="num">${esc(money(l.unit_cost_paise))}</td>
  <td class="num">${esc(money(l.taxable_paise))}</td>
  <td class="num">${esc(formatBp(l.gst_rate_bp))}</td>
  <td class="num">${esc(money(l.total_paise))}</td>
</tr>`,
    )
    .join('')
  const taxRows = note.tax_breakup
    .map(
      (r) =>
        `<tr><td class="num">${esc(formatBp(r.gst_rate_bp))}</td><td class="num">${esc(money(r.taxable_paise))}</td>${
          note.is_interstate
            ? `<td class="num">${esc(money(r.igst_paise))}</td>`
            : `<td class="num">${esc(money(r.cgst_paise))}</td><td class="num">${esc(money(r.sgst_paise))}</td>`
        }</tr>`,
    )
    .join('')
  const body = `${header(shop, PURCHASE_DOC_TITLES.debit_note, note.number, note.note_date)}
<div class="meta">
  ${partyBox('supplier', note.supplier)}
  <div class="box">${kv([
    [biInline('note_no'), esc(note.number)],
    [biInline('note_date'), esc(formatDate(note.note_date))],
    note.bill_number ? [biInline('against_grn'), esc(note.bill_number)] : null,
    note.supplier_invoice_no ? [biInline('supplier_invoice'), esc(note.supplier_invoice_no)] : null,
    [biInline('reason'), `${esc(reason.en)} / ${esc(reason.ta)}`],
    [biInline('settlement'), `${esc(settlement.en)} / ${esc(settlement.ta)}`],
    note.status === 'cancelled' ? [biInline('status'), biInline('cancelled')] : null,
  ])}</div>
</div>
<table class="lines">
  <thead><tr>
    <th class="num">#</th><th>${bi('item')}</th><th>${bi('hsn')}</th><th>${bi('batch_expiry')}</th>
    <th class="num">${bi('qty')}</th><th class="num">${bi('rate')}</th><th class="num">${bi('taxable')}</th>
    <th class="num">${bi('gst')}</th><th class="num">${bi('amount')}</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
${
  taxRows
    ? `<table class="lines" style="margin-top:8px;width:60%">
  <thead><tr><th class="num">${bi('gst')}</th><th class="num">${bi('taxable')}</th>${
    note.is_interstate
      ? `<th class="num">${bi('igst')}</th>`
      : `<th class="num">${bi('cgst')}</th><th class="num">${bi('sgst')}</th>`
  }</tr></thead>
  <tbody>${taxRows}</tbody>
</table>`
    : ''
}
${totalsTable(note, note.is_interstate)}
${note.notes ? `<div class="notes"><b>${biInline('notes')}:</b> ${esc(note.notes)}</div>` : ''}
<p class="small muted">${biInline('debit_note_declaration')}</p>
${signatures()}`
  return wrap(body)
}

// ---------------------------------------------------------------------------------------------
// Goods receipt note (posted bill)
// ---------------------------------------------------------------------------------------------

export function goodsReceiptHtml(bill: PurchaseBillDetail, me: MeResponse | null): string {
  const shop = shopOf(me, bill.store_id)
  const rows = bill.lines
    .map(
      (l) => `<tr>
  <td class="num">${l.line_no}</td>
  <td>${names(l.product.name, l.product.name_ta)}</td>
  <td>${esc(l.batch_no ?? '')}${l.expiry_date ? `<div class="small">${esc(formatDate(l.expiry_date))}</div>` : ''}</td>
  <td class="num">${l.mrp_paise !== null ? esc(money(l.mrp_paise)) : ''}</td>
  <td class="num">${esc(qtyText(l.qty_milli, l.unit, l.pack_size))}${l.free_qty_milli > 0 ? `<div class="small">+ ${esc(qtyText(l.free_qty_milli, l.unit, l.pack_size))} ${biInline('free')}</div>` : ''}</td>
  <td class="num">${esc(money(l.unit_cost_paise))}</td>
  <td class="num">${esc(money(l.taxable_paise))}</td>
  <td class="num">${esc(formatBp(l.gst_rate_bp))}</td>
  <td class="num">${esc(money(l.total_paise))}</td>
</tr>`,
    )
    .join('')
  const body = `${header(shop, PURCHASE_DOC_TITLES.purchase_bill, bill.number ?? '', bill.received_date)}
<div class="meta">
  ${partyBox('supplier', bill.supplier)}
  <div class="box">${kv([
    [biInline('grn_no'), esc(bill.number ?? '')],
    [biInline('received_date'), esc(formatDate(bill.received_date))],
    [biInline('supplier_invoice'), esc(bill.supplier_invoice_no)],
    [biInline('invoice_date'), esc(formatDate(bill.supplier_invoice_date))],
    bill.purchase_order ? [biInline('order_no'), esc(bill.purchase_order.number)] : null,
    bill.due_date ? [biInline('due_date'), esc(formatDate(bill.due_date))] : null,
  ])}</div>
</div>
<table class="lines">
  <thead><tr>
    <th class="num">#</th><th>${bi('item')}</th><th>${bi('batch_expiry')}</th><th class="num">${bi('mrp')}</th>
    <th class="num">${bi('qty')}</th><th class="num">${bi('rate')}</th><th class="num">${bi('taxable')}</th>
    <th class="num">${bi('gst')}</th><th class="num">${bi('amount')}</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
${totalsTable(bill, bill.is_interstate)}
${bill.notes ? `<div class="notes"><b>${biInline('notes')}:</b> ${esc(bill.notes)}</div>` : ''}
${signatures()}`
  return wrap(body)
}

export function printPurchaseDocument(
  html: string,
  title: string,
  paper: PaperSize = 'a4',
): Promise<void> {
  return printHtml(html, { paper, title, css: CSS })
}
