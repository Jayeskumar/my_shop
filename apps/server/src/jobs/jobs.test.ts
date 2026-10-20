import { newId } from '@kadai/shared'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { systemContext } from '../core/context'
import { enqueue } from '../core/jobs'
import { type KadaiDeps, createDeps, destroyDeps, installRuntime } from '../core/runtime'
import { withTenant } from '../db/tenant'
import { createMemoryOtpSender } from '../core/otp'
import { getTestConfig, insertTestTenant, randomPhone } from '../test/helpers'
import { runCleanup } from './core-jobs'
import { JOB_DEFINITIONS, buildRegistry } from './registry'
import { type KadaiJob, defineJob } from './types'
import { type RunningWorker, startWorker } from './worker-runtime'

const suffix = newId().slice(-8)
const seen: Array<{ name: string; data: Record<string, unknown>; retry: number }> = []
let failOnce = true

const testJobs: KadaiJob[] = [
  defineJob<{ tenant_id: string; n: number }>({
    name: `test.echo-${suffix}`,
    work: { pollingIntervalSeconds: 0.5 },
    async handler(job, deps) {
      // Tenant work runs inside withTenant(appDb, systemContext(tenant_id)).
      const stores = await withTenant(deps.db.appDb, systemContext(job.data.tenant_id), (tx) =>
        tx.selectFrom('stores').select('id').execute(),
      )
      seen.push({
        name: job.name,
        data: { ...job.data, stores: stores.length },
        retry: job.retryCount,
      })
    },
  }),
  defineJob({
    name: `test.flaky-${suffix}`,
    options: { retryLimit: 2, retryDelay: 1, retryBackoff: false },
    work: { pollingIntervalSeconds: 0.5 },
    async handler(job) {
      seen.push({ name: job.name, data: job.data, retry: job.retryCount })
      if (failOnce) {
        failOnce = false
        throw new Error('transient failure')
      }
    },
  }),
]

