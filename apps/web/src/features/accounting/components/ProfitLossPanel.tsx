/**
 * Profit & loss (இலாப நஷ்ட கணக்கு) for a period (default: this financial year to date): income,
 * cost of goods sold, gross profit, expenses and net profit with margins; optional comparison
 * with the previous period or the same period last year (comparisonRange), store filter, print
 * and CSV. Accounts link to their ledger for the same dates.
 */
import { useTranslation } from 'react-i18next'
import {
  ACCOUNTING_TITLES,
  type ComparisonMode,
  type ProfitLossQuery,
  STATEMENT_LINE_LABELS,
  accountingRoutes,
  comparisonRange,
} from '@kadai/shared/api/accounting'
import { StorePicker } from '@/components/pickers'
import { DateRangePicker, ErrorFallback, Select, Skeleton, Stat } from '@/components/ui'
import { downloadRoute } from '@/lib/api'
import { formatBp, formatDate, formatMoney } from '@/lib/format'
import { useProfitLoss } from '../api'
import { accountName, bi } from '../lib/labels'
import { type PrintRow, printTable } from '../lib/print'
import { useTenantInfo } from '../lib/tenant'
import { useUrlState } from '../lib/url-state'
import { ExportMenu } from './ExportMenu'
import { changeOf } from '../lib/statements'
import { type StatementItem, StatementTable } from './StatementTable'

const COMPARE = ['none', 'previous_period', 'previous_year'] as const

