/**
 * Date range presets for reports and lists (business dates in the tenant timezone, inclusive).
 * "This …" ranges end today (future dates are meaningless for books); weeks start on Monday.
 */
import {
  addDays,
  addMonths,
  dayOfWeek,
  fyOf,
  fyRange,
  periodOf,
  periodRange,
  todayIn,
  DEFAULT_FY_START_MONTH,
  DEFAULT_TIMEZONE,
  type DateRange,
} from '@kadai/shared/fy'

export type DatePresetKey =
  | 'today'
  | 'yesterday'
  | 'last_7_days'
  | 'last_30_days'
  | 'this_week'
  | 'this_month'
  | 'last_month'
  | 'this_fy'
  | 'last_fy'

export const DEFAULT_DATE_PRESETS: readonly DatePresetKey[] = [
  'today',
  'yesterday',
  'this_week',
  'this_month',
  'last_month',
  'this_fy',
  'last_fy',
]

export interface PresetContext {
  /** Override "today" (tests). */
  today?: string
  timezone?: string
  fyStartMonth?: number
}

export function presetRange(key: DatePresetKey, ctx: PresetContext = {}): DateRange {
  const today = ctx.today ?? todayIn(ctx.timezone ?? DEFAULT_TIMEZONE)
  const fyStart = ctx.fyStartMonth ?? DEFAULT_FY_START_MONTH
  switch (key) {
    case 'today':
      return { from: today, to: today }
    case 'yesterday': {
      const y = addDays(today, -1)
      return { from: y, to: y }
    }
    case 'last_7_days':
      return { from: addDays(today, -6), to: today }
    case 'last_30_days':
      return { from: addDays(today, -29), to: today }
    case 'this_week': {
      // Monday = 1 … Sunday = 0 → days since Monday.
      const sinceMonday = (dayOfWeek(today) + 6) % 7
      return { from: addDays(today, -sinceMonday), to: today }
    }
    case 'this_month':
      return { from: periodRange(periodOf(today)).from, to: today }
    case 'last_month':
      return periodRange(periodOf(addMonths(periodRange(periodOf(today)).from, -1)))
    case 'this_fy':
      return { from: fyRange(fyOf(today, fyStart), fyStart).from, to: today }
    case 'last_fy': {
      const start = fyRange(fyOf(today, fyStart), fyStart).from
      return fyRange(fyOf(addDays(start, -1), fyStart), fyStart)
    }
  }
}

/** The preset whose range equals `range`, if any (to label the picker trigger). */
export function matchPreset(
  range: DateRange | null | undefined,
  presets: readonly DatePresetKey[],
  ctx: PresetContext = {},
): DatePresetKey | null {
  if (!range) return null
  for (const key of presets) {
    const r = presetRange(key, ctx)
    if (r.from === range.from && r.to === range.to) return key
  }
  return null
}
