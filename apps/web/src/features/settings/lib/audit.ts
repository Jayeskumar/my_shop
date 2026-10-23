/**
 * Audit-log presentation helpers: action → localized area + verb, the area filter list, and the
 * `changes` JSON → flat before/after rows for the diff viewer.
 */
import i18next from 'i18next'
import { translate } from '@/lib/i18n'
import type { TranslationKey } from '@/lib/i18n-resources'

/** Action prefixes offered in the area filter (action = '<area>.<verb>'). */
export const AUDIT_AREAS = [
  'auth',
  'user',
  'role',
  'store',
  'register',
  'device',
  'settings',
  'business',
  'number_series',
  'product',
  'category',
  'brand',
  'promotion',
  'store_price',
  'tax_slab_rule',
  'batch',
  'stock',
  'stock_adjustment',
  'stock_transfer',
  'customer',
  'supplier',
  'doctor',
  'sales_invoice',
  'credit_note',
  'purchase_bill',
  'payment',
  'expense',
  'journal',
  'shift',
] as const
export type AuditArea = (typeof AUDIT_AREAS)[number]

function humanize(s: string): string {
  const text = s.replace(/[._]+/g, ' ').trim()
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** "product.price_change" → { area: 'Product', verb: 'Price changed' } in the UI language. */
export function auditActionLabel(action: string): { area: string; verb: string } {
  const dot = action.indexOf('.')
  const area = dot === -1 ? action : action.slice(0, dot)
  const verb = dot === -1 ? '' : action.slice(dot + 1)
  const areaKey = `settings:audit.areas.${area}`
  const verbKey = `settings:audit.verbs.${verb.replace(/\./g, '_')}`
  return {
    area: i18next.exists(areaKey) ? translate(areaKey as TranslationKey) : humanize(area),
    verb: verb
      ? i18next.exists(verbKey)
        ? translate(verbKey as TranslationKey)
        : humanize(verb)
      : '',
  }
}

export interface DiffRow {
  path: string
  before: unknown
  after: unknown
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * `{before, after}` (as written by the server's diffChanges) → one row per changed leaf
 * ("invoice.footer_text"). Returns null for other shapes (shown as raw JSON).
 */
export function diffRows(changes: unknown): DiffRow[] | null {
  if (!isPlain(changes) || !('before' in changes) || !('after' in changes)) return null
  const { before, after } = changes
  if (!isPlain(before) && !isPlain(after)) return null
  const rows: DiffRow[] = []
  const walk = (b: unknown, a: unknown, prefix: string): void => {
    const keys = new Set([...Object.keys(isPlain(b) ? b : {}), ...Object.keys(isPlain(a) ? a : {})])
    for (const key of keys) {
      const bv = isPlain(b) ? b[key] : undefined
      const av = isPlain(a) ? a[key] : undefined
      const path = prefix ? `${prefix}.${key}` : key
      if (isPlain(bv) && isPlain(av)) walk(bv, av, path)
      else rows.push({ path, before: bv ?? null, after: av ?? null })
    }
  }
  walk(before, after, '')
  return rows
}

/** Short display of a changed value. */
export function displayValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return v === '' ? '""' : v
  if (typeof v === 'boolean') return i18next.t(v ? 'common:actions.yes' : 'common:actions.no')
  if (typeof v === 'number') return String(v)
  return JSON.stringify(v)
}
