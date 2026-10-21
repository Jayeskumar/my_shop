/**
 * Shifts & cash (/accounting/shifts): the selected counter's running shift (expected drawer cash,
 * cash in / out, close) and every shift with expected vs counted cash and the short / excess
 * result. Members with shifts.operate only see their own shifts (server rule); shifts.manage
 * also filters by cashier. Filters live in the URL; a row opens the X / Z report.
 */
import { Clock, LogIn, Plus, Wallet } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import {
  type Shift,
  type ShiftDetail,
  type ShiftListQuery,
  ShiftDifferenceStatusSchema,
  accountingRoutes,
} from '@kadai/shared/api/accounting'
import { RegisterPicker, StorePicker, UserPicker } from '@/components/pickers'
import {
  Button,
  Card,
  DataTable,
  type DataTableColumn,
  DateRangePicker,
  EmptyState,
  PageHeader,
  Select,
  Skeleton,
  Stat,
} from '@/components/ui'
import { downloadRoute } from '@/lib/api'
import { useCan, useCurrentRegister } from '@/lib/auth'
import { formatDateTime, formatMoney, formatTime } from '@/lib/format'
import { useCurrentShift, useShifts } from '../api'
import { CashEntryDialog } from '../components/CashEntryDialog'
import { CloseShiftDialog } from '../components/CloseShiftDialog'
import { ExportMenu } from '../components/ExportMenu'
import { FilterPanel } from '../components/FilterPanel'
import { OpenShiftDialog } from '../components/OpenShiftDialog'
import { ShiftStatusBadge } from '../components/ShiftStatusBadge'
import { differenceLabel } from '../lib/labels'
import { useTenantInfo } from '../lib/tenant'
import { useUrlState } from '../lib/url-state'

const SORTS = ['opened_at', 'closed_at', 'difference_paise'] as const
const PAGE_SIZES = [20, 50, 100, 200] as const
const STATUSES = ['all', 'open', 'closed'] as const
const DIFFERENCES = ['all', ...ShiftDifferenceStatusSchema.options] as const

