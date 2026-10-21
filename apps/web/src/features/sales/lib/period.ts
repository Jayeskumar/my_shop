/**
 * Date period of a list (URL `?period=` preset key, `all`, or `custom` with `?from=&to=`) →
 * the API's inclusive business-date range.
 */
import { isDateStr, type DateRange } from '@kadai/shared/fy'
import {
  DEFAULT_DATE_PRESETS,
  matchPreset,
  presetRange,
  type DatePresetKey,
  type PresetContext,
} from '@/lib/date-presets'

export const LIST_DATE_PRESETS: readonly DatePresetKey[] = [
  'today',
  'yesterday',
  'last_7_days',
  'this_week',
  'this_month',
  'last_30_days',
  'last_month',
  'this_fy',
  'last_fy',
]

const PRESET_SET = new Set<string>([...LIST_DATE_PRESETS, ...DEFAULT_DATE_PRESETS])

export interface PeriodState {
  period: string
  from: string
  to: string
}

/** The selected range, or null for all dates. */
export function periodRange(state: PeriodState, ctx: PresetContext): DateRange | null {
  if (state.period === 'all') return null
  if (state.period === 'custom') {
    if (isDateStr(state.from) && isDateStr(state.to) && state.from <= state.to) {
      return { from: state.from, to: state.to }
    }
    return null
  }
  if (PRESET_SET.has(state.period)) return presetRange(state.period as DatePresetKey, ctx)
  return null
}

/** URL patch for a range chosen in the picker (a preset is stored by name, so it rolls over). */
export function periodPatch(range: DateRange | null, ctx: PresetContext): PeriodState {
  if (!range) return { period: 'all', from: '', to: '' }
  const preset = matchPreset(range, LIST_DATE_PRESETS, ctx)
  if (preset) return { period: preset, from: '', to: '' }
  return { period: 'custom', from: range.from, to: range.to }
}
