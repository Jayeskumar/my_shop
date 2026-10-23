/**
 * Display helpers for inventory data: bilingual contract labels in the UI language, product
 * names (UI language first, the other one below), movement / status tones, reason codes and the
 * pack unit used for "2 strips + 3 tabs" style quantities.
 */
import type { BilingualLabel } from '@kadai/shared/api/common'
import {
  ADJUSTMENT_REASONS,
  type ExpiryStatus,
  MOVEMENT_DIRECTION,
  type StockStatus,
} from '@kadai/shared/api/inventory'
import type { AdjustmentKind, StockMovementType } from '@kadai/shared/enums'
import type { Tone } from '@/components/ui'
import type { Language } from '@/lib/i18n'

/** Hotkey scope of the inventory pages (suspended while a dialog is open). */
export const INVENTORY_HOTKEY_SCOPE = 'inventory'

export function langOf(language: string | undefined): Language {
  return language === 'en' ? 'en' : 'ta'
}

/** `{ en, ta }` label in the given UI language. */
export function pickLabel(label: BilingualLabel, language: string | undefined): string {
  return label[langOf(language)]
}

/** Name in the UI language plus the other-language name as a secondary line (when different). */
export function productNames(
  name: string,
  nameTa: string | null | undefined,
  language: string | undefined,
): { primary: string; secondary: string | null } {
  if (!nameTa || nameTa === name) return { primary: name, secondary: null }
  return langOf(language) === 'ta'
    ? { primary: nameTa, secondary: name }
    : { primary: name, secondary: nameTa }
}

/** Pack unit for packs + loose display: tablets and capsules come in strips. */
export function packUnitFor(unit: string): string {
  const u = unit.toUpperCase()
  return u === 'TAB' || u === 'CAP' ? 'STRIP' : 'PACK'
}

export const STOCK_STATUS_TONE: Readonly<Record<StockStatus, Tone>> = {
  ok: 'success',
  low: 'warning',
  out: 'neutral',
  negative: 'danger',
}

export const EXPIRY_STATUS_TONE: Readonly<Record<ExpiryStatus, Tone>> = {
  expired: 'danger',
  expiring: 'warning',
  ok: 'success',
  none: 'neutral',
}

const MOVEMENT_TONE: Partial<Record<StockMovementType, Tone>> = {
  opening: 'info',
  purchase: 'success',
  sale: 'primary',
  sale_return: 'accent',
  purchase_return: 'accent',
  damage: 'danger',
  expiry_writeoff: 'danger',
  transfer_in: 'info',
  transfer_out: 'info',
  adjustment: 'warning',
  stock_take: 'warning',
}

export function movementTone(type: StockMovementType): Tone {
  return MOVEMENT_TONE[type] ?? 'neutral'
}

/** +1 in, −1 out, 0 either way (adjustments / stock takes). */
export function movementDirection(type: StockMovementType): 1 | -1 | 0 {
  return MOVEMENT_DIRECTION[type]
}

export const ADJUSTMENT_KIND_TONE: Readonly<Record<AdjustmentKind, Tone>> = {
  adjustment: 'warning',
  stock_take: 'info',
  damage: 'danger',
  expiry_writeoff: 'danger',
  opening: 'primary',
}

export type ReasonCode = (typeof ADJUSTMENT_REASONS)[number]['code']

const REASON_CODES = new Set<string>(ADJUSTMENT_REASONS.map((r) => r.code))

export function isReasonCode(value: string | null | undefined): value is ReasonCode {
  return typeof value === 'string' && REASON_CODES.has(value)
}

/** Reason suggestions offered for an adjustment kind. */
export function reasonsForKind(kind: AdjustmentKind): ReasonCode[] {
  return ADJUSTMENT_REASONS.filter((r) =>
    (r.kinds as readonly AdjustmentKind[]).includes(kind),
  ).map((r) => r.code)
}

/** Default reason of a new line for a kind (damage → damaged, expiry write-off → expired). */
export function defaultReasonFor(kind: AdjustmentKind): ReasonCode | null {
  if (kind === 'damage') return 'damaged'
  if (kind === 'expiry_writeoff') return 'expired'
  if (kind === 'stock_take') return 'count_correction'
  return null
}

/** Stored reason (a code from ADJUSTMENT_REASONS or free text) in the UI language. */
export function reasonLabel(reason: string | null | undefined, language: string | undefined) {
  if (!reason) return null
  const known = ADJUSTMENT_REASONS.find((r) => r.code === reason)
  if (!known) return reason
  return langOf(language) === 'ta' ? known.label_ta : known.label_en
}
