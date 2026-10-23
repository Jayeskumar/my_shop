/**
 * Print templates of sales documents (thermal 58 / 80 mm, A4 tax invoice; invoices, estimates
 * and credit notes). Import from '@/features/pos/print':
 *
 *   await printSalesDocument({ kind: 'invoice', id })            // fetch model + print
 *   await printSalesDocument({ kind: 'credit_note', id, format: 'a4' })
 *   const html = renderSalesDocumentHtml(model, 'thermal_80')    // preview (iframe srcDoc)
 */
export {
  type PrintModelOptions,
  type PrintSalesDocumentInput,
  type RenderedDocument,
  printSalesDocument,
  printSalesModel,
  renderSalesDocumentBody,
  renderSalesDocumentHtml,
} from './render'
export { buildOfflinePrintModel, type OfflineModelInput } from './offline-model'
export { qrSvg } from './qr'
