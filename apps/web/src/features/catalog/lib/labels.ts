/**
 * Barcode label rendering for POST /labels print models: HTML + exact-mm @page CSS for
 * lib/print (roll labels: one page per label; A4 65-up: a 5 × 13 grid per sheet). Barcodes are
 * drawn as SVG with JsBarcode (EAN-13 / EAN-8 / UPC when the check digit is valid, else CODE128).
 */
import type { Label, LabelPrintModel } from '@kadai/shared/api/catalog'
import { barcodeFormatFor } from '@kadai/shared/api/catalog'
import JsBarcode from 'jsbarcode'
import { formatMoney } from '@/lib/format'

export type LabelNameMode = 'both' | 'en' | 'ta'

export interface LabelRenderOptions {
  showShop: boolean
  showMrp: boolean
  showPrice: boolean
  nameMode: LabelNameMode
  /** Fixed words printed on the label (translated by the caller). */
  words: { mrp: string; price: string; batch: string; expiry: string }
}

const SVG_NS = 'http://www.w3.org/2000/svg'

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

/**
 * SVG markup of the bars of a barcode (scalable: viewBox kept, fixed width/height removed). The
 * human-readable digits are printed as HTML under it (label fonts, no canvas text measuring).
 */
export function barcodeSvg(code: string, format?: string | null): string | null {
  if (typeof document === 'undefined') return null
  const tryFormat = (fmt: string): string | null => {
    const svg = document.createElementNS(SVG_NS, 'svg')
    try {
      JsBarcode(svg, code, {
        format: fmt,
        width: 2,
        height: 60,
        margin: 0,
        displayValue: false,
        background: '#ffffff',
        lineColor: '#000000',
      })
    } catch {
      return null
    }
    svg.removeAttribute('width')
    svg.removeAttribute('height')
    svg.setAttribute('class', 'bc-svg')
    svg.setAttribute('role', 'img')
    svg.setAttribute('aria-label', code)
    return svg.outerHTML
  }
  const preferred = format ?? barcodeFormatFor(code)
  return tryFormat(preferred) ?? (preferred === 'CODE128' ? null : tryFormat('CODE128'))
}

/** '2027-03-31' → '03/2027' (labels print month and year only). */
export function expiryText(date: string | null): string | null {
  if (!date) return null
  const [y, m] = date.split('-')
  return y && m ? `${m}/${y}` : null
}

function labelNames(label: Label, mode: LabelNameMode): string[] {
  const ta = label.name_ta?.trim() || null
  if (mode === 'en' || !ta) return [label.name]
  if (mode === 'ta') return [ta]
  return ta === label.name ? [label.name] : [label.name, ta]
}

function labelHtml(
  label: Label,
  model: LabelPrintModel,
  opts: LabelRenderOptions,
  barcodes: Map<string, string | null>,
): string {
  const parts: string[] = []
  if (opts.showShop) {
    const shop = opts.nameMode === 'ta' && model.shop.name_ta ? model.shop.name_ta : model.shop.name
    parts.push(`<div class="shop">${escapeHtml(shop)}</div>`)
  }
  const names = labelNames(label, opts.nameMode)
  parts.push(
    `<div class="names">${names.map((n, i) => `<div class="${i === 0 ? 'name' : 'name name-2'}">${escapeHtml(n)}</div>`).join('')}</div>`,
  )
  const meta: string[] = []
  if (label.variant_label) meta.push(escapeHtml(label.variant_label))
  else {
    if (label.size) meta.push(escapeHtml(label.size))
    if (label.color) meta.push(escapeHtml(label.color))
  }
  if (label.batch_no) meta.push(`${escapeHtml(opts.words.batch)} ${escapeHtml(label.batch_no)}`)
  const exp = expiryText(label.expiry_date)
  if (exp) meta.push(`${escapeHtml(opts.words.expiry)} ${exp}`)
  if (meta.length) parts.push(`<div class="meta">${meta.join(' · ')}</div>`)
  const svg = label.barcode ? barcodes.get(label.barcode) : null
  if (svg) {
    parts.push(`<div class="bc">${svg}</div>`)
    parts.push(`<div class="bc-code">${escapeHtml(label.barcode ?? '')}</div>`)
  } else {
    parts.push(`<div class="bc bc-text">${label.barcode ? escapeHtml(label.barcode) : ''}</div>`)
  }
  const prices: string[] = []
  if (opts.showMrp && label.mrp_paise !== null)
    prices.push(
      `<span class="mrp">${escapeHtml(opts.words.mrp)} ${formatMoney(label.mrp_paise, { decimals: 'auto' })}</span>`,
    )
  if (
    opts.showPrice &&
    (label.mrp_paise === null || label.price_paise !== label.mrp_paise || !opts.showMrp)
  )
    prices.push(
      `<span class="price">${escapeHtml(opts.words.price)} ${formatMoney(label.price_paise, { decimals: 'auto' })}</span>`,
    )
  if (prices.length) parts.push(`<div class="prices">${prices.join('')}</div>`)
  return `<div class="label">${parts.join('')}</div>`
}

