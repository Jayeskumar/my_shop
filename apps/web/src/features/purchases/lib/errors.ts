/**
 * Purchases error texts: `details.reason` of 4xx answers (PURCHASES_ERROR_REASONS →
 * purchases:errors.<reason>) and the snake_case validation keys of the contract refinements /
 * server VALIDATION_ERROR issues (errors:validation.<key>, then purchases:validation.<key>).
 * Everything else falls back to the shared error catalogue (describeError / notify.error).
 */
import {
  PURCHASES_ERROR_REASONS,
  PURCHASES_VALIDATION_KEYS,
  type PurchasesErrorReason,
  type PurchasesValidationKey,
} from '@kadai/shared/api/purchases'
import i18next from 'i18next'
import { notify } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { describeError } from '@/lib/errors'
import type { TranslationKey } from '@/lib/i18n-resources'
import { translate } from '@/lib/i18n'
import { localizeValidationMessage } from '@/lib/validation'

const REASONS = new Set<string>(PURCHASES_ERROR_REASONS)
const VALIDATION_KEYS = new Set<string>(PURCHASES_VALIDATION_KEYS)

export function isPurchasesReason(value: unknown): value is PurchasesErrorReason {
  return typeof value === 'string' && REASONS.has(value)
}

/** `details.reason` of a purchases API error, when it is one of the contract's reasons. */
export function errorReason(error: unknown): PurchasesErrorReason | null {
  if (!isApiError(error)) return null
  const reason = error.details?.reason
  return isPurchasesReason(reason) ? reason : null
}

/** Localized text of a validation message (purchases key, shared key, token or free text). */
export function validationText(message: string | null | undefined): string | undefined {
  if (!message) return undefined
  if (VALIDATION_KEYS.has(message)) {
    const shared = `errors:validation.${message}`
    if (i18next.exists(shared)) return translate(shared as TranslationKey)
    return translate(`purchases:validation.${message as PurchasesValidationKey}`)
  }
  return localizeValidationMessage(message)
}

/** Title / description for an error thrown by a purchases route. */
export function purchasesErrorDisplay(error: unknown): { title: string; description?: string } {
  const reason = errorReason(error)
  if (reason) return { title: translate(`purchases:errors.${reason}`) }
  if (isApiError(error) && error.code === 'VALIDATION_ERROR') {
    const first = error.validationIssues[0]
    const text = validationText(first?.message)
    const base = describeError(error)
    return text ? { title: base.title, description: text } : base
  }
  return describeError(error)
}

/** Toasts a purchases error with the most specific text available. */
export function notifyPurchasesError(error: unknown): void {
  const reason = errorReason(error)
  if (reason) {
    notify.error(translate(`purchases:errors.${reason}`), { id: `purchases-${reason}` })
    return
  }
  if (isApiError(error) && error.code === 'VALIDATION_ERROR') {
    const issue = error.validationIssues[0]
    const text = validationText(issue?.message)
    if (text) {
      notify.error(describeError(error).title, { description: text, id: 'purchases-validation' })
      return
    }
  }
  notify.error(error)
}

/** Server validation issues as `{path, text}` (paths like "lines.2.batch_no"). */
export function validationIssuesOf(error: unknown): { path: string; text: string }[] {
  if (!isApiError(error) || error.code !== 'VALIDATION_ERROR') return []
  return error.validationIssues.map((i) => ({
    path: i.path,
    text: validationText(i.message) ?? i.message,
  }))
}
