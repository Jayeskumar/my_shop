/**
 * Mock provider — development and tests only (KADAI_ENABLE_MOCK_PAYMENTS=true; production config
 * refuses it). It behaves like a dynamic PSP without the network:
 *  - createQr / createLink return a `upi://pay` URI / the Kadai pay page with provider refs
 *    `mock_qr_…` / `mock_link_…`;
 *  - fetchStatus reports `paid` once `metadata.delay_ms` (copied from the account's
 *    auto_pay_delay_ms when the intent was created) has elapsed — the poll-intents job then
 *    confirms it like a real provider; 0 = only POST /payments/intents/:id/mock-pay pays it.
 * Payment ids and UTRs are derived from the intent id, so repeated polls report the same
 * payment (idempotent confirmation).
 */
import { buildUpiUri } from '@kadai/shared'
import { PROVIDER_CAPABILITIES } from '@kadai/shared/api/payments'
import type {
  PaymentProvider,
  ProviderIntent,
  ProviderRuntimeOptions,
  ReceivedPayment,
} from './types'

/** Payee VPA of mock QRs (a syntactically valid handle that no bank resolves). */
export const MOCK_VPA = 'kadai.mock@mockbank'
/** Payer VPA reported by the mock. */
export const MOCK_PAYER_VPA = 'customer@mockupi'

const compact = (id: string) => id.replace(/-/g, '')

/** The payment the mock reports for an intent (deterministic per intent). */
export function mockPayment(
  intent: Pick<ProviderIntent, 'id' | 'amount_paise'>,
  amount?: number,
): ReceivedPayment {
  const digits = compact(intent.id).replace(/[^0-9]/g, '')
  return {
    provider_payment_id: `mock_pay_${compact(intent.id)}`,
    amount_paise: amount ?? intent.amount_paise,
    payer_vpa: MOCK_PAYER_VPA,
    payer_name: 'Mock Customer',
    utr: `9${digits.padEnd(11, '0').slice(-11)}`,
    fee_paise: 0,
    paid_at: new Date(),
  }
}

function delayOf(intent: ProviderIntent): number {
  const v = intent.metadata.delay_ms
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

export function createMockProvider(
  opts: Pick<ProviderRuntimeOptions, 'publicBaseUrl'>,
): PaymentProvider {
  return {
    code: 'mock',
    capabilities: PROVIDER_CAPABILITIES.mock,
    async createQr(acct, intent) {
      return {
        upi_uri: buildUpiUri({
          vpa: acct.vpa ?? MOCK_VPA,
          payee_name: acct.payee_name,
          amount_paise: intent.amount_paise,
          note: intent.note,
          reference: intent.reference_code,
          mcc: acct.merchant_code,
        }),
        image_url: null,
        provider_ref: `mock_qr_${compact(intent.id)}`,
      }
    },
    async createLink(_acct, intent) {
      return {
        short_url: `${opts.publicBaseUrl}/pay/${intent.reference_code}`,
        provider_ref: `mock_link_${compact(intent.id)}`,
      }
    },
    async fetchStatus(_acct, intent) {
      const delay = delayOf(intent)
      if (delay > 0 && Date.now() >= intent.created_at.getTime() + delay) {
        return { status: 'paid', ...mockPayment(intent) }
      }
      return { status: 'pending' }
    },
    verifyWebhook() {
      return false
    },
    webhookEventId() {
      return null
    },
    webhookEventType() {
      return 'unknown'
    },
    parseWebhook() {
      return []
    },
    async cancel() {
      // Nothing to close.
    },
    async testCredentials() {
      // Always works.
    },
  }
}