export default function ShiftsPage() {
  const { t } = useTranslation(['accounting', 'common'])
  const navigate = useNavigate()
  const tenant = useTenantInfo()
  const canOperate = useCan('shifts.operate')
  const canManage = useCan('shifts.manage')
  const url = useUrlState()
  const [openDialog, setOpenDialog] = useState(false)

  const month = tenant.range('this_month')
  const from = url.date('from', month.from)
  const to = url.date('to', month.to)
  const storeId = url.id('store')
  const registerId = url.id('register')
  const userId = url.id('user')
  const status = url.oneOf('status', STATUSES, 'all')
  const difference = url.oneOf('difference', DIFFERENCES, 'all')
  const sortRaw = url.get('sort')
  const sort =
    sortRaw && (SORTS as readonly string[]).includes(sortRaw.replace(/^-/, ''))
      ? sortRaw
      : '-opened_at'
  const limitParam = url.int('limit', 50)
  const limit = (PAGE_SIZES as readonly number[]).includes(limitParam) ? limitParam : 50
  const offset = url.int('offset', 0)

  const query: ShiftListQuery = {
    from,
    to,
    limit,
    offset,
    sort,
    ...(storeId ? { store_id: storeId } : {}),
    ...(registerId ? { register_id: registerId } : {}),
    ...(userId && canManage ? { user_id: userId } : {}),
    ...(status !== 'all' ? { status } : {}),
    ...(difference !== 'all' ? { difference } : {}),
  }
  const list = useShifts(query)
  const rows = list.data?.data ?? []
  const page = list.data?.page
  const summary = list.data?.summary
  const filtered = Boolean(
    storeId || registerId || userId || status !== 'all' || difference !== 'all',
  )

  const columns = useMemo<DataTableColumn<Shift>[]>(
    () => [
      {
        id: 'register',
        header: t('fields.register'),
        meta: { mobile: 'title' },
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="truncate font-medium">
              {row.original.register_code} · {row.original.register_name}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {[row.original.opened_by_name, tenant.multiStore ? row.original.store_name : null]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
        ),
      },
      {
        id: 'opened_at',
        accessorKey: 'opened_at',
        header: t('shifts.fields.opened'),
        enableSorting: true,
        meta: { mobile: 'subtitle', label: t('shifts.fields.opened') },
        cell: ({ row }) => (
          <span className="whitespace-nowrap tabular-nums text-sm">
            {formatDateTime(row.original.opened_at)}
          </span>
        ),
      },
      {
        id: 'closed_at',
        accessorKey: 'closed_at',
        header: t('shifts.fields.closed'),
        enableSorting: true,
        meta: { label: t('shifts.fields.closed') },
        cell: ({ row }) =>
          row.original.closed_at ? (
            <span className="tabular-nums text-sm">{formatTime(row.original.closed_at)}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'sales',
        header: t('shifts.fields.sales'),
        meta: { align: 'right', label: t('shifts.fields.sales') },
        cell: ({ row }) =>
          row.original.sales_total_paise === null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <div className="flex flex-col items-end">
              <span className="tabular-nums">{formatMoney(row.original.sales_total_paise)}</span>
              <span className="text-xs text-muted-foreground">
                {t('shifts.bills_count', { count: row.original.bills_count ?? 0 })}
              </span>
            </div>
          ),
      },
      {
        id: 'expected',
        header: t('shifts.cash.expected'),
        meta: { align: 'right', label: t('shifts.cash.expected') },
        cell: ({ row }) =>
          row.original.expected_cash_paise === null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <span className="tabular-nums">{formatMoney(row.original.expected_cash_paise)}</span>
          ),
      },
      {
        id: 'counted',
        header: t('shifts.cash.counted'),
        meta: { align: 'right', label: t('shifts.cash.counted') },
        cell: ({ row }) =>
          row.original.counted_cash_paise === null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <span className="tabular-nums">{formatMoney(row.original.counted_cash_paise)}</span>
          ),
      },
      {
        id: 'difference_paise',
        accessorKey: 'difference_paise',
        header: t('shifts.cash.difference'),
        enableSorting: true,
        meta: { align: 'right', mobile: 'value', label: t('shifts.cash.difference') },
        cell: ({ row }) => (
          <ShiftStatusBadge
            status={row.original.status}
            differenceStatus={row.original.difference_status}
            differencePaise={row.original.difference_paise}
          />
        ),
      },
    ],
    [t, tenant.multiStore],
  )

  const csv = () =>
    downloadRoute(accountingRoutes.listShifts, {
      query: { ...query, format: 'csv', limit: undefined, offset: undefined },
      filename: `shifts-${from}-${to}.csv`,
    })

  return (
    <div>
      <PageHeader
        title={t('shifts.title')}
        description={t('shifts.description')}
        actions={
          <>
            <ExportMenu onCsv={csv} disabled={!page?.total} />
            {canOperate ? (
              <Button leftIcon={<Plus />} onClick={() => setOpenDialog(true)}>
                {t('shifts.open_shift')}
              </Button>
            ) : null}
          </>
        }
      />

      {canOperate ? <CurrentCounterCard onOpen={() => setOpenDialog(true)} /> : null}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label={t('shifts.stats.count')}
          value={String(summary?.count ?? 0)}
          loading={list.isLoading}
        />
        <Stat
          label={t('shifts.stats.open')}
          value={String(summary?.open_count ?? 0)}
          loading={list.isLoading}
          tone={summary?.open_count ? 'primary' : 'default'}
        />
        <Stat
          label={t('shifts.stats.short')}
          value={formatMoney(Math.abs(summary?.short_paise ?? 0))}
          loading={list.isLoading}
          tone={summary?.short_paise ? 'danger' : 'default'}
        />
        <Stat
          label={t('shifts.stats.excess')}
          value={formatMoney(summary?.excess_paise ?? 0)}
          loading={list.isLoading}
        />
      </div>

      <FilterPanel
        activeCount={
          [storeId, registerId, userId, status !== 'all', difference !== 'all'].filter(Boolean)
            .length
        }
        onReset={() =>
          url.set({ store: null, register: null, user: null, status: null, difference: null })
        }
        primary={
          <DateRangePicker
            value={{ from, to }}
            onChange={(r) => url.set({ from: r.from, to: r.to })}
            max={tenant.today}
          />
        }
      >
        {tenant.multiStore ? (
          <StorePicker
            value={storeId ?? 'all'}
            onChange={(id) => url.set({ store: id && id !== 'all' ? id : null, register: null })}
            allowAll
            clearable={false}
            className="sm:w-52"
            aria-label={t('common:fields.store')}
          />
        ) : null}
        <RegisterPicker
          value={registerId}
          onChange={(id) => url.set({ register: id })}
          storeId={storeId}
          includeInactive
          placeholder={t('shifts.filters.all_registers')}
          aria-label={t('fields.register')}
          className="sm:w-48"
        />
        {canManage ? (
          <UserPicker
            value={userId}
            onChange={(id) => url.set({ user: id })}
            storeId={storeId}
            includeDisabled
            placeholder={t('shifts.filters.all_cashiers')}
            aria-label={t('shifts.fields.cashier')}
            className="sm:w-48"
          />
        ) : null}
        <Select
          aria-label={t('common:fields.status')}
          value={status}
          onValueChange={(s) => url.set({ status: s === 'all' ? null : s })}
          options={STATUSES.map((s) => ({
            value: s,
            label:
              s === 'all'
                ? t('shifts.filters.all_status')
                : t(s === 'open' ? 'shifts.status_open' : 'shifts.status_closed'),
          }))}
          className="sm:w-44"
        />
        <Select
          aria-label={t('shifts.cash.difference')}
          value={difference}
          onValueChange={(d) => url.set({ difference: d === 'all' ? null : d })}
          options={DIFFERENCES.map((d) => ({
            value: d,
            label: d === 'all' ? t('shifts.filters.all_results') : differenceLabel(d),
          }))}
          className="sm:w-40"
        />
      </FilterPanel>

      <DataTable
        label={t('shifts.title')}
        columns={columns}
        data={rows}
        getRowId={(s) => s.id}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={(s) => navigate(`/accounting/shifts/${s.id}`)}
        sort={sort}
        onSortChange={(s) => url.set({ sort: s && s !== '-opened_at' ? s : null })}
        pagination={
          page
            ? {
                ...page,
                pageSizeOptions: PAGE_SIZES,
                onChange: (next) =>
                  url.set({
                    offset: next.offset || null,
                    limit: next.limit === 50 ? null : next.limit,
                  }),
              }
            : undefined
        }
        renderCard={(s) => (
          <div className="grid gap-1.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="line-clamp-1 break-words font-semibold">
                  {s.register_code} · {s.register_name}
                </div>
                <div className="line-clamp-1 break-words text-xs text-muted-foreground">
                  {[s.opened_by_name, formatDateTime(s.opened_at)].filter(Boolean).join(' · ')}
                </div>
              </div>
              <ShiftStatusBadge
                status={s.status}
                differenceStatus={s.difference_status}
                differencePaise={s.difference_paise}
              />
            </div>
            {s.status === 'closed' ? (
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div>
                  <div className="text-muted-foreground">{t('shifts.fields.sales')}</div>
                  <div className="font-medium tabular-nums">
                    {formatMoney(s.sales_total_paise ?? 0, { decimals: 'auto' })}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">{t('shifts.cash.expected')}</div>
                  <div className="font-medium tabular-nums">
                    {formatMoney(s.expected_cash_paise ?? 0, { decimals: 'auto' })}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">{t('shifts.cash.counted')}</div>
                  <div className="font-medium tabular-nums">
                    {formatMoney(s.counted_cash_paise ?? 0, { decimals: 'auto' })}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )}
        empty={
          <EmptyState
            compact
            icon={<Clock />}
            title={filtered ? t('shifts.none_filtered') : t('shifts.empty_title')}
            description={t('shifts.empty_description')}
            action={
              canOperate && !filtered ? (
                <Button leftIcon={<LogIn />} onClick={() => setOpenDialog(true)}>
                  {t('shifts.open_shift')}
                </Button>
              ) : undefined
            }
          />
        }
      />

      <OpenShiftDialog
        open={openDialog}
        onOpenChange={setOpenDialog}
        onOpened={(s) => navigate(`/accounting/shifts/${s.id}`)}
      />
    </div>
  )
}

/** The selected counter's shift: open → expected cash and quick actions; none → open one. */
function CurrentCounterCard({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation(['accounting', 'common'])
  const register = useCurrentRegister()
  const current = useCurrentShift(register?.id ?? null)
  const [dialog, setDialog] = useState<{ kind: 'cash' | 'close'; shift: ShiftDetail } | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  if (!register) return null
  const shift = current.data?.data ?? null
  const show = (kind: 'cash' | 'close', s: ShiftDetail) => {
    setDialog({ kind, shift: s })
    setDialogOpen(true)
  }
  // The dialogs stay mounted when the card changes (a closed shift disappears from "current"),
  // so the mutation's success callbacks still run.
  const dialogs = dialog ? (
    dialog.kind === 'cash' ? (
      <CashEntryDialog open={dialogOpen} onOpenChange={setDialogOpen} shift={dialog.shift} />
    ) : (
      <CloseShiftDialog open={dialogOpen} onOpenChange={setDialogOpen} shift={dialog.shift} />
    )
  ) : null

  let card: ReactNode
  if (current.isPending) {
    card = <Skeleton className="mb-4 h-24 w-full rounded-xl" />
  } else if (current.error) {
    card = null
  } else if (!shift) {
    card = (
      <Card className="mb-4 flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-full bg-surface-2 text-muted-foreground">
            <Wallet className="size-5" aria-hidden />
          </span>
          <div>
            <div className="font-medium">
              {t('shifts.current.none', { register: `${register.code} · ${register.name}` })}
            </div>
            <div className="text-sm text-muted-foreground">{t('shifts.current.none_hint')}</div>
          </div>
        </div>
        <Button onClick={onOpen} leftIcon={<LogIn />}>
          {t('shifts.open_shift')}
        </Button>
      </Card>
    )
  } else {
    card = (
      <Card
        className="mb-4 flex flex-col gap-3 border-primary/40 p-4 lg:flex-row lg:items-center lg:justify-between"
        data-testid="current-shift"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
            <Wallet className="size-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 font-medium">
              {shift.register_code} · {shift.register_name}
              <ShiftStatusBadge status="open" size="sm" />
            </div>
            <div className="text-sm text-muted-foreground">
              {t('shifts.current.since', {
                name: shift.opened_by_name ?? '—',
                time: formatTime(shift.opened_at),
              })}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <div className="text-xs text-muted-foreground">{t('shifts.cash.expected')}</div>
            <div className="text-lg font-semibold tabular-nums">
              {formatMoney(shift.summary.cash.expected_cash_paise)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">{t('shifts.fields.sales')}</div>
            <div className="text-lg font-semibold tabular-nums">
              {formatMoney(shift.summary.bills.total_paise)}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to={`/accounting/shifts/${shift.id}`}>{t('shifts.view_report')}</Link>
            </Button>
            {shift.can_add_cash_entry ? (
              <Button variant="outline" onClick={() => show('cash', shift)}>
                {t('shifts.cash_in_out')}
              </Button>
            ) : null}
            {shift.can_close ? (
              <Button onClick={() => show('close', shift)}>{t('shifts.close_shift')}</Button>
            ) : null}
          </div>
        </div>
      </Card>
    )
  }
  return (
    <>
      {card}
      {dialogs}
    </>
  )
}
