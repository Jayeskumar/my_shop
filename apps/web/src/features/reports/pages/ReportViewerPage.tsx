/**
 * Generic report viewer (/reports/:reportKey). Everything comes from the REPORTS catalogue of the
 * contract: the route, filters (period presets incl. this FY, store, group-by, N days, pickers),
 * columns with their formats, the totals row and the optional chart. The last filters, sort and
 * visible columns are remembered per report on this device; URL parameters (links from the
 * dashboard) override them. CSV export streams the same report from the server; print renders
 * every row on A4 with the shop header.
 */
import { FEATURE_LABELS } from '@kadai/shared/features'
import {
  REPORT_NOTES,
  type ReportColumnDef,
  type ReportDef,
  getReportDef,
  reportColumns,
} from '@kadai/shared/api/reports'
import { FileSpreadsheet, FileSearch, Info, Printer } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useSearchParams } from 'react-router'
import { ForbiddenPage, NotFoundPage, UpgradePage } from '@/app/pages/StatusPages'
import { Badge, Button, EmptyState, IconButton, PageHeader, notify } from '@/components/ui'
import { useMe } from '@/lib/auth'
import { useHotkeys } from '@/lib/hotkeys'
import { useAccess, usePermission } from '@/lib/permissions'
import { useBreakpoint } from '@/lib/use-media-query'
import { downloadReportCsv, fetchAllRows, useReport } from '../api'
import { ColumnsMenu } from '../components/ColumnsMenu'
import { ReportChart } from '../components/ReportChart'
import { ReportFilters } from '../components/ReportFilters'
import { ReportTable } from '../components/ReportTable'
import { defaultStoreScope, useReportCalendar } from '../lib/calendar'
import type { ReportRow } from '../lib/cells'
import {
  type FilterState,
  type FilterValue,
  type ViewerMemory,
  changedFilterCount,
  defaultFilters,
  filterQuery,
  groupingOf,
  isRangeValue,
  loadMemory,
  rangeText,
  rangeOf,
  saveMemory,
  urlOverrides,
} from '../lib/filters'
import { nameOf, pick, snakeKey, useLang } from '../lib/labels'
import { printReport } from '../lib/print-report'

const DEFAULT_LIMIT = 100
const TIME_GROUPS = new Set(['day', 'month', 'hour'])

export default function ReportViewerPage() {
  const { reportKey } = useParams()
  const def = reportKey ? getReportDef(reportKey) : undefined
  if (!def) return <NotFoundPage />
  return <GuardedViewer key={def.key} def={def} />
}

function GuardedViewer({ def }: { def: ReportDef }) {
  const access = useAccess({
    permission: def.permission,
    feature: def.feature,
    ...(def.business_types ? { businessTypes: def.business_types } : {}),
  })
  if (access === 'forbidden') return <ForbiddenPage />
  if (access === 'feature') return <UpgradePage feature={def.feature} />
  if (access !== 'allowed') return <NotFoundPage />
  return <ReportViewer def={def} />
}

