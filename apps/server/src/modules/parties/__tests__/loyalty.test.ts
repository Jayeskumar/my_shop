/**
 * Loyalty endpoints (feature `loyalty`): points ledger with running balance, manual adjustments
 * (audited, never below zero — also under concurrency), feature gating and permissions.
 */
import { newId } from '@kadai/shared'
import type { Customer, LoyaltyAdjustResult, LoyaltyEntry } from '@kadai/shared/api/parties'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { earnPoints, redeemPoints } from '../../../core/loyalty'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import { api, auditActions, expectStatus, insertInvoice } from './fixtures'

type Data<T> = { data: T }
type List<T> = { data: T[]; page: { limit: number; offset: number; total: number } }

describe('parties: loyalty', () => {
  let t: TestApp
  let shop: TestShop
  let free: TestShop

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t, {
      settings: { loyalty: { enabled: true, min_redeem_points: 10, point_value_paise: 100 } },
    })
    free = await createTestTenant(t, { plan_code: 'free' })
  })
  afterAll(() => t.close())

  const newCustomer = async (s: TestShop = shop) =>
    expectStatus<Data<Customer>>(
      await s.inject({ method: 'POST', url: api('/customers'), payload: { name: 'Loyal' } }),
      201,
    ).data

  const adjust = (id: string, points: number, notes = 'Correction') =>
    shop.inject({
      method: 'POST',
      url: api(`/customers/${id}/loyalty/adjust`),
      payload: { points, notes },
    })

  const ledgerSum = async (id: string) => {
    const res = await sql<{ total: string }>`select coalesce(sum(points), 0)::bigint as total
      from loyalty_ledger where customer_id = ${id}`.execute(t.deps.db.systemDb)
    return Number(res.rows[0]?.total ?? 0)
  }

  it('lists the points ledger newest first with balance after each entry', async () => {
    const c = await newCustomer()
    const inv = await insertInvoice(t, shop, {
      customer_id: c.id,
      invoice_date: '2026-10-01',
      total_paise: 50_000,
    })
    await shop.tx((tx) =>
      earnPoints(tx, shop.ctx, {
        customer_id: c.id,
        points: 50,
        ref_type: 'sales_invoice',
        ref_id: inv.id,
      }),
    )
    await shop.tx((tx) =>
      redeemPoints(tx, shop.ctx, {
        customer_id: c.id,
        points: 20,
        ref_type: 'sales_invoice',
        ref_id: newId(),
      }),
    )
    const adj = expectStatus<Data<LoyaltyAdjustResult>>(
      await adjust(c.id, 5, 'Festival bonus'),
      200,
    )
    expect(adj.data).toMatchObject({ customer_id: c.id, loyalty_points: 35 })
    expect(adj.data.entry).toMatchObject({
      points: 5,
      kind: 'adjust',
      notes: 'Festival bonus',
      balance_after: 35,
      created_by: shop.owner.user.id,
      created_by_name: shop.owner.user.full_name,
    })

    const list = expectStatus<List<LoyaltyEntry>>(
      await shop.inject({ method: 'GET', url: api(`/customers/${c.id}/loyalty`) }),
      200,
    )
    expect(list.page.total).toBe(3)
    expect(list.data.map((e) => [e.kind, e.points, e.balance_after])).toEqual([
      ['adjust', 5, 35],
      ['redeem', -20, 30],
      ['earn', 50, 50],
    ])
    expect(list.data[2]!.ref_number).toBe(inv.number)

    const earned = expectStatus<List<LoyaltyEntry>>(
      await shop.inject({ method: 'GET', url: api(`/customers/${c.id}/loyalty?kind=earn`) }),
      200,
    )
    expect(earned.page.total).toBe(1)
    expect(earned.data[0]!.balance_after).toBe(50)
    const paged = expectStatus<List<LoyaltyEntry>>(
      await shop.inject({
        method: 'GET',
        url: api(`/customers/${c.id}/loyalty?limit=1&offset=1`),
      }),
      200,
    )
    expect(paged.data.map((e) => e.kind)).toEqual(['redeem'])
    expect(await auditActions(t, shop, c.id)).toContain('customer.loyalty_adjust')
  })

  it('never lets an adjustment take the balance below zero', async () => {
    const c = await newCustomer()
    expectStatus(await adjust(c.id, 30), 200)
    const res = await adjust(c.id, -31)
    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body).error.details).toMatchObject({
      reason: 'loyalty_insufficient',
      balance_points: 30,
    })
    expectStatus(await adjust(c.id, -30), 200)
    const customer = expectStatus<Data<Customer>>(
      await shop.inject({ method: 'GET', url: api(`/customers/${c.id}`) }),
      200,
    )
    expect(customer.data.loyalty_points).toBe(0)
  })

  it('applies a retried adjustment once (Idempotency-Key)', async () => {
    const c = await newCustomer()
    const key = `adj-${newId()}`
    const send = (points: number) =>
      shop.inject({
        method: 'POST',
        url: api(`/customers/${c.id}/loyalty/adjust`),
        payload: { points, notes: 'Festival bonus' },
        headers: { 'idempotency-key': key },
      })
    const first = expectStatus<Data<LoyaltyAdjustResult>>(await send(40), 200)
    const retry = await send(40)
    expect(retry.statusCode).toBe(200)
    expect(retry.headers['idempotent-replayed']).toBe('true')
    expect(JSON.parse(retry.body).data.entry.id).toBe(first.data.entry.id)
    expect(await ledgerSum(c.id)).toBe(40)
    // The same key with another body is a client bug, not a second adjustment.
    expect((await send(41)).statusCode).toBe(409)
    expect(await ledgerSum(c.id)).toBe(40)
  })

  it('validates the adjustment body', async () => {
    const c = await newCustomer()
    expect((await adjust(c.id, 0)).statusCode).toBe(400)
    expect((await adjust(c.id, 10, '  ')).statusCode).toBe(400)
    const missing = await adjust(newId(), 10)
    expect(missing.statusCode).toBe(404)
  })

  it('stays non-negative and consistent under concurrent debits', async () => {
    const c = await newCustomer()
    expectStatus(await adjust(c.id, 100), 200)
    const results = await Promise.all(Array.from({ length: 10 }, () => adjust(c.id, -15)))
    const ok = results.filter((r) => r.statusCode === 200).length
    const refused = results.filter((r) => r.statusCode === 422).length
    expect(ok).toBe(6)
    expect(refused).toBe(4)
    const stored = expectStatus<Data<Customer>>(
      await shop.inject({ method: 'GET', url: api(`/customers/${c.id}`) }),
      200,
    ).data.loyalty_points
    expect(stored).toBe(10)
    expect(await ledgerSum(c.id)).toBe(10)
    const list = expectStatus<List<LoyaltyEntry>>(
      await shop.inject({ method: 'GET', url: api(`/customers/${c.id}/loyalty?limit=200`) }),
      200,
    )
    expect(list.data.every((e) => e.balance_after >= 0)).toBe(true)
    expect(list.data[0]!.balance_after).toBe(10)
  })

  it('is a plan feature: free plans get 402 while customers still work', async () => {
    const c = await newCustomer(free)
    const read = await free.inject({ method: 'GET', url: api(`/customers/${c.id}/loyalty`) })
    expect(read.statusCode).toBe(402)
    expect(JSON.parse(read.body).error).toMatchObject({
      code: 'FEATURE_NOT_IN_PLAN',
      details: { feature: 'loyalty' },
    })
    const write = await free.inject({
      method: 'POST',
      url: api(`/customers/${c.id}/loyalty/adjust`),
      payload: { points: 5, notes: 'x' },
    })
    expect(write.statusCode).toBe(402)
    const get = await free.inject({ method: 'GET', url: api(`/customers/${c.id}`) })
    expect(get.statusCode).toBe(200)
  })

  it('checks permissions and tenant isolation', async () => {
    const c = await newCustomer()
    const accountant = await shop.asRole('accountant')
    const read = await shop.inject({
      method: 'GET',
      url: api(`/customers/${c.id}/loyalty`),
      as: accountant,
    })
    expect(read.statusCode).toBe(200)
    const write = await shop.inject({
      method: 'POST',
      url: api(`/customers/${c.id}/loyalty/adjust`),
      payload: { points: 5, notes: 'x' },
      as: accountant,
    })
    expect(write.statusCode).toBe(403)
    const other = await createTestTenant(t)
    const foreign = await other.inject({
      method: 'POST',
      url: api(`/customers/${c.id}/loyalty/adjust`),
      payload: { points: 5, notes: 'x' },
    })
    expect(foreign.statusCode).toBe(404)
    const foreignRead = await other.inject({
      method: 'GET',
      url: api(`/customers/${c.id}/loyalty`),
    })
    expect(foreignRead.statusCode).toBe(404)
  })
})
