/**
 * GST split by rate (taxable, CGST + SGST or IGST, cess) and the totals block of bills and
 * debit notes. Used by the bill editor (live), the bill detail and the debit-note detail.
 */
import type { TaxBreakupRow } from '@kadai/shared/pricing'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Money } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatBp } from '@/lib/format'

export function TaxBreakupTable({
  rows,
  interstate,
  className,
}: {
  rows: readonly TaxBreakupRow[]
  interstate: boolean
  className?: string
}) {
  const { t } = useTranslation('purchases')
  const hasCess = rows.some((r) => r.cess_paise > 0)
  if (rows.length === 0) return null
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full text-sm">
        <caption className="sr-only">{t('totals.tax_split')}</caption>
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            <th scope="col" className="py-1.5 pe-2 text-start font-medium">
              {t('totals.gst_rate')}
            </th>
            <th scope="col" className="px-2 py-1.5 text-end font-medium">
              {t('totals.taxable')}
            </th>
            {interstate ? (
              <th scope="col" className="px-2 py-1.5 text-end font-medium">
                {t('totals.igst')}
              </th>
            ) : (
              <>
                <th scope="col" className="px-2 py-1.5 text-end font-medium">
                  {t('totals.cgst')}
                </th>
                <th scope="col" className="px-2 py-1.5 text-end font-medium">
                  {t('totals.sgst')}
                </th>
              </>
            )}
            {hasCess ? (
              <th scope="col" className="ps-2 py-1.5 text-end font-medium">
                {t('totals.cess')}
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.gst_rate_bp} className="border-b border-border/60 last:border-0">
              <td className="py-1.5 pe-2 tabular-nums">{formatBp(r.gst_rate_bp)}</td>
              <td className="px-2 py-1.5 text-end">
                <Money paise={r.taxable_paise} />
              </td>
              {interstate ? (
                <td className="px-2 py-1.5 text-end">
                  <Money paise={r.igst_paise} />
                </td>
              ) : (
                <>
                  <td className="px-2 py-1.5 text-end">
                    <Money paise={r.cgst_paise} />
                  </td>
                  <td className="px-2 py-1.5 text-end">
                    <Money paise={r.sgst_paise} />
                  </td>
                </>
              )}
              {hasCess ? (
                <td className="ps-2 py-1.5 text-end">
                  <Money paise={r.cess_paise} />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** One row of a totals block. */
export function TotalRow({
  label,
  paise,
  strong,
  muted,
  signed,
  children,
}: {
  label: ReactNode
  paise?: number | null
  strong?: boolean
  muted?: boolean
  /** Show + for positive amounts (round-off). */
  signed?: boolean
  children?: ReactNode
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 py-1',
        strong && 'border-t border-border pt-2 text-lg font-bold',
        muted && 'text-muted-foreground',
      )}
    >
      <span className="min-w-0">{label}</span>
      {children ?? (
        <Money paise={paise ?? 0} signDisplay={signed ? 'always' : 'auto'} className="shrink-0" />
      )}
    </div>
  )
}

export interface DocumentTotals {
  gross_paise?: number
  discount_paise?: number
  taxable_paise: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
  cess_paise: number
  other_charges_paise?: number
  round_off_paise: number
  total_paise: number
}

/** Read-only totals block (detail pages). */
export function TotalsBlock({
  totals,
  interstate,
  extra,
}: {
  totals: DocumentTotals
  interstate: boolean
  extra?: ReactNode
}) {
  const { t } = useTranslation('purchases')
  return (
    <div className="text-sm">
      {totals.gross_paise !== undefined && (totals.discount_paise ?? 0) > 0 ? (
        <>
          <TotalRow label={t('totals.gross')} paise={totals.gross_paise} />
          <TotalRow label={t('totals.discount')} paise={-(totals.discount_paise ?? 0)} muted />
        </>
      ) : null}
      <TotalRow label={t('totals.taxable')} paise={totals.taxable_paise} />
      {interstate ? (
        <TotalRow label={t('totals.igst')} paise={totals.igst_paise} />
      ) : (
        <>
          <TotalRow label={t('totals.cgst')} paise={totals.cgst_paise} />
          <TotalRow label={t('totals.sgst')} paise={totals.sgst_paise} />
        </>
      )}
      {totals.cess_paise > 0 ? <TotalRow label={t('totals.cess')} paise={totals.cess_paise} /> : null}
      {(totals.other_charges_paise ?? 0) > 0 ? (
        <TotalRow label={t('totals.other_charges')} paise={totals.other_charges_paise} />
      ) : null}
      {totals.round_off_paise !== 0 ? (
        <TotalRow label={t('totals.round_off')} paise={totals.round_off_paise} signed muted />
      ) : null}
      <TotalRow label={t('totals.total')} paise={totals.total_paise} strong />
      {extra}
    </div>
  )
}
