/**
 * Form plumbing shared by the party forms: a react-hook-form resolver that validates the REQUEST
 * BODY a form would send with the contract schema (so the client checks exactly what the server
 * checks) and maps issue paths back onto form fields, plus small value converters.
 */
import { get, set, type FieldErrors, type FieldValues, type Resolver } from 'react-hook-form'
import type { z } from 'zod'

/**
 * Resolver: `toBody(values)` → `schema.safeParse(body)`. Issue paths are body paths
 * ("address.pincode", "bank_details.ifsc"); `mapPath` renames them to form paths and may return
 * null to drop an issue (fields the form does not show). Root issues (e.g. `empty_patch`) are
 * reported under `root`.
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

/** Form address (all strings) → AddressSchema input (empty parts omitted). */
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

export function addressToBody(
  address: AddressFormValues,
  stateCode: string | null | undefined,
): {
  line1?: string
  line2?: string
  city?: string
  district?: string
  state_code?: string
  pincode?: string
} {
  const out: Record<string, string> = {}
  for (const key of ['line1', 'line2', 'city', 'district', 'pincode'] as const) {
    const v = textOrUndefined(address[key])
    if (v !== undefined) out[key] = v
  }
  if (stateCode) out.state_code = stateCode
  return out
}

export function addressFromRecord(address: {
  line1?: string | undefined
  line2?: string | undefined
  city?: string | undefined
  district?: string | undefined
  pincode?: string | undefined
}): AddressFormValues {
  return {
    line1: address.line1 ?? '',
    line2: address.line2 ?? '',
    city: address.city ?? '',
    district: address.district ?? '',
    pincode: address.pincode ?? '',
  }
}

/** Signed opening balance from the form's side + amount. */
export function signedOpening(side: 'due' | 'advance', amountPaise: number | null): number {
  const amount = amountPaise ?? 0
  return side === 'advance' ? -amount : amount
}
