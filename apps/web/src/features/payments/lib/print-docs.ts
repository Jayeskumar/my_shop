/**
 * Printable documents of the payments module (lib/print renders them in a hidden iframe):
 *
 *  - Receipt / payment voucher: bilingual (Tamil + English labels side by side, always both,
 *    whatever the UI language), amount in words in both languages, allocations and advance.
 *  - UPI standee poster (A5 / A4): shop name in Tamil and English, the static UPI QR (no
 *    amount), the UPI ID and "scan with any UPI app".
 *
 * Every dynamic value is HTML-escaped.
 */
import type { PaymentDetail } from '@kadai/shared/api/payments'
import { PAYMENT_METHOD_LABELS } from '@kadai/shared/api/payments'
import type { PaperSize } from '@/lib/print'
import { amountInWords, formatDate, formatDateTime, formatMoney } from '@/lib/format'
import type { TranslationKey } from '@/lib/i18n-resources'
import { translate } from '@/lib/i18n'
import { qrSvgMarkup } from './qr'

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

/** "தமிழ் / English" label pair of a payments:print.* key. */
function both(key: string): { ta: string; en: string } {
  const k = `payments:print.${key}` as TranslationKey
  return { ta: translate(k, { lng: 'ta' }), en: translate(k, { lng: 'en' }) }
}

function pair(key: string): string {
  const l = both(key)
  return `<span class="ta">${escapeHtml(l.ta)}</span> <span class="en">${escapeHtml(l.en)}</span>`
}

export interface ShopHeader {
  name: string
  name_ta: string | null
  address?: string | null
  phone?: string | null
  gstin?: string | null
}

// ---- receipt / voucher -----------------------------------------------------------------------

export const RECEIPT_CSS = `
  .rc { display: grid; gap: 6px; }
  .rc .shop { text-align: center; }
  .rc .shop .ta { font-size: 1.35em; font-weight: 700; display: block; }
  .rc .shop .en { font-weight: 600; display: block; }
  .rc .shop .meta { font-size: 0.85em; }
  .rc h1 { font-size: 1.1em; text-align: center; margin: 4px 0; padding: 4px 0;
    border-top: 1px dashed #000; border-bottom: 1px dashed #000; }
  .rc h1 .en { display: block; font-size: 0.85em; font-weight: 600; }
  .rc .row { display: flex; justify-content: space-between; gap: 8px; }
  .rc .row > :first-child { flex: 0 0 auto; }
  .rc .row > :last-child { text-align: right; overflow-wrap: anywhere; }
  .rc .label .en { color: #333; font-size: 0.85em; }
  .rc .amount { font-size: 1.4em; font-weight: 700; text-align: center; margin: 4px 0; }
  .rc .words { font-size: 0.85em; }
  .rc table td { padding: 2px 0; vertical-align: top; }
  .rc .stamp { text-align: center; font-weight: 700; border: 2px solid #000; padding: 4px; }
  .rc .sign { margin-top: 28px; display: flex; justify-content: space-between; font-size: 0.85em; }
  .rc .foot { text-align: center; font-size: 0.85em; border-top: 1px dashed #000; padding-top: 4px; }
`

export function receiptHtml(payment: PaymentDetail, shop: ShopHeader): string {
  const isIn = payment.direction === 'in'
  const title = both(isIn ? 'receipt_title' : 'voucher_title')
  const method = PAYMENT_METHOD_LABELS[payment.method]
  const allocations = payment.allocations
    .map((a) => {
      const doc =
        a.target_type === 'opening_balance'
          ? both('opening_balance').ta + ' / ' + both('opening_balance').en
          : [a.document_number ?? '—', a.document_date ? `(${formatDate(a.document_date)})` : '']
              .filter(Boolean)
              .join(' ')
      return `<tr><td>${escapeHtml(doc)}</td><td class="num">${escapeHtml(formatMoney(a.amount_paise))}</td></tr>`
    })
    .join('')
  const advance =
    payment.unallocated_paise > 0
      ? `<tr><td>${pair('advance')}</td><td class="num">${escapeHtml(formatMoney(payment.unallocated_paise))}</td></tr>`
      : ''
  const reference = payment.reference ?? payment.intent?.utr ?? null
  const shopMeta = [shop.address, shop.phone, shop.gstin ? `GSTIN: ${shop.gstin}` : null]
    .filter(Boolean)
    .map((x) => `<div class="meta">${escapeHtml(String(x))}</div>`)
    .join('')
  const row = (labelKey: string, value: string): string =>
    `<div class="row"><span class="label">${pair(labelKey)}</span><span>${escapeHtml(value)}</span></div>`

  return `<div class="rc">
  <div class="shop">
    ${shop.name_ta ? `<span class="ta">${escapeHtml(shop.name_ta)}</span>` : ''}
    <span class="en">${escapeHtml(shop.name)}</span>
    ${shopMeta}
  </div>
  <h1>${escapeHtml(title.ta)}<span class="en">${escapeHtml(title.en)}</span></h1>
  ${payment.status === 'cancelled' ? `<div class="stamp">${pair('cancelled')}</div>` : ''}
  ${row('number', payment.number ?? '—')}
  ${row('date', formatDateTime(payment.paid_at) || formatDate(payment.payment_date))}
  ${row(isIn ? 'received_from' : 'paid_to', payment.party_name ?? '—')}
  <div class="amount">${escapeHtml(formatMoney(payment.amount_paise))}</div>
  <div class="words">${escapeHtml(amountInWords(payment.amount_paise, 'ta'))}</div>
  <div class="words">${escapeHtml(amountInWords(payment.amount_paise, 'en'))}</div>
  ${row('method', `${method.ta} / ${method.en}`)}
  ${reference ? row('reference', reference) : ''}
  ${
    allocations || advance
      ? `<div class="label">${pair('against')}</div><table>${allocations}${advance}</table>`
      : ''
  }
  ${payment.notes ? row('notes', payment.notes) : ''}
  <div class="sign"><span>${pair(isIn ? 'received_by' : 'paid_by')}</span><span>${pair('signature')}</span></div>
  <div class="foot">${pair('thanks')}</div>
</div>`
}

