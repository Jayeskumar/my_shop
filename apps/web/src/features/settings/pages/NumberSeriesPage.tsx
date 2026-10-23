/**
 * Number series (/settings/number-series): every document series of a financial year, per store
 * (and per counter for POS bills), with prefix, padding, the next number as it will print and how
 * many documents were issued. Series not used yet this year show their default prefix and can be
 * customised before the first document (e.g. to continue old numbering).
 */
import { ListOrdered, Pencil } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DOC_TYPE_LABELS,
  type NumberSeries,
  type NumberSeriesListQuery,
} from '@kadai/shared/api/identity'
import { NumberSeriesDocTypeSchema, type NumberSeriesDocType } from '@kadai/shared/enums'
import { fyOf, todayIn } from '@kadai/shared/fy'
import {
  Badge,
  DataTable,
  type DataTableColumn,
  EmptyState,
  IconButton,
  Select,
} from '@/components/ui'
import { useAuth, useCan } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatNumber } from '@/lib/format'
import { getLanguage, localizedName } from '@/lib/i18n'
import { useNumberSeries } from '../api'
import { SeriesEditorDialog } from '../components/SeriesEditorDialog'
import { SettingsPageHeader } from '../components/SettingsPageHeader'
import { useListParams } from '../lib/list-params'

const ALL = 'all'

/** '2026-27' → '2025-26' / '2027-28'. */
function shiftFy(fy: string, by: number): string {
  const start = Number(fy.slice(0, 4)) + by
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

/** Document name, GST mark and where the series is used (store · counter). */
function SeriesDocument({ series: s }: { series: NumberSeries }) {
  const { t } = useTranslation('settings')
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <span className="font-medium leading-snug">
          {DOC_TYPE_LABELS[s.doc_type][getLanguage()]}
        </span>
        {s.is_gst_document ? (
          <Badge size="sm" tone="info" appearance="outline">
            GST
          </Badge>
        ) : null}
      </div>
      <div className="text-xs text-muted-foreground">
        <span className="font-mono">{s.store_code}</span>
        {s.register_code ? ` · ${t('series.counter', { code: s.register_code })}` : ''}
      </div>
    </div>
  )
}

/** The next number as it will print, with its length against the limit. */
function SeriesNext({ series: s }: { series: NumberSeries }) {
  const { t } = useTranslation('settings')
  const over = s.next.length > s.max_length
  return (
    <div className="min-w-0">
      <div className="break-all font-mono text-sm font-semibold tracking-wide">{s.next}</div>
      <div className={cn('text-xs tabular-nums', over ? 'text-danger' : 'text-muted-foreground')}>
        {t('series.length', { count: s.next.length, max: s.max_length })}
      </div>
    </div>
  )
}

/** Phone card: the whole card opens the editor. */
function SeriesCard({ series: s }: { series: NumberSeries }) {
  const { t } = useTranslation('settings')
  return (
    <div className="flex items-start justify-between gap-3">
      <SeriesDocument series={s} />
      <div className="shrink-0 text-end">
        <div className="font-mono text-sm font-semibold tracking-wide">{s.next}</div>
        <div className="text-xs text-muted-foreground">
          {s.id === null
            ? t('series.not_used')
            : t('series.issued_count', {
                count: s.issued_count,
                formatted: formatNumber(s.issued_count),
              })}
        </div>
      </div>
    </div>
  )
}

