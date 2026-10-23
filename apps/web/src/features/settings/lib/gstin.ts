/**
 * Live GSTIN feedback for the business / store forms: while typing, how far along; at 15
 * characters, whether the check character matches and which state / PAN it encodes.
 */
import {
  getState,
  gstinCheckChar,
  isValidGstin,
  isValidStateCode,
  panFromGstin,
  type IndianState,
} from '@kadai/shared/gst'

export type GstinStatus =
  | { kind: 'empty' }
  | { kind: 'typing'; length: number }
  | { kind: 'too_long'; length: number }
  | { kind: 'state'; code: string }
  | { kind: 'format' }
  /** Structure is fine but the check character does not match: some character is mistyped. */
  | { kind: 'checksum' }
  | { kind: 'valid'; state: IndianState | null; stateCode: string; pan: string | null }

export const GSTIN_LENGTH = 15

/** Normalised (trimmed, upper-case, no inner spaces) form of what the user typed. */
export function cleanGstin(input: string | null | undefined): string {
  return (input ?? '').replace(/\s+/g, '').toUpperCase()
}

export function gstinStatus(input: string | null | undefined): GstinStatus {
  const v = cleanGstin(input)
  if (v === '') return { kind: 'empty' }
  if (v.length > GSTIN_LENGTH) return { kind: 'too_long', length: v.length }
  if (v.length >= 2 && /^\d{2}/.test(v) && !isValidStateCode(v.slice(0, 2)))
    return { kind: 'state', code: v.slice(0, 2) }
  if (v.length < GSTIN_LENGTH) return { kind: 'typing', length: v.length }
  // A copy for the type guard: narrowing `v` would leave it `never` below.
  const candidate: unknown = v
  if (isValidGstin(candidate)) {
    const code = v.slice(0, 2)
    return { kind: 'valid', state: getState(code) ?? null, stateCode: code, pan: panFromGstin(v) }
  }
  const first14 = v.slice(0, 14)
  if (/^[0-9]{2}[0-9A-Z]{10}[1-9A-Z][0-9A-Z]$/.test(first14)) {
    if (gstinCheckChar(first14) !== v.charAt(14)) return { kind: 'checksum' }
  }
  return { kind: 'format' }
}
