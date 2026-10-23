/** Bilingual print documents: both languages, shop / supplier blocks, escaping and totals. */
import { describe, expect, it } from 'vitest'
import { makeMe } from '@/test/fixtures'
import { bill, debitNote, order, supplier } from '../testing/fixtures'
import { debitNoteHtml, goodsReceiptHtml, purchaseOrderHtml } from './print-docs'

describe('purchases print documents', () => {
  it('prints the purchase order in English and Tamil with the supplier and totals', () => {
    const o = order({ notes: 'Send <fresh> stock' })
    const html = purchaseOrderHtml(o, makeMe())
    expect(html).toContain('Purchase Order')
    expect(html).toContain('கொள்முதல் ஆணை')
    expect(html).toContain('POS1/2627/00004')
    expect(html).toContain('Sri Lakshmi Traders')
    expect(html).toContain('ஆசீர்வாத் கோதுமை மாவு 5 கிலோ')
    expect(html).toContain('₹14,061.60')
    expect(html).toContain('Send &lt;fresh&gt; stock')
    expect(html).not.toContain('Received by')
    expect(html).toContain('Rupees Fourteen Thousand Sixty One')
  })

  it('prints a debit note with the bill reference, reason, settlement and GST split', () => {
    const html = debitNoteHtml(debitNote(), makeMe())
    expect(html).toContain('Debit Note')
    expect(html).toContain('டெபிட் நோட்')
    expect(html).toContain('GRNS1/2627/00018')
    expect(html).toContain('Expired / காலாவதி')
    expect(html).toContain(supplier().gstin ?? '')
    expect(html).toContain('₹49.46')
    expect(html).toContain('2 strips')
  })

  it('prints the goods receipt note with free quantities', () => {
    const html = goodsReceiptHtml(bill(), makeMe())
    expect(html).toContain('Goods Receipt Note')
    expect(html).toContain('SLT/1182')
    expect(html).toContain('+ 1 strip')
    expect(html).toContain('DL2410')
  })
})