/** Receipt paper from the shop's invoice print format (A4 shops get a half-page A5 receipt). */
export function receiptPaper(format: 'thermal_80' | 'thermal_58' | 'a4' | null | undefined): PaperSize {
  if (format === 'thermal_58') return 'thermal_58'
  if (format === 'a4') return 'a5'
  return 'thermal_80'
}

// ---- standee poster --------------------------------------------------------------------------

export interface StandeeInput {
  shop: { name: string; name_ta: string | null }
  store: { name: string; name_ta: string | null } | null
  vpa: string
  payee_name: string
  upi_uri: string
  paper: 'a4' | 'a5'
}

export function standeeCss(paper: 'a4' | 'a5'): string {
  const qr = paper === 'a4' ? '135mm' : '95mm'
  const big = paper === 'a4' ? '30pt' : '22pt'
  return `
  .st { height: 100%; display: flex; flex-direction: column; align-items: center; text-align: center;
    gap: ${paper === 'a4' ? '8mm' : '5mm'}; padding-top: ${paper === 'a4' ? '6mm' : '2mm'}; }
  .st .ta-name { font-size: ${big}; font-weight: 800; line-height: 1.2; }
  .st .en-name { font-size: ${paper === 'a4' ? '18pt' : '14pt'}; font-weight: 600; }
  .st .store { font-size: ${paper === 'a4' ? '13pt' : '11pt'}; }
  .st .qr { border: 3px solid #000; border-radius: 6mm; padding: 4mm; }
  .st .qr svg { width: ${qr}; height: ${qr}; display: block; }
  .st .scan-ta { font-size: ${paper === 'a4' ? '22pt' : '16pt'}; font-weight: 700; }
  .st .scan-en { font-size: ${paper === 'a4' ? '14pt' : '11pt'}; }
  .st .vpa { font-family: ui-monospace, 'Courier New', monospace; font-size: ${paper === 'a4' ? '16pt' : '12pt'};
    font-weight: 700; border: 1px dashed #000; padding: 2mm 4mm; border-radius: 2mm; }
  .st .payee { font-size: ${paper === 'a4' ? '12pt' : '10pt'}; }
`
}

export function standeeHtml(input: StandeeInput): string {
  const qr = qrSvgMarkup(input.upi_uri, 512, 2) ?? ''
  const scan = both('standee_scan')
  const upiId = both('upi_id')
  const storeLine =
    input.store && input.store.name !== input.shop.name
      ? `<div class="store">${escapeHtml(input.store.name_ta ?? input.store.name)}${
          input.store.name_ta && input.store.name_ta !== input.store.name
            ? ` · ${escapeHtml(input.store.name)}`
            : ''
        }</div>`
      : ''
  return `<div class="st">
  <div>
    ${input.shop.name_ta ? `<div class="ta-name">${escapeHtml(input.shop.name_ta)}</div>` : ''}
    <div class="${input.shop.name_ta ? 'en-name' : 'ta-name'}">${escapeHtml(input.shop.name)}</div>
    ${storeLine}
  </div>
  <div class="qr">${qr}</div>
  <div>
    <div class="scan-ta">${escapeHtml(scan.ta)}</div>
    <div class="scan-en">${escapeHtml(scan.en)}</div>
  </div>
  <div class="vpa">${escapeHtml(upiId.ta)} / ${escapeHtml(upiId.en)}: ${escapeHtml(input.vpa)}</div>
  <div class="payee">${escapeHtml(input.payee_name)}</div>
</div>`
}
