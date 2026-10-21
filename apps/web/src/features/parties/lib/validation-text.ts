/**
 * Render-time translation of snake_case validation keys (contract refinements, server
 * VALIDATION_ERROR issues, import row codes): errors:validation.<key>, then
 * parties:validation.<key>.
 */
import { useTranslation } from 'react-i18next'
import type { TranslationKey } from '@/lib/i18n-resources'
import { translate } from '@/lib/i18n'

const KEY_RE = /^[a-z][a-z0-9_]*$/

/** Localized text of a snake_case validation key, or undefined when the key is unknown. */
export function useValidationKeyText(): (message: string | null | undefined) => string | undefined {
  const { i18n } = useTranslation(['parties', 'errors'])
  return (message) => {
    if (!message || !KEY_RE.test(message)) return undefined
    for (const key of [`errors:validation.${message}`, `parties:validation.${message}`]) {
      if (i18n.exists(key)) return translate(key as TranslationKey)
    }
    return undefined
  }
}
