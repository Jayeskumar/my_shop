/**
 * Composition dealers (CMP-08 quarterly statement / GSTR-4 yearly): turnover and the tax at the
 * composition rate for each quarter of the financial year, the quarter of the chosen month
 * highlighted, plus reverse-charge purchases (tax paid in cash).
 */
import type { CompositionSummary } from '@kadai/shared/api/reports'
import { Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Card, Money } from '@/components/ui'
import { formatDate, formatMoney, formatNumber } from '@/lib/format'
import { type SimpleColumn, SimpleTable } from '../components/SimpleTable'

type Quarter = CompositionSummary['quarters'][number]

export function CompositionView({ report }: { report: CompositionSummary }) {
  const { t } = useTranslation('reports')
  const current = report.quarters.find((q) => q.quarter === report.quarter) ?? null
  const money = (p: number) => <Money paise={p} />
  const sum = (pick: (q: Quarter) => number): number =>
    report.quarters.reduce((s, q) => s + pick(q), 0)

  const columns: SimpleColumn<Quarter>[] = [
    {
      key: 'quarter',
      header: t('composition.col.quarter'),
      mobile: 'title',
      className: 'min-w-44',
      cell: (q) => (
        <span>
          <span className="font-semibold">{t(`composition.quarters.${q.quarter}`)}</span>
          <span className="block text-xs text-muted-foreground">
            {formatDate(q.from)} – {formatDate(q.to)}
          </span>
        </span>
      ),
    },
    {
      key: 'bills',
      header: t('composition.col.bills'),
      align: 'right',
      cell: (q) => formatNumber(q.bills),
      total: formatNumber(sum((q) => q.bills)),
    },
    {
      key: 'outward',
      header: t('composition.col.outward'),
      align: 'right',
      cell: (q) => money(q.outward_turnover_paise),
      total: money(sum((q) => q.outward_turnover_paise)),
    },
    {
      key: 'taxable',
      header: t('composition.col.taxable'),
      align: 'right',
      cell: (q) => money(q.taxable_turnover_paise),
      total: money(sum((q) => q.taxable_turnover_paise)),
    },
    {
      key: 'cgst',
      header: t('composition.col.cgst'),
      align: 'right',
      cell: (q) => money(q.cgst_paise),
      total: money(sum((q) => q.cgst_paise)),
    },
    {
      key: 'sgst',
      header: t('composition.col.sgst'),
      align: 'right',
      cell: (q) => money(q.sgst_paise),
      total: money(sum((q) => q.sgst_paise)),
    },
    {
      key: 'rcm_taxable',
      header: t('composition.col.rcm_taxable'),
      align: 'right',
      headClassName: 'min-w-24 whitespace-normal',
      cell: (q) => money(q.inward_rcm_taxable_paise),
      total: money(sum((q) => q.inward_rcm_taxable_paise)),
    },
    {
      key: 'rcm_tax',
      header: t('composition.col.rcm_tax'),
      align: 'right',
      headClassName: 'min-w-24 whitespace-normal',
      cell: (q) => money(q.inward_rcm_tax_paise),
      total: money(sum((q) => q.inward_rcm_tax_paise)),
    },
  ]

  return (
    <div className="grid grid-cols-1 gap-4">
      <div
        role="note"
        className="flex items-start gap-2 rounded-lg border border-info/30 bg-info-soft px-3 py-2 text-sm text-info-soft-foreground"
      >
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>{t('composition.intro', { rate: report.rate_bp / 100, fy: report.fy })}</p>
      </div>
      {current ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Card className="p-4">
            <p className="text-sm text-muted-foreground">
              {t('composition.quarter_turnover', {
                quarter: t(`composition.quarters.${current.quarter}`),
              })}
            </p>
            <p className="text-2xl font-bold tabular-nums">
              {money(current.taxable_turnover_paise)}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-sm text-muted-foreground">{t('composition.tax_payable')}</p>
            <p className="text-2xl font-bold tabular-nums">
              {money(current.cgst_paise + current.sgst_paise + current.inward_rcm_tax_paise)}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('composition.tax_split', {
                cgst: formatMoney(current.cgst_paise),
                sgst: formatMoney(current.sgst_paise),
              })}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-sm text-muted-foreground">{t('composition.bills')}</p>
            <p className="text-2xl font-bold tabular-nums">{formatNumber(current.bills)}</p>
          </Card>
        </div>
      ) : null}
      <SimpleTable
        label={t('composition.title', { fy: report.fy })}
        columns={columns}
        rows={report.quarters}
        rowKey={(q) => q.quarter}
        totalLabel={t('composition.fy_total')}
        highlight={(q) => q.quarter === report.quarter}
      />
    </div>
  )
}
