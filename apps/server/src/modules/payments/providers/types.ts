/**
 * Payment provider adapter interface (ARCHITECTURE.md §11.1). One adapter per provider code;
 * adapters are stateless and never touch the database — the payments services load the account
 * (with decrypted credentials) and the intent, call the adapter OUTSIDE any transaction (network
 * calls must not hold a pooled connection) and persist the normalised result.
 *
 * Adapters signal failures with AppError PROVIDER_ERROR (502) carrying
 * `details: { provider, provider_error_code, http_status, retryable }`.
 */
import type { PaymentIntentKind, PaymentIntentPurpose, PaymentProviderCode } from '@kadai/shared'
import type { ProviderCapabilities } from '@kadai/shared/api/payments'

/** Non-secret options stored in payment_provider_accounts.config. */
export interface ProviderConfig {
  /** mock: pay automatically this many ms after an intent is created (0 = only via mock-pay). */
  auto_pay_delay_ms?: number
  /** razorpay: the masked key id shown in the setup screen. */
  key_id_masked?: string
}

export interface ProviderCredentials {
  key_id: string
  key_secret: string
}

/** A provider account as adapters see it (credentials decrypted). */
export interface ProviderAccountRuntime {
  id: string
  tenant_id: string
  provider: PaymentProviderCode
  mode: 'test' | 'live'
  display_name: string
  vpa: string | null
  /** UPI payee name / QR name (defaults to the shop name). */
  payee_name: string
  merchant_code: string | null
  credentials: ProviderCredentials | null
  config: ProviderConfig
}

/** The intent fields adapters need. */
export interface ProviderIntent {
  id: string
  tenant_id: string
  kind: PaymentIntentKind
  purpose: PaymentIntentPurpose
  reference_code: string
  amount_paise: number
  /** UPI transaction note / provider description. */
  note: string | null
  provider_ref: string | null
  created_at: Date
  expires_at: Date | null
  /** payment_intents.metadata (mock: delay_ms). */
  metadata: Record<string, unknown>
}

export interface ProviderCustomer {
  name: string
  /** E.164 phone. */
  phone: string | null
}

export interface CreateQrResult {
  /** `upi://pay?…` to render as a QR (static VPA / providers returning the QR content). */
  upi_uri: string | null
  /** Provider-hosted QR image. */
  image_url: string | null
  /** Provider QR id (null for the static UPI ID: nothing to poll or close). */
  provider_ref: string | null
}

export interface CreateLinkResult {
  short_url: string
  provider_ref: string
}

/** A payment received through the provider (webhook, polling or manual confirmation). */
export interface ReceivedPayment {
  provider_payment_id: string | null
  amount_paise: number
  payer_vpa: string | null
  payer_name: string | null
  /** Bank RRN / UTR. */
  utr: string | null
  fee_paise: number | null
  paid_at: Date | null
}

/** Result of fetchStatus (polling). */
export type NormalizedStatus =
  | { status: 'pending' }
  | ({ status: 'paid' } & ReceivedPayment)
  | { status: 'failed'; reason: string }
  | { status: 'expired' }
  | { status: 'cancelled' }

/** One normalised webhook event. */
export type NormalizedEvent =
  | ({
      type: 'paid'
      provider_ref: string | null
      intent_id: string | null
      reference_code: string | null
    } & ReceivedPayment)
  | {
      type: 'failed'
      provider_ref: string | null
      intent_id: string | null
      reference_code: string | null
      provider_payment_id: string | null
      reason: string
    }

export type WebhookHeaders = Readonly<Record<string, string | string[] | undefined>>

export interface PaymentProvider {
  readonly code: PaymentProviderCode
  readonly capabilities: ProviderCapabilities
  /** Single-use, fixed-amount QR for the intent (static UPI ID: a `upi://pay` URI). */
  createQr(acct: ProviderAccountRuntime, intent: ProviderIntent): Promise<CreateQrResult>
  /** Hosted payment link (dues collection). */
  createLink(
    acct: ProviderAccountRuntime,
    intent: ProviderIntent,
    customer: ProviderCustomer,
  ): Promise<CreateLinkResult>
  /** Current status at the provider (polling: on-prem, missed webhooks). */
  fetchStatus(acct: ProviderAccountRuntime, intent: ProviderIntent): Promise<NormalizedStatus>
  /** Signature check over the exact raw body (timing-safe). */
  verifyWebhook(secret: string, rawBody: Buffer, headers: WebhookHeaders): boolean
  /** Provider event id used for de-duplication (null = derive from the body). */
  webhookEventId(body: unknown, headers: WebhookHeaders): string | null
  /** Event type label stored with the raw event. */
  webhookEventType(body: unknown): string
  parseWebhook(body: unknown): NormalizedEvent[]
  /** Closes the QR / cancels the link at the provider. */
  cancel(acct: ProviderAccountRuntime, intent: ProviderIntent): Promise<void>
  /** Throws PROVIDER_ERROR when the credentials do not work. */
  testCredentials(acct: ProviderAccountRuntime): Promise<void>
}

/** Options the adapters are built with (from the server config / environment). */
export interface ProviderRuntimeOptions {
  /** Razorpay API base URL (RAZORPAY_API_BASE; tests point it at a fake server). */
  razorpayApiBase: string
  /** Per-request timeout of provider HTTP calls. */
  timeoutMs: number
  /** Kadai public base URL (mock links point at the Kadai pay page). */
  publicBaseUrl: string
  /** fetch implementation (tests may inject one). */
  fetch?: typeof fetch
}
