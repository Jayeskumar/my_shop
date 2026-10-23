/**
 * The payments fixtures must parse with the contract response schemas, so MSW handlers answer
 * exactly what the real server must answer.
 */
import { describe, expect, it } from 'vitest'
import { ChartOfAccountsSchema, ShiftDetailSchema } from '@kadai/shared/api/accounting'
import { CustomerListItemSchema, SupplierListItemSchema } from '@kadai/shared/api/parties'
import {
  OpenItemsResponseSchema,
  PaymentDetailSchema,
  PaymentIntentListResponseSchema,
  PaymentIntentSchema,
  PaymentListResponseSchema,
  PaymentProviderAccountSchema,
  ProviderTestResultSchema,
  PublicPayPageSchema,
  UpiQrPayloadSchema,
} from '@kadai/shared/api/payments'
import { InvoiceListResponseSchema } from '@kadai/shared/api/sales'
import * as F from './fixtures'

describe('payments fixtures match the contracts', () => {
  it.each([
    ['providers', () => F.providerList().map((p) => PaymentProviderAccountSchema.parse(p))],
    ['vpa test result', () => ProviderTestResultSchema.parse(F.vpaTestResult())],
    ['upi qr', () => UpiQrPayloadSchema.parse(F.upiQrPayload())],
    ['chart', () => ChartOfAccountsSchema.parse(F.chartOfAccounts())],
    ['open shift', () => ShiftDetailSchema.parse(F.openShift())],
    ['customer', () => CustomerListItemSchema.parse(F.customerListItem())],
    ['supplier', () => SupplierListItemSchema.parse(F.supplierListItem())],
    ['open items in', () => OpenItemsResponseSchema.parse(F.openItems('customer'))],
    ['open items out', () => OpenItemsResponseSchema.parse(F.openItems('supplier'))],
    ['due invoices', () => InvoiceListResponseSchema.parse(F.dueInvoices())],
    ['intents', () => F.todaysIntents().map((i) => PaymentIntentSchema.parse(i))],
    ['intent list', () => PaymentIntentListResponseSchema.parse(F.intentList())],
    ['payment list', () => PaymentListResponseSchema.parse(F.paymentList())],
    ['payment detail', () => PaymentDetailSchema.parse(F.paymentDetail())],
    ['pay page', () => PublicPayPageSchema.parse(F.publicPayPage())],
  ])('%s', (_name, parse) => {
    expect(parse).not.toThrow()
  })
})
