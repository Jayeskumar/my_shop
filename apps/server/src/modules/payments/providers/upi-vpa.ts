/**
 * Static UPI ID (`upi_vpa`, the default and zero-cost provider): an NPCI `upi://pay` intent with
 * the shop's own VPA, a fixed amount, the note and the intent's reference code as `tr`. It works
 * offline (the POS renders the QR itself). There is no bank callback and nothing to poll or
 * close: the cashier confirms receipt (soundbox / phone) — POST /payments/intents/:id/confirm,
 * `confirmation='manual'`, audited.
 */
import { buildUpiUri } from '@kadai/shared'
import { PROVIDER_CAPABILITIES } from '@kadai/shared/api/payments'
import { notSupported } from './errors'
import type { PaymentProvider, ProviderAccountRuntime, ProviderIntent } from './types'

/** UPI intent URI for an intent of a VPA account. */
export function vpaIntentUri(acct: ProviderAccountRuntime, intent: ProviderIntent): string {
  if (!acct.vpa) throw notSupported('upi_vpa', 'payments without a UPI ID')
  return buildUpiUri({
    vpa: acct.vpa,
    payee_name: acct.payee_name,
    amount_paise: intent.amount_paise,
    note: intent.note,
    reference: intent.reference_code,
    mcc: acct.merchant_code,
  })
}

export function createUpiVpaProvider(): PaymentProvider {
  return {
    code: 'upi_vpa',
    capabilities: PROVIDER_CAPABILITIES.upi_vpa,
    async createQr(acct, intent) {
      return { upi_uri: vpaIntentUri(acct, intent), image_url: null, provider_ref: null }
    },
    async createLink() {
      // Dues links of a static UPI ID are the Kadai pay page (modules/payments/links.ts).
      throw notSupported('upi_vpa', 'hosted payment links')
    },
    async fetchStatus() {
      throw notSupported('upi_vpa', 'status polling')
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
      // A static QR cannot be closed: nothing to do.
    },
    async testCredentials() {
      // No credentials; the owner verifies the VPA by scanning the ₹1 test QR.
    },
  }
}
