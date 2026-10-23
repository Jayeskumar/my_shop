/**
 * The parties fixtures must parse with the contract response schemas, so MSW handlers answer
 * exactly what the real server must answer.
 */
import { describe, expect, it } from 'vitest'
import { ShiftDetailSchema } from '@kadai/shared/api/accounting'
import { ImportJobSchema } from '@kadai/shared/api/identity'
import {
  CustomerListItemSchema,
  CustomerSchema,
  CustomerSummarySchema,
  DoctorSchema,
  LoyaltyEntrySchema,
  PartyLedgerSchema,
  SupplierListItemSchema,
  SupplierSchema,
} from '@kadai/shared/api/parties'
import { OpenItemsResponseSchema, PaymentListResponseSchema } from '@kadai/shared/api/payments'
import { PurchaseBillListResponseSchema } from '@kadai/shared/api/purchases'
import { InvoiceListResponseSchema } from '@kadai/shared/api/sales'
import {
  billList,
  customer,
  customerBook,
  customerLedger,
  customerSummary,
  doctor,
  importJob,
  invoiceList,
  loyaltyEntries,
  openItems,
  openShift,
  paymentList,
  supplier,
  supplierBook,
  supplierLedger,
} from './fixtures'

describe('parties fixtures match the contracts', () => {
  it.each([
    ['customer list items', () => customerBook().map((c) => CustomerListItemSchema.parse(c))],
    ['customer', () => CustomerSchema.parse(customer())],
    ['summary', () => CustomerSummarySchema.parse(customerSummary())],
    ['customer ledger', () => PartyLedgerSchema.parse(customerLedger())],
    ['supplier ledger', () => PartyLedgerSchema.parse(supplierLedger())],
    ['loyalty', () => loyaltyEntries().map((e) => LoyaltyEntrySchema.parse(e))],
    ['suppliers', () => supplierBook().map((s) => SupplierListItemSchema.parse(s))],
    ['supplier', () => SupplierSchema.parse(supplier())],
    ['doctor', () => DoctorSchema.parse(doctor())],
    ['invoices', () => InvoiceListResponseSchema.parse(invoiceList())],
    ['payments in', () => PaymentListResponseSchema.parse(paymentList('customer'))],
    ['payments out', () => PaymentListResponseSchema.parse(paymentList('supplier'))],
    ['open items', () => OpenItemsResponseSchema.parse(openItems('customer'))],
    ['supplier open items', () => OpenItemsResponseSchema.parse(openItems('supplier'))],
    ['bills', () => PurchaseBillListResponseSchema.parse(billList())],
    ['import job', () => ImportJobSchema.parse(importJob())],
    ['open shift', () => ShiftDetailSchema.parse(openShift())],
  ])('%s', (_name, parse) => {
    expect(parse).not.toThrow()
  })
})
