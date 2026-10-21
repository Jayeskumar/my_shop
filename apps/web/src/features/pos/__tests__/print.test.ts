/** Print templates: thermal 58 / 80 mm and A4 from the offline print model, credit notes. */
import { describe, expect, it } from 'vitest'
import { SalesPrintModelSchema, type SalesPrintModel } from '@kadai/shared/api/sales'
import { buildOfflinePrintModel, renderSalesDocumentBody, renderSalesDocumentHtml } from '../print'
import { priceLocalCart } from '../lib/pricing'
import { TODAY, cartOf, dal, lineOf, makeBootstrap, rice, sugar } from './fixtures'
import { contextOf, pricingEnvOf } from './helpers'

function offlineModel(locale: 'ta' | 'en' = 'ta'): SalesPrintModel {
  const b = makeBootstrap()
  const cart = cartOf([
    lineOf(rice),
    lineOf(dal, { qty_milli: 2000 }),
    lineOf(sugar, { qty_milli: 1500 }),
  ])
  return buildOfflinePrintModel({
    context: contextOf(b),
    cart,
    pricing: priceLocalCart(cart, pricingEnvOf(b)),
    tenders: [{ method: 'cash', amount_paise: 100_000 }],
    number: 'S1-A/2627/00005',
    invoice_date: TODAY,
    created_at: '2026-10-21T10:00:00.000Z',
    cashier_name: 'Murugan K',
    locale,
  })
}

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')

describe('offline print model', () => {
  it('follows the print contract (the receipt of an offline bill looks like an online one)', () => {
    const model = offlineModel()
    expect(SalesPrintModelSchema.safeParse(model).error).toBeUndefined()
    expect(model.document.number).toBe('S1-A/2627/00005')
    expect(model.totals.total_paise).toBe(79_100)
    expect(model.change_paise).toBe(20_900)
    expect(model.payments).toEqual([
      expect.objectContaining({ method: 'cash', amount_paise: 79_100 }),
    ])
  })
})

describe('receipt templates', () => {
  it('80 mm: bilingual title, items with qty / rate / amount, totals, cash handed over and change', () => {
    const { html, paper } = renderSalesDocumentBody(offlineModel(), 'thermal_80')
    expect(paper).toBe('thermal_80')
    const t = text(html)
    expect(t).toContain('வரி விலைப்பட்டியல் / Tax Invoice')
    expect(t).toContain('S1-A/2627/00005')
    expect(t).toContain('பொன்னி அரிசி 5 கிலோ')
    expect(t).toContain('Ponni Rice 5 kg')
    expect(t).toContain('395.00')
    expect(t).toContain('₹791.00')
    expect(t).toContain('₹1,000.00') // cash handed over
    expect(t).toContain('₹209.00') // change
    expect(t).toContain('நீங்கள் சேமித்தது')
    expect(t).toMatch(/Rupees Seven Hundred Ninety One/i)
  })

  it('58 mm puts qty × rate under the item', () => {
    const t = text(renderSalesDocumentBody(offlineModel('en'), 'thermal_58').html)
    expect(t).toMatch(/2\s*(pcs|nos|PCS)?\s*× 165.00/)
    expect(t).toContain('330.00')
  })

  it('A4 has the GST summary and the copy labels', () => {
    const model = {
      ...offlineModel('en'),
      format: 'a4' as const,
      copies: [{ en: 'Original for recipient', ta: 'பெறுநருக்கான அசல்' }],
    }
    const t = text(renderSalesDocumentBody(model, 'a4').html)
    expect(t).toContain('Original for recipient')
    expect(t).toContain('HSN')
    expect(t).toContain('753.34') // taxable value
    expect(t).toMatch(/18\.8[24]/) // CGST / SGST halves
  })

  it('credit note: title, original invoice and settlement', () => {
    const base = offlineModel('en')
    const model: SalesPrintModel = {
      ...base,
      kind: 'credit_note',
      doc_type: 'credit_note',
      title: { en: 'Credit Note', ta: 'வரவுக் குறிப்பு' },
      document: {
        ...base.document,
        number: 'CN-S1/2627/00001',
        original_invoice: { number: 'S1-A/2627/00005', date: TODAY },
        reason: { en: 'Damaged', ta: 'சேதம்' },
      },
      settlement: {
        method: 'cash',
        label: { en: 'Cash refund', ta: 'ரொக்கத் திருப்பம்' },
        amount_paise: 6_600,
      },
    }
    expect(SalesPrintModelSchema.safeParse(model).error).toBeUndefined()
    const t = text(renderSalesDocumentBody(model, 'thermal_80').html)
    expect(t).toContain('Credit Note')
    expect(t).toContain('CN-S1/2627/00001')
    expect(t).toContain('S1-A/2627/00005')
    expect(t).toContain('Cash refund')
  })

  it('renderSalesDocumentHtml returns a standalone document with the paper size', () => {
    const html = renderSalesDocumentHtml(offlineModel(), 'thermal_80')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('size: 80mm auto')
  })
})
