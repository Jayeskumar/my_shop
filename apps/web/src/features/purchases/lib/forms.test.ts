/**
 * Pure state models of the purchases editors: validation, live totals and the request bodies
 * (checked against the contract request schemas).
 */
import { describe, expect, it } from 'vitest'
import {
  DebitNoteCreateSchema,
  PurchaseBillCreateSchema,
  PurchaseBillUpdateSchema,
  PurchaseOrderCreateSchema,
  PurchaseOrderUpdateSchema,
} from '@kadai/shared/api/purchases'
import {
  IDS,
  STORE_ID,
  TODAY,
  bill,
  debitNotePrefill,
  doloProduct,
  draftOrder,
  product,
  reorderSuggestions,
  returnable,
  supplierListItem,
  supplier2ListItem,
} from '../testing/fixtures'
import {
  type BillContext,
  type BillDraft,
  computeBill,
  draftFromBill,
  effectiveDueDate,
  emptyHeader,
  fromPackMilli,
  lineFromProduct,
  lineWarnings,
  mapServerIssue,
  plannedPriceChanges,
  productFromListItem,
  toCreateBody,
  toPackMilli,
  toUpdateBody,
  validateBill,
} from './bill-form'
import { expiryInputText, normalizeExpiryTyping, parseExpiryText } from './expiry'
import { billFilterQuery, orderFilterQuery, returnFilterQuery } from './list-filters'
import {
  QTY_BELOW_RECEIVED,
  computeOrder,
  draftFromOrder,
  orderLineFromReorder,
  reorderOrderBody,
  toOrderCreateBody,
  toOrderUpdateBody,
  validateOrder,
} from './order-form'
import {
  QTY_ABOVE_RETURNABLE,
  billReturnDraft,
  computeReturn,
  emptyReturnHeader,
  freeLinesFromPrefill,
  prefillReason,
  toDebitNoteBody,
  validateReturn,
} from './return-form'

const ctx: BillContext = {
  store_state_code: '33',
  itc_allowed: true,
  today: TODAY,
  expiry_warning_days: 90,
}

function newDraft(): BillDraft {
  const s = supplierListItem()
  return {
    header: {
      ...emptyHeader({ store_id: STORE_ID, today: TODAY, itc_allowed: true }),
      supplier: {
        id: s.id,
        name: s.name,
        phone: s.phone,
        gstin: s.gstin,
        state_code: s.state_code,
        payment_terms_days: s.payment_terms_days,
        balance_paise: s.balance_paise,
      },
      supplier_invoice_no: ' SLT/1200 ',
      supplier_invoice_date: '2026-10-18',
    },
    lines: [],
  }
}

describe('expiry quick entry', () => {
  it('reads MM/YY as the last day of the month and normalises typing', () => {
    expect(parseExpiryText('08/27')).toEqual({ kind: 'ok', date: '2027-08-31' })
    expect(parseExpiryText('2/2028')).toEqual({ kind: 'ok', date: '2028-02-29' })
    expect(parseExpiryText('15-09-2027')).toEqual({ kind: 'ok', date: '2027-09-15' })
    expect(parseExpiryText('13/27')).toEqual({ kind: 'invalid' })
    expect(parseExpiryText('  ')).toEqual({ kind: 'empty' })
    expect(normalizeExpiryTyping('0827')).toBe('08/27')
    expect(normalizeExpiryTyping('082027')).toBe('08/2027')
    expect(expiryInputText('2027-08-31')).toBe('08/27')
    expect(expiryInputText('2027-08-15')).toBe('15-08-2027')
  })
})

