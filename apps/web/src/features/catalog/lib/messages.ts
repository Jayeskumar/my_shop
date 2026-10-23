/**
 * Localization of catalog validation keys and server error details.
 *
 * Custom rules of the catalog contract carry snake_case keys as messages (CATALOG_VALIDATION_KEYS,
 * e.g. 'mrp_below_sale_price'). They are translated at render time: errors:validation.<key> when
 * the shared catalogue has it, else catalog:validation.<key>. Anything else is left to the UI kit
 * (FormField localizes zod tokens and known shared messages).
 */
import i18next from 'i18next'
import { isApiError } from '@/lib/api'
import type { TranslationKey } from '@/lib/i18n-resources'
import { translate } from '@/lib/i18n'

const KEY_RE = /^[a-z][a-z0-9_]*$/

/** Translation of a snake_case validation key, or undefined when it is not one we know. */
export function catalogValidationText(message: string | null | undefined): string | undefined {
  if (!message || !KEY_RE.test(message)) return undefined
  for (const ns of ['errors:validation', 'catalog:validation'] as const) {
    const key = `${ns}.${message}`
    if (i18next.exists(key)) return translate(key as TranslationKey)
  }
  return undefined
}

/** Localized text of a catalog `details.reason` (409 / 422), e.g. barcode_taken; else undefined. */
export function catalogReasonText(error: unknown): string | undefined {
  if (!isApiError(error)) return undefined
  const reason = error.details?.reason
  if (typeof reason !== 'string' || !KEY_RE.test(reason)) return undefined
  const key = `catalog:error_reasons.${reason}`
  return i18next.exists(key) ? translate(key as TranslationKey) : undefined
}

/** `details.hint === 'deactivate'` on a 409 from deleting used categories / brands / rules. */
export function isInUseConflict(error: unknown): boolean {
  if (!isApiError(error) || error.status !== 409) return false
  return error.details?.hint === 'deactivate' || error.details?.reason === 'in_use_deactivate'
}

/** First server validation issue as a localized sentence (dialogs without per-field mapping). */
export function firstIssueText(error: unknown): string | undefined {
  if (!isApiError(error) || error.code !== 'VALIDATION_ERROR') return undefined
  const issue = error.validationIssues[0]
  if (!issue) return undefined
  return catalogValidationText(issue.message) ?? issue.message
}

/** Product import error (`imports.errors[].code`) in the UI language, else the English detail. */
export function importErrorText(code: string, message: string): string {
  if (!KEY_RE.test(code)) return message
  const key = `catalog:import_errors.${code}`
  return i18next.exists(key) ? translate(key as TranslationKey) : message
}

/** Import summary counter (`summary.details`), e.g. categories_created → "3 categories created". */
export function importDetailText(key: string, count: number): string {
  const k = `catalog:import.details.${key}`
  if (KEY_RE.test(key) && i18next.exists(`${k}_other`))
    return translate(k as TranslationKey, { count })
  return `${key.replace(/_/g, ' ')}: ${count}`
}
