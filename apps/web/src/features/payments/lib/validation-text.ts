/**
 * Render-time translation of snake_case validation keys (contract refinements such as
 * 'vpa_invalid', 'allocations_exceed_amount', and the same keys in server VALIDATION_ERROR
 * issues): errors:validation.<key>, then payments:validation.<key>, then payments:reasons.<key>
 * (server `details.reason` codes such as 'intent_used'). Translating at render time
 * means a language switch updates messages that are already on screen.
 */
import { useTranslation } from 'react-i18next'
import type { TranslationKey } from '@/lib/i18n-resources'
import { translate } from '@/lib/i18n'

const KEY_RE = /^[a-z][a-z0-9_]*$/

/** Localized text of a snake_case validation key, or undefined when the key is unknown. */
export function useValidationKeyText(): (message: string | null | undefined) => string | undefined {
  const { i18n } = useTranslation(['payments', 'errors'])
  return (message) => {
    if (!message || !KEY_RE.test(message)) return undefined
    for (const key of [
      `errors:validation.${message}`,
      `payments:validation.${message}`,
      `payments:reasons.${message}`,
    ]) {
      if (i18n.exists(key)) return translate(key as TranslationKey)
    }
    return undefined
  }
}