describe('bill form', () => {
  it('validates batch, expiry, quantity and dates before saving', () => {
    const d = newDraft()
    const dolo = lineFromProduct(productFromListItem(doloProduct()))
    d.lines.push({ ...dolo, expiry_text: '14/27' })
    d.header.received_date = '2026-10-17'
    const errors = validateBill(d, ctx, 'save')
    expect(errors.header.received_date).toBe('date_order')
    expect(errors.lines[dolo.key]).toMatchObject({
      batch_no: 'batch_no_required',
      expiry: 'expiry_format',
    })
    expect(errors.lines[dolo.key]?.qty).toBeTruthy()
    expect(validateBill({ ...d, lines: [] }, ctx, 'save').header.lines).toBeTruthy()
    const future = newDraft()
    future.header.supplier_invoice_date = '2026-10-21'
    expect(validateBill(future, ctx, 'save').header.supplier_invoice_date).toBe('future_date')
  })

  it('needs the supplier invoice number to post a draft made from an order', () => {
    const d = newDraft()
    d.header.supplier_invoice_no = ''
    d.header.purchase_order = { id: IDS.order, number: 'POS1/2627/00004' }
    expect(validateBill(d, ctx, 'save').header.supplier_invoice_no).toBeUndefined()
    expect(validateBill(d, ctx, 'post').header.supplier_invoice_no).toBe(
      'supplier_invoice_no_required',
    )
  })

  it('builds a create body the contract accepts, in packs for strips', () => {
    const d = newDraft()
    const atta = {
      ...lineFromProduct(productFromListItem(product())),
      qty_milli: 20_000,
      unit_cost_paise: 24_500,
    }
    const dolo = {
      ...lineFromProduct(productFromListItem(doloProduct())),
      batch_no: 'DL2410',
      expiry_text: '03/28',
      qty_milli: fromPackMilli(10_000, 15),
      free_qty_milli: fromPackMilli(1_000, 15),
      discount_bp: 200,
      unit_cost_paise: 2_250,
      sale_price_paise: 3_400,
    }
    d.lines.push(atta, dolo)
    d.header.other_charges_paise = 15_000
    const body = PurchaseBillCreateSchema.parse(toCreateBody(d, ctx, IDS.file))
    expect(body).toMatchObject({
      supplier_id: IDS.supplier,
      store_id: STORE_ID,
      supplier_invoice_no: 'SLT/1200',
      is_interstate: false,
      due_date: '2026-11-17',
      other_charges_paise: 15_000,
      round_off_paise: null,
      client_ref: IDS.file,
    })
    expect(body.lines[1]).toMatchObject({
      product_id: IDS.dolo,
      batch_no: 'DL2410',
      expiry_date: '2028-03-31',
      qty_milli: 150_000,
      free_qty_milli: 15_000,
      discount_bp: 200,
      gst_rate_bp: 1200,
      sale_price_paise: 3_400,
    })
    expect(toPackMilli(150_000, 15)).toBe(10_000)
    // Live totals equal the fixture bill computed by the same shared maths.
    const calc = computeBill(d, ctx)
    const reference = bill()
    expect(calc.doc?.taxable_paise).toBe(reference.taxable_paise)
    expect(calc.doc?.total_paise).toBe(reference.total_paise)
  })

  it('uses IGST for an interstate supplier unless overridden', () => {
    const d = newDraft()
    const s = supplier2ListItem()
    d.header.supplier = { ...d.header.supplier!, id: s.id, state_code: s.state_code }
    d.lines.push({
      ...lineFromProduct(productFromListItem(product())),
      qty_milli: 1_000,
      unit_cost_paise: 10_000,
    })
    expect(computeBill(d, ctx).doc?.igst_paise).toBe(500)
    d.header.interstate_manual = false
    expect(computeBill(d, ctx).doc?.igst_paise).toBe(0)
  })

  it('round-trips a saved draft into an update body and maps server issues', () => {
    const saved = bill({ id: IDS.billDraft, status: 'draft' })
    const d = draftFromBill(saved, ctx)
    const body = PurchaseBillUpdateSchema.parse(toUpdateBody(d, ctx, saved))
    expect(body.if_updated_at).toBe(saved.updated_at)
    expect(body.lines).toHaveLength(2)
    expect(mapServerIssue('lines.1.batch_no', d)).toEqual({
      line: d.lines[1]!.key,
      field: 'batch_no',
    })
    expect(mapServerIssue('supplier_invoice_no', d)).toEqual({ field: 'supplier_invoice_no' })
    expect(effectiveDueDate(d.header)).toBe(saved.due_date)
  })

  it('warns about a higher rate, near expiry and plans price updates', () => {
    const d = newDraft()
    const l = {
      ...lineFromProduct(productFromListItem(doloProduct())),
      qty_milli: 15_000,
      unit_cost_paise: 2_500,
      batch_no: 'X1',
      expiry_text: '11/26',
      mrp_paise: 3_500,
    }
    d.lines.push(l)
    const calc = computeBill(d, ctx)
    const codes = lineWarnings(l, 0, calc, ctx).map((w) => w.code)
    expect(codes).toEqual(expect.arrayContaining(['cost_above_last', 'mrp_changed', 'near_expiry']))
    const fields = plannedPriceChanges(d, calc).map((c) => c.field)
    expect(fields).toEqual(expect.arrayContaining(['purchase_price_paise', 'mrp_paise']))
  })
})

