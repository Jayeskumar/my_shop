/**
 * Purchase bill drafts: server-side totals and landed costs (other charges pro-rata, free
 * quantity dilution, non-ITC tax capitalised), defaults (due date from supplier terms,
 * interstate from states, product GST), round-off override, batch validation, the duplicate
 * supplier invoice guard, PATCH / DELETE rules, from-order drafts, returnable, list filters /
 * summary / CSV and idempotent creates.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays, newId, todayIn } from '@kadai/shared'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import { auditActions, dataOf, expectError, makeProduct, makeSupplier, req } from './fixtures'

interface BillLineView {
  id: string
  line_no: number
  product_id: string
  purchase_order_line_id: string | null
  batch_no: string | null
  gross_paise: number
  discount_paise: number
  taxable_paise: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
  total_paise: number
  gst_rate_bp: number
  landed_unit_cost_paise: number
  qty_milli: number
  free_qty_milli: number
  returnable_qty_milli: number
  current: { last_cost_paise: number | null; stock_qty_milli: number | null }
}
interface BillView {
  id: string
  number: string | null
  status: string
  supplier_invoice_no: string
  due_date: string | null
  is_interstate: boolean
  itc_eligible: boolean
  gross_paise: number
  discount_paise: number
  taxable_paise: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
  tax_paise: number
  other_charges_paise: number
  round_off_paise: number
  total_paise: number
  due_paise: number
  updated_at: string
  purchase_order_id: string | null
  lines: BillLineView[]
  tax_breakup: { gst_rate_bp: number; taxable_paise: number }[]
  warnings: { code: string; line_no: number | null }[]
}

const today = todayIn('Asia/Kolkata')

describe('purchases: purchase bill drafts', () => {
  let t: TestApp
  let shop: TestShop
  let supplier: { id: string; name: string }
  let interSupplier: { id: string; name: string }
  let a: { id: string }
  let b: { id: string }

  const twoLines = () => [
    {
      product_id: a.id,
      qty_milli: 10_000,
      free_qty_milli: 2_000,
      unit_cost_paise: 10_000,
      discount_bp: 1000,
    },
    {
      product_id: b.id,
      batch_no: 'PCM2301',
      expiry_date: addDays(today, 400),
      qty_milli: 100_000,
      unit_cost_paise: 5_000,
      discount_paise: 500,
      mrp_paise: 6_500,
    },
  ]

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    supplier = await makeSupplier(t, shop.tenant.id, { payment_terms_days: 30 })
    interSupplier = await makeSupplier(t, shop.tenant.id, { state_code: '29' })
    a = await makeProduct(t, shop.tenant.id, { name: 'Ponni rice 1kg', gst_rate_bp: 1800 })
    b = await makeProduct(t, shop.tenant.id, {
      name: 'Paracetamol 500',
      unit: 'TAB',
      pack_size: 10,
      track_batches: true,
      gst_rate_bp: 1200,
      mrp_paise: 6_000,
    })
  })
  afterAll(() => t.close())

  async function create(payload: Record<string, unknown>, status = 201): Promise<BillView> {
    const res = await req(shop, 'POST', '/purchase-bills', {
      supplier_id: supplier.id,
      store_id: shop.store.id,
      supplier_invoice_no: `INV-${newId().slice(-8)}`,
      supplier_invoice_date: today,
      lines: twoLines(),
      ...payload,
    })
    return dataOf<BillView>(res, status)
  }

  it('computes line and header totals, other-charge allocation and landed cost exactly', async () => {
    const bill = await create({ other_charges_paise: 1001 })
    expect(bill.status).toBe('draft')
    expect(bill.number).toBeNull()
    const [la, lb] = bill.lines
    // A: 10 × ₹100 − 10% = ₹900 taxable, 18% GST; 2 free → landed over 12 units.
    expect(la).toMatchObject({
      gross_paise: 100_000,
      discount_paise: 0,
      taxable_paise: 90_000,
      cgst_paise: 8_100,
      sgst_paise: 8_100,
      igst_paise: 0,
      total_paise: 106_200,
      gst_rate_bp: 1800,
      landed_unit_cost_paise: 7_554, // (90000 + 646) × 1000 / 12000
    })
    // B: 10 strips × ₹50 − ₹5 = ₹495, 12% (product default); landed per strip of 10.
    expect(lb).toMatchObject({
      gross_paise: 50_000,
      discount_paise: 500,
      taxable_paise: 49_500,
      cgst_paise: 2_970,
      sgst_paise: 2_970,
      total_paise: 55_440,
      gst_rate_bp: 1200,
      landed_unit_cost_paise: 4_986, // (49500 + 355) × 10 × 1000 / 100000
    })
    expect(bill).toMatchObject({
      gross_paise: 150_000,
      discount_paise: 10_500,
      taxable_paise: 139_500,
      cgst_paise: 11_070,
      sgst_paise: 11_070,
      igst_paise: 0,
      tax_paise: 22_140,
      other_charges_paise: 1_001,
      round_off_paise: -41,
      total_paise: 162_600,
      due_paise: 0,
      is_interstate: false,
      itc_eligible: true,
      due_date: addDays(today, 30),
    })
    expect(bill.tax_breakup.map((r) => r.gst_rate_bp)).toEqual([1200, 1800])
    // Totals identity of the purchase_bills CHECK.
    expect(bill.total_paise).toBe(
      bill.taxable_paise + bill.tax_paise + bill.other_charges_paise + bill.round_off_paise,
    )
  })

  it('capitalises the tax into landed cost when not ITC-eligible', async () => {
    const bill = await create({ other_charges_paise: 1001, itc_eligible: false })
    expect(bill.itc_eligible).toBe(false)
    expect(bill.lines.map((l) => l.landed_unit_cost_paise)).toEqual([8_904, 5_580])
    expect(bill.total_paise).toBe(162_600)
  })

  it('uses IGST for an inter-state supplier and honours the supplier round-off override', async () => {
    const bill = await create({ supplier_id: interSupplier.id, round_off_paise: 0 })
    expect(bill.is_interstate).toBe(true)
    expect(bill.lines[0]).toMatchObject({ igst_paise: 16_200, cgst_paise: 0, sgst_paise: 0 })
    expect(bill.round_off_paise).toBe(0)
    expect(bill.total_paise).toBe(139_500 + 22_140)
    expect(bill.due_date).toBeNull()
    expect(bill.warnings.some((w) => w.code === 'interstate_mismatch')).toBe(false)
    const forced = await create({ supplier_id: interSupplier.id, is_interstate: false })
    expect(forced.is_interstate).toBe(false)
    expect(
      forced.warnings.some((w) => w.code === 'interstate_mismatch' && w.line_no === null),
    ).toBe(true)
  })

  it('requires batch number and expiry for batch-tracked products', async () => {
    const res = await req(shop, 'POST', '/purchase-bills', {
      supplier_id: supplier.id,
      store_id: shop.store.id,
      supplier_invoice_no: 'NOBATCH-1',
      supplier_invoice_date: today,
      lines: [{ product_id: b.id, qty_milli: 10_000, unit_cost_paise: 100 }],
    })
    const err = expectError(res, 400, 'VALIDATION_ERROR')
    expect(err.details?.issues?.map((i) => [i.path, i.message])).toEqual([
      ['lines.0.batch_no', 'batch_no_required'],
      ['lines.0.expiry_date', 'expiry_required'],
    ])
  })

  it('rejects invalid input, future dates, services and unknown references', async () => {
    expectError(
      await req(shop, 'POST', '/purchase-bills', {
        supplier_id: supplier.id,
        store_id: shop.store.id,
        supplier_invoice_no: '',
        supplier_invoice_date: today,
        lines: twoLines(),
      }),
      400,
      'VALIDATION_ERROR',
    )
    expectError(
      await req(shop, 'POST', '/purchase-bills', {
        supplier_id: supplier.id,
        store_id: shop.store.id,
        supplier_invoice_no: 'X',
        supplier_invoice_date: today,
        lines: [],
      }),
      400,
      'VALIDATION_ERROR',
    )
    const future = await req(shop, 'POST', '/purchase-bills', {
      supplier_id: supplier.id,
      store_id: shop.store.id,
      supplier_invoice_no: 'FUT-1',
      supplier_invoice_date: addDays(today, 2),
      lines: twoLines(),
    })
    expect(expectError(future, 400, 'VALIDATION_ERROR').details?.issues?.[0]).toMatchObject({
      path: 'supplier_invoice_date',
      message: 'future_date',
    })
    const service = await makeProduct(t, shop.tenant.id, { kind: 'service' })
    expectError(
      await req(shop, 'POST', '/purchase-bills', {
        supplier_id: supplier.id,
        store_id: shop.store.id,
        supplier_invoice_no: 'SVC-1',
        supplier_invoice_date: today,
        lines: [{ product_id: service.id, qty_milli: 1000, unit_cost_paise: 100 }],
      }),
      422,
      'UNPROCESSABLE',
      'product_not_purchasable',
    )
    expectError(
      await req(shop, 'POST', '/purchase-bills', {
        supplier_id: newId(),
        store_id: shop.store.id,
        supplier_invoice_no: 'NF-1',
        supplier_invoice_date: today,
        lines: twoLines(),
      }),
      404,
      'NOT_FOUND',
    )
    const inactive = await makeSupplier(t, shop.tenant.id, { is_active: false })
    expectError(
      await req(shop, 'POST', '/purchase-bills', {
        supplier_id: inactive.id,
        store_id: shop.store.id,
        supplier_invoice_no: 'IN-1',
        supplier_invoice_date: today,
        lines: twoLines(),
      }),
      422,
      'UNPROCESSABLE',
      'supplier_inactive',
    )
  })

  it('refuses a supplier invoice number already used by the supplier in the FY (409 + bill id)', async () => {
    const first = await create({ supplier_invoice_no: 'DUP/101' })
    const res = await req(shop, 'POST', '/purchase-bills', {
      supplier_id: supplier.id,
      store_id: shop.store.id,
      supplier_invoice_no: 'dup/101',
      supplier_invoice_date: today,
      lines: twoLines(),
    })
    const err = expectError(res, 409, 'DUPLICATE', 'duplicate_supplier_invoice')
    expect(err.details).toMatchObject({ existing_bill_id: first.id, existing_status: 'draft' })
    // Another supplier may use the same number.
    await create({ supplier_id: interSupplier.id, supplier_invoice_no: 'DUP/101' })
    // A deleted (draft) bill frees the number.
    expect((await req(shop, 'DELETE', `/purchase-bills/${first.id}`)).statusCode).toBe(204)
    await create({ supplier_invoice_no: 'DUP/101' })
  })

  it('PATCH recomputes totals, keeps line ids without lines, checks staleness and the draft status', async () => {
    const bill = await create({ other_charges_paise: 1001 })
    const patched = dataOf<BillView>(
      await req(shop, 'PATCH', `/purchase-bills/${bill.id}`, {
        other_charges_paise: 0,
        if_updated_at: bill.updated_at,
      }),
    )
    expect(patched.lines.map((l) => l.id)).toEqual(bill.lines.map((l) => l.id))
    expect(patched.lines.map((l) => l.landed_unit_cost_paise)).toEqual([7_500, 4_950])
    expect(patched.total_paise).toBe(161_600) // 139500 + 22140 = 161640 → nearest rupee
    expectError(
      await req(shop, 'PATCH', `/purchase-bills/${bill.id}`, {
        notes: 'late',
        if_updated_at: bill.updated_at,
      }),
      409,
      'STALE_WRITE',
    )
    // A supplier round-off override survives PATCHes that do not touch it.
    const over = dataOf<BillView>(
      await req(shop, 'PATCH', `/purchase-bills/${bill.id}`, { round_off_paise: 10 }),
    )
    expect(over.round_off_paise).toBe(10)
    const kept = dataOf<BillView>(
      await req(shop, 'PATCH', `/purchase-bills/${bill.id}`, { notes: 'checked' }),
    )
    expect(kept.round_off_paise).toBe(10)
    const auto = dataOf<BillView>(
      await req(shop, 'PATCH', `/purchase-bills/${bill.id}`, { round_off_paise: null }),
    )
    expect(auto.round_off_paise).toBe(-40)
    const relined = dataOf<BillView>(
      await req(shop, 'PATCH', `/purchase-bills/${bill.id}`, {
        lines: [{ product_id: a.id, qty_milli: 1_000, unit_cost_paise: 1_000, gst_rate_bp: 500 }],
      }),
    )
    expect(relined.lines).toHaveLength(1)
    expect(relined.lines[0]).toMatchObject({ taxable_paise: 1_000, cgst_paise: 25, sgst_paise: 25 })
    expect(relined.warnings.some((w) => w.code === 'gst_rate_differs')).toBe(true)
    expectError(await req(shop, 'PATCH', `/purchase-bills/${bill.id}`, {}), 400, 'VALIDATION_ERROR')
  })

  it('creates idempotently with an Idempotency-Key', async () => {
    const payload = {
      supplier_id: supplier.id,
      store_id: shop.store.id,
      supplier_invoice_no: `IDEM-${newId().slice(-6)}`,
      supplier_invoice_date: today,
      lines: twoLines(),
    }
    const key = `bill-${newId()}`
    const first = await req(shop, 'POST', '/purchase-bills', payload, {
      headers: { 'idempotency-key': key },
    })
    const again = await req(shop, 'POST', '/purchase-bills', payload, {
      headers: { 'idempotency-key': key },
    })
    expect(again.statusCode).toBe(201)
    expect(again.headers['idempotent-replayed']).toBe('true')
    expect(dataOf<BillView>(again, 201).id).toBe(dataOf<BillView>(first, 201).id)
    const mismatch = await req(
      shop,
      'POST',
      '/purchase-bills',
      { ...payload, other_charges_paise: 5 },
      { headers: { 'idempotency-key': key } },
    )
    expectError(mismatch, 409, 'IDEMPOTENCY_MISMATCH')
  })

  it('deletes drafts only (audited)', async () => {
    const bill = await create({})
    expect((await req(shop, 'DELETE', `/purchase-bills/${bill.id}`)).statusCode).toBe(204)
    expect((await req(shop, 'GET', `/purchase-bills/${bill.id}`)).statusCode).toBe(404)
    expect(await auditActions(t, shop.tenant.id, bill.id)).toEqual(['purchase_bill.delete'])
  })

  it('lists with filters, summary, sorting and CSV', async () => {
    const s = await makeSupplier(t, shop.tenant.id, {
      name: `Murugan Agencies ${newId().slice(-4)}`,
    })
    const one = await create({ supplier_id: s.id, supplier_invoice_no: 'MA-1' })
    const two = await create({
      supplier_id: s.id,
      supplier_invoice_no: 'MA-2',
      received_date: addDays(today, -3),
      supplier_invoice_date: addDays(today, -3),
    })
    const list = await req(shop, 'GET', `/purchase-bills?supplier_id=${s.id}&sort=received_date`)
    expect(list.statusCode).toBe(200)
    const body = list.json<{
      data: { id: string; supplier_name: string; line_count: number }[]
      page: { total: number }
      summary: { count: number; total_paise: number; due_paise: number }
    }>()
    expect(body.data.map((r) => r.id)).toEqual([two.id, one.id])
    expect(body.page.total).toBe(2)
    expect(body.summary).toMatchObject({ count: 2, total_paise: one.total_paise + two.total_paise })
    expect(body.data[0]!.line_count).toBe(2)
    const q = await req(shop, 'GET', `/purchase-bills?q=MA-2&supplier_id=${s.id}`)
    expect(q.json<{ data: { id: string }[] }>().data.map((r) => r.id)).toEqual([two.id])
    const ranged = await req(
      shop,
      'GET',
      `/purchase-bills?supplier_id=${s.id}&from=${today}&to=${today}&status=draft`,
    )
    expect(ranged.json<{ data: { id: string }[] }>().data.map((r) => r.id)).toEqual([one.id])
    expectError(
      await req(shop, 'GET', `/purchase-bills?from=${today}&to=${addDays(today, -1)}`),
      400,
      'VALIDATION_ERROR',
    )
    const csv = await req(shop, 'GET', `/purchase-bills?supplier_id=${s.id}&format=csv`)
    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-type']).toContain('text/csv')
    const lines = csv.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n')
    expect(lines[0]).toContain('GRN number')
    expect(lines).toHaveLength(3)
    expect(lines.some((l) => l.includes('MA-2'))).toBe(true)
  })
})
