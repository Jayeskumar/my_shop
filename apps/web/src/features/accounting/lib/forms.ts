/**
 * Form plumbing shared by the accounting forms: a react-hook-form resolver that validates the
 * REQUEST BODY a form would send with the contract schema (so the client checks exactly what the
 * server checks) and maps issue paths back onto form fields, plus small value helpers.
 */
import { get, set, type FieldErrors, type FieldValues, type Resolver } from 'react-hook-form'
import type { z } from 'zod'

/**
 * Resolver: `toBody(values)` → `schema.safeParse(body)`. Issue paths are body paths
 * ("lines.1.debit_paise"); `mapPath` renames them to form paths and may return null to drop an
 * issue (fields the form does not show). Root issues are reported under `root`.
 */
export function contractResolver<V extends FieldValues>(
  schema: z.ZodType,
  toBody: (values: V) => unknown,
  mapPath: (bodyPath: string) => string | null = (p) => p,
): Resolver<V> {
  return (values) => {
    const result = schema.safeParse(toBody(values))
    if (result.success) return { values, errors: {} }
    const errors: FieldErrors<V> = {}
    for (const issue of result.error.issues) {
      const bodyPath = issue.path.map(String).join('.')
      const path = bodyPath === '' ? 'root' : mapPath(bodyPath)
      if (path === null || get(errors, path)) continue
      set(errors, path, { type: issue.code, message: issue.message })
    }
    return { values: {}, errors }
  }
}

/** Trimmed text, '' → null (clearable body fields). */
export function textOrNull(value: string | null | undefined): string | null {
  const v = (value ?? '').trim()
  return v === '' ? null : v
}

/** Trimmed text, '' → undefined. */
export function textOrUndefined(value: string | null | undefined): string | undefined {
  const v = (value ?? '').trim()
  return v === '' ? undefined : v
}