describe('order form', () => {
  it('prefills reorder lines and builds a contract create body', () => {
    const group = reorderSuggestions().groups[0]!
    const lines = group.items.map((i) => orderLineFromReorder(i))
    expect(lines[0]).toMatchObject({ qty_milli: 20_000, unit_cost_paise: 24_000 })
    const draft = {
      supplier: { id: IDS.supplier, name: 'Sri Lakshmi Traders', phone: null, state_code: '33' },
      store_id: STORE_ID,
      order_date: TODAY,
      expected_date: '2026-10-23',
      notes: '',
      terms: ' 30 days ',
      lines,
    }
    expect(validateOrder(draft)).toEqual({ header: {}, lines: {} })
    const body = PurchaseOrderCreateSchema.parse(toOrderCreateBody(draft, IDS.file))
    expect(body).toMatchObject({
      supplier_id: IDS.supplier,
      terms: '30 days',
      expected_date: '2026-10-23',
    })
    expect(body.lines[1]).toMatchObject({
      product_id: IDS.dolo,
      qty_milli: 255_000,
      unit_cost_paise: 2_250,
      gst_rate_bp: 1200,
    })
    const totals = computeOrder(draft, '33')
    expect(totals.total_paise).toBe(totals.taxable_paise + totals.tax_paise)
    expect(totals.taxable_paise).toBe(480_000 + 38_250)
  })

  it('keeps received quantities when editing a draft', () => {
    const o = draftOrder()
    const d = draftFromOrder(o)
    d.lines[0] = { ...d.lines[0]!, received_qty_milli: 10_000, qty_milli: 5_000 }
    expect(validateOrder(d).lines[d.lines[0]!.key]?.qty).toBe(QTY_BELOW_RECEIVED)
    d.expected_date = '2026-10-01'
    expect(validateOrder(d).header.expected_date).toBe('date_order')
    const body = PurchaseOrderUpdateSchema.parse(toOrderUpdateBody({ ...draftFromOrder(o) }, o))
    expect(body.if_updated_at).toBe(o.updated_at)
  })

  it('creates one body per reorder group with the chosen quantities', () => {
    const items = reorderSuggestions().groups[0]!.items
    const body = PurchaseOrderCreateSchema.parse(
      reorderOrderBody({
        store_id: STORE_ID,
        supplier_id: IDS.supplier,
        client_ref: IDS.file,
        items: [{ item: items[0]!, qty_milli: 25_000 }],
      }),
    )
    expect(body.lines).toEqual([
      { product_id: IDS.atta, qty_milli: 25_000, unit_cost_paise: 24_000 },
    ])
  })

  it('prices a never-bought reorder item at the product purchase price, like the server', () => {
    const fresh = reorderSuggestions().groups[1]!.items[0]!
    expect(fresh.last_cost_paise).toBeNull()
    const line = orderLineFromReorder(fresh)
    expect(line.unit_cost_paise).toBe(6_200)
    const totals = computeOrder(
      {
        supplier: { id: IDS.supplier, name: 'Sri Lakshmi Traders', phone: null, state_code: '33' },
        store_id: STORE_ID,
        order_date: TODAY,
        expected_date: null,
        notes: '',
        terms: '',
        lines: [line],
      },
      '33',
    )
    expect(totals.taxable_paise).toBe(fresh.estimated_cost_paise)
    const body = reorderOrderBody({
      store_id: STORE_ID,
      supplier_id: IDS.supplier,
      client_ref: IDS.file,
      items: [{ item: fresh, qty_milli: fresh.suggested_qty_milli }],
    })
    expect(body.lines[0]).toMatchObject({ unit_cost_paise: 6_200, qty_milli: 12_000 })
  })
})