describe('background jobs (pg-boss)', () => {
  let deps: KadaiDeps
  let worker: RunningWorker
  const heartbeatKey = `worker_heartbeat_test_${suffix}`

  beforeAll(async () => {
    deps = createDeps(getTestConfig(), {
      applicationName: 'kadai-test-worker',
      jobDefinitions: testJobs,
      jobRole: 'worker',
      otpSender: createMemoryOtpSender(),
      defaultMetrics: false,
    })
    installRuntime(deps)
    worker = await startWorker(deps, testJobs, { heartbeatKey })
  }, 60_000)

  afterAll(async () => {
    await worker?.stop()
    for (const j of testJobs) await deps.jobs.boss.deleteQueue(j.name).catch(() => undefined)
    await deps.db.systemDb.deleteFrom('system_settings').where('key', '=', heartbeatKey).execute()
    await destroyDeps(deps)
  })

  it('processes an enqueued job with its payload', async () => {
    const shop = await insertTestTenant(deps.db.systemDb)
    const id = await enqueue(`test.echo-${suffix}`, { tenant_id: shop.tenant.id, n: 1 })
    expect(id).toBeTruthy()
    await expect.poll(() => seen.find((s) => s.data.n === 1), { timeout: 10_000 }).toBeTruthy()
    expect(seen.find((s) => s.data.n === 1)?.data).toMatchObject({
      tenant_id: shop.tenant.id,
      stores: 1,
    })
  })

  it('enqueues inside a business transaction: only committed jobs run', async () => {
    const shop = await insertTestTenant(deps.db.systemDb)
    const ctx = systemContext(shop.tenant.id)
    await expect(
      withTenant(deps.db.appDb, ctx, async (tx) => {
        await enqueue(`test.echo-${suffix}`, { tenant_id: shop.tenant.id, n: 2 }, { tx })
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    await withTenant(deps.db.appDb, ctx, (tx) =>
      enqueue(`test.echo-${suffix}`, { tenant_id: shop.tenant.id, n: 3 }, { tx }),
    )
    await expect.poll(() => seen.find((s) => s.data.n === 3), { timeout: 10_000 }).toBeTruthy()
    expect(seen.find((s) => s.data.n === 2)).toBeUndefined()
  })

  it('retries failed jobs', async () => {
    await enqueue(`test.flaky-${suffix}`, { k: 'v' })
    await expect
      .poll(() => seen.filter((s) => s.name === `test.flaky-${suffix}`).length, { timeout: 15_000 })
      .toBe(2)
    expect(seen.filter((s) => s.name === `test.flaky-${suffix}`).map((s) => s.retry)).toEqual([
      0, 1,
    ])
    const metrics = await deps.metrics.registry.getSingleMetricAsString(
      'kadai_jobs_processed_total',
    )
    expect(metrics).toContain(`name="test.flaky-${suffix}",status="failed"`)
  })

  it('refuses unknown job names', async () => {
    await expect(enqueue('nobody.knows', {})).rejects.toThrow(/unknown job/)
  })

  it('writes the worker heartbeat', async () => {
    const row = await deps.db.systemDb
      .selectFrom('system_settings')
      .select('value')
      .where('key', '=', heartbeatKey)
      .executeTakeFirst()
    expect(row?.value).toMatchObject({ pid: process.pid, jobs: testJobs.length })
  })
})

describe('job registry', () => {
  it('includes core.cleanup and validates names', () => {
    expect(JOB_DEFINITIONS.map((j) => j.name)).toContain('core.cleanup')
    const noop = async () => undefined
    expect(() => buildRegistry([[defineJob({ name: 'Bad Name', handler: noop })]])).toThrow(
      /invalid job name/,
    )
    expect(() =>
      buildRegistry([
        [defineJob({ name: 'a.b', handler: noop })],
        [defineJob({ name: 'a.b', handler: noop })],
      ]),
    ).toThrow(/duplicate/)
    expect(() =>
      buildRegistry([[defineJob({ name: 'a.c', intervalSeconds: 1, handler: noop })]]),
    ).toThrow(/intervalSeconds/)
  })
})

describe('core.cleanup', () => {
  it('deletes expired idempotency keys, old OTPs and long-dead sessions only', async () => {
    const config = getTestConfig()
    const deps = createDeps(config, {
      applicationName: 'kadai-test',
      otpSender: createMemoryOtpSender(),
      defaultMetrics: false,
    })
    try {
      const db = deps.db.systemDb
      const shop = await insertTestTenant(db)
      const t = shop.tenant.id
      const phone = randomPhone()
      await db
        .insertInto('idempotency_keys')
        .values([
          {
            tenant_id: t,
            key: `expired-${suffix}`,
            method: 'POST',
            path: '/x',
            request_hash: 'h',
            expires_at: sql<Date>`now() - interval '1 hour'`,
          },
          { tenant_id: t, key: `live-${suffix}`, method: 'POST', path: '/x', request_hash: 'h' },
        ])
        .execute()
      await db
        .insertInto('otp_codes')
        .values([
          {
            phone,
            purpose: 'login',
            code_hash: 'x',
            expires_at: new Date(),
            created_at: sql<Date>`now() - interval '2 days'`,
          },
          { phone, purpose: 'login', code_hash: 'y', expires_at: new Date() },
        ])
        .execute()
      const old = newId()
      const fresh = newId()
      await db
        .insertInto('auth_sessions')
        .values([
          {
            id: old,
            user_id: shop.owner.user_id,
            refresh_token_hash: `h-${old}`,
            family_id: old,
            expires_at: sql<Date>`now() - interval '40 days'`,
          },
          {
            id: fresh,
            user_id: shop.owner.user_id,
            refresh_token_hash: `h-${fresh}`,
            family_id: fresh,
            expires_at: sql<Date>`now() + interval '10 days'`,
          },
        ])
        .execute()

      const result = await runCleanup(db)
      expect(result.idempotency_keys).toBeGreaterThanOrEqual(1)
      const keys = await db
        .selectFrom('idempotency_keys')
        .select('key')
        .where('tenant_id', '=', t)
        .execute()
      expect(keys.map((k) => k.key)).toEqual([`live-${suffix}`])
      const otps = await db
        .selectFrom('otp_codes')
        .select('code_hash')
        .where('phone', '=', phone)
        .execute()
      expect(otps.map((o) => o.code_hash)).toEqual(['y'])
      const sessions = await db
        .selectFrom('auth_sessions')
        .select('id')
        .where('id', 'in', [old, fresh])
        .execute()
      expect(sessions.map((s) => s.id)).toEqual([fresh])
    } finally {
      await destroyDeps(deps)
    }
  })
})
