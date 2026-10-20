import { newId } from '@kadai/shared'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Tx } from '../db/tenant'
import { type TestApp, buildTestApp } from '../test/helpers'
import { type TestShop, createTestTenant, insertTestCustomer } from '../test/tenants'
import { isAppError } from './errors'
import {
  adjustPoints,
  earnPoints,
  expirePoints,
  redeemPoints,
  reversePoints,
  reversiblePoints,
} from './loyalty'

/** Σ ledger points vs the stored balance of a customer. */
async function balances(tx: Tx, tenantId: string, customerId: string) {
  const ledger = await sql<{ total: string }>`
    select coalesce(sum(points), 0)::bigint as total from loyalty_ledger
     where tenant_id = ${tenantId} and customer_id = ${customerId}`.execute(tx)
  const row = await tx
    .selectFrom('customers')
    .select('loyalty_points')
    .where('id', '=', customerId)
    .executeTakeFirstOrThrow()
  return { ledger: Number(ledger.rows[0]?.total ?? 0), stored: Number(row.loyalty_points) }
}

async function expectReason(promise: Promise<unknown>, reason: string, code = 'UNPROCESSABLE') {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(isAppError(err), String(err)).toBe(true)
  if (isAppError(err)) {
    expect(err.code).toBe(code)
    if (reason) expect(err.details?.reason).toBe(reason)
  }
}

