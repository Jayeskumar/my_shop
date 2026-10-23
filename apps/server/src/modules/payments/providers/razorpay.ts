/**
 * Razorpay adapter (ARCHITECTURE.md §11.1) — fetch-based client, no SDK.
 *
 *  - Dynamic UPI QR: POST /v1/payments/qr_codes {type: upi_qr, usage: single_use,
 *    fixed_amount: true, payment_amount, close_by, notes {tenant_id, intent_id, reference_code}}.
 *    Razorpay requires close_by at least 15 minutes ahead, so the provider QR lives a little
 *    longer than our own (shorter) expires_at — the expire job closes it at the provider.
 *  - Payment links (dues): POST /v1/payment_links (reference_id = reference_code, no Razorpay
 *    notifications: Kadai sends the link itself).
 *  - Polling: GET /v1/payments/qr_codes/:id/payments (a captured payment = paid) and
 *    GET /v1/payment_links/:id (status paid; payer details from GET /v1/payments/:id).
 *  - Webhooks: X-Razorpay-Signature = hex HMAC-SHA256(raw body, webhook secret), checked in
 *    constant time; events qr_code.credited, payment_link.paid, payment.failed; de-duplicated by
 *    X-Razorpay-Event-Id.
 *  - Close / cancel: POST /v1/payments/qr_codes/:id/close, POST /v1/payment_links/:id/cancel.
 *  - Credentials check: GET /v1/payments?count=1.
 *
 * Every request has a timeout (8 s by default); idempotent GETs are retried on network errors,
 * timeouts, 429 and 5xx. Errors become PROVIDER_ERROR with Razorpay's error code.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { PROVIDER_CAPABILITIES } from '@kadai/shared/api/payments'
import { providerFailure, isProviderFailure } from './errors'
import type {
  NormalizedEvent,
  NormalizedStatus,
  PaymentProvider,
  ProviderAccountRuntime,
  ProviderCredentials,
  ProviderIntent,
  ProviderRuntimeOptions,
  ReceivedPayment,
  WebhookHeaders,
} from './types'

/** Razorpay rejects close_by / expire_by less than 15 minutes ahead; keep a minute of margin. */
export const RAZORPAY_MIN_LIFETIME_SECONDS = 16 * 60
/** Delays between retries of idempotent GET requests. */
const GET_RETRY_DELAYS_MS = [250, 750] as const

type Json = Record<string, unknown>

function rec(v: unknown): Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {}
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}
function intOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : null
}
function unixToDate(v: unknown): Date | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? new Date(v * 1000) : null
}
function truncate(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : chars.slice(0, max).join('')
}
function headerValue(headers: WebhookHeaders, name: string): string | null {
  const v = headers[name] ?? headers[name.toLowerCase()]
  const s = Array.isArray(v) ? v[0] : v
  return typeof s === 'string' && s.trim() !== '' ? s.trim() : null
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function lifetimeEnd(expiresAt: Date | null, now = Date.now()): number {
  const ours = expiresAt ? Math.ceil(expiresAt.getTime() / 1000) : 0
  return Math.max(ours, Math.ceil(now / 1000) + RAZORPAY_MIN_LIFETIME_SECONDS)
}

export interface RazorpayClientOptions {
  baseUrl: string
  timeoutMs: number
  fetch?: typeof fetch
}

/** Minimal Razorpay REST client (Basic auth with key id / secret). */
export class RazorpayClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly creds: ProviderCredentials,
    private readonly opts: RazorpayClientOptions,
  ) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = opts.fetch ?? fetch
  }

  get(path: string): Promise<Json> {
    return this.request('GET', path, undefined, true)
  }

  post(path: string, body?: Json): Promise<Json> {
    return this.request('POST', path, body ?? {}, false)
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: Json | undefined,
    retry: boolean,
  ): Promise<Json> {
    const attempts = retry ? GET_RETRY_DELAYS_MS.length + 1 : 1
    let lastError: unknown = null
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(GET_RETRY_DELAYS_MS[attempt - 1]!)
      try {
        return await this.once(method, path, body)
      } catch (err) {
        lastError = err
        const retryable = isProviderFailure(err) && err.details?.retryable === true
        if (!retryable) throw err
      }
    }
    throw lastError
  }

  private async once(method: 'GET' | 'POST', path: string, body: Json | undefined): Promise<Json> {
    const auth = Buffer.from(`${this.creds.key_id}:${this.creds.key_secret}`).toString('base64')
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Basic ${auth}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      })
    } catch (err) {
      const timeout =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      throw providerFailure(
        'razorpay',
        timeout ? 'Razorpay did not answer in time' : 'Could not reach Razorpay',
        { code: timeout ? 'TIMEOUT' : 'NETWORK_ERROR', retryable: true, cause: err },
      )
    }
    const text = await res.text().catch(() => '')
    let json: Json = {}
    if (text) {
      try {
        json = rec(JSON.parse(text) as unknown)
      } catch {
        json = {}
      }
    }
    if (res.ok) return json
    const error = rec(json.error)
    const code = str(error.code) ?? `HTTP_${res.status}`
    const description = str(error.description) ?? `HTTP ${res.status}`
    throw providerFailure('razorpay', `Razorpay: ${description}`, {
      code,
      httpStatus: res.status,
      retryable: res.status >= 500 || res.status === 429,
    })
  }
}

