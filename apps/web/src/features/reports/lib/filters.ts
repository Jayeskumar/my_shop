/**
 * Filter state of the generic report viewer, driven by the REPORTS catalogue (`ReportFilterDef`):
 * defaults, the API query built from it, the per-report memory in localStorage (last filters,
 * sort and visible columns) and overrides from the URL (links from the dashboard and other
 * modules, e.g. `/reports/expiry?days=30` or `/reports/customer-outstanding?overdue_only=true`).
 *
 * Date ranges remember their preset ("this month"), not the dates, so a report opened next month
 * shows next month.
 */
import {
  REPORT_DATE_PRESETS,
  type ReportDatePreset,
  type ReportDef,
  type ReportFilterDef,
  reportDatePresetRange,
  reportRangeIssue,
} from '@kadai/shared/api/reports'
import { formatDateDisplay, isDateStr, isPeriod } from '@kadai/shared/fy'
import { isUuid } from '@kadai/shared/ids'
import type { QueryParams } from '@/lib/api'
import { isRecord, storage } from '@/lib/storage'
import type { ReportCalendar } from './calendar'

export interface RangeValue {
  /** null = custom from / to. */
  preset: ReportDatePreset | null
  from: string
  to: string
}

export type FilterValue = string | number | boolean | string[] | RangeValue | null

export interface FilterState {
  values: Record<string, FilterValue>
  /** Display names of picked records (brand / supplier …) keyed by filter key. */
  names: Record<string, string>
}

export interface ViewerMemory extends FilterState {
  sort: string
  /** Column key → shown (overrides `hidden_by_default`). */
  columns: Record<string, boolean>
}

const STORAGE_VERSION = 1
const storageKey = (reportKey: string): string => `reports.viewer.${reportKey}`

export const DATE_RANGE_KEY = 'date_range'

export function isRangeValue(v: unknown): v is RangeValue {
  return (
    isRecord(v) &&
    (v.preset === null ||
      (typeof v.preset === 'string' &&
        (REPORT_DATE_PRESETS as readonly string[]).includes(v.preset))) &&
    isDateStr(v.from) &&
    isDateStr(v.to)
  )
}

export function presetValue(preset: ReportDatePreset, cal: ReportCalendar): RangeValue {
  return { preset, ...reportDatePresetRange(preset, cal.today, cal.fyStartMonth) }
}

/** "01-10-2026 – 21-10-2026" (one date when from = to). */
export function rangeText(value: { from: string; to: string }): string {
  return value.from === value.to
    ? formatDateDisplay(value.from)
    : `${formatDateDisplay(value.from)} – ${formatDateDisplay(value.to)}`
}

/** A remembered preset is re-evaluated against today. */
export function freshRange(range: RangeValue, cal: ReportCalendar): RangeValue {
  return range.preset ? presetValue(range.preset, cal) : range
}

function defaultValue(f: ReportFilterDef, cal: ReportCalendar, store: string | null): FilterValue {
  switch (f.kind) {
    case 'date_range':
      return presetValue(f.default_preset ?? 'this_month', cal)
    case 'store':
      return store
    case 'multi_select':
      return Array.isArray(f.default) ? [...(f.default as readonly string[])] : []
    case 'boolean':
      return typeof f.default === 'boolean' ? f.default : false
    case 'number':
    case 'money':
      return typeof f.default === 'number' ? f.default : null
    default:
      return typeof f.default === 'string' ? f.default : null
  }
}

export function defaultFilters(
  def: ReportDef,
  cal: ReportCalendar,
  store: string | null,
): FilterState {
  return {
    values: Object.fromEntries(def.filters.map((f) => [f.key, defaultValue(f, cal, store)])),
    names: {},
  }
}

/** The value if it is acceptable for the filter, else undefined (stored / URL input). */
export function acceptValue(
  f: ReportFilterDef,
  value: unknown,
  ctx: { cal: ReportCalendar; storeIds: readonly string[] },
): FilterValue | undefined {
  if (value === null) return f.kind === 'date_range' ? undefined : null
  switch (f.kind) {
    case 'date_range': {
      if (!isRangeValue(value)) return undefined
      if (value.preset && f.presets && !f.presets.includes(value.preset)) return undefined
      const range = freshRange(value, ctx.cal)
      return reportRangeIssue(range.from, range.to) ? undefined : range
    }
    case 'date':
      return isDateStr(value) ? value : undefined
    case 'month':
      return isPeriod(value) ? value : undefined
    case 'store':
      return typeof value === 'string' && (value === 'all' || ctx.storeIds.includes(value))
        ? value
        : undefined
    case 'select':
      return typeof value === 'string' && (f.options ?? []).some((o) => o.value === value)
        ? value
        : undefined
    case 'multi_select':
      return Array.isArray(value) &&
        value.every((v) => typeof v === 'string' && (f.options ?? []).some((o) => o.value === v))
        ? (value as string[])
        : undefined
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined
    case 'number':
    case 'money':
      return typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        (f.min === undefined || value >= f.min) &&
        (f.max === undefined || value <= f.max)
        ? value
        : undefined
    case 'text':
      return typeof value === 'string' && value.length <= 100 ? value : undefined
    default:
      // category / brand / product / supplier / user / register: a record id.
      return isUuid(value) ? value : undefined
  }
}

