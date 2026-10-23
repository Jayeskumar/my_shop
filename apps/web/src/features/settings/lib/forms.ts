/**
 * Form plumbing shared by the settings forms: a react-hook-form resolver that validates the
 * REQUEST BODY a form would send with the contract schema (the client checks exactly what the
 * server checks) and maps issue paths back onto form fields, plus small value converters and a
 * changed-fields diff for PATCH bodies.
 */
import { get, set, type FieldErrors, type FieldValues, type Resolver } from 'react-hook-form'
import type { z } from 'zod'
import type { Address } from '@kadai/shared/api/common'

/**
 * Resolver: `toBody(values)` → `schema.safeParse(body)`. Issue paths are body paths
 * ("address.pincode"); `mapPath` renames them to form paths and may return null to drop an
 * issue. Root issues (e.g. `empty_patch`) are reported under `root`.
 */
export function contractResolver<V extends FieldValues>(
  schema: z.ZodType | ((values: V) => z.ZodType),
  toBody: (values: V) => unknown,
  mapPath: (bodyPath: string) => string | null = (p) => p,
  /** Rewrites fixed English messages of shared refinements into validation keys. */
  mapMessage: (message: string) => string = (m) => m,
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
      set(errors, path, { type: issue.code, message: mapMessage(issue.message) })
    }
    return { values: {}, errors }
  }
}

/** Trimmed text, '' → null (clearable body fields). */
export function textOrNull(value: string | null | undefined): string | null {
  const v = (value ?? '').trim()
  return v === '' ? null : v
}

/** Trimmed text, '' → undefined (address parts, optional texts). */
export function textOrUndefined(value: string | null | undefined): string | undefined {
  const v = (value ?? '').trim()
  return v === '' ? undefined : v
}

/** Address as edited in forms (all strings; the state comes from the state / GSTIN field). */
export interface AddressFormValues {
  line1: string
  line2: string
  city: string
  district: string
  pincode: string
}

export const EMPTY_ADDRESS: AddressFormValues = {
  line1: '',
  line2: '',
  city: '',
  district: '',
  pincode: '',
}

/** Form address → AddressSchema input (empty parts omitted). */
export function addressToBody(
  address: AddressFormValues,
  stateCode: string | null | undefined,
): Address {
  const out: Record<string, string> = {}
  for (const key of ['line1', 'line2', 'city', 'district', 'pincode'] as const) {
    const v = textOrUndefined(address[key])
    if (v !== undefined) out[key] = v
  }
  if (stateCode) out.state_code = stateCode
  return out as Address
}

export function addressFromRecord(address: Partial<Address> | null | undefined): AddressFormValues {
  return {
    line1: address?.line1 ?? '',
    line2: address?.line2 ?? '',
    city: address?.city ?? '',
    district: address?.district ?? '',
    pincode: address?.pincode ?? '',
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Fields of `next` that differ from `base`, recursing into plain objects (arrays and scalars
 * are compared by value and replaced whole). Returns undefined when nothing changed.
 */
export function changedFields<T>(base: T, next: T): Partial<T> | undefined {
  if (!isPlainObject(base) || !isPlainObject(next)) {
    return JSON.stringify(base) === JSON.stringify(next) ? undefined : (next as Partial<T>)
  }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(next)) {
    const a = base[key]
    const b = next[key]
    if (isPlainObject(a) && isPlainObject(b)) {
      const nested = changedFields(a, b)
      if (nested !== undefined) out[key] = nested
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      out[key] = b
    }
  }
  return Object.keys(out).length ? (out as Partial<T>) : undefined
}

/** Only digits (PIN, pincode inputs). */
export function digitsOnly(value: string, max?: number): string {
  const d = value.replace(/\D/g, '')
  return max === undefined ? d : d.slice(0, max)
}

/**
 * Top-level keys of `next` whose value differs from `base` (objects such as `address` are sent
 * whole — the server replaces them). Returns undefined when nothing changed.
 */
export function changedTopLevel<T extends Record<string, unknown>>(
  base: T,
  next: T,
): Partial<T> | undefined {
  const out: Partial<T> = {}
  let changed = false
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (JSON.stringify(base[key]) !== JSON.stringify(next[key])) {
      out[key] = next[key]
      changed = true
    }
  }
  return changed ? out : undefined
}
