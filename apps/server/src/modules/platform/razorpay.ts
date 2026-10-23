/**
 * Razorpay client for OUR SaaS billing (the vendor's Razorpay account — not a shop's payment
 * provider, which lives in modules/payments): payment links for prepaid plans and subscriptions
 * for monthly auto-renew. Plain fetch with Basic auth and a timeout; every failure surfaces as
 * 502 PROVIDER_ERROR with `details.reason` (PLATFORM_ERROR_REASONS).
 */
import { AppError } from '../../core/errors'
import type { RazorpayPlatformSettings } from './settings'

export const RAZORPAY_PROVIDER = 'razorpay_platform'
const DEFAULT_TIMEOUT_MS = 15_000

/** Notes we attach to links / subscriptions (string values only, Razorpay limit 15 keys). */
export type RazorpayNotes = Record<string, string>

export interface CreatePaymentLinkInput {
  amount_paise: number
  /** Our vendor order id (Razorpay reference_id, ≤ 40 chars). */
  reference_id: string
  description: string
  customer: { name: string; contact: string | null; email: string | null }
  notes: RazorpayNotes
  callback_url: string
  /** Absolute expiry. */
  expire_by: Date
  notify_sms: boolean
}

export interface PaymentLinkResult {
  id: string
  short_url: string
  status: string
  expire_by: Date | null
}

export interface CreateSubscriptionInput {
  plan_id: string
  total_count: number
  /** First charge later than now (free months, trial end, prepaid first cycle). */
  start_at: Date | null
  /** Expiry of the authorisation link. */
  expire_by: Date
  /** Upfront amount charged with the authorisation (discounted first cycle). */
  upfront?: { name: string; amount_paise: number } | null
  notes: RazorpayNotes
}

export interface SubscriptionResult {
  id: string
  short_url: string
  status: string
}

export interface RazorpayPlatformClient {
  readonly configured: boolean
  createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLinkResult>
  cancelPaymentLink(id: string): Promise<void>
  createSubscription(input: CreateSubscriptionInput): Promise<SubscriptionResult>
  cancelSubscription(id: string, opts: { atCycleEnd: boolean }): Promise<{ status: string }>
}

export interface RazorpayClientOptions {
  timeoutMs?: number
  /** Injected fetch (tests); defaults to the global fetch. */
  fetch?: typeof fetch
}

function notConfigured(): AppError {
  return new AppError(
    'PROVIDER_ERROR',
    'Razorpay platform billing is not configured',
    { provider: RAZORPAY_PROVIDER, reason: 'billing_not_configured' },
  )
}

function unavailable(message: string, cause?: unknown, extra: Record<string, unknown> = {}): AppError {
  return new AppError(
    'PROVIDER_ERROR',
    message,
    { provider: RAZORPAY_PROVIDER, reason: 'provider_unavailable', ...extra },
    cause === undefined ? {} : { cause },
  )
}

const unix = (d: Date): number => Math.floor(d.getTime() / 1000)

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

export function createRazorpayClient(
  settings: RazorpayPlatformSettings,
  opts: RazorpayClientOptions = {},
): RazorpayPlatformClient {
  const doFetch = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const configured = Boolean(settings.keyId && settings.keySecret)

  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Record<string, unknown>> {
    if (!configured) throw notConfigured()
    const auth = Buffer.from(`${settings.keyId}:${settings.keySecret}`).toString('base64')
    let res: Response
    try {
      res = await doFetch(`${settings.apiUrl}${path}`, {
        method,
        headers: {
          authorization: `Basic ${auth}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw unavailable(`Razorpay ${method} ${path} failed`, err)
    }
    const text = await res.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (!res.ok) {
      const error =
        json && typeof json === 'object' && 'error' in json
          ? (json as { error?: { code?: unknown; description?: unknown } }).error
          : undefined
      throw unavailable(
        `Razorpay ${method} ${path} → ${res.status}${str(error?.description) ? `: ${String(error?.description)}` : ''}`,
        undefined,
        { status: res.status, provider_code: str(error?.code) },
      )
    }
    if (!json || typeof json !== 'object' || Array.isArray(json))
      throw unavailable(`Razorpay ${method} ${path} returned no JSON object`)
    return json as Record<string, unknown>
  }

  function requireId(obj: Record<string, unknown>, what: string): { id: string; short_url: string } {
    const id = str(obj.id)
    const shortUrl = str(obj.short_url)
    if (!id || !shortUrl) throw unavailable(`Razorpay ${what} response lacks id / short_url`)
    return { id, short_url: shortUrl }
  }

  return {
    configured,

    async createPaymentLink(input) {
      const body = {
        amount: input.amount_paise,
        currency: 'INR',
        accept_partial: false,
        reference_id: input.reference_id,
        description: input.description.slice(0, 2048),
        customer: {
          name: input.customer.name.slice(0, 100),
          ...(input.customer.contact ? { contact: input.customer.contact } : {}),
          ...(input.customer.email ? { email: input.customer.email } : {}),
        },
        notify: { sms: input.notify_sms && Boolean(input.customer.contact), email: Boolean(input.customer.email) },
        reminder_enable: false,
        notes: input.notes,
        callback_url: input.callback_url,
        callback_method: 'get',
        expire_by: unix(input.expire_by),
      }
      const res = await call('POST', '/v1/payment_links', body)
      const { id, short_url } = requireId(res, 'payment link')
      const expire = typeof res.expire_by === 'number' && res.expire_by > 0 ? new Date(res.expire_by * 1000) : null
      return { id, short_url, status: str(res.status) ?? 'created', expire_by: expire }
    },

    async cancelPaymentLink(id) {
      await call('POST', `/v1/payment_links/${encodeURIComponent(id)}/cancel`)
    },

    async createSubscription(input) {
      const body: Record<string, unknown> = {
        plan_id: input.plan_id,
        total_count: input.total_count,
        quantity: 1,
        customer_notify: 1,
        expire_by: unix(input.expire_by),
        notes: input.notes,
      }
      if (input.start_at) body.start_at = unix(input.start_at)
      if (input.upfront && input.upfront.amount_paise > 0) {
        body.addons = [
          {
            item: {
              name: input.upfront.name.slice(0, 100),
              amount: input.upfront.amount_paise,
              currency: 'INR',
            },
          },
        ]
      }
      const res = await call('POST', '/v1/subscriptions', body)
      const { id, short_url } = requireId(res, 'subscription')
      return { id, short_url, status: str(res.status) ?? 'created' }
    },

    async cancelSubscription(id, { atCycleEnd }) {
      const res = await call('POST', `/v1/subscriptions/${encodeURIComponent(id)}/cancel`, {
        cancel_at_cycle_end: atCycleEnd ? 1 : 0,
      })
      return { status: str(res.status) ?? 'cancelled' }
    },
  }
}
