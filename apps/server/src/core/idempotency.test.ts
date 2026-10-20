import { newId } from '@kadai/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTenant } from '../db/tenant'
import { fixtureModule } from '../test/fixture-module'
import {
  type TestApp,
  type TestTenant,
  bearer,
  buildTestApp,
  insertTestTenant,
  signTestToken,
} from '../test/helpers'
import { systemContext } from './context'
import { requestHash, runIdempotent } from './idempotency'

describe('idempotency (in-transaction keys)', () => {
  let t: TestApp
  let shop: TestTenant
  let token: string

  beforeAll(async () => {
    t = await buildTestApp({ modules: [fixtureModule] })
    shop = await insertTestTenant(t.deps.db.systemDb)
    token = await signTestToken(t.deps, shop.owner)
  })
  afterAll(() => t.close())

  const post = (payload: unknown, key?: string) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/__test/brands',
      headers: { ...bearer(token), ...(key ? { 'idempotency-key': key } : {}) },
      payload: payload as Record<string, unknown>,
    })

  it('replays the stored response for the same key and body', async () => {
    const key = `key-${newId()}`
    const first = await post({ name: 'Idhayam' }, key)
    expect(first.statusCode).toBe(201)
    expect(first.headers['idempotent-replayed']).toBe('false')
    const second = await post({ name: 'Idhayam' }, key)
    expect(second.statusCode).toBe(201)
    expect(second.headers['idempotent-replayed']).toBe('true')
    expect(second.json()).toEqual(first.json())
    const count = await t.deps.db.systemDb
      .selectFrom('brands')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('tenant_id', '=', shop.tenant.id)
      .where('name', '=', 'Idhayam')
      .executeTakeFirstOrThrow()
    expect(Number(count.n)).toBe(1)
  })

  it('uses body client_ref as the key', async () => {
    const ref = `pos-${newId()}`
    const a = await post({ name: 'Gold Winner', client_ref: ref })
    const b = await post({ name: 'Gold Winner', client_ref: ref })
    expect(a.statusCode).toBe(201)
    expect(b.headers['idempotent-replayed']).toBe('true')
  })

  it('rejects the same key with a different body (409 IDEMPOTENCY_MISMATCH)', async () => {
    const key = `key-${newId()}`
    expect((await post({ name: 'Cavin' }, key)).statusCode).toBe(201)
    const res = await post({ name: 'Cavins' }, key)
    expect(res.statusCode).toBe(409)
    expect(res.json<{ error: { code: string } }>().error.code).toBe('IDEMPOTENCY_MISMATCH')
  })

  it('does not keep the key when the work fails (retry runs again)', async () => {
    const key = `key-${newId()}`
    expect((await post({ name: 'Dup Brand' })).statusCode).toBe(201)
    const failed = await post({ name: 'Dup Brand' }, key) // unique violation → rolled back
    expect(failed.statusCode).toBe(409)
    expect(failed.json<{ error: { code: string } }>().error.code).toBe('DUPLICATE')
    const row = await t.deps.db.systemDb
      .selectFrom('idempotency_keys')
      .select('key')
      .where('tenant_id', '=', shop.tenant.id)
      .where('key', '=', key)
      .executeTakeFirst()
    expect(row).toBeUndefined()
  })

  it('a concurrent duplicate blocks until the first commits, then replays', async () => {
    const ctx = systemContext(shop.tenant.id)
    const key = `key-${newId()}`
    const hash = requestHash({ n: 1 })
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let workRuns = 0
    const first = withTenant(t.deps.db.appDb, ctx, (tx) =>
      runIdempotent(tx, ctx, { key, method: 'POST', path: '/x', requestHash: hash }, async () => {
        workRuns++
        await gate
        return { status: 201, body: { id: 'first' } }
      }),
    )
    // Give the first transaction time to insert its 'processing' row.
    await new Promise((r) => setTimeout(r, 100))
    let secondDone = false
    const second = withTenant(t.deps.db.appDb, ctx, (tx) =>
      runIdempotent(tx, ctx, { key, method: 'POST', path: '/x', requestHash: hash }, async () => {
        workRuns++
        return { status: 201, body: { id: 'second' } }
      }),
    ).finally(() => {
      secondDone = true
    })
    await new Promise((r) => setTimeout(r, 200))
    expect(secondDone).toBe(false) // blocked on the unique index
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual({ status: 201, body: { id: 'first' }, replayed: false })
    expect(b).toEqual({ status: 201, body: { id: 'first' }, replayed: true })
    expect(workRuns).toBe(1)
  })

  it('a concurrent duplicate takes over when the first rolls back', async () => {
    const ctx = systemContext(shop.tenant.id)
    const key = `key-${newId()}`
    const hash = requestHash({ n: 2 })
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const first = withTenant(t.deps.db.appDb, ctx, (tx) =>
      runIdempotent(tx, ctx, { key, method: 'POST', path: '/x', requestHash: hash }, async () => {
        await gate
        throw new Error('boom')
      }),
    )
    await new Promise((r) => setTimeout(r, 100))
    const second = withTenant(t.deps.db.appDb, ctx, (tx) =>
      runIdempotent(tx, ctx, { key, method: 'POST', path: '/x', requestHash: hash }, async () => ({
        status: 201,
        body: { id: 'second' },
      })),
    )
    release()
    await expect(first).rejects.toThrow('boom')
    await expect(second).resolves.toEqual({ status: 201, body: { id: 'second' }, replayed: false })
  })

  it('requestHash is independent of key order', () => {
    expect(requestHash({ a: 1, b: { c: 2, d: 3 } })).toBe(requestHash({ b: { d: 3, c: 2 }, a: 1 }))
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }))
  })
})