const mm = (n: number): string => `${Number(n.toFixed(2))}mm`

/** Page CSS with the template's exact geometry. */
export function labelCss(model: LabelPrintModel): string {
  const t = model.template
  const roll = t.media === 'roll'
  const small = t.label_height_mm < 23
  return `
@page { size: ${mm(t.page_width_mm)} ${mm(t.page_height_mm)}; margin: 0; }
html, body { margin: 0; padding: 0; }
body { width: ${mm(t.page_width_mm)}; font-size: ${small ? '6pt' : '6.5pt'}; line-height: 1.12; }
.sheet { width: ${mm(t.page_width_mm)}; height: ${mm(t.page_height_mm)}; overflow: hidden; break-after: page; page-break-after: always; }
.sheet:last-child { break-after: auto; page-break-after: auto; }
${
  roll
    ? '.sheet { display: block; }'
    : `.sheet { padding: ${mm(t.margin_top_mm)} 0 0 ${mm(t.margin_left_mm)}; display: grid; grid-template-columns: repeat(${t.columns}, ${mm(t.label_width_mm)}); grid-auto-rows: ${mm(t.label_height_mm)}; column-gap: ${mm(t.gap_x_mm)}; row-gap: ${mm(t.gap_y_mm)}; align-content: start; }`
}
.label { width: ${mm(t.label_width_mm)}; height: ${mm(t.label_height_mm)}; padding: 0.8mm 1.2mm; display: flex; flex-direction: column; overflow: hidden; color: #000; }
.shop { font-size: 0.85em; font-weight: 700; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.names { overflow: hidden; }
.name { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.name-2 { font-weight: 600; line-height: 1.45; }
.shop, .names, .meta, .bc-code, .prices { flex: none; }
.meta { font-size: 0.85em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bc { flex: 1 1 auto; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 0.3mm 0; }
.bc-svg { width: 100%; height: 100%; display: block; }
.bc-text { font-family: monospace; font-size: 1.1em; }
.bc-code { font-family: monospace; font-size: 0.9em; letter-spacing: 0.08em; text-align: center; line-height: 1; }
.prices { display: flex; justify-content: space-between; gap: 1mm; font-weight: 700; font-size: 1.1em; white-space: nowrap; }
.prices span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.mrp { font-weight: 600; }
`
}

/** Body HTML: every copy of every label, paginated for the template. */
export function renderLabelsHtml(model: LabelPrintModel, opts: LabelRenderOptions): string {
  const barcodes = new Map<string, string | null>()
  for (const l of model.labels) {
    if (l.barcode && !barcodes.has(l.barcode))
      barcodes.set(l.barcode, barcodeSvg(l.barcode, l.barcode_format))
  }
  const copies: string[] = []
  for (const l of model.labels) {
    const html = labelHtml(l, model, opts, barcodes)
    for (let i = 0; i < l.copies; i++) copies.push(html)
  }
  const perSheet =
    model.template.media === 'roll' ? 1 : model.template.columns * model.template.rows
  const sheets: string[] = []
  for (let i = 0; i < copies.length; i += perSheet)
    sheets.push(`<div class="sheet">${copies.slice(i, i + perSheet).join('')}</div>`)
  return sheets.join('')
}

/** Number of sheets (roll labels or A4 pages) a model prints on. */
export function sheetCount(model: LabelPrintModel): number {
  const perSheet =
    model.template.media === 'roll' ? 1 : model.template.columns * model.template.rows
  return Math.ceil(model.total_copies / perSheet)
}
