/**
 * Estimates (create / list / convert), print models, sharing and the public invoice.
 */
import { addDays, newId, todayIn } from '@kadai/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import {
  API,
  type SaleData,
  addStock,
  clientRef,
  dataOf,
  errorOf,
  insertBatch,
  insertCustomer,
  insertProduct,
  line,
  sell,
  stockOf,
} from './fixtures'

let t: TestApp
let shop: TestShop
let today: string

interface Detail {
  id: string
  doc_type: string
  number: string | null
  status: string
  total_paise: number
  due_date: string | null
  converted_to_id: string | null
  source_estimate: { id: string; number: string | null } | null
  share_url: string | null
  lines: Array<{ unit_price_paise: number }>
}

interface PrintModel {
  kind: string
  doc_type: string
  format: string
  title: { en: string; ta: string }
  copies: Array<{ en: string }>
  seller: { name: string; gstin: string | null; store_code: string; logo_url: string | null }
  document: {
    number: string | null
    time: string
    valid_until: string | null
    cashier_name: string | null
  }
  buyer: { name: string } | null
  lines: Array<{
    name: string
    qty_display: { en: string; ta: string }
    uqc: string
    rate_paise: number
  }>
  tax_breakup: Array<{
    gst_rate_bp: number
    cgst_rate_bp: number
    sgst_rate_bp: number
    tax_paise: number
  }>
  hsn_summary: Array<{ hsn_code: string | null }>
  tax_labels: { sgst: string }
  totals: { total_paise: number; item_count: number }
  amount_in_words: { en: string; ta: string }
  payments: Array<{ method: string; label: { ta: string } }>
  change_paise: number
  due_paise: number
  customer_balance_paise: number | null
  savings: { total_paise: number } | null
  upi: { uri: string; amount_paise: number } | null
  rx: { doctor_name: string } | null
  footer: { text_ta: string }
  share_url: string | null
}

beforeAll(async () => {
  t = await buildTestApp()
  shop = await createTestTenant(t)
  today = todayIn('Asia/Kolkata')
})
afterAll(() => t.close())

async function estimate(body: Record<string, unknown>) {
  return shop.inject({
    method: 'POST',
    url: `${API}/sales/estimates`,
    payload: { store_id: shop.store.id, client_ref: clientRef(), ...body },
  })
}

