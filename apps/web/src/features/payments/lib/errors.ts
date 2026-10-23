/**
 * Error toasts of the payments screens: a payments `details.reason` (PAYMENTS_ERROR_REASONS in
 * the contract, e.g. 'intent_paid', 'utr_already_used', 'no_upi_account') is shown with its own
 * Tamil / English text from payments:errors.<reason>; anything else falls back to the generic
 * error-code message (notify.error).
 */
import { notify } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { i18n, translate } from '@/lib/i18n'
import type { TranslationKey } from '@/lib/i18n-resources'

/** The translated text of an error's `details.reason`, or null when there is none. */
export function paymentErrorText(error: unknown): string | null {
  if (!isApiError(error)) return null
  const reason = error.details?.reason
  if (typeof reason !== 'string' || !/^[a-z][a-z0-9_]*$/.test(reason)) return null
  const key = `payments:errors.${reason}`
  return i18n.exists(key) ? translate(key as TranslationKey) : null
}

export function notifyPaymentError(error: unknown): void {
  const text = paymentErrorText(error)
  if (text && isApiError(error)) {
    notify.error(text, {
      id: `payments-${String(error.details?.reason)}`,
      ...(error.requestId
        ? { description: translate('errors:reference', { id: error.requestId }) }
        : {}),
    })
    return
  }
  notify.error(error)
}
