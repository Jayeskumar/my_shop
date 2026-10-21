/**
 * Where the money went: posted expenses of the filtered period by category as a ranked
 * horizontal bar list (one series → one colour, value at the bar tip, share in the tooltip).
 * Eight largest categories are shown, the rest fold into "Others". Each row is a button that
 * filters the list to that category (the expense table below is the full data view).
 */
import type { ExpenseListSummary } from '@kadai/shared/api/accounting'
import { useTranslation } from 'react-i18next'
import { Skeleton } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatMoney, formatNumber } from '@/lib/format'
import { accountName } from '../lib/labels'

const MAX_ROWS = 8

interface Row {
  id: string | null
  label: string
  count: number
  total: number
}

export function CategoryTotalsChart({
  summary,
  loading,
  selectedId,
  onSelect,
}: {
  summary: ExpenseListSummary | undefined
  loading?: boolean
  selectedId?: string | null
  onSelect?: (accountId: string | null) => void
}) {
  const { t } = useTranslation('accounting')
  if (loading && !summary) {
    return (
      <div className="flex flex-col gap-3" aria-busy>
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    )
  }
  const cats = [...(summary?.by_category ?? [])].sort((a, b) => b.total_paise - a.total_paise)
  if (!cats.length) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">{t('expenses.chart_empty')}</p>
    )
  }
  const rows: Row[] = cats.slice(0, MAX_ROWS).map((c) => ({
    id: c.expense_account_id,
    label: accountName(c),
    count: c.count,
    total: c.total_paise,
  }))
  const rest = cats.slice(MAX_ROWS)
  if (rest.length) {
    rows.push({
      id: null,
      label: t('expenses.chart_others', { count: rest.length }),
      count: rest.reduce((n, c) => n + c.count, 0),
      total: rest.reduce((n, c) => n + c.total_paise, 0),
    })
  }
  const max = Math.max(...rows.map((r) => r.total), 1)
  const grand = summary?.total_paise ?? rows.reduce((n, r) => n + r.total, 0)

  return (
    <ul className="flex flex-col gap-2.5" aria-label={t('expenses.chart_title')}>
      {rows.map((row) => {
        const share = grand > 0 ? Math.round((row.total / grand) * 1000) / 10 : 0
        const selected = row.id !== null && row.id === selectedId
        const clickable = Boolean(onSelect && row.id)
        const tip = t('expenses.chart_tooltip', {
          name: row.label,
          amount: formatMoney(row.total),
          count: row.count,
          share: formatNumber(share, 1),
        })
        const content = (
          <>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className={cn('min-w-0 truncate', selected ? 'font-semibold' : 'font-medium')}>
                {row.label}
              </span>
              <span className="shrink-0 tabular-nums">
                {formatMoney(row.total, { decimals: 'auto' })}
                <span className="ms-1.5 text-xs text-muted-foreground">
                  {formatNumber(share, 1)}%
                </span>
              </span>
            </div>
            <div className="mt-1 h-2.5 w-full" aria-hidden>
              <div
                className={cn(
                  'h-full rounded-e-[4px] transition-[width] duration-300',
                  selected ? 'bg-primary' : 'bg-primary/80 group-hover:bg-primary',
                )}
                style={{ width: `${Math.max(1.5, (row.total / max) * 100)}%` }}
              />
            </div>
          </>
        )
        return (
          <li key={row.id ?? 'others'}>
            {clickable ? (
              <button
                type="button"
                title={tip}
                aria-label={tip}
                aria-pressed={selected}
                onClick={() => onSelect?.(selected ? null : row.id)}
                className="group block w-full rounded-md px-1 py-0.5 text-start focus-visible:outline-2 focus-visible:outline-ring"
              >
                {content}
              </button>
            ) : (
              <div title={tip} className="px-1 py-0.5">
                {content}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
