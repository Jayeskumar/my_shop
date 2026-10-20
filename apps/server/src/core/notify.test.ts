import { newId } from '@kadai/shared'
import {
  NOTIFICATION_JOBS,
  NOTIFICATION_TEMPLATES,
  NotificationProviderError,
  type NotificationProvider,
  buildOutboundMessage,
  createNotificationProviderRegistry,
} from '@kadai/shared/api/notifications'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defineJob } from '../jobs/types'
import { type TestApp, buildTestApp } from '../test/helpers'
import { type TestShop, createTestTenant } from '../test/tenants'
import { isAppError } from './errors'
import { setJobQueue } from './jobs'
import {
  deliverMessage,
  enqueueNotification,
  getNotificationProviders,
  setNotificationProviders,
} from './notify'

const invoiceParams = {
  shop_name: 'Sri Murugan Stores',
  customer_name: 'Lakshmi',
  number: 'S1-A/2627/00042',
  amount: '₹1,250.00',
  due: null,
  link: 'https://kadai.app/i/Ab3dE5gH7jK9mN1pQ3sT5v',
}

async function sendJobsFor(t: TestApp, notificationId: string) {
  const res = await sql<{
    data: { tenant_id: string; notification_id: string }
    singleton_key: string | null
    start_after: Date
  }>`
    select data, singleton_key, start_after from pgboss.job
     where name = ${NOTIFICATION_JOBS.send} and data->>'notification_id' = ${notificationId}`.execute(
    t.deps.db.systemDb,
  )
  return res.rows
}

async function expectValidation(promise: Promise<unknown>, path: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(isAppError(err), String(err)).toBe(true)
  if (isAppError(err)) {
    expect(err.code).toBe('VALIDATION_ERROR')
    const issues = (err.details as { issues: Array<{ path: string }> }).issues
    expect(
      issues.map((i) => i.path).some((p) => p.startsWith(path)),
      JSON.stringify(issues),
    ).toBe(true)
  }
}

