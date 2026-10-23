/**
 * Accounting error texts: `details.reason` of 4xx answers (ACCOUNTING_ERROR_REASONS →
 * accounting:errors.<reason>) and the snake_case validation keys of the contract refinements /
 * server VALIDATION_ERROR issues (errors:validation.<key>, then accounting:validation.<key>).
 * Everything else falls back to the shared error catalogue (describeError / notify.error).
 */
import {
  ACCOUNTING_ERROR_REASONS,
  ACCOUNTING_VALIDATION_KEYS,
  type AccountingErrorReason,
  type AccountingValidationKey,
} from '@kadai/shared/api/accounting'
import i18next from 'i18next'
import { notify } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { describeError } from '@/lib/errors'
import type { TranslationKey } from '@/lib/i18n-resources'
import { translate } from '@/lib/i18n'
import { localizeValidationMessage } from '@/lib/validation'

const REASONS = new Set<string>(ACCOUNTING_ERROR_REASONS)
const VALIDATION_KEYS = new Set<string>(ACCOUNTING_VALIDATION_KEYS)

export function isAccountingReason(value: unknown): value is AccountingErrorReason {
  return typeof value === 'string' && REASONS.has(value)
}

/** `details.reason` of an accounting API error, when it is one of the contract's reasons. */
export function errorReason(error: unknown): AccountingErrorReason | null {
  if (!isApiError(error)) return null
  const reason = error.details?.reason
  return isAccountingReason(reason) ? reason : null
}

/** Localized text of a validation message (accounting key, shared key, token or free text). */
export function validationText(message: string | null | undefined): string | undefined {
  if (!message) return undefined
  if (VALIDATION_KEYS.has(message)) {
    const shared = `errors:validation.${message}`
    if (i18next.exists(shared)) return translate(shared as TranslationKey)
    return translate(`accounting:validation.${message as AccountingValidationKey}`)
  }
  return localizeValidationMessage(message)
}

/** Title / description for an error thrown by an accounting route. */
export function accountingErrorDisplay(error: unknown): { title: string; description?: string } {
  const reason = errorReason(error)
  if (reason) return { title: translate(`accounting:errors.${reason}`) }
  if (isApiError(error) && error.code === 'VALIDATION_ERROR') {
    const first = error.validationIssues[0]
    const text = validationText(first?.message)
    const base = describeError(error)
    return text ? { title: base.title, description: text } : base
  }
  return describeError(error)
}

/** Toasts an accounting error with the most specific text available. */
export function notifyAccountingError(error: unknown): void {
  const reason = errorReason(error)
  if (reason) {
    notify.error(translate(`accounting:errors.${reason}`), { id: `accounting-${reason}` })
    return
  }
  if (isApiError(error) && error.code === 'VALIDATION_ERROR') {
    const issue = error.validationIssues[0]
    const text = validationText(issue?.message)
    if (text) {
      notify.error(describeError(error).title, { description: text, id: 'accounting-validation' })
      return
    }
  }
  notify.error(error)
}

/** Server validation issues as `{path, text}` (paths like "lines.2.account_id"). */
export function validationIssuesOf(error: unknown): { path: string; text: string }[] {
  if (!isApiError(error) || error.code !== 'VALIDATION_ERROR') return []
  return error.validationIssues.map((i) => ({
    path: i.path,
    text: validationText(i.message) ?? i.message,
  }))
}
