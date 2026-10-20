import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant } from '../db/tenant'
import { closeTestDb, insertTestTenant, testDb, type TestTenant } from '../test/helpers'
import { systemContext } from './context'
import { CHANNELS, EventBus, notify } from './events'

describe('events (LISTEN/NOTIFY)', () => {
  let bus: EventBus
  let shop: TestTenant

  beforeAll(async () => {
    bus = new EventBus({ pool: testDb().systemPool })
    await bus.start()
    shop = await insertTestTenant(testDb().systemDb)
  })
  afterAll(async () => {
    await bus.stop()
    await closeTestDb()
  })

  function collect(marker: string) {
    const got: unknown[] = []
    const unsubscribe = bus.subscribe(CHANNELS.paymentIntents, (p) => {
      if ((p as { marker?: string }).marker === marker) got.push(p)
    })
    return { got, unsubscribe }
  }

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('delivers notifications sent inside a committed tenant transaction (app role)', async () => {
    const marker = `commit-${Date.now()}`
    const { got, unsubscribe } = collect(marker)
    await withTenant(testDb().appDb, systemContext(shop.tenant.id), async (tx) => {
      await notify(tx, CHANNELS.paymentIntents, {
        tenant_id: shop.tenant.id,
        intent_id: 'i1',
        status: 'paid',
        marker,
      })
      await wait(100)
      // Not delivered before COMMIT.
      expect(got).toHaveLength(0)
    })
    await expect.poll(() => got.length, { timeout: 3000 }).toBe(1)
    expect(got[0]).toEqual({ tenant_id: shop.tenant.id, intent_id: 'i1', status: 'paid', marker })
    unsubscribe()
  })

  it('does not deliver notifications of rolled-back transactions', async () => {
    const marker = `rollback-${Date.now()}`
    const { got, unsubscribe } = collect(marker)
    await expect(
      withTenant(testDb().appDb, systemContext(shop.tenant.id), async (tx) => {
        await notify(tx, CHANNELS.paymentIntents, { marker })
        throw new Error('abort')
      }),
    ).rejects.toThrow('abort')
    await wait(300)
    expect(got).toHaveLength(0)
    unsubscribe()
  })

  it('unsubscribe stops delivery; other subscribers keep receiving', async () => {
    const marker = `unsub-${Date.now()}`
    const a = collect(marker)
    const b = collect(marker)
    a.unsubscribe()
    await notify(testDb().systemDb, CHANNELS.paymentIntents, { marker })
    await expect.poll(() => b.got.length, { timeout: 3000 }).toBe(1)
    expect(a.got).toHaveLength(0)
    b.unsubscribe()
  })

  it('rejects oversized payloads and unknown channels', async () => {
    await expect(
      notify(testDb().systemDb, CHANNELS.cache, { big: 'x'.repeat(9000) }),
    ).rejects.toThrow(RangeError)
    await expect(notify(testDb().systemDb, 'nope' as typeof CHANNELS.cache, {})).rejects.toThrow(
      /unknown event channel/,
    )
  })

  it('reconnects after the LISTEN connection drops', async () => {
    const reconnecting = new EventBus({ pool: testDb().systemPool, minBackoffMs: 50 })
    await reconnecting.start()
    try {
      expect(reconnecting.connected).toBe(true)
      const pid = reconnecting.backendPid
      expect(pid).toBeTypeOf('number')
      // Terminate exactly this bus's connection (other test files have their own).
      await testDb().systemPool.query('SELECT pg_terminate_backend($1)', [pid])
      await expect.poll(() => reconnecting.connected, { timeout: 3000 }).toBe(false)
      await reconnecting.waitUntilConnected(5000)
      const marker = `reconnect-${Date.now()}`
      const got: unknown[] = []
      reconnecting.subscribe(CHANNELS.cache, (p) => {
        if ((p as { marker?: string }).marker === marker) got.push(p)
      })
      await notify(testDb().systemDb, CHANNELS.cache, { marker })
      await expect.poll(() => got.length, { timeout: 3000 }).toBe(1)
    } finally {
      await reconnecting.stop()
    }
  })
})
