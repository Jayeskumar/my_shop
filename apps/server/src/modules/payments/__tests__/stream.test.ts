/**
 * Live intent status: the SSE stream sends the intent at once, pushes the paid status delivered
 * by NOTIFY kadai_payment_intents (markIntentPaid inside the transaction) and closes on a
 * terminal status; streams are authenticated and tenant-checked.
 */
import { newId } from '@kadai/shared'
import { type PaymentIntent, INTENT_STREAM_EVENT } from '@kadai/shared/api/payments'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CHANNELS } from '../../../core/events'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import {
  type Data,
  api,
  closeOpenIntents,
  createUpiAccount,
  expectError,
  expectStatus,
} from './fixtures'

function parseSse(body: string): Array<{ event: string; data: PaymentIntent }> {
  return body
    .split('\n\n')
    .map((block) => {
      const lines = block.split('\n')
      const event = lines.find((l) => l.startsWith('event: '))?.slice(7)
      const data = lines.find((l) => l.startsWith('data: '))?.slice(6)
      return event && data ? { event, data: JSON.parse(data) as PaymentIntent } : null
    })
    .filter((e): e is { event: string; data: PaymentIntent } => e !== null)
}

describe('payments: intent stream (SSE)', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop

  beforeAll(async () => {
    t = await buildTestApp()
    await t.deps.events.waitUntilConnected()
    shop = await createTestTenant(t)
    other = await createTestTenant(t)
    await createUpiAccount(shop)
  })
  afterAll(async () => {
    await closeOpenIntents(t, [shop])
    await t.close()
  })

  const newIntent = async () =>
    expectStatus<Data<PaymentIntent>>(
      await shop.inject({
        method: 'POST',
        url: api('/payments/intents'),
        payload: { purpose: 'pos_sale', store_id: shop.store.id, amount_paise: 4_200 },
      }),
      201,
    ).data

  it('streams the current status, then the paid status, and closes', async () => {
    const intent = await newIntent()
    const notified: unknown[] = []
    const unsubscribe = t.deps.events.subscribe(CHANNELS.paymentIntents, (p) => {
      notified.push(p)
    })
    const stream = shop.inject({ method: 'GET', url: api(`/payments/intents/${intent.id}/stream`) })
    await new Promise((r) => setTimeout(r, 400))
    expectStatus(
      await shop.inject({
        method: 'POST',
        url: api(`/payments/intents/${intent.id}/confirm`),
        payload: { utr: '700012345678' },
      }),
      200,
    )
    const res = await stream
    unsubscribe()
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.headers['cache-control']).toBe('no-store')
    const events = parseSse(res.body)
    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(events.every((e) => e.event === INTENT_STREAM_EVENT)).toBe(true)
    expect(events[0]?.data).toMatchObject({ id: intent.id, status: 'pending' })
    expect(events[events.length - 1]?.data).toMatchObject({
      id: intent.id,
      status: 'paid',
      utr: '700012345678',
    })
    expect(notified).toContainEqual({
      tenant_id: shop.tenant.id,
      intent_id: intent.id,
      status: 'paid',
    })
  })

  it('closes at once for a terminal intent', async () => {
    const intent = await newIntent()
    expectStatus(
      await shop.inject({
        method: 'POST',
        url: api(`/payments/intents/${intent.id}/cancel`),
        payload: {},
      }),
      200,
    )
    const res = await shop.inject({
      method: 'GET',
      url: api(`/payments/intents/${intent.id}/stream`),
    })
    const events = parseSse(res.body)
    expect(events).toHaveLength(1)
    expect(events[0]?.data.status).toBe('cancelled')
  })

  it('requires authentication, permission and the right tenant', async () => {
    const intent = await newIntent()
    expectError(
      await shop.inject({
        method: 'GET',
        url: api(`/payments/intents/${intent.id}/stream`),
        as: null,
      }),
      401,
      'UNAUTHENTICATED',
    )
    expectError(
      await other.inject({ method: 'GET', url: api(`/payments/intents/${intent.id}/stream`) }),
      404,
      'NOT_FOUND',
    )
    expectError(
      await shop.inject({ method: 'GET', url: api(`/payments/intents/${newId()}/stream`) }),
      404,
      'NOT_FOUND',
    )
    const clerk = await shop.asRole('inventory_clerk')
    expectError(
      await shop.inject({
        method: 'GET',
        url: api(`/payments/intents/${intent.id}/stream`),
        as: clerk,
      }),
      403,
      'FORBIDDEN',
    )
    // Close the remaining open intent so nothing streams on.
    expectStatus(
      await shop.inject({
        method: 'POST',
        url: api(`/payments/intents/${intent.id}/cancel`),
        payload: {},
      }),
      200,
    )
  })
})
