/**
 * Razorpay adapter in isolation (injected fetch): retries of idempotent GETs on 5xx / network
 * errors, no retry for creates, timeouts, error mapping to PROVIDER_ERROR with Razorpay's code,
 * constant-time webhook signature checks and webhook parsing.
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../../core/errors'
import { createRazorpayProvider } from '../providers/razorpay'
import type { ProviderAccountRuntime, ProviderIntent } from '../providers/types'

const account: ProviderAccountRuntime = {
  id: '01a15f65-0000-7000-8000-000000000001',
  tenant_id: '01a15f65-0000-7000-8000-000000000002',
  provider: 'razorpay',
  mode: 'test',
  display_name: 'Razorpay',
  vpa: null,
  payee_name: 'Murugan Stores',
  merchant_code: '5411',
  credentials: { key_id: 'rzp_test_Abcdef123456', key_secret: 'secret-123456' },
  config: {},
}

const intent: ProviderIntent = {
  id: '01a15f65-0000-7000-8000-000000000003',
  tenant_id: account.tenant_id,
  kind: 'qr',
  purpose: 'pos_sale',
  reference_code: 'KDABCDEFGH12',
  amount_paise: 1_000,
  note: null,
  provider_ref: 'qr_123',
  created_at: new Date(),
  expires_at: new Date(Date.now() + 600_000),
  metadata: {},
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function provider(fetchImpl: typeof fetch, timeoutMs = 8_000) {
  return createRazorpayProvider({
    razorpayApiBase: 'https://razorpay.example',
    timeoutMs,
    publicBaseUrl: 'http://localhost:8080',
    fetch: fetchImpl,
  })
}

describe('razorpay adapter', () => {
  it('retries GETs on 5xx and network errors, then succeeds', async () => {
    let calls = 0
    const p = provider(async () => {
      calls++
      if (calls === 1) return json(503, { error: { code: 'SERVER_ERROR', description: 'busy' } })
      if (calls === 2) throw new TypeError('fetch failed')
      return json(200, {
        items: [
          {
            id: 'pay_1',
            amount: 1_000,
            status: 'captured',
            vpa: 'a@okaxis',
            acquirer_data: { rrn: '123456789012' },
          },
        ],
      })
    })
    const status = await p.fetchStatus(account, intent)
    expect(calls).toBe(3)
    expect(status).toMatchObject({
      status: 'paid',
      provider_payment_id: 'pay_1',
      utr: '123456789012',
      amount_paise: 1_000,
    })
  })

  it('does not retry creates and maps errors to PROVIDER_ERROR', async () => {
    let calls = 0
    const p = provider(async () => {
      calls++
      return json(500, { error: { code: 'SERVER_ERROR', description: 'Internal error' } })
    })
    const err = await p.createQr(account, intent).catch((e: unknown) => e)
    expect(calls).toBe(1)
    expect(err).toBeInstanceOf(AppError)
    expect(err).toMatchObject({
      code: 'PROVIDER_ERROR',
      status: 502,
      details: {
        provider: 'razorpay',
        provider_error_code: 'SERVER_ERROR',
        http_status: 500,
        retryable: true,
      },
    })
    const auth = provider(async () =>
      json(401, { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } }),
    )
    await expect(auth.testCredentials(account)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: 'Razorpay: Authentication failed',
      details: { provider_error_code: 'BAD_REQUEST_ERROR', retryable: false },
    })
  })

  it('times out slow requests', async () => {
    const p = provider(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error))
        }),
      50,
    )
    await expect(
      p.createLink(account, { ...intent, kind: 'link' }, { name: 'X', phone: null }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      details: { provider_error_code: 'TIMEOUT' },
    })
  })

  it('treats "already closed" as a successful close', async () => {
    const p = provider(async () =>
      json(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'QR code is already closed' } }),
    )
    await expect(p.cancel(account, intent)).resolves.toBeUndefined()
    const other = provider(async () =>
      json(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'Invalid id' } }),
    )
    await expect(other.cancel(account, intent)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
  })

  it('verifies webhook signatures over the raw body', () => {
    const p = provider(fetch)
    const raw = Buffer.from('{"event":"qr_code.credited"}')
    const sig = createHmac('sha256', 'whsec').update(raw).digest('hex')
    expect(p.verifyWebhook('whsec', raw, { 'x-razorpay-signature': sig })).toBe(true)
    expect(p.verifyWebhook('whsec', raw, { 'x-razorpay-signature': sig.toUpperCase() })).toBe(true)
    expect(p.verifyWebhook('other', raw, { 'x-razorpay-signature': sig })).toBe(false)
    expect(
      p.verifyWebhook('whsec', Buffer.from(`${raw.toString()} `), { 'x-razorpay-signature': sig }),
    ).toBe(false)
    expect(p.verifyWebhook('whsec', raw, { 'x-razorpay-signature': 'abc' })).toBe(false)
    expect(p.verifyWebhook('whsec', raw, {})).toBe(false)
    expect(p.webhookEventId({ id: 'x' }, { 'x-razorpay-event-id': 'evt_1' })).toBe('evt_1')
  })

  it('parses qr_code.credited, payment_link.paid and payment.failed', () => {
    const p = provider(fetch)
    expect(
      p.parseWebhook({
        event: 'qr_code.credited',
        payload: {
          payment: {
            entity: {
              id: 'pay_1',
              amount: 500,
              status: 'captured',
              vpa: 'x@okaxis',
              acquirer_data: { rrn: '1' },
              fee: 2,
            },
          },
          qr_code: { entity: { id: 'qr_1', notes: { intent_id: 'i1', reference_code: 'R1' } } },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        type: 'paid',
        provider_ref: 'qr_1',
        intent_id: 'i1',
        reference_code: 'R1',
        amount_paise: 500,
        utr: '1',
        fee_paise: 2,
      }),
    ])
    expect(
      p.parseWebhook({
        event: 'payment_link.paid',
        payload: {
          payment_link: {
            entity: {
              id: 'plink_1',
              amount_paid: 700,
              reference_id: 'R2',
              notes: { intent_id: 'i2' },
            },
          },
          payment: { entity: { id: 'pay_2', status: 'captured' } },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        type: 'paid',
        provider_ref: 'plink_1',
        intent_id: 'i2',
        reference_code: 'R2',
        amount_paise: 700,
      }),
    ])
    expect(
      p.parseWebhook({
        event: 'payment.failed',
        payload: {
          payment: {
            entity: { id: 'pay_3', error_description: 'Declined', notes: { intent_id: 'i3' } },
          },
        },
      }),
    ).toEqual([expect.objectContaining({ type: 'failed', intent_id: 'i3', reason: 'Declined' })])
    expect(p.parseWebhook({ event: 'order.paid' })).toEqual([])
    expect(p.parseWebhook('garbage')).toEqual([])
  })
})
