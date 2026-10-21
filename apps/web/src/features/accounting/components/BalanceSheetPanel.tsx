/**
 * Balance sheet (இருப்புநிலைக் குறிப்பு) as of a date: assets on one side, liabilities and
 * capital (with this year's profit so far and earlier years' profit) on the other, totals and
 * the "assets = liabilities + capital" check. Tenant-wide: members limited to some stores get a
 * clear message instead (403 all_stores_required).
 */
import { CheckCircle2, ShieldAlert, TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  ACCOUNTING_TITLES,
  type BalanceSheetQuery,
  STATEMENT_LINE_LABELS,
  accountingRoutes,
} from '@kadai/shared/api/accounting'
import { DatePicker, EmptyState, ErrorFallback, Skeleton } from '@/components/ui'
import { downloadRoute } from '@/lib/api'
import { formatDate, formatMoney } from '@/lib/format'
import { useBalanceSheet } from '../api'
import { errorReason } from '../lib/errors'
import { accountName, bi } from '../lib/labels'
import { type PrintRow, printTable } from '../lib/print'
import { useTenantInfo } from '../lib/tenant'
import { useUrlState } from '../lib/url-state'
import { ExportMenu } from './ExportMenu'
import { type StatementItem, StatementTable } from './StatementTable'

export function BalanceSheetPanel() {
  const { t } = useTranslation(['accounting', 'common'])
  const tenant = useTenantInfo()
  const url = useUrlState()
  const asOf = url.date('as_of', tenant.today)
  const query: BalanceSheetQuery = { as_of: asOf }
  const bs = useBalanceSheet(query, { enabled: !tenant.storeScoped })
  const data = bs.data?.data
  const ledgerLink = (id: string) =>
    `/accounting/ledgers?account=${id}&to=${asOf}&from=${data?.fy_start ?? tenant.fyStart}`

  const assets: StatementItem[] = data
    ? [
        { kind: 'heading', label: bi(STATEMENT_LINE_LABELS.assets) },
        { kind: 'lines', lines: data.assets.lines },
        { kind: 'result', label: t('statements.bs.total_assets'), amount: data.total_assets_paise },
      ]
    : []
  const liabilities: StatementItem[] = data
    ? [
        { kind: 'heading', label: bi(STATEMENT_LINE_LABELS.liabilities) },
        { kind: 'lines', lines: data.liabilities.lines },
        {
          kind: 'total',
          label: t('statements.bs.total_liabilities'),
          amount: data.liabilities.total_paise,
        },
        { kind: 'heading', label: bi(STATEMENT_LINE_LABELS.equity) },
        { kind: 'lines', lines: data.equity.lines },
        {
          kind: 'total',
          label: bi(STATEMENT_LINE_LABELS.current_period_profit),
          amount: data.current_period_profit_paise,
          note: data.fy,
        },
        {
          kind: 'total',
          label: bi(STATEMENT_LINE_LABELS.retained_earnings),
          amount: data.retained_earnings_paise,
        },
        { kind: 'total', label: t('statements.bs.total_equity'), amount: data.total_equity_paise },
        {
          kind: 'result',
          label: bi(STATEMENT_LINE_LABELS.total_liabilities_equity),
          amount: data.total_liabilities_equity_paise,
        },
      ]
    : []

  const csv = () =>
    downloadRoute(accountingRoutes.balanceSheet, {
      query: { ...query, format: 'csv' },
      filename: `balance-sheet-${asOf}.csv`,
    })
  const print = () => {
    if (!data) return
    const rows: PrintRow[] = []
    for (const item of [...assets, ...liabilities]) {
      if (item.kind === 'heading') rows.push({ kind: 'section', cells: [item.label, ''] })
      else if (item.kind === 'lines')
        for (const l of item.lines)
          rows.push({ cells: [`${l.code} ${accountName(l)}`, formatMoney(l.amount_paise)] })
      else
        rows.push({
          kind: 'total',
          cells: [typeof item.label === 'string' ? item.label : '', formatMoney(item.amount)],
        })
    }
    return printTable({
      title: bi(ACCOUNTING_TITLES.balance_sheet),
      subtitle: t('statements.as_of', { date: formatDate(data.as_of) }),
      columns: [
        { label: t('statements.particulars') },
        { label: t('statements.amount'), align: 'right' },
      ],
      rows,
    })
  }

  if (tenant.storeScoped || errorReason(bs.error) === 'all_stores_required') {
    return (
      <div className="rounded-xl border border-dashed border-border bg-surface">
        <EmptyState
          icon={<ShieldAlert />}
          title={t('errors.all_stores_required')}
          description={t('statements.all_stores_hint')}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t('statements.as_of_label')}
          <DatePicker
            value={asOf}
            onChange={(d) => url.set({ as_of: d && d !== tenant.today ? d : null })}
            max={tenant.today}
            className="w-44"
          />
        </label>
        <div className="flex gap-2 sm:ms-auto">
          <ExportMenu onPrint={print} onCsv={csv} disabled={!data} />
        </div>
      </div>

      {bs.error ? (
        <ErrorFallback error={bs.error} reset={() => void bs.refetch()} />
      ) : !data ? (
        <div className="grid gap-4 lg:grid-cols-2" aria-busy>
          <Skeleton className="h-96 rounded-xl" />
          <Skeleton className="h-96 rounded-xl" />
        </div>
      ) : (
        <>
          {data.balanced ? (
            <p className="flex items-center gap-2 text-sm text-success">
              <CheckCircle2 className="size-4" aria-hidden />
              {t('statements.bs.balanced')}
            </p>
          ) : (
            <p
              role="alert"
              className="flex items-center gap-2 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground"
            >
              <TriangleAlert className="size-4" aria-hidden />
              {t('statements.bs.not_balanced', {
                amount: formatMoney(Math.abs(data.difference_paise)),
              })}
            </p>
          )}
          <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
            <StatementTable
              items={liabilities}
              comparing={false}
              ledgerLink={ledgerLink}
              label={t('statements.bs.liabilities_side')}
            />
            <StatementTable
              items={assets}
              comparing={false}
              ledgerLink={ledgerLink}
              label={t('statements.bs.assets_side')}
            />
          </div>
        </>
      )}
    </div>
  )
}
