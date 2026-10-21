import { describe, expect, it } from 'vitest'
import { getReportDef, reportDatePresetRange } from '@kadai/shared/api/reports'
import { storage } from '@/lib/storage'
import { makeMe } from '@/test/fixtures'
import type { ReportCalendar } from './calendar'
import {
  changedFilterCount,
  defaultFilters,
  filterQuery,
  groupingOf,
  loadMemory,
  saveMemory,
  sortAllowed,
  urlOverrides,
} from './filters'
import { buildReportHtml } from './print-report'
import { reportColumns } from '@kadai/shared/api/reports'
import { salesSummaryFixture } from '../testing/fixtures'

const cal: ReportCalendar = { today: '2026-10-21', timezone: 'Asia/Kolkata', fyStartMonth: 4 }
const STORE = '0192f0a0-0000-7000-8000-000000000301'
const ctx = { cal, storeIds: [STORE], store: 'all' }
const salesSummary = getReportDef('sales-summary')!
const expiry = getReportDef('expiry')!

describe('report filters', () => {
  it('defaults follow the catalogue and build a contract query', () => {
    const state = defaultFilters(salesSummary, cal, 'all')
    expect(state.values.group_by).toBe('day')
    expect(filterQuery(salesSummary, state.values)).toEqual({
      from: '2026-10-01',
      to: '2026-10-21',
      group_by: 'day',
    })
    const exp = defaultFilters(expiry, cal, STORE)
    expect(filterQuery(expiry, exp.values)).toEqual({
      store_id: STORE,
      days: 90,
      include_expired: true,
    })
  })

  it('remembers presets (not dates) and drops stale or invalid stored values', () => {
    const memory = loadMemory(salesSummary, ctx)
    saveMemory(salesSummary, {
      ...memory,
      values: {
        ...memory.values,
        date_range: { preset: 'this_fy', from: '2025-04-01', to: '2025-06-01' },
        group_by: 'weekday',
        store_id: '0192f0a0-0000-7000-8000-000000009999',
      },
      sort: '-not_a_column',
    })
    const loaded = loadMemory(salesSummary, ctx)
    expect(loaded.values.date_range).toEqual({
      preset: 'this_fy',
      ...reportDatePresetRange('this_fy', cal.today, 4),
    })
    expect(loaded.values.group_by).toBe('day')
    expect(loaded.values.store_id).toBe('all')
    expect(loaded.sort).toBe('group')
  })

  it('survives garbage in storage', () => {
    storage.set('reports.viewer.sales-summary', { v: 1, values: 'nope', columns: [1] })
    expect(loadMemory(salesSummary, ctx).values.group_by).toBe('day')
  })

  it('applies URL overrides: preset, custom range and typed values', () => {
    const base = defaultFilters(expiry, cal, 'all')
    const next = urlOverrides(
      expiry,
      new URLSearchParams('days=30&include_expired=false'),
      base,
      ctx,
    )
    expect(next?.values.days).toBe(30)
    expect(next?.values.include_expired).toBe(false)
    expect(urlOverrides(expiry, new URLSearchParams('days=9999'), base, ctx)).toBeNull()

    const sales = defaultFilters(salesSummary, cal, 'all')
    const range = urlOverrides(
      salesSummary,
      new URLSearchParams('from=2026-10-05&to=2026-10-07'),
      sales,
      ctx,
    )
    expect(range?.values.date_range).toEqual({ preset: null, from: '2026-10-05', to: '2026-10-07' })
    // Longer than the 366-day limit: ignored.
    expect(
      urlOverrides(salesSummary, new URLSearchParams('from=2024-01-01&to=2026-01-01'), sales, ctx),
    ).toBeNull()
  })

  it('knows the grouping, the changed filters and the allowed sorts', () => {
    const state = defaultFilters(salesSummary, cal, 'all')
    expect(groupingOf(salesSummary, state.values)).toBe('day')
    expect(
      changedFilterCount(salesSummary, { ...state.values, group_by: 'month' }, state.values),
    ).toBe(1)
    expect(sortAllowed(salesSummary, '-net_sales_paise')).toBe(true)
    expect(sortAllowed(salesSummary, 'tax_paise')).toBe(false)
  })
})

describe('report print', () => {
  it('prints the shop header, every row and the totals row', () => {
    const report = salesSummaryFixture()
    const html = buildReportHtml({
      def: salesSummary,
      me: makeMe(),
      title: 'Sales summary',
      columns: reportColumns(salesSummary, 'day'),
      rows: report.data,
      totals: report.totals,
      filterLines: ['Period: 01-10-2026 – 21-10-2026'],
      storeName: 'All stores',
      generatedAt: report.meta.generated_at,
      truncated: false,
      lng: 'en',
    })
    expect(html).toContain('Sri Murugan Stores')
    expect(html).toContain('GSTIN: 33AAAPL1234C1ZV')
    expect(html).toContain('Period: 01-10-2026 – 21-10-2026')
    expect(html.match(/<tr>/g)?.length).toBe(1 + report.data.length + 1)
    expect(html).toContain('₹6,46,629.90')
  })
})
