/**
 * Rendering + printing of sales documents. Public API (used by the POS and the back office):
 *
 *   renderSalesDocumentHtml(model, format?)   → complete HTML document (preview iframe srcDoc)
 *   renderSalesDocumentBody(model, format?)   → { html, css, paper } for lib/print's printHtml
 *   printSalesDocument({ kind, id, format? }) → loads the print model and prints it
 *   printSalesModel(model, { format?, silent? })
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { type SalesPrintModel, salesRoutes } from '@kadai/shared/api/sales'
import type { PrintFormat } from '@kadai/shared/settings'
import { api, callRoute } from '@/lib/api'
import { getLanguage } from '@/lib/i18n'
import { type PaperSize, buildPrintDocument, printHtml } from '@/lib/print'
import { recordPrintDuration } from '../lib/kiosk'
import { A4Document, PRINT_TEMPLATE_CSS, ThermalReceipt } from './templates'

export interface RenderedDocument {
  html: string
  css: string
  paper: PaperSize
  title: string
}

/** Body markup + CSS of a print model in a format (default: the model's own format). */
export function renderSalesDocumentBody(
  model: SalesPrintModel,
  format: PrintFormat = model.format,
): RenderedDocument {
  const element =
    format === 'a4' ? (
      <A4Document model={model} />
    ) : (
      <ThermalReceipt model={model} width={format === 'thermal_58' ? 58 : 80} />
    )
  const title = [model.title.en, model.document.number].filter(Boolean).join(' ')
  return { html: renderToStaticMarkup(element), css: PRINT_TEMPLATE_CSS, paper: format, title }
}

/** A complete standalone HTML document (fonts, paper size, template CSS). */
export function renderSalesDocumentHtml(
  model: SalesPrintModel,
  format: PrintFormat = model.format,
): string {
  const doc = renderSalesDocumentBody(model, format)
  return buildPrintDocument(doc.html, { paper: doc.paper, css: doc.css, title: doc.title })
}

// ---------------------------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------------------------

const logoCache = new Map<string, string>()

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('logo read failed'))
    reader.readAsDataURL(blob)
  })
}

/**
 * The logo of the print model is an authenticated API path (/api/v1/files/:id/content): fetch it
 * with the session and inline it, so the print frame can show it (cached per page load).
 */
async function inlineLogo(model: SalesPrintModel): Promise<SalesPrintModel> {
  const url = model.seller.logo_url
  if (!url || url.startsWith('data:')) return model
  const cached = logoCache.get(url)
  if (cached) return { ...model, seller: { ...model.seller, logo_url: cached } }
  if (!url.startsWith('/api/')) return model
  try {
    const blob = await api.get<Blob>(url, { responseType: 'blob', timeoutMs: 5_000 })
    const dataUrl = await blobToDataUrl(blob)
    logoCache.set(url, dataUrl)
    return { ...model, seller: { ...model.seller, logo_url: dataUrl } }
  } catch {
    // Offline / no access: print without the logo rather than not at all.
    return { ...model, seller: { ...model.seller, logo_url: null } }
  }
}

export interface PrintModelOptions {
  format?: PrintFormat
  /** Kiosk printing: no dialog flow (the browser prints straight to the default printer). */
  silent?: boolean
  /** Extra copies (settings.invoice.copies for thermal receipts). */
  copies?: number
}

/** Prints a print model (renders the template, inlines the logo). */
export async function printSalesModel(
  model: SalesPrintModel,
  options: PrintModelOptions = {},
): Promise<void> {
  const prepared = await inlineLogo(model)
  const format = options.format ?? prepared.format
  const doc = renderSalesDocumentBody(prepared, format)
  const started = performance.now()
  // A4 tax invoices carry their copies (original / duplicate…) as pages already.
  const copies = format === 'a4' ? 1 : Math.max(1, Math.min(5, options.copies ?? 1))
  if (options.silent) {
    // --kiosk-printing: print() returns immediately; nothing to wait for.
    void printHtml(doc.html, { paper: doc.paper, css: doc.css, title: doc.title, copies })
    return
  }
  await printHtml(doc.html, {
    paper: doc.paper,
    css: doc.css,
    title: doc.title,
    copies,
    onAfterPrint: () => recordPrintDuration(performance.now() - started),
  })
}

export interface PrintSalesDocumentInput {
  kind: 'invoice' | 'credit_note'
  id: string
  /** Default: the register's print format, else settings.invoice.print_format (server side). */
  format?: PrintFormat
  locale?: 'ta' | 'en'
  silent?: boolean
  copies?: number
}

/** Loads the print model of an invoice / estimate / credit note and prints it. */
export async function printSalesDocument(input: PrintSalesDocumentInput): Promise<SalesPrintModel> {
  const query = {
    ...(input.format ? { format: input.format } : {}),
    locale: input.locale ?? getLanguage(),
  }
  const res =
    input.kind === 'invoice'
      ? await callRoute(salesRoutes.printInvoice, { params: { id: input.id }, query })
      : await callRoute(salesRoutes.printCreditNote, { params: { id: input.id }, query })
  await printSalesModel(res.data, {
    ...(input.format ? { format: input.format } : {}),
    ...(input.silent !== undefined ? { silent: input.silent } : {}),
    ...(input.copies !== undefined ? { copies: input.copies } : {}),
  })
  return res.data
}