/** Defaults + the remembered state of this report (invalid / stale entries are dropped). */
export function loadMemory(
  def: ReportDef,
  ctx: { cal: ReportCalendar; storeIds: readonly string[]; store: string | null },
): ViewerMemory {
  const base = defaultFilters(def, ctx.cal, ctx.store)
  const memory: ViewerMemory = { ...base, sort: def.default_sort, columns: {} }
  const saved = storage.get<unknown>(storageKey(def.key), null)
  if (!isRecord(saved) || saved.v !== STORAGE_VERSION) return memory
  const values = isRecord(saved.values) ? saved.values : {}
  const names = isRecord(saved.names) ? saved.names : {}
  for (const f of def.filters) {
    if (!(f.key in values)) continue
    const accepted = acceptValue(f, values[f.key], ctx)
    if (accepted === undefined) continue
    memory.values[f.key] = accepted
    const name = names[f.key]
    if (typeof name === 'string' && accepted !== null) memory.names[f.key] = name
  }
  if (typeof saved.sort === 'string' && sortAllowed(def, saved.sort)) memory.sort = saved.sort
  if (isRecord(saved.columns)) {
    for (const c of def.columns) {
      const shown = saved.columns[c.key]
      if (typeof shown === 'boolean') memory.columns[c.key] = shown
    }
  }
  return memory
}

export function saveMemory(def: ReportDef, memory: ViewerMemory): void {
  storage.set(storageKey(def.key), { v: STORAGE_VERSION, ...memory })
}

export function forgetMemory(def: ReportDef): void {
  storage.remove(storageKey(def.key))
}

/** Sort strings the report accepts: its default and the `sort` keys of its columns (±). */
export function sortAllowed(def: ReportDef, sort: string): boolean {
  const field = sort.replace(/^-/, '')
  return field === def.default_sort.replace(/^-/, '') || def.columns.some((c) => c.sort === field)
}

function parseParam(f: ReportFilterDef, raw: string[]): unknown {
  const first = raw[0] ?? ''
  switch (f.kind) {
    case 'boolean':
      return first === 'true' || first === '1'
        ? true
        : first === 'false' || first === '0'
          ? false
          : undefined
    case 'number':
    case 'money': {
      const n = Number(first)
      return first !== '' && Number.isSafeInteger(n) ? n : undefined
    }
    case 'multi_select':
      return raw.flatMap((r) => r.split(',')).filter(Boolean)
    default:
      return first
  }
}

/**
 * Applies `?key=value` overrides from the URL (`from` + `to` or `preset` set the date range).
 * Returns null when the URL carries no report filter.
 */
export function urlOverrides(
  def: ReportDef,
  params: URLSearchParams,
  state: FilterState,
  ctx: { cal: ReportCalendar; storeIds: readonly string[] },
): FilterState | null {
  let changed = false
  const values = { ...state.values }
  const names = { ...state.names }
  for (const f of def.filters) {
    if (f.kind === 'date_range') {
      const preset = params.get('preset')
      const from = params.get('from')
      const to = params.get('to')
      const candidate =
        preset && (REPORT_DATE_PRESETS as readonly string[]).includes(preset)
          ? presetValue(preset as ReportDatePreset, ctx.cal)
          : from && to
            ? { preset: null, from, to }
            : null
      const accepted = candidate ? acceptValue(f, candidate, ctx) : undefined
      if (accepted !== undefined) {
        values[f.key] = accepted
        changed = true
      }
      continue
    }
    const raw = params.getAll(f.key)
    if (!raw.length) continue
    const accepted = acceptValue(f, parseParam(f, raw), ctx)
    if (accepted === undefined) continue
    values[f.key] = accepted
    delete names[f.key]
    changed = true
  }
  return changed ? { values, names } : null
}

/** API query of the filters (empty values are left out so the server defaults apply). */
export function filterQuery(def: ReportDef, values: Record<string, FilterValue>): QueryParams {
  const query: QueryParams = {}
  for (const f of def.filters) {
    const v = values[f.key]
    if (v === null || v === undefined || v === '') continue
    if (f.kind === 'date_range') {
      if (isRangeValue(v)) {
        query.from = v.from
        query.to = v.to
      }
      continue
    }
    // 'all' and "no store" both mean every store the member can access.
    if (f.kind === 'store' && v === 'all') continue
    if (Array.isArray(v)) {
      if (v.length) query[f.key] = v
      continue
    }
    if (typeof v === 'object') continue
    query[f.key] = v
  }
  return query
}

/** The range filter's current value, if the report has one. */
export function rangeOf(def: ReportDef, values: Record<string, FilterValue>): RangeValue | null {
  const f = def.filters.find((x) => x.kind === 'date_range')
  const v = f ? values[f.key] : null
  return isRangeValue(v) ? v : null
}

/** group_by-like value that decides the visible columns (`group_by`, or `group` for stock ageing). */
export function groupingOf(def: ReportDef, values: Record<string, FilterValue>): string | null {
  for (const key of ['group_by', 'group']) {
    if (def.filters.some((f) => f.key === key)) {
      const v = values[key]
      if (typeof v === 'string') return v
      const f = def.filters.find((x) => x.key === key)
      return typeof f?.default === 'string' ? f.default : null
    }
  }
  return null
}

/** Filters (other than period and store) that differ from their defaults — the "Filters (n)" badge. */
export function changedFilterCount(
  def: ReportDef,
  values: Record<string, FilterValue>,
  defaults: Record<string, FilterValue>,
): number {
  return def.filters.filter((f) => {
    if (f.kind === 'date_range' || f.kind === 'store') return false
    return JSON.stringify(values[f.key] ?? null) !== JSON.stringify(defaults[f.key] ?? null)
  }).length
}