describe('core/loyalty', () => {
  let t: TestApp
  let shop: TestShop
  let plain: TestShop

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t, {
      settings: {
        loyalty: {
          enabled: true,
          points_per_100_rupees: 1,
          point_value_paise: 100,
          min_redeem_points: 10,
        },
      },
    })
    plain = await createTestTenant(t)
  })
  afterAll(() => t.close())

  const ref = () => ({ ref_type: 'sales_invoice', ref_id: newId() })

  it('records nothing while loyalty is disabled', async () => {
    const c = await insertTestCustomer(t.deps, plain.tenant.id)
    const res = await plain.tx((tx) =>
      earnPoints(tx, plain.ctx, { customer_id: c.id, amount_paise: 1_000_000, ...ref() }),
    )
    expect(res).toEqual({ entry_id: null, points: 0, balance: 0 })
    await expectReason(
      plain.tx((tx) => redeemPoints(tx, plain.ctx, { customer_id: c.id, points: 10, ...ref() })),
      'loyalty_disabled',
    )
  })

  it('earns from the bill amount, idempotently per document', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id)
    const doc = ref()
    const first = await shop.tx((tx) =>
      earnPoints(tx, shop.ctx, { customer_id: c.id, amount_paise: 123_456, ...doc }),
    )
    expect(first).toMatchObject({ points: 12, balance: 12 })
    expect(first.entry_id).toBeTruthy()
    const again = await shop.tx((tx) =>
      earnPoints(tx, shop.ctx, { customer_id: c.id, amount_paise: 123_456, ...doc }),
    )
    expect(again).toEqual({ entry_id: first.entry_id, points: 0, balance: 12 })
    const small = await shop.tx((tx) =>
      earnPoints(tx, shop.ctx, { customer_id: c.id, amount_paise: 9_999, ...ref() }),
    )
    expect(small).toEqual({ entry_id: null, points: 0, balance: 12 })
    const explicit = await shop.tx((tx) =>
      earnPoints(tx, shop.ctx, { customer_id: c.id, points: 8, ...ref() }),
    )
    expect(explicit.balance).toBe(20)
    expect(await shop.tx((tx) => balances(tx, shop.tenant.id, c.id))).toEqual({
      ledger: 20,
      stored: 20,
    })
  })

  it('redeems within balance, minimum and bill value', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id)
    await shop.tx((tx) => earnPoints(tx, shop.ctx, { customer_id: c.id, points: 50, ...ref() }))
    await expectReason(
      shop.tx((tx) => redeemPoints(tx, shop.ctx, { customer_id: c.id, points: 5, ...ref() })),
      'loyalty_below_minimum',
    )
    await expectReason(
      shop.tx((tx) => redeemPoints(tx, shop.ctx, { customer_id: c.id, points: 60, ...ref() })),
      'loyalty_insufficient',
    )
    await expectReason(
      shop.tx((tx) =>
        redeemPoints(tx, shop.ctx, {
          customer_id: c.id,
          points: 30,
          bill_total_paise: 2_500,
          ...ref(),
        }),
      ),
      'loyalty_exceeds_bill',
    )
    const res = await shop.tx((tx) =>
      redeemPoints(tx, shop.ctx, {
        customer_id: c.id,
        points: 30,
        bill_total_paise: 10_000,
        ...ref(),
      }),
    )
    expect(res).toMatchObject({ points: -30, balance: 20, value_paise: 3_000 })
    await expectReason(
      shop.tx((tx) => redeemPoints(tx, shop.ctx, { customer_id: c.id, points: -5, ...ref() })),
      '',
      'VALIDATION_ERROR',
    )
    expect(await shop.tx((tx) => balances(tx, shop.tenant.id, c.id))).toEqual({
      ledger: 20,
      stored: 20,
    })
  })

  it('reverses a cancelled bill: gives back redeemed, takes back earned; repeat is a no-op', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id)
    await shop.tx((tx) => earnPoints(tx, shop.ctx, { customer_id: c.id, points: 40, ...ref() }))
    const bill = ref()
    await shop.tx(async (tx) => {
      await redeemPoints(tx, shop.ctx, { customer_id: c.id, points: 20, ...bill })
      await earnPoints(tx, shop.ctx, { customer_id: c.id, points: 15, ...bill })
    })
    expect(
      await shop.tx((tx) => reversiblePoints(tx, shop.ctx, { customer_id: c.id, ...bill })),
    ).toEqual({
      earned: 15,
      redeemed: 20,
    })
    const res = await shop.tx((tx) => reversePoints(tx, shop.ctx, { customer_id: c.id, ...bill }))
    expect(res).toMatchObject({
      restored_points: 20,
      removed_points: 15,
      shortfall_points: 0,
      balance: 40,
    })
    expect(res.entries.map((e) => e.points)).toEqual([20, -15])
    const again = await shop.tx((tx) => reversePoints(tx, shop.ctx, { customer_id: c.id, ...bill }))
    expect(again).toMatchObject({ entries: [], restored_points: 0, removed_points: 0, balance: 40 })
    expect(await shop.tx((tx) => balances(tx, shop.tenant.id, c.id))).toEqual({
      ledger: 40,
      stored: 40,
    })
  })

  it('partial reversal (returns) and clamping of points already spent', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id)
    const bill = ref()
    await shop.tx((tx) => earnPoints(tx, shop.ctx, { customer_id: c.id, points: 30, ...bill }))
    const partial = await shop.tx((tx) =>
      reversePoints(tx, shop.ctx, {
        customer_id: c.id,
        ...bill,
        earned_points: 10,
        notes: 'CN for 1 item',
      }),
    )
    expect(partial).toMatchObject({ removed_points: 10, balance: 20 })
    // The customer spends 15 of the remaining 20 on another bill …
    await shop.tx((tx) => redeemPoints(tx, shop.ctx, { customer_id: c.id, points: 15, ...ref() }))
    // … then the original bill is cancelled: 20 earned left to take back, only 5 available.
    const full = await shop.tx((tx) => reversePoints(tx, shop.ctx, { customer_id: c.id, ...bill }))
    expect(full).toMatchObject({ removed_points: 5, shortfall_points: 15, balance: 0 })
    expect(await shop.tx((tx) => balances(tx, shop.tenant.id, c.id))).toEqual({
      ledger: 0,
      stored: 0,
    })
  })

  it('manual adjustments are audited and never go below zero', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id)
    const up = await shop.tx((tx) =>
      adjustPoints(tx, shop.ctx, {
        customer_id: c.id,
        points: 25,
        notes: 'Migrated from old card',
      }),
    )
    expect(up.balance).toBe(25)
    await expectReason(
      shop.tx((tx) =>
        adjustPoints(tx, shop.ctx, { customer_id: c.id, points: -26, notes: 'Too much' }),
      ),
      'loyalty_insufficient',
    )
    await expectReason(
      shop.tx((tx) => adjustPoints(tx, shop.ctx, { customer_id: c.id, points: 5, notes: '  ' })),
      '',
      'VALIDATION_ERROR',
    )
    const down = await shop.tx((tx) =>
      adjustPoints(tx, shop.ctx, { customer_id: c.id, points: -25, notes: 'Correction' }),
    )
    expect(down.balance).toBe(0)
    const audits = await shop.tx((tx) =>
      tx
        .selectFrom('audit_logs')
        .select(['action', 'changes'])
        .where('entity_id', '=', c.id)
        .where('action', '=', 'customer.loyalty_adjust')
        .execute(),
    )
    expect(audits).toHaveLength(2)
    const kinds = await shop.tx((tx) =>
      tx.selectFrom('loyalty_ledger').select('kind').where('customer_id', '=', c.id).execute(),
    )
    expect(kinds.map((k) => k.kind)).toEqual(['adjust', 'adjust'])
  })

  it('expiry is clamped to the balance', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id)
    await shop.tx((tx) => earnPoints(tx, shop.ctx, { customer_id: c.id, points: 12, ...ref() }))
    const res = await shop.tx((tx) => expirePoints(tx, shop.ctx, { customer_id: c.id, points: 50 }))
    expect(res).toMatchObject({ points: -12, balance: 0 })
    expect(
      (await shop.tx((tx) => expirePoints(tx, shop.ctx, { customer_id: c.id, points: 5 })))
        .entry_id,
    ).toBeNull()
  })

  it('concurrent redemptions serialise on the customer row and never go negative', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id)
    await shop.tx((tx) => earnPoints(tx, shop.ctx, { customer_id: c.id, points: 30, ...ref() }))
    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        shop.tx((tx) => redeemPoints(tx, shop.ctx, { customer_id: c.id, points: 20, ...ref() })),
      ),
    )
    const fulfilled = attempts.filter((a) => a.status === 'fulfilled')
    const rejected = attempts.filter((a): a is PromiseRejectedResult => a.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(3)
    for (const r of rejected) {
      expect(isAppError(r.reason) && r.reason.details?.reason).toBe('loyalty_insufficient')
    }
    expect(await shop.tx((tx) => balances(tx, shop.tenant.id, c.id))).toEqual({
      ledger: 10,
      stored: 10,
    })
  })

  it('concurrent earn + redeem keep the ledger and balance equal', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id)
    await shop.tx((tx) => earnPoints(tx, shop.ctx, { customer_id: c.id, points: 100, ...ref() }))
    await Promise.all([
      ...Array.from({ length: 5 }, () =>
        shop.tx((tx) => earnPoints(tx, shop.ctx, { customer_id: c.id, points: 3, ...ref() })),
      ),
      ...Array.from({ length: 5 }, () =>
        shop.tx((tx) => redeemPoints(tx, shop.ctx, { customer_id: c.id, points: 10, ...ref() })),
      ),
    ])
    expect(await shop.tx((tx) => balances(tx, shop.tenant.id, c.id))).toEqual({
      ledger: 65,
      stored: 65,
    })
  })

  it("cannot touch another tenant's customer", async () => {
    const other = await insertTestCustomer(t.deps, plain.tenant.id)
    await expectReason(
      shop.tx((tx) => earnPoints(tx, shop.ctx, { customer_id: other.id, points: 5, ...ref() })),
      '',
      'NOT_FOUND',
    )
  })
})