describe('estimates', () => {
  it('create (numbered, no stock), list by doc_type, convert at current prices', async () => {
    const c = await insertCustomer(t, shop, { credit_limit_paise: 10_000_000 })
    const p = await insertProduct(t, shop, { sale_price_paise: 10_000 })
    await addStock(shop, { product_id: p, qty_milli: 10_000 })
    const est = dataOf<Detail>(await estimate({ customer_id: c, lines: [line(p, 3_000)] }), 201)
    expect(est).toMatchObject({ doc_type: 'estimate', status: 'completed', total_paise: 30_000 })
    expect(est.number).toMatch(/^ESTS1\//)
    expect(est.due_date).toBe(addDays(today, 7))
    expect(await stockOf(t, shop.tenant.id, p)).toBe(10_000)

    const list = dataOf<Array<{ id: string }>>(
      await shop.inject({ method: 'GET', url: `${API}/sales/invoices?doc_type=estimate` }),
    )
    expect(list.map((e) => e.id)).toContain(est.id)
    const defaultList = dataOf<Array<{ id: string }>>(
      await shop.inject({ method: 'GET', url: `${API}/sales/invoices` }),
    )
    expect(defaultList.map((e) => e.id)).not.toContain(est.id)

    const printed = dataOf<PrintModel>(
      await shop.inject({ method: 'GET', url: `${API}/sales/invoices/${est.id}/print` }),
    )
    expect(printed.title.en).toBe('Estimate')
    expect(printed.document.valid_until).toBe(addDays(today, 7))

    await t.deps.db.systemDb
      .updateTable('products')
      .set({ sale_price_paise: 11_000 })
      .where('id', '=', p)
      .execute()
    const conv = dataOf<SaleData>(
      await shop.inject({
        method: 'POST',
        url: `${API}/sales/estimates/${est.id}/convert`,
        payload: { status: 'completed', tenders: [{ method: 'cash', amount_paise: 33_000 }] },
      }),
      201,
    )
    expect(conv.invoice.status).toBe('completed')
    expect(conv.invoice.total_paise).toBe(33_000)
    expect(conv.invoice['source_estimate']).toMatchObject({ id: est.id, number: est.number })
    expect(await stockOf(t, shop.tenant.id, p)).toBe(7_000)
    const after = dataOf<Detail>(
      await shop.inject({ method: 'GET', url: `${API}/sales/invoices/${est.id}` }),
    )
    expect(after).toMatchObject({ status: 'converted', converted_to_id: conv.invoice.id })
    const twice = await shop.inject({
      method: 'POST',
      url: `${API}/sales/estimates/${est.id}/convert`,
      payload: {},
    })
    expect(twice.statusCode).toBe(409)
  })

  it('keep_prices converts at the estimate prices into a draft', async () => {
    const p = await insertProduct(t, shop, { sale_price_paise: 5_000, track_inventory: false })
    const est = dataOf<Detail>(await estimate({ lines: [line(p, 2_000)] }), 201)
    await t.deps.db.systemDb
      .updateTable('products')
      .set({ sale_price_paise: 6_000 })
      .where('id', '=', p)
      .execute()
    const conv = dataOf<SaleData>(
      await shop.inject({
        method: 'POST',
        url: `${API}/sales/estimates/${est.id}/convert`,
        payload: { keep_prices: true },
      }),
      201,
    )
    expect(conv.invoice.status).toBe('draft')
    expect(conv.invoice.total_paise).toBe(10_000)
  })

  it('pharmacy estimates keep the prescription when converted (or take a new one)', async () => {
    const pharmacy = await createTestTenant(t, { business_type: 'pharmacy' })
    const p = await insertProduct(t, pharmacy, {
      sale_price_paise: 5_000,
      attributes: { schedule: 'H' },
    })
    await addStock(pharmacy, { product_id: p, qty_milli: 10_000 })
    const est = async (rx: Record<string, unknown> | null) =>
      dataOf<Detail>(
        await pharmacy.inject({
          method: 'POST',
          url: `${API}/sales/estimates`,
          payload: {
            store_id: pharmacy.store.id,
            client_ref: clientRef(),
            lines: [line(p)],
            ...(rx ? { rx } : {}),
          },
        }),
        201,
      )
    const convert = (id: string, extra: Record<string, unknown> = {}) =>
      pharmacy.inject({
        method: 'POST',
        url: `${API}/sales/estimates/${id}/convert`,
        payload: {
          status: 'completed',
          tenders: [{ method: 'cash', amount_paise: 5_000 }],
          ...extra,
        },
      })
    const withRx = await est({ doctor_name: 'Dr. Revathi', patient_name: 'Murugan' })
    const kept = dataOf<SaleData>(await convert(withRx.id), 201)
    expect(kept.invoice['rx']).toMatchObject({ doctor_name: 'Dr. Revathi' })

    const without = await est(null)
    const refused = await convert(without.id)
    expect(refused.statusCode).toBe(422)
    expect(errorOf(refused).code).toBe('RX_REQUIRED')
    const given = dataOf<SaleData>(
      await convert(without.id, { rx: { doctor_name: 'Dr. Selvam', patient_name: 'Lakshmi' } }),
      201,
    )
    expect(given.invoice['rx']).toMatchObject({ patient_name: 'Lakshmi' })
  })

  it('validates validity and permissions', async () => {
    const p = await insertProduct(t, shop, { track_inventory: false })
    const past = await estimate({ lines: [line(p)], valid_until: addDays(today, -1) })
    expect(past.statusCode).toBe(400)
    const viewer = await shop.asRole('viewer_est', { permissions: ['sales.read'] })
    const denied = await shop.inject({
      method: 'POST',
      url: `${API}/sales/estimates`,
      payload: { store_id: shop.store.id, lines: [line(p)] },
      as: viewer,
    })
    expect(denied.statusCode).toBe(403)
    const notEstimate = await sell(shop, {
      lines: [line(p)],
      tenders: [{ method: 'cash', amount_paise: 10_000 }],
    })
    const conv = await shop.inject({
      method: 'POST',
      url: `${API}/sales/estimates/${notEstimate.invoice.id}/convert`,
      payload: {},
    })
    expect(conv.statusCode).toBe(409)
  })
})

describe('print model', () => {
  it('thermal: header, lines, tax breakup, words, payments and change, savings', async () => {
    const c = await insertCustomer(t, shop, { name: 'Kavitha', credit_limit_paise: 10_000_000 })
    const p = await insertProduct(t, shop, {
      name: 'Ponni Rice 1kg',
      sale_price_paise: 6_300,
      mrp_paise: 7_000,
      gst_rate_bp: 500,
      unit: 'KG',
      decimal_qty: true,
    })
    await addStock(shop, { product_id: p, qty_milli: 10_000 })
    const r = await sell(shop, {
      customer_id: c,
      lines: [line(p, 1_500)],
      tenders: [{ method: 'cash', amount_paise: 10_000 }],
    })
    const m = dataOf<PrintModel>(
      await shop.inject({
        method: 'GET',
        url: `${API}/sales/invoices/${r.invoice.id}/print?format=thermal_58&locale=ta`,
      }),
    )
    expect(m.kind).toBe('invoice')
    expect(m.format).toBe('thermal_58')
    expect(m.title).toEqual({ en: 'Tax Invoice', ta: 'வரி விலைப்பட்டியல்' })
    expect(m.copies).toEqual([])
    expect(m.seller.store_code).toBe('S1')
    expect(m.seller.gstin).toBeTruthy()
    expect(m.buyer?.name).toBe('Kavitha')
    expect(m.document.number).toBe(r.invoice.number)
    expect(m.document.time).toMatch(/^\d{2}:\d{2}$/)
    expect(m.lines[0]).toMatchObject({ name: 'Ponni Rice 1kg', uqc: 'KGS', rate_paise: 6_300 })
    expect(m.lines[0]?.qty_display.en).toBe('1.5 kg')
    expect(m.tax_breakup[0]).toMatchObject({
      gst_rate_bp: 500,
      cgst_rate_bp: 250,
      sgst_rate_bp: 250,
    })
    expect(m.tax_labels.sgst).toBe('SGST')
    expect(m.totals.total_paise).toBe(9_500)
    expect(m.amount_in_words.en).toBe('Rupees Ninety Five Only')
    expect(m.amount_in_words.ta).toContain('ரூபாய்')
    expect(m.payments[0]).toMatchObject({ method: 'cash', label: { ta: 'ரொக்கம்' } })
    expect(m.change_paise).toBe(500)
    expect(m.savings?.total_paise).toBe(1_050)
    expect(m.customer_balance_paise).toBe(0)
    expect(m.footer.text_ta).toBeTruthy()
    expect(JSON.stringify(m)).not.toContain('cost_paise')
  })

  it('A4 tax invoice copies; UPI QR for the due; rx block for pharmacies', async () => {
    const pharmacy = await createTestTenant(t, { business_type: 'pharmacy' })
    await t.deps.db.systemDb
      .insertInto('payment_provider_accounts')
      .values({
        id: newId(),
        tenant_id: pharmacy.tenant.id,
        provider: 'upi_vpa',
        display_name: 'UPI',
        vpa: 'medicals@oksbi',
        payee_name: 'Sri Medicals',
      })
      .execute()
    const c = await insertCustomer(t, pharmacy, { credit_limit_paise: 1_000_000 })
    const p = await insertProduct(t, pharmacy, {
      sale_price_paise: 12_000,
      gst_rate_bp: 1200,
      attributes: { schedule: 'H' },
    })
    const b = await insertBatch(t, pharmacy, p, { expiry_date: addDays(today, 300) })
    await t.deps.db.systemDb
      .updateTable('products')
      .set({ track_batches: true })
      .where('id', '=', p)
      .execute()
    await addStock(pharmacy, { product_id: p, qty_milli: 5_000, batch_id: b })
    const r = await sell(pharmacy, {
      customer_id: c,
      lines: [line(p)],
      rx: { doctor_name: 'Dr. Anand', patient_name: 'Meena' },
      tenders: [{ method: 'cash', amount_paise: 2_000 }],
    })
    const m = dataOf<PrintModel>(
      await pharmacy.inject({
        method: 'GET',
        url: `${API}/sales/invoices/${r.invoice.id}/print?format=a4`,
      }),
    )
    expect(m.copies[0]?.en).toBe('Original for Recipient')
    expect(m.due_paise).toBe(10_000)
    expect(m.upi?.amount_paise).toBe(10_000)
    expect(m.upi?.uri).toMatch(/^upi:\/\/pay\?pa=medicals@oksbi&pn=Sri%20Medicals&am=100\.00/)
    expect(m.rx?.doctor_name).toBe('Dr. Anand')
    const held = await sell(pharmacy, { status: 'held', lines: [line(p)] })
    const heldPrint = await pharmacy.inject({
      method: 'GET',
      url: `${API}/sales/invoices/${held.invoice.id}/print`,
    })
    expect(heldPrint.statusCode).toBe(409)
  })
})

describe('share and public invoice', () => {
  it('shares by WhatsApp (link + notification + wa.me) and serves the public view without ids or costs', async () => {
    const c = await insertCustomer(t, shop, {
      name: 'Ravi',
      phone: '+919876543210',
      credit_limit_paise: 1_000_000,
    })
    const p = await insertProduct(t, shop, { sale_price_paise: 20_000, track_inventory: false })
    await t.deps.db.systemDb
      .insertInto('payment_provider_accounts')
      .values({
        id: newId(),
        tenant_id: shop.tenant.id,
        provider: 'upi_vpa',
        display_name: 'UPI',
        vpa: 'kadai@okhdfc',
      })
      .execute()
    const r = await sell(shop, {
      customer_id: c,
      lines: [line(p)],
      tenders: [{ method: 'cash', amount_paise: 5_000 }],
    })
    const share = dataOf<{
      url: string
      share_token: string
      notification_id: string | null
      message: string
      wa_me_url: string | null
    }>(
      await shop.inject({
        method: 'POST',
        url: `${API}/sales/invoices/${r.invoice.id}/share`,
        payload: { channel: 'whatsapp' },
      }),
    )
    expect(share.url).toBe(`${t.config.publicBaseUrl}/i/${share.share_token}`)
    expect(share.notification_id).toBeTruthy()
    expect(share.wa_me_url).toMatch(/^https:\/\/wa\.me\/919876543210\?text=/)
    expect(share.message).toContain(r.invoice.number!)
    const outbox = await t.deps.db.systemDb
      .selectFrom('notifications')
      .select(['template_code', 'recipient', 'ref_id'])
      .where('id', '=', share.notification_id!)
      .executeTakeFirstOrThrow()
    expect(outbox).toMatchObject({
      template_code: 'invoice_share',
      recipient: '+919876543210',
      ref_id: r.invoice.id,
    })

    const pub = await t.app.inject({
      method: 'GET',
      url: `/public/v1/invoices/${share.share_token}`,
    })
    expect(pub.statusCode).toBe(200)
    const body = pub.json() as {
      data: { document: PrintModel; pay: { upi_uri: string; amount_paise: number } | null }
    }
    expect(body.data.document.document.number).toBe(r.invoice.number)
    expect(body.data.document.customer_balance_paise).toBeNull()
    expect(body.data.document.seller.logo_url).toBeNull()
    expect(body.data.pay?.amount_paise).toBe(15_000)
    expect(body.data.pay?.upi_uri).toMatch(/^upi:\/\/pay\?pa=kadai@okhdfc/)
    expect(pub.body).not.toContain(r.invoice.id)
    expect(pub.body).not.toContain(shop.tenant.id)
    expect(pub.body).not.toContain('cost')

    const unknown = await t.app.inject({
      method: 'GET',
      url: '/public/v1/invoices/AAAAAAAAAAAAAAAAAAAAAA',
    })
    expect(unknown.statusCode).toBe(404)
    const malformed = await t.app.inject({ method: 'GET', url: '/public/v1/invoices/short' })
    expect(malformed.statusCode).toBe(400)
  })

  it('without a phone the share is a validation error; the free plan gets no notification', async () => {
    const p = await insertProduct(t, shop, { track_inventory: false })
    const r = await sell(shop, {
      lines: [line(p)],
      tenders: [{ method: 'cash', amount_paise: 10_000 }],
    })
    const res = await shop.inject({
      method: 'POST',
      url: `${API}/sales/invoices/${r.invoice.id}/share`,
      payload: { channel: 'sms' },
    })
    expect(res.statusCode).toBe(400)
    expect(errorOf(res).code).toBe('VALIDATION_ERROR')

    const free = await createTestTenant(t, { plan_code: 'free' })
    const fp = await insertProduct(t, free, { track_inventory: false })
    const fr = await sell(free, {
      lines: [line(fp)],
      tenders: [{ method: 'cash', amount_paise: 10_000 }],
    })
    const share = dataOf<{ notification_id: string | null; wa_me_url: string | null }>(
      await free.inject({
        method: 'POST',
        url: `${API}/sales/invoices/${fr.invoice.id}/share`,
        payload: { channel: 'whatsapp', phone: '9840011223' },
      }),
    )
    expect(share.notification_id).toBeNull()
    expect(share.wa_me_url).toMatch(/^https:\/\/wa\.me\/919840011223/)
  })
})
