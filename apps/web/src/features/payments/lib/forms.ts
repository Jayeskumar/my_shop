/**
 * Form plumbing for the payments forms: a react-hook-form resolver that validates the REQUEST
 * BODY a form would send with the contract schema (the client checks exactly what the server
 * checks) and maps issue paths back onto form fields, plus server-error mapping.
 */
import {
  get,
  set,
  type FieldErrors,
  type FieldValues,
  type Path,
  type Resolver,
  type UseFormSetError,
} from 'react-hook-form'
import type { z } from 'zod'
import { isApiError } from '@/lib/api'

/**
 * Resolver: `toBody(values)` → `schema.safeParse(body)`. Issue paths are body paths
 * ("credentials.key_id"); `mapPath` renames them to form paths and may return null to drop an
 * issue (fields the form does not show). Root issues (e.g. `empty_patch`) go under `root`.
 */
export function contractResolver<V extends FieldValues>(
  schema: z.ZodType | ((values: V) => z.ZodType),
  toBody: (values: V) => unknown,
  mapPath: (bodyPath: string) => string | null = (p) => p,
): Resolver<V> {
  return (values) => {
    const s = typeof schema === 'function' ? schema(values) : schema
    const result = s.safeParse(toBody(values))
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

/**
 * Puts the field issues of a 400 VALIDATION_ERROR onto the form (body path → form path via
 * `mapPath`). Returns true when at least one issue landed on a shown field; the caller toasts
 * everything else.
 */
export function applyContractErrors<V extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<V>,
  fields: readonly string[],
  mapPath: (bodyPath: string) => string | null = (p) => p,
): boolean {
  if (!isApiError(error) || error.code !== 'VALIDATION_ERROR') return false
  let applied = false
  for (const issue of error.validationIssues) {
    const path = mapPath(issue.path)
    if (path === null || !fields.includes(path)) continue
    setError(path as Path<V>, { type: 'server', message: issue.message })
    applied = true
  }
  return applied
}

/** Trimmed text, '' → undefined (optional body fields). */
export function textOrUndefined(value: string | null | undefined): string | undefined {
  const v = (value ?? '').trim()
  return v === '' ? undefined : v
}
