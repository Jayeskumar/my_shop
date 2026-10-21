/**
 * Inventory error texts: `details.reason` of 403/409/422 answers (INVENTORY_ERROR_REASONS →
 * inventory:errors.<reason>) and snake_case validation keys of the contract refinements /
 * server VALIDATION_ERROR issues (errors:validation.<key>, then inventory:validation.<key>).
 * Everything else falls back to the shared error catalogue (describeError / notify.error).
 */
import {
  INVENTORY_ERROR_REASONS,
  INVENTORY_VALIDATION_KEYS,
  type InventoryErrorReason,
  type InventoryValidationKey,
} from '@kadai/shared/api/inventory'
import i18next from 'i18next'
import { notify } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { describeError } from '@/lib/errors'
import type { TranslationKey } from '@/lib/i18n-resources'
import { translate } from '@/lib/i18n'
import { localizeValidationMessage } from '@/lib/validation'

const REASONS = new Set<string>(INVENTORY_ERROR_REASONS)
const VALIDATION_KEYS = new Set<string>(INVENTORY_VALIDATION_KEYS)

export function isInventoryReason(value: unknown): value is InventoryErrorReason {
  return typeof value === 'string' && REASONS.has(value)
}

/** `details.reason` of an inventory API error, when it is one of the contract's reasons. */
export function errorReason(error: unknown): InventoryErrorReason | null {
  if (!isApiError(error)) return null
  const reason = error.details?.reason
  return isInventoryReason(reason) ? reason : null
}

/** Localized text of a validation message (inventory key, shared key, token or free text). */
export function validationText(message: string | null | undefined): string | undefined {
  if (!message) return undefined
  if (VALIDATION_KEYS.has(message)) {
    const shared = `errors:validation.${message}`
    if (i18next.exists(shared)) return translate(shared as TranslationKey)
    return translate(`inventory:validation.${message as InventoryValidationKey}`)
  }
  return localizeValidationMessage(message)
}

/** Title / description for an error thrown by an inventory route. */
export function inventoryErrorDisplay(error: unknown): { title: string; description?: string } {
  const reason = errorReason(error)
  if (reason) return { title: translate(`inventory:errors.${reason}`) }
  if (isApiError(error) && error.code === 'VALIDATION_ERROR') {
    const first = error.validationIssues[0]
    const text = validationText(first?.message)
    const base = describeError(error)
    return text ? { title: base.title, description: text } : base
  }
  return describeError(error)
}

/** Toasts an inventory error with the most specific text available. */
export function notifyInventoryError(error: unknown): void {
  const reason = errorReason(error)
  if (reason) {
    notify.error(translate(`inventory:errors.${reason}`), { id: `inventory-${reason}` })
    return
  }
  if (isApiError(error) && error.code === 'VALIDATION_ERROR') {
    const text = validationText(error.validationIssues[0]?.message)
    if (text) {
      notify.error(describeError(error).title, { description: text, id: 'inventory-validation' })
      return
    }
  }
  notify.error(error)
}
