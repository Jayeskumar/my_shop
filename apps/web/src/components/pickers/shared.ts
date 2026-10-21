/**
 * Helpers shared by the cross-module pickers (components/pickers). Pure functions only — the
 * components live in the *-picker.tsx files.
 */
import type { BatchRow } from '@kadai/shared/api/inventory'
import { normalizeIndianPhone } from '@kadai/shared/phone'
import type { FieldSize } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { getLanguage } from '@/lib/i18n'

/** Props every picker accepts (forwarded to the Combobox). */
export interface PickerBaseProps {
  id?: string
  placeholder?: string
  disabled?: boolean
  /** Show the ✕ button (default true). */
  clearable?: boolean
  size?: FieldSize
  className?: string
  'aria-label'?: string
}

/** Rows asked for per search (async pickers). */
export const PICKER_PAGE_SIZE = 20

/** Pickers keep static lists (accounts, categories, users, batches) this long before refetching. */
export const PICKER_STALE_MS = 5 * 60_000

/** A value an async picker can display before (or without) loading the full row. */
export type PickerRef<T extends { id: string; name: string }> = Pick<T, 'id' | 'name'> & Partial<T>

/** Barcode / SKU-like input (no spaces, at least one digit): try the exact lookup on Enter. */
export function isCodeLike(query: string): boolean {
  return /^\S+$/.test(query) && /\d/.test(query)
}

/** A typed Indian mobile number → E.164, else null. */
export function phoneQuery(query: string): string | null {
  const digits = query.replace(/[\s-]/g, '')
  if (!/^(\+?91|0)?[6-9]\d{9}$/.test(digits)) return null
  return normalizeIndianPhone(digits)
}

/** null for 404 (no exact match), rethrows other failures. */
export async function nullOn404<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work
  } catch (error) {
    if (isApiError(error) && error.status === 404) return null
    throw error
  }
}

/** The name in the UI language and, when it differs, the other one (shown as a subtitle). */
export function bilingualNames(
  name: string,
  nameTa: string | null | undefined,
): { primary: string; secondary: string | null } {
  if (!nameTa || nameTa === name) return { primary: name, secondary: null }
  return getLanguage() === 'ta'
    ? { primary: nameTa, secondary: name }
    : { primary: name, secondary: nameTa }
}

/** Search keywords for local (static) filtering: both languages, codes. */
export function keywordsOf(...parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/** "a · b · c" from the parts that are present (null when none). */
export function joinParts(...parts: Array<string | null | undefined | false>): string | null {
  const kept = parts.filter((p): p is string => typeof p === 'string' && p.length > 0)
  return kept.length ? kept.join(' · ') : null
}

/** FEFO: earliest expiry first, batches without expiry last, then oldest first. */
export function fefoOrder(
  a: Pick<BatchRow, 'expiry_date' | 'created_at'>,
  b: Pick<BatchRow, 'expiry_date' | 'created_at'>,
): number {
  if (a.expiry_date !== b.expiry_date) {
    if (a.expiry_date === null) return 1
    if (b.expiry_date === null) return -1
    return a.expiry_date < b.expiry_date ? -1 : 1
  }
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0
}
