/**
 * Delivery receipts: POST /webhooks/notifications/whatsapp_cloud (X-Hub-Signature-256 HMAC with
 * the app secret), the GET hub.challenge verification, and MSG91 delivery reports (shared token)
 * moving outbox rows to delivered / read / failed — forward only, per tenant row.
 */
import { createHmac } from 'node:crypto'
import { newId } from '@kadai/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import { verifyWhatsAppSignature } from '../webhooks'
import { errorOf, expectStatus } from './fixtures'

const APP_SECRET = 'meta-app-secret-1'
const VERIFY_TOKEN = 'kadai-verify-7'
const DLR_TOKEN = 'dlr-token-9'

const sign = (raw: string, secret = APP_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(raw, 'utf8').digest('hex')}`

function statusesBody(
  statuses: Array<{ id: string; status: string; timestamp?: string; errors?: unknown[] }>,
): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1029384756',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '919876500000', phone_number_id: '1098' },
              statuses: statuses.map((s) => ({ recipient_id: '919876543210', ...s })),
            },
          },
        ],
      },
    ],
  })
}

describe('notification webhooks', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop

  beforeAll(async () => {
    t = await buildTestApp({
      env: {
        WHATSAPP_APP_SECRET: APP_SECRET,
        WHATSAPP_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
        MSG91_WEBHOOK_TOKEN: DLR_TOKEN,
      },
    })
    shop = await createTestTenant(t)
    other = await createTestTenant(t)
  })
  afterAll(() => t.close())

  async function sentRow(
    s: TestShop,
    provider: 'whatsapp_cloud' | 'msg91',
    providerMessageId: string,
    status = 'sent',
  ): Promise<string> {
    const id = newId()
    await t.deps.db.systemDb
      .insertInto('notifications')
      .values({
        id,
        tenant_id: s.tenant.id,
        channel: provider === 'msg91' ? 'sms' : 'whatsapp',
        template_code: 'invoice_share',
        recipient: '+919876543210',
        status,
        provider,
        provider_message_id: providerMessageId,
        attempts: 1,
        sent_at: status === 'queued' ? null : new Date(),
      })
      .execute()
    return id
  }
  const row = (id: string) =>
    t.deps.db.systemDb
      .selectFrom('notifications')
      .select(['status', 'error', 'sent_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()

  const postWhatsApp = (raw: string, signature: string | null) =>
    t.app.inject({
      method: 'POST',
      url: '/webhooks/notifications/whatsapp_cloud',
      headers: {
        'content-type': 'application/json',
        ...(signature ? { 'x-hub-signature-256': signature } : {}),
      },
      payload: raw,
    })

  it('applies signed WhatsApp status callbacks (delivered → read; failures with the reason)', async () => {
    const wamid = `wamid.${newId()}`
    const failing = `wamid.${newId()}`
    const id = await sentRow(shop, 'whatsapp_cloud', wamid)
    const failId = await sentRow(shop, 'whatsapp_cloud', failing)
    const delivered = statusesBody([
      { id: wamid, status: 'delivered', timestamp: '1792900000' },
      {
        id: failing,
        status: 'failed',
        timestamp: '1792900001',
        errors: [{ code: 131026, title: 'Message undeliverable' }],
      },
      { id: `wamid.${newId()}`, status: 'delivered' }, // unknown id: ignored
    ])
    const res = await postWhatsApp(delivered, sign(delivered))
    expect(expectStatus<{ data: { ok: boolean } }>(res, 200).data.ok).toBe(true)
    expect(await row(id)).toMatchObject({ status: 'delivered' })
    const failed = await row(failId)
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('provider_error: 131026 Message undeliverable')

    const read = statusesBody([{ id: wamid, status: 'read', timestamp: '1792900060' }])
    expectStatus(await postWhatsApp(read, sign(read)), 200)
    expect((await row(id)).status).toBe('read')
    // Receipts arriving late never move a status backwards.
    const late = statusesBody([
      { id: wamid, status: 'delivered' },
      { id: wamid, status: 'sent' },
      { id: wamid, status: 'failed' },
    ])
    expectStatus(await postWhatsApp(late, sign(late)), 200)
    expect((await row(id)).status).toBe('read')
  })

  it('rejects unsigned, mis-signed and tampered WhatsApp callbacks (401 invalid_signature)', async () => {
    const wamid = `wamid.${newId()}`
    const id = await sentRow(shop, 'whatsapp_cloud', wamid)
    const body = statusesBody([{ id: wamid, status: 'delivered' }])
    for (const signature of [
      null,
      sign(body, 'some-other-secret'),
      'sha256=abc',
      sign(body).replace('sha256=', 'sha1='),
    ]) {
      const e = errorOf(await postWhatsApp(body, signature), 401)
      expect(e).toMatchObject({ code: 'UNAUTHENTICATED', details: { reason: 'invalid_signature' } })
    }
    const tampered = body.replace('delivered', 'read')
    errorOf(await postWhatsApp(tampered, sign(body)), 401)
    expect((await row(id)).status).toBe('sent')
    // Non-status payloads (incoming messages) are accepted and ignored.
    const message = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { messages: [{ id: 'wamid.in', type: 'text' }] } }] }],
    })
    expectStatus(await postWhatsApp(message, sign(message)), 200)
  })

  it('matches receipts by provider and message id (WhatsApp ids are globally unique)', async () => {
    const shared = `wamid.${newId()}`
    const mine = await sentRow(shop, 'whatsapp_cloud', shared)
    const theirs = await sentRow(other, 'whatsapp_cloud', shared, 'delivered')
    const smsSameId = await sentRow(shop, 'msg91', shared)
    const body = statusesBody([{ id: shared, status: 'read' }])
    expectStatus(await postWhatsApp(body, sign(body)), 200)
    expect((await row(mine)).status).toBe('read')
    expect((await row(theirs)).status).toBe('read')
    // Matching is by (provider, message id): the SMS row with the same id is untouched.
    expect((await row(smsSameId)).status).toBe('sent')
  })

  it('answers the WhatsApp verification challenge as text (403 on a wrong token)', async () => {
    const ok = await t.app.inject({
      method: 'GET',
      url: `/webhooks/notifications/whatsapp_cloud?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`,
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.headers['content-type']).toMatch(/^text\/plain/)
    expect(ok.body).toBe('1158201444')
    const wrong = await t.app.inject({
      method: 'GET',
      url: '/webhooks/notifications/whatsapp_cloud?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1',
    })
    expect(errorOf(wrong, 403).code).toBe('FORBIDDEN')
    const mode = await t.app.inject({
      method: 'GET',
      url: `/webhooks/notifications/whatsapp_cloud?hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`,
    })
    errorOf(mode, 403)
    const missing = await t.app.inject({
      method: 'GET',
      url: '/webhooks/notifications/whatsapp_cloud',
    })
    errorOf(missing, 400)
    const msg91 = await t.app.inject({
      method: 'GET',
      url: `/webhooks/notifications/msg91?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`,
    })
    errorOf(msg91, 404)
    errorOf(
      await t.app.inject({ method: 'POST', url: '/webhooks/notifications/twilio', payload: {} }),
      400,
    )
  })

  it('applies MSG91 delivery reports with the shared token (JSON or form data)', async () => {
    const requestId = `3561707a${newId().slice(-12)}`
    const failedReq = `3561707b${newId().slice(-12)}`
    const id = await sentRow(shop, 'msg91', requestId)
    const failId = await sentRow(shop, 'msg91', failedReq)
    const report = [
      {
        requestId,
        report: [
          { number: '919876543210', status: '1', desc: 'DELIVERED', date: '2026-10-21 10:01:02' },
        ],
      },
      { requestId: failedReq, report: [{ number: '919876543210', status: '16', desc: 'NDNC' }] },
    ]
    const ok = await t.app.inject({
      method: 'POST',
      url: `/webhooks/notifications/msg91?token=${DLR_TOKEN}`,
      payload: report,
    })
    expectStatus(ok, 200)
    expect((await row(id)).status).toBe('delivered')
    expect(await row(failId)).toMatchObject({ status: 'failed', error: 'provider_error: NDNC' })

    // Form-encoded body with a JSON `data` field, token in a header.
    const formReq = `3561707c${newId().slice(-12)}`
    const formId = await sentRow(shop, 'msg91', formReq)
    const form = await t.app.inject({
      method: 'POST',
      url: '/webhooks/notifications/msg91',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-kadai-webhook-token': DLR_TOKEN,
      },
      payload: `data=${encodeURIComponent(JSON.stringify([{ requestId: formReq, report: [{ desc: 'DELIVERED' }] }]))}`,
    })
    expectStatus(form, 200)
    expect((await row(formId)).status).toBe('delivered')

    for (const url of [
      '/webhooks/notifications/msg91',
      '/webhooks/notifications/msg91?token=wrong',
    ]) {
      const e = errorOf(await t.app.inject({ method: 'POST', url, payload: report }), 401)
      expect(e.details).toMatchObject({ reason: 'invalid_signature' })
    }
  })

  it('verifies the signature over the exact raw bytes', () => {
    const raw = Buffer.from('{"a":1}')
    expect(verifyWhatsAppSignature(APP_SECRET, raw, sign('{"a":1}'))).toBe(true)
    expect(verifyWhatsAppSignature(APP_SECRET, raw, sign('{"a": 1}'))).toBe(false)
    expect(verifyWhatsAppSignature(null, raw, sign('{"a":1}'))).toBe(false)
    expect(verifyWhatsAppSignature(APP_SECRET, undefined, sign('{"a":1}'))).toBe(false)
    expect(verifyWhatsAppSignature(APP_SECRET, raw, sign('{"a":1}').toUpperCase())).toBe(false)
  })
})

describe('notification webhooks without secrets', () => {
  let t: TestApp
  beforeAll(async () => {
    t = await buildTestApp({
      env: { WHATSAPP_APP_SECRET: '', WHATSAPP_WEBHOOK_VERIFY_TOKEN: '', MSG91_WEBHOOK_TOKEN: '' },
    })
  })
  afterAll(() => t.close())

  it('refuses WhatsApp callbacks and verification when no app secret / token is configured', async () => {
    const body = statusesBody([{ id: 'wamid.x', status: 'delivered' }])
    const res = await t.app.inject({
      method: 'POST',
      url: '/webhooks/notifications/whatsapp_cloud',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    })
    expect(errorOf(res, 401).details).toMatchObject({ reason: 'invalid_signature' })
    const verify = await t.app.inject({
      method: 'GET',
      url: '/webhooks/notifications/whatsapp_cloud?hub.mode=subscribe&hub.verify_token=&hub.challenge=1',
    })
    errorOf(verify, 403)
    // MSG91 reports are accepted without a configured token (MSG91 does not sign them).
    expectStatus(
      await t.app.inject({ method: 'POST', url: '/webhooks/notifications/msg91', payload: [] }),
      200,
    )
  })
})
