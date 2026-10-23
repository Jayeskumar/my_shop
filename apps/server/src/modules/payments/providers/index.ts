/**
 * Provider registry: the adapter for a provider code, built from the server configuration.
 *
 * `RAZORPAY_API_BASE` (default https://api.razorpay.com) is an operational override read from the
 * environment here — only this module talks to the Razorpay payments API, and the integration
 * tests point it at a fake Razorpay server.
 */
import type { PaymentProviderCode } from '@kadai/shared'
import { PROVIDER_CAPABILITIES } from '@kadai/shared/api/payments'
import type { Config } from '../../../config'
import { AppError } from '../../../core/errors'
import { createMockProvider } from './mock'
import { createRazorpayProvider } from './razorpay'
import type { PaymentProvider, ProviderRuntimeOptions } from './types'
import { createUpiVpaProvider } from './upi-vpa'

export type * from './types'
export { providerFailure, isProviderFailure, providerErrorCode, errorText } from './errors'

export const DEFAULT_RAZORPAY_API_BASE = 'https://api.razorpay.com'
/** Timeout of every provider HTTP request. */
export const PROVIDER_TIMEOUT_MS = 8_000

/** Provider codes whose status the poll-intents job can fetch. */
export const POLLING_PROVIDER_CODES: readonly PaymentProviderCode[] = (
  Object.entries(PROVIDER_CAPABILITIES) as Array<
    [PaymentProviderCode, (typeof PROVIDER_CAPABILITIES)[PaymentProviderCode]]
  >
)
  .filter(([, c]) => c.polling && c.implemented)
  .map(([code]) => code)

export function isPollingProvider(code: PaymentProviderCode): boolean {
  return POLLING_PROVIDER_CODES.includes(code)
}

function razorpayBase(env: NodeJS.ProcessEnv): string {
  const raw = env.RAZORPAY_API_BASE?.trim()
  if (!raw) return DEFAULT_RAZORPAY_API_BASE
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`RAZORPAY_API_BASE is not a URL: ${raw}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('RAZORPAY_API_BASE must be an http(s) URL')
  }
  return raw.replace(/\/+$/, '')
}

export function providerRuntimeOptions(
  config: Pick<Config, 'publicBaseUrl'>,
  env: NodeJS.ProcessEnv = process.env,
): ProviderRuntimeOptions {
  return {
    razorpayApiBase: razorpayBase(env),
    timeoutMs: PROVIDER_TIMEOUT_MS,
    publicBaseUrl: config.publicBaseUrl,
  }
}

export interface ProviderDeps {
  config: Pick<Config, 'publicBaseUrl' | 'enableMockPayments'>
}

/**
 * The adapter for `code`. Mock needs KADAI_ENABLE_MOCK_PAYMENTS; providers without an adapter in
 * this release (cashfree, phonepe, paytm) are 422 `provider_not_implemented`.
 */
export function getProvider(code: PaymentProviderCode, deps: ProviderDeps): PaymentProvider {
  switch (code) {
    case 'upi_vpa':
      return createUpiVpaProvider()
    case 'razorpay':
      return createRazorpayProvider(providerRuntimeOptions(deps.config))
    case 'mock':
      if (!deps.config.enableMockPayments) {
        throw new AppError('UNPROCESSABLE', 'Mock payments are disabled on this server', {
          reason: 'mock_payments_disabled',
        })
      }
      return createMockProvider({ publicBaseUrl: deps.config.publicBaseUrl })
    default:
      throw new AppError('UNPROCESSABLE', `No adapter for the ${code} provider in this release`, {
        reason: 'provider_not_implemented',
        provider: code,
      })
  }
}
