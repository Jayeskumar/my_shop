/**
 * User-facing texts for settings errors:
 *
 *  - Contract refinements and server VALIDATION_ERROR issues carry snake_case keys ('gstin',
 *    'store_code', 'series_too_long' …). They are translated at render time from
 *    errors:validation.<key>, then settings:validation.<key>, so a language switch updates them.
 *  - Identity 403/409/422 errors carry `details.reason` (IDENTITY_ERROR_REASONS) → settings:errors.*.
 *  - 402 (FEATURE_NOT_IN_PLAN / PLAN_LIMIT_REACHED) is shown as an upgrade hint, not a failure.
 */
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { IDENTITY_ERROR_REASONS, type IdentityErrorReason } from '@kadai/shared/api/identity'
import { LIMIT_METRICS, isFeature, type Feature, type LimitMetric } from '@kadai/shared/features'
import { notify } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { describeError } from '@/lib/errors'
import { translate } from '@/lib/i18n'
import type { TranslationKey } from '@/lib/i18n-resources'

const KEY_RE = /^[a-z][a-z0-9_]*$/

/** Localized text of a snake_case validation key, or undefined when the key is unknown. */
export function useValidationKeyText(): (message: string | null | undefined) => string | undefined {
  const { i18n } = useTranslation(['settings', 'errors'])
  return useCallback(
    (message) => {
      if (!message || !KEY_RE.test(message)) return undefined
      for (const key of [`errors:validation.${message}`, `settings:validation.${message}`]) {
        if (i18n.exists(key)) return translate(key as TranslationKey)
      }
      return undefined
    },
    // i18n.language makes the callback change on a language switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [i18n, i18n.language],
  )
}

/** `details.reason` of an identity error, when it is one the UI knows. */
export function errorReason(error: unknown): IdentityErrorReason | null {
  if (!isApiError(error)) return null
  const reason = error.details?.reason
  return typeof reason === 'string' &&
    (IDENTITY_ERROR_REASONS as readonly string[]).includes(reason)
    ? (reason as IdentityErrorReason)
    : null
}

/** Text for an identity error reason (with its details as interpolation values). */
export function reasonText(error: unknown): string | null {
  const reason = errorReason(error)
  if (!reason || !isApiError(error)) return null
  const details = error.details ?? {}
  const count = typeof details.member_count === 'number' ? details.member_count : undefined
  return translate(
    `settings:errors.${reason}` as TranslationKey,
    count === undefined ? {} : { count },
  )
}

const isLimitMetric = (v: string): v is LimitMetric =>
  (LIMIT_METRICS as readonly string[]).includes(v)

/** Plan / licence limits (402): what is missing. */
export type PlanBlock =
  | { kind: 'feature'; feature: Feature }
  | { kind: 'limit'; metric: LimitMetric; limit: number | null }

export function planBlockOf(error: unknown): PlanBlock | null {
  if (!isApiError(error) || error.status !== 402) return null
  const d = error.details ?? {}
  if (
    error.code === 'PLAN_LIMIT_REACHED' &&
    typeof d.metric === 'string' &&
    isLimitMetric(d.metric)
  )
    return { kind: 'limit', metric: d.metric, limit: typeof d.limit === 'number' ? d.limit : null }
  if (error.code === 'FEATURE_NOT_IN_PLAN' && typeof d.feature === 'string' && isFeature(d.feature))
    return { kind: 'feature', feature: d.feature }
  return null
}

/**
 * Toasts an error from a settings action: the identity reason text when there is one, else the
 * generic localized message of the error code.
 */
export function notifySettingsError(error: unknown): void {
  const text = reasonText(error)
  if (text) {
    notify.error(text, { id: `settings-${errorReason(error) ?? 'error'}` })
    return
  }
  notify.error(error)
}

/** Title + optional description for inline error panels. */
export function settingsErrorDisplay(error: unknown): { title: string; description?: string } {
  const text = reasonText(error)
  if (text) return { title: text }
  const d = describeError(error)
  return d.description ? { title: d.title, description: d.description } : { title: d.title }
}
