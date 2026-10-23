import { describe, expect, it } from 'vitest'
import { PaymentIntentSchema, UpiQrPayloadSchema } from '@kadai/shared/api/payments'
import {
  CreditNoteDetailSchema,
  CreditNoteListResponseSchema,
  InvoiceListResponseSchema,
  PublicInvoiceSchema,
  ReturnableResponseSchema,
  SalesInvoiceDetailSchema,
} from '@kadai/shared/api/sales'
import * as F from './fixtures'

describe('sales fixtures follow the contract', () => {
  it.each([
    ['invoice list', InvoiceListResponseSchema, F.invoiceList()],
    ['invoice detail', SalesInvoiceDetailSchema, F.invoiceDetail()],
    ['estimate detail', SalesInvoiceDetailSchema, F.estimateDetail()],
    ['returnable', ReturnableResponseSchema, F.returnable()],
    ['credit note list', CreditNoteListResponseSchema, F.creditNoteList()],
    ['credit note detail', CreditNoteDetailSchema, F.creditNoteDetail()],
    ['public invoice', PublicInvoiceSchema, F.publicInvoice()],
    ['upi qr', UpiQrPayloadSchema, F.upiQr()],
    ['payment intent', PaymentIntentSchema, F.paymentIntent()],
  ] as const)('%s', (_name, schema, value) => {
    const result = schema.safeParse(value)
    expect(result.error?.issues ?? []).toEqual([])
  })

  it('the sample bill adds up', () => {
    const inv = F.invoiceDetail()
    const lines = inv.lines.reduce((s, l) => s + l.total_paise, 0)
    expect(lines + inv.round_off_paise).toBe(inv.total_paise)
    expect(inv.taxable_paise + inv.tax_paise).toBe(inv.total_paise)
    expect(inv.paid_paise + inv.due_paise).toBe(inv.total_paise)
  })
})
