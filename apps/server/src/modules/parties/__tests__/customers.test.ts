/**
 * Customers API: create / get / lookup / list / update / delete, phone uniqueness, GSTIN-derived
 * state, opening balance journals, permissions, idempotency and tenant isolation.
 */
import { addDays, makeGstin, newId, todayIn } from '@kadai/shared'
import type { Customer, CustomerListItem } from '@kadai/shared/api/parties'
import { partiesRoutes } from '@kadai/shared/api/parties'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unimplementedRoutes } from '../../../core/http'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, type TestShopMember, createTestTenant } from '../../../test/tenants'
import { partiesImpls } from '../index'
import {
  api,
  auditActions,
  expectStatus,
  insertInvoice,
  localMobile,
  openingEntries,
  partyBalances,
  postSaleJournal,
} from './fixtures'

type Data<T> = { data: T }
type List<T> = { data: T[]; page: { limit: number; offset: number; total: number } }

describe('parties: customers', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop
  let cashier: TestShopMember
  let clerk: TestShopMember
  let today: string

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    other = await createTestTenant(t)
    cashier = await shop.asRole('cashier')
    clerk = await shop.asRole('inventory_clerk')
    today = todayIn('Asia/Kolkata')
  })
  afterAll(() => t.close())

  const create = async (payload: Record<string, unknown>, as: TestShop = shop) =>
    expectStatus<Data<Customer>>(
      await as.inject({ method: 'POST', url: api('/customers'), payload }),
      201,
    ).data

  it('implements every route of the parties catalogue', () => {
    expect(unimplementedRoutes(partiesRoutes, partiesImpls)).toEqual([])
  })

  it('creates a customer: phone normalised, state from the GSTIN, price tier default', async () => {
    const phone = localMobile()
    const gstin = makeGstin('29', 'ABCPK1234F', '1')
    const c = await create({
      name: '  Murugan Stores ',
      name_ta: 'முருகன் ஸ்டோர்ஸ்',
      phone: `0${phone}`,
      gstin: gstin.toLowerCase(),
      customer_type: 'wholesale',
      tags: ['Regular', 'regular', 'Street-3'],
      address: { line1: '12, Bazaar Street', city: 'Madurai', pincode: '625001' },
    })
    expect(c).toMatchObject({
      name: 'Murugan Stores',
      phone: `+91${phone}`,
      gstin,
      state_code: '29',
      customer_type: 'wholesale',
      price_tier: 'wholesale',
      balance_paise: 0,
      opening_balance_paise: 0,
      overdue_paise: 0,
      loyalty_points: 0,
      tags: ['regular', 'street-3'],
      whatsapp_opt_in: true,
      is_active: true,
      last_invoice_at: null,
      created_by: shop.owner.user.id,
    })
    expect(c.address).toMatchObject({ line1: '12, Bazaar Street', city: 'Madurai' })
    expect(await auditActions(t, shop, c.id)).toEqual(['customer.create'])

    const got = expectStatus<Data<Customer>>(
      await shop.inject({ method: 'GET', url: api(`/customers/${c.id}`) }),
      200,
    )
    expect(got.data).toEqual(c)
  })

  it('validates GSTIN checksum, state consistency, phone and empty patches', async () => {
    const bad = await shop.inject({
      method: 'POST',
      url: api('/customers'),
      payload: { name: 'X', gstin: '33ABCDE1234F1Z0' },
    })
    expect(bad.statusCode).toBe(400)
    expect(JSON.parse(bad.body).error.code).toBe('VALIDATION_ERROR')

    const mismatch = await shop.inject({
      method: 'POST',
      url: api('/customers'),
      payload: { name: 'X', gstin: makeGstin('29', 'ABCPK1234F', '1'), state_code: '33' },
    })
    expect(mismatch.statusCode).toBe(400)
    expect(JSON.parse(mismatch.body).error.details.issues[0]).toMatchObject({
      path: 'gstin',
      message: 'gstin_state',
    })

    const phone = await shop.inject({
      method: 'POST',
      url: api('/customers'),
      payload: { name: 'X', phone: '12345' },
    })
    expect(phone.statusCode).toBe(400)

    const c = await create({ name: 'Patch target' })
    const empty = await shop.inject({
      method: 'PATCH',
      url: api(`/customers/${c.id}`),
      payload: {},
    })
    expect(empty.statusCode).toBe(400)
    // Changing the state of a customer whose GSTIN is from another state.
    const withGstin = await create({ name: 'GST customer', gstin: makeGstin('33', 'AAAPL1234C') })
    const res = await shop.inject({
      method: 'PATCH',
      url: api(`/customers/${withGstin.id}`),
      payload: { state_code: '29' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error.details.issues[0]).toMatchObject({
      path: 'state_code',
      message: 'gstin_state',
    })
  })

  it('rejects a duplicate phone with 409 DUPLICATE and the existing id', async () => {
    const phone = localMobile()
    const first = await create({ name: 'First', phone })
    const dup = await shop.inject({
      method: 'POST',
      url: api('/customers'),
      payload: { name: 'Second', phone: `+91 ${phone.slice(0, 5)} ${phone.slice(5)}` },
    })
    expect(dup.statusCode).toBe(409)
    const err = JSON.parse(dup.body).error
    expect(err.code).toBe('DUPLICATE')
    expect(err.details).toMatchObject({ field: 'phone', existing_id: first.id })

    const second = await create({ name: 'Second', phone: localMobile() })
    const patch = await shop.inject({
      method: 'PATCH',
      url: api(`/customers/${second.id}`),
      payload: { phone },
    })
    expect(patch.statusCode).toBe(409)
    expect(JSON.parse(patch.body).error.details.existing_id).toBe(first.id)

    // The same phone is free in another tenant.
    const elsewhere = await create({ name: 'Other shop', phone }, other)
    expect(elsewhere.phone).toBe(first.phone)
  })

  it('serialises concurrent creates with the same phone (one wins, the rest 409)', async () => {
    const phone = localMobile()
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        shop.inject({
          method: 'POST',
          url: api('/customers'),
          payload: { name: `Racer ${i}`, phone },
        }),
      ),
    )
    const codes = results.map((r) => r.statusCode).sort()
    expect(codes).toEqual([201, 409, 409, 409, 409])
    const winner = JSON.parse(results.find((r) => r.statusCode === 201)!.body).data.id
    for (const r of results.filter((x) => x.statusCode === 409))
      expect(JSON.parse(r.body).error.details.existing_id).toBe(winner)
  })

  it('looks up by phone exactly (normalised) for the POS', async () => {
    const phone = localMobile()
    const c = await create({ name: 'Lookup me', phone })
    const hit = expectStatus<Data<CustomerListItem>>(
      await shop.inject({
        method: 'GET',
        url: api(`/customers/lookup?phone=0${phone}`),
        as: cashier,
      }),
      200,
    )
    expect(hit.data).toMatchObject({ id: c.id, phone: `+91${phone}` })
    expect('address' in hit.data).toBe(false)
    const miss = await shop.inject({
      method: 'GET',
      url: api(`/customers/lookup?phone=${localMobile()}`),
    })
    expect(miss.statusCode).toBe(404)
    const invalid = await shop.inject({ method: 'GET', url: api('/customers/lookup?phone=12') })
    expect(invalid.statusCode).toBe(400)
    // Tenant isolation: another tenant does not find it.
    const isolated = await other.inject({
      method: 'GET',
      url: api(`/customers/lookup?phone=${phone}`),
    })
    expect(isolated.statusCode).toBe(404)
  })

  it('posts the opening balance as a journal and its later changes as deltas', async () => {
    const c = await create({ name: 'Old khata', opening_balance_paise: 125_000 })
    expect(c.balance_paise).toBe(125_000)
    expect(c.opening_balance_paise).toBe(125_000)
    expect(await openingEntries(t, shop, c.id)).toEqual([
      { subtype: 'receivable', debit_paise: 125_000, credit_paise: 0 },
      { subtype: 'opening_balance', debit_paise: 0, credit_paise: 125_000 },
    ])

    const lowered = expectStatus<Data<Customer>>(
      await shop.inject({
        method: 'PATCH',
        url: api(`/customers/${c.id}`),
        payload: { opening_balance_paise: 100_000, if_updated_at: c.updated_at },
      }),
      200,
    ).data
    expect(lowered).toMatchObject({ opening_balance_paise: 100_000, balance_paise: 100_000 })
    const entries = await openingEntries(t, shop, c.id)
    expect(entries.slice(2)).toEqual([
      { subtype: 'receivable', debit_paise: 0, credit_paise: 25_000 },
      { subtype: 'opening_balance', debit_paise: 25_000, credit_paise: 0 },
    ])
    // Both audit rows of the PATCH share the transaction timestamp: compare as a set.
    expect((await auditActions(t, shop, c.id)).sort()).toEqual([
      'customer.create',
      'customer.opening_balance_change',
      'customer.update',
    ])

    // Re-sending the same value changes nothing (no journal, no permission needed).
    const same = await shop.inject({
      method: 'PATCH',
      url: api(`/customers/${c.id}`),
      payload: { opening_balance_paise: 100_000, notes: 'Pays on Sundays' },
      as: cashier,
    })
    expect(same.statusCode, same.body).toBe(200)
    expect((await openingEntries(t, shop, c.id)).length).toBe(4)

    // An advance (negative) opening balance credits the receivable.
    const advance = await create({ name: 'Advance', opening_balance_paise: -5_000 })
    expect(advance.balance_paise).toBe(-5_000)
    expect(await partyBalances(t, shop, 'customer', advance.id)).toEqual({
      ledger: -5_000,
      stored: -5_000,
    })
  })

  it('needs accounting permission to change an opening balance later', async () => {
    const c = await create({ name: 'Guarded', opening_balance_paise: 1_000 })
    const res = await shop.inject({
      method: 'PATCH',
      url: api(`/customers/${c.id}`),
      payload: { opening_balance_paise: 0 },
      as: cashier,
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error.details).toMatchObject({
      reason: 'opening_balance_permission',
      required: ['accounting.write'],
    })
    // Nothing was posted or changed.
    expect(await partyBalances(t, shop, 'customer', c.id)).toEqual({ ledger: 1_000, stored: 1_000 })
    // A cashier may still create a customer with an opening balance.
    const byCashier = expectStatus<Data<Customer>>(
      await shop.inject({
        method: 'POST',
        url: api('/customers'),
        payload: { name: 'Cashier added', opening_balance_paise: 2_500 },
        as: cashier,
      }),
      201,
    ).data
    expect(byCashier.balance_paise).toBe(2_500)
  })

  it('rejects stale PATCHes (if_updated_at)', async () => {
    const c = await create({ name: 'Stale' })
    await shop.inject({ method: 'PATCH', url: api(`/customers/${c.id}`), payload: { notes: 'a' } })
    const res = await shop.inject({
      method: 'PATCH',
      url: api(`/customers/${c.id}`),
      payload: { notes: 'b', if_updated_at: '2020-01-01T00:00:00.000Z' },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error.code).toBe('STALE_WRITE')
  })

  it('replays an idempotent create with the same key', async () => {
    const key = `cust-${newId()}`
    const payload = { name: 'Idempotent', phone: localMobile(), opening_balance_paise: 700 }
    const a = await shop.inject({
      method: 'POST',
      url: api('/customers'),
      payload,
      headers: { 'idempotency-key': key },
    })
    const b = await shop.inject({
      method: 'POST',
      url: api('/customers'),
      payload,
      headers: { 'idempotency-key': key },
    })
    expect(a.statusCode).toBe(201)
    expect(b.statusCode).toBe(201)
    expect(b.headers['idempotent-replayed']).toBe('true')
    const id = JSON.parse(a.body).data.id
    expect(JSON.parse(b.body).data.id).toBe(id)
    expect(await partyBalances(t, shop, 'customer', id)).toEqual({ ledger: 700, stored: 700 })
    const mismatch = await shop.inject({
      method: 'POST',
      url: api('/customers'),
      payload: { ...payload, name: 'Different' },
      headers: { 'idempotency-key': key },
    })
    expect(mismatch.statusCode).toBe(409)
  })

  describe('list', () => {
    let list: TestShop
    const ids: Record<string, string> = {}
    let phone: string

    beforeAll(async () => {
      list = await createTestTenant(t, { settings: { credit: { default_credit_days: 15 } } })
      phone = localMobile()
      const mk = async (key: string, payload: Record<string, unknown>) => {
        ids[key] = (await create(payload, list)).id
      }
      await mk('anbu', { name: 'Anbu', name_ta: 'அன்பு', phone, tags: ['vip'] })
      await mk('bala', {
        name: 'Bala Traders',
        gstin: makeGstin('33', 'BALPT1234Q'),
        customer_type: 'business',
        opening_balance_paise: 50_000,
      })
      await mk('chitra', { name: 'Chitra', opening_balance_paise: -2_000, tags: ['vip'] })
      await mk('dinesh', { name: 'Dinesh', credit_days: 60, opening_balance_paise: 9_000 })
      // Overdue: an unpaid invoice 20 days old (> 15 default credit days) for Anbu; Dinesh has
      // 60 credit days, so his 20-day-old invoice is not overdue yet.
      const old = addDays(today, -20)
      const a = await insertInvoice(t, list, {
        customer_id: ids.anbu!,
        invoice_date: old,
        total_paise: 30_000,
        due_paise: 30_000,
      })
      await postSaleJournal(list, {
        invoice_id: a.id,
        customer_id: ids.anbu!,
        amount_paise: 30_000,
        date: old,
      })
      await insertInvoice(t, list, {
        customer_id: ids.dinesh!,
        invoice_date: old,
        total_paise: 9_000,
        due_paise: 9_000,
      })
      await insertInvoice(t, list, {
        customer_id: ids.chitra!,
        invoice_date: today,
        total_paise: 100,
        invoice_at: new Date(Date.now() - 60_000),
      })
      // Estimates and held bills do not count as visits.
      await insertInvoice(t, list, {
        customer_id: ids.bala!,
        invoice_date: today,
        total_paise: 5_000,
        doc_type: 'estimate',
      })
    })

    const get = async (qs: string) =>
      expectStatus<List<CustomerListItem>>(
        await list.inject({ method: 'GET', url: api(`/customers?${qs}`) }),
        200,
      )
    const names = (l: List<CustomerListItem>) => l.data.map((c) => c.name)

    it('sorts by name by default and paginates with totals', async () => {
      const all = await get('')
      expect(names(all)).toEqual(['Anbu', 'Bala Traders', 'Chitra', 'Dinesh'])
      expect(all.page).toEqual({ limit: 50, offset: 0, total: 4 })
      const page2 = await get('limit=2&offset=2')
      expect(names(page2)).toEqual(['Chitra', 'Dinesh'])
      expect(page2.page.total).toBe(4)
      const past = await get('limit=2&offset=10')
      expect(past.data).toEqual([])
      expect(past.page.total).toBe(4)
    })

    it('includes balance, overdue, last visit and loyalty points', async () => {
      const all = await get('')
      const anbu = all.data.find((c) => c.id === ids.anbu)!
      expect(anbu).toMatchObject({
        balance_paise: 30_000,
        overdue_paise: 30_000,
        loyalty_points: 0,
      })
      expect(anbu.last_invoice_at).not.toBeNull()
      const dinesh = all.data.find((c) => c.id === ids.dinesh)!
      expect(dinesh.overdue_paise).toBe(0)
      const bala = all.data.find((c) => c.id === ids.bala)!
      expect(bala.last_invoice_at).toBeNull()
    })

    it('searches name, Tamil name, phone digits and GSTIN', async () => {
      expect(names(await get('q=bala'))).toEqual(['Bala Traders'])
      expect(names(await get(`q=${encodeURIComponent('அன்பு')}`))).toEqual(['Anbu'])
      expect(names(await get(`q=${phone.slice(2, 8)}`))).toEqual(['Anbu'])
      expect(names(await get(`q=${encodeURIComponent(`0${phone}`)}`))).toEqual(['Anbu'])
      expect(names(await get('q=33balpt'))).toEqual(['Bala Traders'])
      expect(names(await get('q=%25'))).toEqual([])
    })

    it('filters by dues, credit, overdue, tag, type, active and ids', async () => {
      expect(names(await get('has_due=true'))).toEqual(['Anbu', 'Bala Traders', 'Dinesh'])
      expect(names(await get('credit=true'))).toEqual(['Chitra'])
      expect(names(await get('overdue=true'))).toEqual(['Anbu'])
      expect(names(await get('tag=VIP'))).toEqual(['Anbu', 'Chitra'])
      expect(names(await get('customer_type=business'))).toEqual(['Bala Traders'])
      expect(names(await get(`ids=${ids.chitra},${ids.dinesh}`))).toEqual(['Chitra', 'Dinesh'])
      expect(names(await get(`ids=${ids.chitra}&ids=${ids.anbu}`))).toEqual(['Anbu', 'Chitra'])
      await list.inject({
        method: 'PATCH',
        url: api(`/customers/${ids.dinesh}`),
        payload: { is_active: false },
      })
      expect(names(await get('is_active=false'))).toEqual(['Dinesh'])
      expect((await get('is_active=true')).page.total).toBe(3)
      await list.inject({
        method: 'PATCH',
        url: api(`/customers/${ids.dinesh}`),
        payload: { is_active: true },
      })
    })

    it('sorts by balance and by last visit', async () => {
      expect(names(await get('sort=-balance_paise'))).toEqual([
        'Bala Traders',
        'Anbu',
        'Dinesh',
        'Chitra',
      ])
      const byVisit = names(await get('sort=-last_invoice_at'))
      expect(byVisit.slice(0, 2)).toEqual(['Chitra', 'Anbu'])
      expect(byVisit.slice(2).sort()).toEqual(['Bala Traders', 'Dinesh'].sort())
      const bad = await list.inject({ method: 'GET', url: api('/customers?sort=phone') })
      expect(bad.statusCode).toBe(400)
    })

    it('never shows another tenant’s customers', async () => {
      const foreign = await create({ name: 'Anbu Foreign' }, other)
      expect(names(await get('q=anbu'))).toEqual(['Anbu'])
      const res = await list.inject({ method: 'GET', url: api(`/customers/${foreign.id}`) })
      expect(res.statusCode).toBe(404)
      const patch = await list.inject({
        method: 'PATCH',
        url: api(`/customers/${foreign.id}`),
        payload: { name: 'Hijack' },
      })
      expect(patch.statusCode).toBe(404)
      const del = await list.inject({ method: 'DELETE', url: api(`/customers/${foreign.id}`) })
      expect(del.statusCode).toBe(404)
      expect(names(await get(`ids=${foreign.id}`))).toEqual([])
    })
  })

  it('deletes a customer without history and deactivates one with history', async () => {
    const fresh = await create({ name: 'Never used' })
    const del = expectStatus<Data<{ id: string; result: string }>>(
      await shop.inject({ method: 'DELETE', url: api(`/customers/${fresh.id}`) }),
      200,
    )
    expect(del.data).toEqual({ id: fresh.id, result: 'deleted' })
    expect(
      (await shop.inject({ method: 'GET', url: api(`/customers/${fresh.id}`) })).statusCode,
    ).toBe(404)

    const used = await create({ name: 'Has khata', opening_balance_paise: 100 })
    const res = expectStatus<Data<{ id: string; result: string }>>(
      await shop.inject({ method: 'DELETE', url: api(`/customers/${used.id}`) }),
      200,
    )
    expect(res.data.result).toBe('deactivated')
    const after = expectStatus<Data<Customer>>(
      await shop.inject({ method: 'GET', url: api(`/customers/${used.id}`) }),
      200,
    )
    expect(after.data).toMatchObject({ is_active: false, balance_paise: 100 })
    expect(await auditActions(t, shop, used.id)).toContain('customer.deactivate')
  })

  it('enforces customers.read / customers.write', async () => {
    const c = await create({ name: 'Perms' })
    for (const [method, url, payload] of [
      ['GET', api('/customers'), undefined],
      ['GET', api(`/customers/${c.id}`), undefined],
      ['GET', api(`/customers/${c.id}/ledger`), undefined],
      ['GET', api(`/customers/${c.id}/summary`), undefined],
      ['POST', api('/customers'), { name: 'No' }],
      ['PATCH', api(`/customers/${c.id}`), { name: 'No' }],
      ['DELETE', api(`/customers/${c.id}`), undefined],
    ] as const) {
      const res = await shop.inject({ method, url, payload, as: clerk })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
      expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN')
    }
    const accountant = await shop.asRole('accountant')
    expect(
      (await shop.inject({ method: 'GET', url: api('/customers'), as: accountant })).statusCode,
    ).toBe(200)
    expect(
      (
        await shop.inject({
          method: 'POST',
          url: api('/customers'),
          payload: { name: 'No' },
          as: accountant,
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (await shop.inject({ method: 'GET', url: api('/customers'), as: null })).statusCode,
    ).toBe(401)
  })
})