function ReportViewer({ def }: { def: ReportDef }) {
  const { t } = useTranslation(['reports', 'common'])
  const lng = useLang()
  const me = useMe()
  const cal = useReportCalendar()
  const desktop = useBreakpoint('md')
  const canExport = usePermission('data.export')
  const [params, setParams] = useSearchParams()
  const storeIds = useMemo(() => (me?.stores ?? []).map((s) => s.id), [me])
  const storeDefault = defaultStoreScope(me)

  const [memory, setMemory] = useState<ViewerMemory>(() => {
    const ctx = { cal, storeIds, store: storeDefault }
    const remembered = loadMemory(def, ctx)
    const fromUrl = urlOverrides(def, params, remembered, ctx)
    return fromUrl ? { ...remembered, ...fromUrl } : remembered
  })
  const [page, setPage] = useState({ offset: 0, limit: DEFAULT_LIMIT })
  const [busy, setBusy] = useState<'csv' | 'print' | null>(null)

  // URL overrides apply once; afterwards the screen state (and its memory) is the truth.
  const consumedUrl = useRef(false)
  useEffect(() => {
    if (consumedUrl.current) return
    consumedUrl.current = true
    if ([...params.keys()].length) setParams({}, { replace: true })
  }, [params, setParams])

  useEffect(() => saveMemory(def, memory), [def, memory])

  const defaults = useMemo(() => defaultFilters(def, cal, storeDefault), [def, cal, storeDefault])
  const grouping = groupingOf(def, memory.values)
  const allColumns = useMemo(() => reportColumns(def, grouping), [def, grouping])
  const isShown = (c: ReportColumnDef): boolean => memory.columns[c.key] ?? !c.hidden_by_default
  // The "Group" column is titled after the chosen grouping ("Day", "Counter" …).
  const groupOption = def.filters
    .find((f) => f.key === 'group_by')
    ?.options?.find((o) => o.value === grouping)
  const columns = allColumns
    .filter((c, i) => i === 0 || isShown(c))
    .map((c) => (c.key === 'group_label' && groupOption ? { ...c, label: groupOption.label } : c))

  const filtersQuery = useMemo(() => filterQuery(def, memory.values), [def, memory.values])
  const query = useMemo(
    () => ({ ...filtersQuery, sort: memory.sort, limit: page.limit, offset: page.offset }),
    [filtersQuery, memory.sort, page],
  )
  const report = useReport(def, query)
  const envelope = report.data
  const rows = envelope?.data ?? []
  const meta = envelope?.meta ?? null

  const title = t(`reports:titles.${snakeKey(def.key)}`)
  const description = t(`reports:descriptions.${snakeKey(def.key)}`)
  const range = rangeOf(def, memory.values)
  const storeName = storeLabel(memory.values.store_id ?? null)

  function storeLabel(value: FilterValue): string | null {
    if (!def.filters.some((f) => f.kind === 'store')) return null
    if (value === 'all' || value === null) return t('common:misc.all_stores')
    const store = me?.stores.find((s) => s.id === value)
    return store ? `${store.code} · ${nameOf(store.name, store.name_ta)}` : null
  }

  const update = (patch: Partial<ViewerMemory>): void => {
    setMemory((m) => ({ ...m, ...patch }))
    setPage((p) => ({ ...p, offset: 0 }))
  }
  const onFilter = (key: string, value: FilterValue, name?: string | null): void => {
    setMemory((m) => {
      const names = { ...m.names }
      if (name) names[key] = name
      else delete names[key]
      return { ...m, values: { ...m.values, [key]: value }, names }
    })
    setPage((p) => ({ ...p, offset: 0 }))
  }
  const onReset = (): void => {
    const keep: Record<string, FilterValue> = {}
    // Clearing filters keeps the period and store the user is looking at.
    for (const f of def.filters)
      if (f.kind === 'date_range' || f.kind === 'store') keep[f.key] = memory.values[f.key] ?? null
    const fresh: FilterState = defaults
    update({ values: { ...fresh.values, ...keep }, names: {} })
  }

  const filterLines = (): string[] => {
    const lines: string[] = []
    for (const f of def.filters) {
      const v = memory.values[f.key]
      if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue
      let text: string | null = null
      if (f.kind === 'date_range' && isRangeValue(v)) text = rangeText(v)
      else if (f.kind === 'store') text = storeLabel(v)
      else if (f.kind === 'select')
        text = pick(f.options?.find((o) => o.value === v)?.label, lng) || String(v)
      else if (f.kind === 'multi_select' && Array.isArray(v)) text = v.join(', ')
      else if (f.kind === 'boolean') {
        if (v === f.default || (v === false && f.default === undefined)) continue
        text = t(v ? 'common:actions.yes' : 'common:actions.no')
      } else if (typeof v === 'string' || typeof v === 'number')
        text = memory.names[f.key] ?? String(v)
      if (text) lines.push(`${pick(f.label, lng)}: ${text}`)
    }
    return lines
  }

  const exportCsv = async (): Promise<void> => {
    setBusy('csv')
    try {
      await downloadReportCsv(def, filtersQuery)
      notify.success(t('reports:viewer.csv_ready'))
    } catch (error) {
      notify.error(error)
    } finally {
      setBusy(null)
    }
  }

  const print = async (): Promise<void> => {
    if (!me || busy) return
    setBusy('print')
    try {
      const all = await fetchAllRows(def, { ...filtersQuery, sort: memory.sort })
      await printReport({
        def,
        me,
        title,
        columns,
        rows: all.data,
        totals: all.totals,
        filterLines: filterLines(),
        storeName: all.meta.store_name ?? storeName,
        generatedAt: all.meta.generated_at,
        truncated: all.meta.notes.includes('truncated') || all.page.total > all.data.length,
        lng,
      })
    } catch (error) {
      notify.error(error)
    } finally {
      setBusy(null)
    }
  }

  useHotkeys({ 'mod+p': () => void print() }, { enabled: Boolean(me) })

  const chart =
    def.chart && (!def.chart.group_by || (grouping && def.chart.group_by.includes(grouping)))
      ? def.chart
      : null
  const timeKey = grouping && TIME_GROUPS.has(grouping) ? 'group_key' : null

  const actions = (
    <>
      <ColumnsMenu
        columns={allColumns}
        isShown={isShown}
        compact={!desktop}
        onToggle={(c, shown) =>
          setMemory((m) => ({ ...m, columns: { ...m.columns, [c.key]: shown } }))
        }
        onReset={() => setMemory((m) => ({ ...m, columns: {} }))}
      />
      {desktop ? (
        <Button
          variant="outline"
          leftIcon={<Printer />}
          loading={busy === 'print'}
          onClick={() => void print()}
          title="Ctrl+P"
        >
          {t('common:actions.print')}
        </Button>
      ) : (
        <IconButton
          icon={<Printer />}
          label={t('common:actions.print')}
          variant="outline"
          loading={busy === 'print'}
          onClick={() => void print()}
        />
      )}
      {canExport ? (
        desktop ? (
          <Button
            variant="outline"
            leftIcon={<FileSpreadsheet />}
            loading={busy === 'csv'}
            onClick={() => void exportCsv()}
          >
            {t('common:actions.export_csv')}
          </Button>
        ) : (
          <IconButton
            icon={<FileSpreadsheet />}
            label={t('common:actions.export_csv')}
            variant="outline"
            loading={busy === 'csv'}
            onClick={() => void exportCsv()}
          />
        )
      ) : null}
    </>
  )

  const notes = (meta?.notes ?? []).filter((n) => (REPORT_NOTES as readonly string[]).includes(n))

  return (
    <div className="min-w-0">
      <PageHeader
        title={title}
        description={description}
        breadcrumbs={[{ label: t('reports:index.title'), to: '/reports' }, { label: title }]}
        meta={
          def.feature === 'advanced_reports' ? (
            <Badge tone="accent" size="sm" className="hidden sm:inline-flex">
              {FEATURE_LABELS.advanced_reports[lng]}
            </Badge>
          ) : null
        }
      />
      <ReportFilters
        def={def}
        state={memory}
        onChange={onFilter}
        onReset={onReset}
        changedCount={changedFilterCount(def, memory.values, defaults.values)}
        calendar={cal}
        actions={actions}
      />
      <p className="mb-3 text-xs text-muted-foreground" aria-live="polite">
        {[
          range
            ? rangeText(range)
            : meta?.as_of
              ? t('reports:viewer.as_of', { date: rangeText({ from: meta.as_of, to: meta.as_of }) })
              : t('reports:viewer.as_of_now'),
          storeName,
          envelope ? t('reports:viewer.rows', { count: envelope.page.total }) : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {notes.length ? (
        <div
          role="note"
          className="mb-3 flex items-start gap-2 rounded-lg border border-info/30 bg-info-soft px-3 py-2 text-sm text-info-soft-foreground"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          <ul className="grid gap-0.5">
            {notes.map((n) => (
              <li key={n}>{t(`reports:notes.${n}`)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {chart && rows.length > 1 ? (
        <ReportChart chart={chart} rows={rows} timeKey={timeKey} title={title} />
      ) : null}
      <ReportTable
        label={title}
        columns={columns}
        rows={rows}
        rowKey={(row: ReportRow, i) =>
          def.row_key.map((k) => String(row[k] ?? '')).join('|') + `#${page.offset + i}`
        }
        totals={envelope?.totals ?? null}
        showTotals={def.totals}
        page={envelope?.page ?? null}
        onPageChange={(next) => setPage(next)}
        sort={memory.sort}
        onSortChange={(sort) => update({ sort })}
        loading={report.isPending}
        fetching={report.isFetching}
        error={report.error}
        onRetry={() => void report.refetch()}
        empty={
          <EmptyState
            icon={<FileSearch />}
            title={t('reports:viewer.empty_title')}
            description={t('reports:viewer.empty_hint')}
            action={
              changedFilterCount(def, memory.values, defaults.values) > 0 ? (
                <Button variant="outline" onClick={onReset}>
                  {t('common:actions.clear_filters')}
                </Button>
              ) : null
            }
          />
        }
      />
    </div>
  )
}
