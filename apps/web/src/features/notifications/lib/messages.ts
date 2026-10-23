/**
 * Render-time texts of the notifications contract's snake_case keys:
 *  - validation keys (NOTIFICATIONS_VALIDATION_KEYS, also the `message` of server
 *    VALIDATION_ERROR issues): errors:validation.<key>, then notifications:validation.<key>;
 *  - `details.reason` of 4xx errors (NOTIFICATIONS_ERROR_REASONS): notifications:errors.<reason>.
 * Translating when rendering keeps messages in step with a தமிழ் / English switch.
 */
import { notify } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { i18n, translate } from '@/lib/i18n'
import type { TranslationKey } from '@/lib/i18n-resources'
import { localizeValidationMessage } from '@/lib/validation'

const KEY_RE = /^[a-z][a-z0-9_]*$/

/** Localized text of a validation key or message (falls back to the shared form localizer). */
export function validationText(message: string | null | undefined): string | undefined {
  if (!message) return undefined
  if (KEY_RE.test(message)) {
    for (const key of [`errors:validation.${message}`, `notifications:validation.${message}`]) {
      if (i18n.exists(key)) return translate(key as TranslationKey)
    }
  }
  return localizeValidationMessage(message)
}

/** The `details.reason` of an API error, when it is one of this module's reasons. */
export function errorReason(error: unknown): string | null {
  if (!isApiError(error)) return null
  const reason = error.details?.reason
  if (typeof reason !== 'string' || !KEY_RE.test(reason)) return null
  return i18n.exists(`notifications:errors.${reason}`) ? reason : null
}

/** Translated text of an error's `details.reason`, or null. */
export function reasonText(error: unknown): string | null {
  const reason = errorReason(error)
  return reason ? translate(`notifications:errors.${reason}` as TranslationKey) : null
}

/** Toast for a failed notifications call: the reason's own text, else the generic error text. */
export function notifyNotificationError(error: unknown): void {
  const text = reasonText(error)
  if (text && isApiError(error)) {
    notify.error(text, {
      id: `notifications-${String(error.details?.reason)}`,
      ...(error.requestId
        ? { description: translate('errors:reference', { id: error.requestId }) }
        : {}),
    })
    return
  }
  notify.error(error)
}

/** Server VALIDATION_ERROR issues as {path → localized message} (first issue per path). */
export function fieldErrorsOf(error: unknown): Record<string, string> {
  if (!isApiError(error) || error.code !== 'VALIDATION_ERROR') return {}
  const out: Record<string, string> = {}
  for (const issue of error.validationIssues) {
    const path = issue.path.split('.')[0] ?? ''
    if (!path || out[path]) continue
    out[path] = validationText(issue.message) ?? issue.message
  }
  return out
}