describe('return form', () => {
  it('prorates bill lines exactly like the server and caps at the returnable quantity', () => {
    const data = returnable()
    const draft = billReturnDraft(data, emptyReturnHeader({ store_id: STORE_ID, today: TODAY }))
    if (draft.mode !== 'bill') throw new Error('bill mode expected')
    const dolo = draft.lines[1]!
    // Return the whole line (charged + free): exactly the bill line's amounts.
    draft.lines[1] = { ...dolo, qty_milli: dolo.line.returnable_qty_milli }
    const totals = computeReturn(draft, false)
    expect(totals.total_paise).toBe(dolo.line.total_paise)
    draft.lines[1] = { ...dolo, qty_milli: dolo.line.returnable_qty_milli + 1_000 }
    expect(validateReturn(draft, TODAY).lines[dolo.line.bill_line_id]?.qty).toBe(
      QTY_ABOVE_RETURNABLE,
    )
    draft.lines[1] = { ...dolo, qty_milli: 15_000 }
    const body = DebitNoteCreateSchema.parse(
      toDebitNoteBody(draft, { client_ref: IDS.file, interstate: false }),
    )
    expect(body).toMatchObject({
      bill_id: IDS.billPosted,
      reason: 'return',
      settlement: 'adjust_due',
      lines: [{ bill_line_id: dolo.line.bill_line_id, qty_milli: 15_000 }],
    })
  })

  it('builds free-form lines from the batches-page prefill', () => {
    const prefill = debitNotePrefill()
    expect(prefillReason(prefill, TODAY)).toBe('expired')
    const draft = {
      mode: 'free' as const,
      header: {
        ...emptyReturnHeader({ store_id: STORE_ID, today: TODAY, reason: 'expired' }),
        supplier: { id: IDS.supplier, name: 'Sri Lakshmi Traders', state_code: '33' },
        settlement: 'refund_bank' as const,
        account_id: IDS.file,
        refund_reference: 'UTR 99',
      },
      lines: freeLinesFromPrefill(prefill),
    }
    expect(validateReturn(draft, TODAY)).toEqual({ header: {}, lines: {} })
    const body = DebitNoteCreateSchema.parse(
      toDebitNoteBody(draft, { client_ref: IDS.file, interstate: false }),
    )
    expect(body).toMatchObject({
      supplier_id: IDS.supplier,
      store_id: STORE_ID,
      is_interstate: false,
      reason: 'expired',
      settlement: 'refund_bank',
      account_id: IDS.file,
      refund_reference: 'UTR 99',
      lines: [
        {
          product_id: IDS.dolo,
          batch_id: IDS.batchDolo,
          qty_milli: 30_000,
          unit_cost_paise: 2_208,
          gst_rate_bp: 1200,
        },
      ],
    })
    // A batch-tracked line needs its batch; more than the stock is refused.
    const missing = { ...draft, lines: [{ ...draft.lines[0]!, batch_id: null, qty_milli: 45_000 }] }
    expect(validateReturn(missing, TODAY).lines[draft.lines[0]!.key]).toMatchObject({
      batch: 'batch_no_required',
      qty: QTY_ABOVE_RETURNABLE,
    })
  })
})

describe('list quick filters', () => {
  it('map to the contract list queries', () => {
    expect(billFilterQuery('overdue')).toEqual({ status: ['posted'], overdue: true })
    expect(billFilterQuery('to_pay')).toEqual({ status: ['posted'], has_due: true })
    expect(orderFilterQuery('open')).toEqual({ status: ['sent', 'partially_received'] })
    expect(returnFilterQuery('refunds')).toEqual({ settlement: ['refund_cash', 'refund_bank'] })
  })
})