function receivedFrom(payment: Json): ReceivedPayment {
  const upi = rec(payment.upi)
  const acquirer = rec(payment.acquirer_data)
  return {
    provider_payment_id: str(payment.id),
    amount_paise: intOrNull(payment.amount) ?? 0,
    payer_vpa: str(payment.vpa) ?? str(upi.vpa),
    payer_name: str(upi.payer_name) ?? null,
    utr: str(acquirer.rrn) ?? str(acquirer.upi_transaction_id),
    fee_paise: intOrNull(payment.fee),
    paid_at: unixToDate(payment.created_at),
  }
}

function intentIdOf(...notes: unknown[]): string | null {
  for (const n of notes) {
    const id = str(rec(n).intent_id)
    if (id) return id
  }
  return null
}

function referenceOf(...notes: unknown[]): string | null {
  for (const n of notes) {
    const ref = str(rec(n).reference_code)
    if (ref) return ref
  }
  return null
}

/** Close/cancel errors that mean "nothing left to close". */
const ALREADY_CLOSED_RE = /already|closed|cancell?ed|expired/i

export function createRazorpayProvider(opts: ProviderRuntimeOptions): PaymentProvider {
  const clientFor = (acct: ProviderAccountRuntime): RazorpayClient => {
    if (!acct.credentials) {
      throw providerFailure('razorpay', 'Razorpay credentials are not configured', {
        code: 'CREDENTIALS_MISSING',
      })
    }
    return new RazorpayClient(acct.credentials, {
      baseUrl: opts.razorpayApiBase,
      timeoutMs: opts.timeoutMs,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    })
  }

  const notes = (intent: ProviderIntent) => ({
    tenant_id: intent.tenant_id,
    intent_id: intent.id,
    reference_code: intent.reference_code,
  })

  const requireRef = (intent: ProviderIntent): string => {
    if (!intent.provider_ref) {
      throw providerFailure('razorpay', 'The intent has no Razorpay reference', {
        code: 'REFERENCE_MISSING',
      })
    }
    return intent.provider_ref
  }

  return {
    code: 'razorpay',
    capabilities: PROVIDER_CAPABILITIES.razorpay,

    async createQr(acct, intent) {
      const res = await clientFor(acct).post('/v1/payments/qr_codes', {
        type: 'upi_qr',
        name: truncate(acct.payee_name, 40),
        usage: 'single_use',
        fixed_amount: true,
        payment_amount: intent.amount_paise,
        description: truncate(intent.note ?? `Payment ${intent.reference_code}`, 255),
        close_by: lifetimeEnd(intent.expires_at),
        notes: notes(intent),
      })
      const id = str(res.id)
      if (!id)
        throw providerFailure('razorpay', 'Razorpay returned no QR id', { code: 'BAD_RESPONSE' })
      const content = str(res.image_content)
      return {
        provider_ref: id,
        image_url: str(res.image_url),
        upi_uri: content && /^upi:\/\//i.test(content) ? content : null,
      }
    },

    async createLink(acct, intent, customer) {
      const res = await clientFor(acct).post('/v1/payment_links', {
        amount: intent.amount_paise,
        currency: 'INR',
        accept_partial: false,
        reference_id: intent.reference_code,
        description: truncate(intent.note ?? `Payment ${intent.reference_code}`, 2048),
        customer: {
          name: truncate(customer.name, 100),
          ...(customer.phone ? { contact: customer.phone } : {}),
        },
        notify: { sms: false, email: false },
        reminder_enable: false,
        expire_by: lifetimeEnd(intent.expires_at),
        notes: notes(intent),
      })
      const id = str(res.id)
      const url = str(res.short_url)
      if (!id || !url) {
        throw providerFailure('razorpay', 'Razorpay returned no payment link', {
          code: 'BAD_RESPONSE',
        })
      }
      return { provider_ref: id, short_url: url }
    },

    async fetchStatus(acct, intent): Promise<NormalizedStatus> {
      const client = clientFor(acct)
      const ref = requireRef(intent)
      if (intent.kind === 'link') {
        const link = await client.get(`/v1/payment_links/${encodeURIComponent(ref)}`)
        const status = str(link.status)
        if (status === 'paid') {
          const payments = Array.isArray(link.payments) ? link.payments.map(rec) : []
          const first = payments.find((p) => str(p.status) === 'captured') ?? payments[0]
          const paymentId = first ? str(first.payment_id) : null
          let detail: ReceivedPayment = {
            provider_payment_id: paymentId,
            amount_paise: intOrNull(link.amount_paid) ?? intOrNull(first?.amount) ?? 0,
            payer_vpa: null,
            payer_name: null,
            utr: null,
            fee_paise: null,
            paid_at: unixToDate(first?.created_at),
          }
          if (paymentId) {
            // Payer VPA / RRN live on the payment entity; best effort (the link status suffices).
            try {
              const p = await client.get(`/v1/payments/${encodeURIComponent(paymentId)}`)
              const full = receivedFrom(p)
              detail = { ...full, amount_paise: detail.amount_paise || full.amount_paise }
            } catch {
              // keep the link-level details
            }
          }
          return { status: 'paid', ...detail }
        }
        if (status === 'cancelled') return { status: 'cancelled' }
        if (status === 'expired') return { status: 'expired' }
        return { status: 'pending' }
      }
      const res = await client.get(`/v1/payments/qr_codes/${encodeURIComponent(ref)}/payments`)
      const items = (Array.isArray(res.items) ? res.items : []).map(rec)
      const captured = items
        .filter((p) => str(p.status) === 'captured')
        .sort((a, b) => (intOrNull(a.created_at) ?? 0) - (intOrNull(b.created_at) ?? 0))
      const first = captured[0]
      if (first) return { status: 'paid', ...receivedFrom(first) }
      return { status: 'pending' }
    },

    verifyWebhook(secret, rawBody, headers) {
      const signature = headerValue(headers, 'x-razorpay-signature')
      if (!signature || !/^[0-9a-f]{64}$/i.test(signature) || !secret) return false
      const expected = createHmac('sha256', secret).update(rawBody).digest()
      const given = Buffer.from(signature, 'hex')
      return given.length === expected.length && timingSafeEqual(given, expected)
    },

    webhookEventId(body, headers) {
      return headerValue(headers, 'x-razorpay-event-id') ?? str(rec(body).id)
    },

    webhookEventType(body) {
      return str(rec(body).event) ?? 'unknown'
    },

    parseWebhook(body): NormalizedEvent[] {
      const event = str(rec(body).event)
      const payload = rec(rec(body).payload)
      const payment = rec(rec(payload.payment).entity)
      switch (event) {
        case 'qr_code.credited': {
          const qr = rec(rec(payload.qr_code).entity)
          if (str(payment.status) === 'failed') return []
          return [
            {
              type: 'paid',
              provider_ref: str(qr.id),
              intent_id: intentIdOf(qr.notes, payment.notes),
              reference_code: referenceOf(qr.notes, payment.notes),
              ...receivedFrom(payment),
            },
          ]
        }
        case 'payment_link.paid': {
          const link = rec(rec(payload.payment_link).entity)
          const received = receivedFrom(payment)
          return [
            {
              type: 'paid',
              provider_ref: str(link.id),
              intent_id: intentIdOf(link.notes, payment.notes),
              reference_code: str(link.reference_id) ?? referenceOf(link.notes),
              ...received,
              amount_paise: received.amount_paise || (intOrNull(link.amount_paid) ?? 0),
            },
          ]
        }
        case 'payment.failed': {
          return [
            {
              type: 'failed',
              provider_ref: null,
              intent_id: intentIdOf(payment.notes),
              reference_code: referenceOf(payment.notes),
              provider_payment_id: str(payment.id),
              reason: str(payment.error_description) ?? str(payment.error_code) ?? 'payment_failed',
            },
          ]
        }
        default:
          return []
      }
    },

    async cancel(acct, intent) {
      const ref = requireRef(intent)
      const path =
        intent.kind === 'link'
          ? `/v1/payment_links/${encodeURIComponent(ref)}/cancel`
          : `/v1/payments/qr_codes/${encodeURIComponent(ref)}/close`
      try {
        await clientFor(acct).post(path)
      } catch (err) {
        const status = isProviderFailure(err) ? err.details?.http_status : null
        if (status === 400 && err instanceof Error && ALREADY_CLOSED_RE.test(err.message)) return
        throw err
      }
    },

    async testCredentials(acct) {
      await clientFor(acct).get('/v1/payments?count=1')
    },
  }
}
