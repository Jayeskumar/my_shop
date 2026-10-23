/**
 * Offers & schemes (GET /promotions, feature promotions): status tabs (active / scheduled /
 * ended / switched off), kind filter and search; the editor opens in a side panel (?id= / ?new).
 */
import {
  PROMOTION_KIND_LABELS,
  PROMOTION_STATUS_LABELS,
  type PromotionResponse,
  type PromotionStatus,
  catalogRoutes,
} from '@kadai/shared/api/catalog'
import { PromotionKindSchema, type PromotionKind } from '@kadai/shared/promotions'
import { keepPreviousData } from '@tanstack/react-query'
import { BadgePercent, Plus } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import {
  Badge,
  Button,
  type DataTableColumn,
  DataTable,
  EmptyState,
  PageHeader,
  SearchInput,
  Select,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui'
import { useCan, useMe } from '@/lib/auth'
import { localizedName } from '@/lib/i18n'
import { useRouteQuery } from '@/lib/query'
import { PromotionEditor } from '../components/PromotionEditor'
import { bilingual } from '../lib/format'
import { promotionText, scheduleParts } from '../lib/promotion-text'

const STATUS_TONE: Record<PromotionStatus, 'success' | 'info' | 'neutral' | 'warning'> = {
  active: 'success',
  scheduled: 'info',
  expired: 'neutral',
  inactive: 'warning',
}

const ALL = '__all'
const PAGE = 50

export default function PromotionsPage() {
  const { t } = useTranslation(['catalog', 'common'])
  const me = useMe()
  const tz = me?.tenant.timezone
  const canWrite = useCan('catalog.write')
  const [params, setParams] = useSearchParams()
  const status = (params.get('status') as PromotionStatus | null) ?? null
  const kindParam = PromotionKindSchema.safeParse(params.get('kind'))
  const kind: PromotionKind | null = kindParam.success ? kindParam.data : null
  const q = params.get('q') ?? ''
  const offset = Number(params.get('offset') ?? 0) || 0
  const editingId = params.get('id')
  const creating = params.has('new')

  const update = (patch: Record<string, string | null>, keepOffset = false): void =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) next.delete(k)
          else next.set(k, v)
        }
        if (!keepOffset) next.delete('offset')
        return next
      },
      { replace: true },
    )

  const list = useRouteQuery(
    catalogRoutes.listPromotions,
    {
      query: {
        ...(status ? { status } : {}),
        ...(kind ? { kind } : {}),
        ...(q ? { q } : {}),
        limit: PAGE,
        offset,
      },
    },
    { placeholderData: keepPreviousData },
  )
  const rows = list.data?.data ?? []
  const filtered = Boolean(status || kind || q)

  const columns = useMemo<DataTableColumn<PromotionResponse>[]>(
    () => [
      {
        id: 'name',
        header: t('promotions.col_offer'),
        meta: { mobile: 'title' },
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-medium">
              {localizedName(row.original.name, row.original.name_ta)}
            </p>
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {promotionText(row.original)}
            </p>
          </div>
        ),
      },
      {
        id: 'kind',
        header: t('promotions.col_kind'),
        meta: { mobile: 'subtitle' },
        cell: ({ row }) => (
          <span className="text-sm">{bilingual(PROMOTION_KIND_LABELS[row.original.kind])}</span>
        ),
      },
      {
        id: 'schedule',
        header: t('promotions.col_schedule'),
        cell: ({ row }) => {
          const { range, days } = scheduleParts(row.original, tz)
          return (
            <span className="grid grid-cols-1 text-sm text-muted-foreground">
              <span className="whitespace-nowrap">
                {range ?? (days ? t('promotions.every_day_short') : t('promotions.always'))}
              </span>
              {days ? <span>{days}</span> : null}
            </span>
          )
        },
      },
      {
        id: 'priority',
        header: t('promotions.col_priority'),
        meta: { align: 'right' },
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5 tabular-nums">
            {row.original.priority}
            {row.original.stackable ? (
              <Badge tone="info" size="sm">
                {t('promotions.stackable_short')}
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: 'status',
        header: t('common:fields.status'),
        cell: ({ row }) => (
          <Badge
            tone={STATUS_TONE[row.original.status]}
            size="sm"
            dot
            className="whitespace-nowrap"
          >
            {bilingual(PROMOTION_STATUS_LABELS[row.original.status])}
          </Badge>
        ),
      },
    ],
    [t, tz],
  )

  return (
    <div>
      <PageHeader
        title={t('pages.promotions')}
        description={t('promotions.description')}
        actions={
          canWrite ? (
            <Button leftIcon={<Plus />} onClick={() => update({ new: '1', id: null }, true)}>
              {t('promotions.new')}
            </Button>
          ) : null
        }
      />
      <Tabs
        value={status ?? 'all'}
        onValueChange={(v) => update({ status: v === 'all' ? null : v })}
        variant="pills"
        className="mb-3"
      >
        <TabsList aria-label={t('common:fields.status')}>
          <TabsTrigger value="all">{t('promotions.tab_all')}</TabsTrigger>
          {(['active', 'scheduled', 'expired', 'inactive'] as const).map((s) => (
            <TabsTrigger key={s} value={s}>
              {bilingual(PROMOTION_STATUS_LABELS[s])}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row">
        <SearchInput
          value={q}
          onChange={(v) => update({ q: v || null })}
          placeholder={t('promotions.search')}
          wrapperClassName="sm:max-w-xs"
        />
        <Select
          value={kind ?? ALL}
          onValueChange={(v) => update({ kind: v === ALL ? null : v })}
          aria-label={t('promotions.col_kind')}
          className="sm:w-56"
          options={[
            { value: ALL, label: t('promotions.all_kinds') },
            ...PromotionKindSchema.options.map((k) => ({
              value: k,
              label: bilingual(PROMOTION_KIND_LABELS[k]),
            })),
          ]}
        />
      </div>
      {!filtered && list.data?.page.total === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-surface">
          <EmptyState
            icon={<BadgePercent />}
            title={t('promotions.empty_title')}
            description={t('promotions.empty_description')}
            action={
              canWrite ? (
                <Button leftIcon={<Plus />} onClick={() => update({ new: '1' }, true)}>
                  {t('promotions.new')}
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <DataTable<PromotionResponse>
          label={t('pages.promotions')}
          columns={columns}
          data={rows}
          getRowId={(p) => p.id}
          loading={list.isFetching}
          error={list.error}
          onRetry={() => void list.refetch()}
          onRowClick={(p) => update({ id: p.id, new: null }, true)}
          renderCard={(p) => <PromotionCard promotion={p} timezone={tz} />}
          pagination={
            list.data
              ? {
                  ...list.data.page,
                  onChange: (n) => update({ offset: n.offset ? String(n.offset) : null }, true),
                  pageSizeOptions: [PAGE],
                }
              : undefined
          }
        />
      )}
      {creating || editingId ? (
        <PromotionEditor
          key={editingId ?? 'new'}
          promotionId={editingId}
          readOnly={!canWrite}
          onClose={() => update({ id: null, new: null }, true)}
        />
      ) : null}
    </div>
  )
}

function PromotionCard({
  promotion: p,
  timezone,
}: {
  promotion: PromotionResponse
  timezone?: string | undefined
}) {
  const { t } = useTranslation(['catalog', 'common'])
  const { range, days } = scheduleParts(p, timezone)
  return (
    <div className="grid grid-cols-1 gap-1.5">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 font-semibold leading-snug">{localizedName(p.name, p.name_ta)}</p>
        <Badge tone={STATUS_TONE[p.status]} size="sm" dot className="shrink-0 whitespace-nowrap">
          {bilingual(PROMOTION_STATUS_LABELS[p.status])}
        </Badge>
      </div>
      <p className="text-sm">{promotionText(p)}</p>
      <p className="text-sm text-muted-foreground">
        {range ?? (days ? t('promotions.every_day_short') : t('promotions.always'))}
        {days ? ` · ${days}` : ''}
      </p>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{bilingual(PROMOTION_KIND_LABELS[p.kind])}</span>
        <span>
          {t('promotions.col_priority')}: {p.priority}
        </span>
        {p.stackable ? (
          <Badge tone="info" size="sm">
            {t('promotions.stackable_short')}
          </Badge>
        ) : null}
      </p>
    </div>
  )
}