export default function NumberSeriesPage() {
  const { t } = useTranslation(['settings', 'common'])
  const me = useAuth((s) => s.me)
  const canManage = useCan('settings.manage')
  const stores = useMemo(() => me?.stores ?? [], [me])
  const currentFy = fyOf(todayIn(me?.tenant.timezone), me?.tenant.fy_start_month ?? 4)
  const [state, setState] = useListParams({ fy: currentFy, store: ALL, doc: ALL })
  const fyOptions = [shiftFy(currentFy, 1), currentFy, shiftFy(currentFy, -1)].map((fy) => ({
    value: fy,
    label: fy === currentFy ? t('series.fy_current', { fy }) : fy,
  }))
  const docType = NumberSeriesDocTypeSchema.safeParse(state.doc)
  const query: NumberSeriesListQuery = {
    fy: state.fy,
    ...(state.store !== ALL ? { store_id: state.store } : {}),
    ...(docType.success ? { doc_type: docType.data } : {}),
  }
  const list = useNumberSeries(query)
  const [editing, setEditing] = useState<NumberSeries | null>(null)
  const [open, setOpen] = useState(false)
  const lng = getLanguage()
  const rows = useMemo(
    () =>
      [...(list.data?.data ?? [])].sort(
        (a, b) =>
          a.store_code.localeCompare(b.store_code) ||
          NumberSeriesDocTypeSchema.options.indexOf(a.doc_type) -
            NumberSeriesDocTypeSchema.options.indexOf(b.doc_type) ||
          (a.register_code ?? '').localeCompare(b.register_code ?? ''),
      ),
    [list.data],
  )

  const columns = useMemo<DataTableColumn<NumberSeries>[]>(
    () => [
      {
        id: 'doc',
        header: t('series.col_document'),
        meta: { className: 'min-w-44' },
        cell: ({ row }) => <SeriesDocument series={row.original} />,
      },
      {
        id: 'next',
        header: t('series.col_next'),
        cell: ({ row }) => <SeriesNext series={row.original} />,
      },
      {
        id: 'issued',
        header: t('series.col_issued'),
        meta: { align: 'right' },
        cell: ({ row }) =>
          row.original.id === null ? (
            <span className="whitespace-nowrap text-xs text-muted-foreground">
              {t('series.not_used')}
            </span>
          ) : (
            <span className="tabular-nums">{formatNumber(row.original.issued_count)}</span>
          ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('common:actions.edit')}</span>,
        meta: { align: 'right', className: 'w-12' },
        cell: ({ row }) =>
          canManage ? (
            <IconButton
              size="sm"
              icon={<Pencil />}
              label={row.original.id === null ? t('series.customise') : t('common:actions.edit')}
              onClick={(e) => {
                e.stopPropagation()
                setEditing(row.original)
                setOpen(true)
              }}
              onKeyDown={(e) => e.stopPropagation()}
            />
          ) : null,
      },
    ],
    [t, canManage],
  )

  const docOptions = [
    { value: ALL, label: t('series.all_documents') },
    ...NumberSeriesDocTypeSchema.options.map((d: NumberSeriesDocType) => ({
      value: d,
      label: DOC_TYPE_LABELS[d][lng],
    })),
  ]
  const storeOptions = [
    { value: ALL, label: t('common:misc.all_stores') },
    ...stores.map((s) => ({
      value: s.id,
      label: `${s.code} · ${localizedName(s.name, s.name_ta)}`,
    })),
  ]

  return (
    <div className="max-w-5xl">
      <SettingsPageHeader title={t('pages.number_series')} description={t('series.description')} />
      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        <Select value={state.fy} onValueChange={(fy) => setState({ fy })} options={fyOptions} />
        {stores.length > 1 ? (
          <Select
            value={state.store}
            onValueChange={(store) => setState({ store })}
            options={storeOptions}
          />
        ) : null}
        <Select value={state.doc} onValueChange={(doc) => setState({ doc })} options={docOptions} />
      </div>
      <DataTable
        label={t('pages.number_series')}
        columns={columns}
        data={rows}
        getRowId={(s) => s.key}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={
          canManage
            ? (s) => {
                setEditing(s)
                setOpen(true)
              }
            : undefined
        }
        renderCard={(s) => <SeriesCard series={s} />}
        empty={
          <EmptyState
            compact
            icon={<ListOrdered />}
            title={t('series.empty_title')}
            description={t('series.empty_description')}
          />
        }
      />
      <div className="mt-3 rounded-lg bg-surface-2 px-4 py-3 text-sm text-muted-foreground">
        {t('series.rules')}
      </div>
      <SeriesEditorDialog open={open} onOpenChange={setOpen} series={editing} />
    </div>
  )
}
