/**
 * The purchases fixtures must parse with the contract response schemas, so the MSW handlers
 * answer exactly what the real server must answer.
 */
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { ProductDetailSchema, ProductListItemSchema } from '@kadai/shared/api/catalog'
import { BatchRowSchema } from '@kadai/shared/api/inventory'
import { SupplierListItemSchema, SupplierSchema } from '@kadai/shared/api/parties'
import { PaymentDetailSchema } from '@kadai/shared/api/payments'
import {
  BillReturnableResponseSchema,
  DebitNoteDetailSchema,
  DebitNoteListResponseSchema,
  DebitNotePrefillSchema,
  PurchaseBillDetailSchema,
  PurchaseBillListResponseSchema,
  PurchaseOrderDetailSchema,
  PurchaseOrderListRowSchema,
  ReorderSuggestionsSchema,
} from '@kadai/shared/api/purchases'
import * as F from './fixtures'

const cases: [string, z.ZodType, () => unknown][] = [
  ['supplier list item', SupplierListItemSchema, F.supplierListItem],
  ['interstate supplier', SupplierListItemSchema, F.supplier2ListItem],
  ['supplier', SupplierSchema, F.supplier],
  ['product', ProductListItemSchema, F.product],
  ['batch-tracked product', ProductListItemSchema, F.doloProduct],
  ['product detail', ProductDetailSchema, () => F.productDetail(F.doloProduct())],
  ['batch', BatchRowSchema, F.batchRow],
  ['posted bill', PurchaseBillDetailSchema, F.bill],
  ['draft bill', PurchaseBillDetailSchema, F.draftBill],
  ['overdue bill', PurchaseBillDetailSchema, F.overdueBill],
  ['bill list', PurchaseBillListResponseSchema, F.billList],
  ['returnable', BillReturnableResponseSchema, () => F.returnable()],
  ['order', PurchaseOrderDetailSchema, F.order],
  ['draft order', PurchaseOrderDetailSchema, F.draftOrder],
  ['order row', PurchaseOrderListRowSchema, () => F.orderRow(F.order())],
  ['reorder suggestions', ReorderSuggestionsSchema, F.reorderSuggestions],
  ['debit note', DebitNoteDetailSchema, F.debitNote],
  ['debit note list', DebitNoteListResponseSchema, F.debitNoteList],
  ['debit note prefill', DebitNotePrefillSchema, F.debitNotePrefill],
  ['payment', PaymentDetailSchema, F.paymentDetail],
]

describe('purchases fixtures match the contracts', () => {
  it.each(cases)('%s', (_name, schema, make) => {
    const result = schema.safeParse(make())
    expect(result.error?.issues ?? []).toEqual([])
  })

  it('bill totals add up (taxable + tax + other charges + round off)', () => {
    const b = F.bill()
    expect(b.total_paise).toBe(
      b.taxable_paise + b.tax_paise + b.other_charges_paise + b.round_off_paise,
    )
    expect(b.due_paise).toBe(b.total_paise - b.paid_paise)
  })
})