describe('core/notify enqueueNotification', () => {
  let t: TestApp
  let shop: TestShop

  beforeAll(async () => {
    t = await buildTestApp({
      jobDefinitions: [defineJob({ name: NOTIFICATION_JOBS.send, handler: async () => undefined })],
    })
    shop = await createTestTenant(t)
  })
  afterAll(() => t.close())

  it('writes the outbox row in the business transaction and enqueues the send job after commit', async () => {
    const refId = newId()
    const queued = await shop.tx((tx) =>
      enqueueNotification(tx, shop.ctx, {
        channel: 'whatsapp',
        template_code: 'invoice_share',
        to: '98765 43210',
        recipient_name: ' Lakshmi ',
        params: invoiceParams,
        ref_type: 'sales_invoice',
        ref_id: refId,
      }),
    )
    expect(queued).toMatchObject({
      channel: 'whatsapp',
      template_code: 'invoice_share',
      recipient: '+919876543210',
      status: 'queued',
      locale: shop.ctx.locale,
    })
    const row = await shop.tx((tx) =>
      tx
        .selectFrom('notifications')
        .selectAll()
        .where('id', '=', queued.id)
        .executeTakeFirstOrThrow(),
    )
    expect(row).toMatchObject({
      tenant_id: shop.tenant.id,
      status: 'queued',
      recipient: '+919876543210',
      recipient_name: 'Lakshmi',
      ref_type: 'sales_invoice',
      ref_id: refId,
      attempts: 0,
      created_by: shop.owner.user.id,
    })
    expect(row.params).toEqual(invoiceParams)
    const jobs = await sendJobsFor(t, queued.id)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.data).toEqual({ tenant_id: shop.tenant.id, notification_id: queued.id })
    expect(jobs[0]!.singleton_key).toBe(queued.id)
  })

  it('leaves nothing behind when the transaction rolls back', async () => {
    let id = ''
    await expect(
      shop.tx(async (tx) => {
        id = (
          await enqueueNotification(tx, shop.ctx, {
            channel: 'sms',
            template_code: 'payment_link',
            to: '+919876543210',
            params: {
              shop_name: 'S',
              customer_name: 'C',
              amount: '₹10.00',
              link: 'https://x.in/pay/1',
            },
          })
        ).id
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(id).not.toBe('')
    const row = await shop.tx((tx) =>
      tx.selectFrom('notifications').select('id').where('id', '=', id).executeTakeFirst(),
    )
    expect(row).toBeUndefined()
    expect(await sendJobsFor(t, id)).toHaveLength(0)
  })

  it('delays the job to scheduled_at and honours an explicit locale', async () => {
    const at = new Date(Date.now() + 2 * 60 * 60 * 1000)
    const queued = await shop.tx((tx) =>
      enqueueNotification(tx, shop.ctx, {
        channel: 'email',
        template_code: 'daily_summary',
        to: ' Owner@Shop.IN ',
        locale: 'en',
        params: NOTIFICATION_TEMPLATES.daily_summary.sample.en,
        scheduled_at: at.toISOString(),
      }),
    )
    expect(queued.recipient).toBe('owner@shop.in')
    expect(queued.locale).toBe('en')
    expect(queued.scheduled_at.getTime()).toBe(at.getTime())
    const [job] = await sendJobsFor(t, queued.id)
    expect(Math.abs(new Date(job!.start_after).getTime() - at.getTime())).toBeLessThan(1000)
  })

  it('keeps the row queued for the sweep when the job cannot be enqueued', async () => {
    setJobQueue(null)
    try {
      const queued = await shop.tx((tx) =>
        enqueueNotification(tx, shop.ctx, {
          channel: 'sms',
          template_code: 'welcome',
          to: '9876501234',
          params: { shop_name: 'Sri Murugan Stores', customer_name: 'Ravi', link: null },
        }),
      )
      const row = await shop.tx((tx) =>
        tx
          .selectFrom('notifications')
          .select('status')
          .where('id', '=', queued.id)
          .executeTakeFirst(),
      )
      expect(row?.status).toBe('queued')
      expect(await sendJobsFor(t, queued.id)).toHaveLength(0)
    } finally {
      setJobQueue(t.deps.jobs)
    }
  })

  it('rejects unknown templates, unsupported channels, bad recipients and params', async () => {
    const base = {
      channel: 'sms',
      template_code: 'welcome',
      to: '9876501234',
      params: { shop_name: 'S', customer_name: 'C', link: null },
    } as const
    await expectValidation(
      shop.tx((tx) =>
        enqueueNotification(tx, shop.ctx, { ...base, template_code: 'nope' as never }),
      ),
      'template_code',
    )
    await expectValidation(
      shop.tx((tx) =>
        enqueueNotification(tx, shop.ctx, {
          ...base,
          template_code: 'otp',
          channel: 'whatsapp',
          params: { otp: '123456', minutes: 5 },
        }),
      ),
      'channel',
    )
    await expectValidation(
      shop.tx((tx) => enqueueNotification(tx, shop.ctx, { ...base, to: '12345' })),
      'to',
    )
    await expectValidation(
      shop.tx((tx) =>
        enqueueNotification(tx, shop.ctx, { ...base, channel: 'email', to: 'not-an-email' }),
      ),
      'to',
    )
    await expectValidation(
      shop.tx((tx) =>
        enqueueNotification(tx, shop.ctx, { ...base, params: { customer_name: 'C' } }),
      ),
      'params.shop_name',
    )
    await expectValidation(
      shop.tx((tx) =>
        enqueueNotification(tx, shop.ctx, { ...base, params: { ...base.params, 'Bad Key': 'x' } }),
      ),
      'params',
    )
    await expectValidation(
      shop.tx((tx) =>
        enqueueNotification(tx, shop.ctx, { ...base, ref_type: 'customer', ref_id: 'x' }),
      ),
      'ref_id',
    )
    await expectValidation(
      shop.tx((tx) => enqueueNotification(tx, shop.ctx, { ...base, scheduled_at: 'tomorrow' })),
      'scheduled_at',
    )
  })
})

describe('core/notify provider registry', () => {
  const message = buildOutboundMessage({
    notification_id: newId(),
    tenant_id: newId(),
    code: 'payment_link',
    channel: 'sms',
    locale: 'ta',
    to: '+919876543210',
    params: NOTIFICATION_TEMPLATES.payment_link.sample.ta,
  })!

  const provider = (
    code: NotificationProvider['code'],
    send: NotificationProvider['send'],
  ): NotificationProvider => ({ code, channels: ['sms'], configured: true, send })

  it('delivers through the channel provider and classifies failures', async () => {
    const previous = setNotificationProviders(createNotificationProviderRegistry())
    try {
      expect(await deliverMessage(message)).toMatchObject({
        ok: false,
        provider: null,
        error: { kind: 'permanent', code: 'no_provider' },
      })
      const sent: string[] = []
      getNotificationProviders().register(
        provider('msg91', async (m) => {
          sent.push(m.body)
          return { provider_message_id: 'req-1', status: 'sent' }
        }),
      )
      expect(await deliverMessage(message)).toEqual({
        ok: true,
        provider: 'msg91',
        result: { provider_message_id: 'req-1', status: 'sent' },
      })
      expect(sent[0]).toContain('₹2,450.00')
      getNotificationProviders().register(
        provider('kadai_relay', async () => {
          throw new NotificationProviderError({
            message: 'quota exceeded',
            kind: 'permanent',
            provider: 'kadai_relay',
            code: 'quota_exceeded',
          })
        }),
      )
      const relayed = await deliverMessage(message, { provider: 'kadai_relay' })
      expect(relayed).toMatchObject({
        ok: false,
        provider: 'kadai_relay',
        error: { code: 'quota_exceeded' },
      })
      expect(
        await deliverMessage({ ...message, channel: 'email' }, { provider: 'msg91' }),
      ).toMatchObject({
        ok: false,
        error: { code: 'no_provider' },
      })
    } finally {
      setNotificationProviders(previous)
    }
  })
})