export function ProfitLossPanel() {
  const { t } = useTranslation(['accounting', 'common'])
  const tenant = useTenantInfo()
  const url = useUrlState()
  const from = url.date('from', tenant.fyStart)
  const to = url.date('to', tenant.today)
  const compare = url.oneOf('compare', COMPARE, 'none')
  const storeId = url.id('store')
  const range = compare === 'none' ? null : comparisonRange(from, to, compare as ComparisonMode)

  const query: ProfitLossQuery = {
    from,
    to,
    ...(storeId ? { store_id: storeId } : {}),
    ...(range ? { compare_from: range.from, compare_to: range.to } : {}),
  }
  const pl = useProfitLoss(query)
  const data = pl.data?.data
  const comparing = Boolean(data?.compare)
  const ledgerLink = (id: string) => `/accounting/ledgers?account=${id}&from=${from}&to=${to}`

  const profit = data?.net_profit_paise ?? 0
  const items: StatementItem[] = data
    ? [
        { kind: 'heading', label: bi(STATEMENT_LINE_LABELS.income) },
        { kind: 'lines', lines: data.income.lines },
        {
          kind: 'total',
          label: t('statements.pl.total_income'),
          amount: data.income.total_paise,
          compare: data.income.compare_total_paise,
        },
        { kind: 'heading', label: t('statements.pl.less_cogs') },
        { kind: 'lines', lines: data.cogs.lines },
        {
          kind: 'total',
          label: t('statements.pl.total_cogs'),
          amount: data.cogs.total_paise,
          compare: data.cogs.compare_total_paise,
        },
        {
          kind: 'result',
          label: bi(STATEMENT_LINE_LABELS.gross_profit),
          amount: data.gross_profit_paise,
          compare: data.gross_profit_compare_paise,
          note:
            data.gross_margin_bp === null
              ? null
              : t('statements.pl.margin', { value: formatBp(data.gross_margin_bp) }),
          tone: data.gross_profit_paise < 0 ? 'bad' : null,
        },
        { kind: 'heading', label: t('statements.pl.less_expenses') },
        { kind: 'lines', lines: data.expenses.lines },
        {
          kind: 'total',
          label: t('statements.pl.total_expenses'),
          amount: data.expenses.total_paise,
          compare: data.expenses.compare_total_paise,
        },
        {
          kind: 'result',
          label: bi(profit < 0 ? STATEMENT_LINE_LABELS.net_loss : STATEMENT_LINE_LABELS.net_profit),
          amount: Math.abs(profit),
          changeFrom: profit,
          compare: data.net_profit_compare_paise,
          note:
            data.net_margin_bp === null
              ? null
              : t('statements.pl.margin', { value: formatBp(data.net_margin_bp) }),
          tone: profit < 0 ? 'bad' : 'good',
        },
      ]
    : []

  const csv = () =>
    downloadRoute(accountingRoutes.profitLoss, {
      query: { ...query, format: 'csv' },
      filename: `profit-loss-${from}-${to}.csv`,
    })
  const print = () => {
    if (!data) return
    const rows: PrintRow[] = []
    for (const item of items) {
      if (item.kind === 'heading')
        rows.push({ kind: 'section', cells: [item.label, '', ...(comparing ? [''] : [])] })
      else if (item.kind === 'lines')
        for (const l of item.lines)
          rows.push({
            cells: [
              `${l.code} ${accountName(l)}`,
              formatMoney(l.amount_paise),
              ...(comparing ? [l.compare_paise === null ? '' : formatMoney(l.compare_paise)] : []),
            ],
          })
      else
        rows.push({
          kind: 'total',
          cells: [
            `${typeof item.label === 'string' ? item.label : ''}${item.note ? ` (${item.note})` : ''}`,
            formatMoney(item.amount),
            ...(comparing ? [item.compare == null ? '' : formatMoney(item.compare)] : []),
          ],
        })
    }
    return printTable({
      title: bi(ACCOUNTING_TITLES.profit_loss),
      subtitle: [
        t('print.period', { from: formatDate(data.from), to: formatDate(data.to) }),
        storeId ? tenant.stores.find((s) => s.id === storeId)?.name : null,
      ]
        .filter(Boolean)
        .join(' · '),
      columns: [
        { label: t('statements.particulars') },
        { label: t('statements.amount'), align: 'right' },
        ...(comparing && data.compare
          ? [
              {
                label: t('print.period', {
                  from: formatDate(data.compare.from),
                  to: formatDate(data.compare.to),
                }),
                align: 'right' as const,
              },
            ]
          : []),
      ],
      rows,
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <DateRangePicker
          value={{ from, to }}
          onChange={(r) => url.set({ from: r.from, to: r.to })}
          presets={['this_month', 'last_month', 'this_fy', 'last_fy', 'last_30_days']}
          max={tenant.today}
        />
        <Select
          aria-label={t('statements.compare_with')}
          value={compare}
          onValueChange={(c) => url.set({ compare: c === 'none' ? null : c })}
          options={COMPARE.map((c) => ({ value: c, label: t(`statements.compare_${c}`) }))}
          className="sm:w-56"
        />
        {tenant.multiStore ? (
          <StorePicker
            value={storeId ?? 'all'}
            onChange={(id) => url.set({ store: id && id !== 'all' ? id : null })}
            allowAll
            clearable={false}
            className="sm:w-52"
            aria-label={t('common:fields.store')}
          />
        ) : null}
        <div className="flex gap-2 sm:ms-auto">
          <ExportMenu onPrint={print} onCsv={csv} disabled={!data} />
        </div>
      </div>
      {range ? (
        <p className="text-xs text-muted-foreground">
          {t('statements.comparing_with', {
            from: formatDate(range.from),
            to: formatDate(range.to),
          })}
        </p>
      ) : null}

      {pl.error ? (
        <ErrorFallback error={pl.error} reset={() => void pl.refetch()} />
      ) : !data ? (
        <div className="flex flex-col gap-3" aria-busy>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label={bi(STATEMENT_LINE_LABELS.net_sales)}
              value={formatMoney(data.net_sales_paise)}
              change={kpiChange(data.net_sales_paise, data.net_sales_compare_paise, 'up')}
            />
            <Stat
              label={bi(STATEMENT_LINE_LABELS.gross_profit)}
              value={formatMoney(data.gross_profit_paise)}
              hint={
                data.gross_margin_bp === null
                  ? undefined
                  : t('statements.pl.margin', { value: formatBp(data.gross_margin_bp) })
              }
              change={kpiChange(data.gross_profit_paise, data.gross_profit_compare_paise, 'up')}
            />
            <Stat
              label={bi(STATEMENT_LINE_LABELS.expenses)}
              value={formatMoney(data.expenses.total_paise)}
              change={kpiChange(
                data.expenses.total_paise,
                data.expenses.compare_total_paise,
                'down',
              )}
            />
            <Stat
              label={bi(
                profit < 0 ? STATEMENT_LINE_LABELS.net_loss : STATEMENT_LINE_LABELS.net_profit,
              )}
              value={formatMoney(Math.abs(profit))}
              tone={profit < 0 ? 'danger' : 'primary'}
              hint={
                data.net_margin_bp === null
                  ? undefined
                  : t('statements.pl.margin', { value: formatBp(data.net_margin_bp) })
              }
              change={kpiChange(profit, data.net_profit_compare_paise, 'up')}
            />
          </div>
          <StatementTable
            items={items}
            comparing={comparing}
            ledgerLink={ledgerLink}
            label={bi(ACCOUNTING_TITLES.profit_loss)}
          />
        </>
      )}
    </div>
  )
}

function kpiChange(
  amount: number,
  compare: number | null,
  goodWhen: 'up' | 'down',
): { bp: number; goodWhen: 'up' | 'down' } | undefined {
  const bp = changeOf(amount, compare)
  return bp === null ? undefined : { bp, goodWhen }
}
