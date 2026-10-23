/**
 * Form plumbing of the sales dialogs: contract-schema validation of the request body a form would
 * send, render-time translation of snake_case validation keys (contract refinements and server
 * VALIDATION_ERROR issues: errors:validation.<key>, then sales:validation.<key>), and mapping of
 * server errors onto a field.
 */
import { useTranslation } from 'react-i18next'
import type { z } from 'zod'
import { isApiError } from '@/lib/api'
import { translate } from '@/lib/i18n'
import type { TranslationKey } from '@/lib/i18n-resources'
import { localizeValidationMessage } from '@/lib/validation'

const KEY_RE = /^[a-z][a-z0-9_]*$/

/** Localized text of a validation message (snake_case key, zod token, known shared text). */
export function useValidationText(): (message: string | null | undefined) => string | undefined {
  const { i18n } = useTranslation(['sales', 'errors'])
  return (message) => {
    if (!message) return undefined
    if (KEY_RE.test(message)) {
      for (const key of [`errors:validation.${message}`, `sales:validation.${message}`]) {
        if (i18n.exists(key)) return translate(key as TranslationKey)
      }
    }
    return localizeValidationMessage(message)
  }
}

/** Issues of `schema.safeParse(body)` as `{ path: message }` (first issue per path). */
export function contractIssues(schema: z.ZodType, body: unknown): Record<string, string> {
  const result = schema.safeParse(body)
  if (result.success) return {}
  const out: Record<string, string> = {}
  for (const issue of result.error.issues) {
    const path = issue.path.map(String).join('.')
    if (!(path in out)) out[path] = issue.message
  }
  return out
}

/** The first issue whose path starts with `prefix` (e.g. 'tenders' matches 'tenders.0.amount'). */
export function issueAt(issues: Record<string, string>, prefix: string): string | undefined {
  if (prefix in issues) return issues[prefix]
  const hit = Object.entries(issues).find(([p]) => p.startsWith(`${prefix}.`))
  return hit?.[1]
}

/** Field message of a server VALIDATION_ERROR for `path` (prefix match), if any. */
export function serverIssue(error: unknown, path: string): string | undefined {
  if (!isApiError(error) || error.code !== 'VALIDATION_ERROR') return undefined
  const hit = error.validationIssues.find((i) => i.path === path || i.path.startsWith(`${path}.`))
  return hit?.message
}

/** `details.reason` of an API error (string), if any. */
export function errorReason(error: unknown): string | undefined {
  if (!isApiError(error)) return undefined
  const reason = (error.details as { reason?: unknown } | undefined)?.reason
  return typeof reason === 'string' ? reason : undefined
}
