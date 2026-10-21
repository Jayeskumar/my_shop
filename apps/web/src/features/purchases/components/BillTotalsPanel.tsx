/**
 * Live totals of the bill editor: gross, discount, taxable, CGST / SGST or IGST, cess, other
 * charges (freight, packing — spread over the lines' landed cost), round-off (automatic nearest
 * rupee or the supplier's exact figure) and the payable total, with the GST split by rate and a
 * check against the total printed on the supplier's invoice.
 */
import { Check } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, FormField, MoneyInput, Switch } from '@/components/ui'
import { formatMoney } from '@/lib/format'
import type { BillComputation, BillHeaderDraft } from '../lib/bill-form'
import { TaxBreakupTable, TotalRow } from './TaxBreakup'

export interface BillTotalsPanelProps {
  header: BillHeaderDraft
  calc: BillComputation
  lineCount: number
  disabled?: boolean
  roundOffError?: string
  onChange: (patch: Partial<BillHeaderDraft>) => void
}

export function BillTotalsPanel({
  header,
  calc,
  lineCount,
  disabled,
  roundOffError,
  onChange,
}: BillTotalsPanelProps) {
  const { t } = useTranslation('purchases')
  const [paperTotal, setPaperTotal] = useState<number | null>(null)
  const doc = calc.doc
  const autoRound = header.round_off_manual === null
  const difference = paperTotal !== null && doc ? paperTotal - doc.total_paise : null

  return (
    <section
      aria-labelledby="bill-totals-title"
      className="rounded-xl border border-border bg-surface p-4 shadow-card"
    >
      <h2
        id="bill-totals-title"
        className="mb-2 flex items-center justify-between text-base font-semibold"
      >
        {t('totals.title')}
        <span className="text-xs font-normal text-muted-foreground">
          {t('totals.items', { count: lineCount })}
        </span>
      </h2>
      <div className="text-sm">
        <TotalRow label={t('totals.gross')} paise={doc?.gross_paise ?? 0} />
        {doc && doc.discount_paise > 0 ? (
          <TotalRow label={t('totals.discount')} paise={-doc.discount_paise} muted />
        ) : null}
        <TotalRow label={t('totals.taxable')} paise={doc?.taxable_paise ?? 0} />
        {calc.is_interstate ? (
          <TotalRow label={t('totals.igst')} paise={doc?.igst_paise ?? 0} />
        ) : (
          <>
            <TotalRow label={t('totals.cgst')} paise={doc?.cgst_paise ?? 0} />
            <TotalRow label={t('totals.sgst')} paise={doc?.sgst_paise ?? 0} />
          </>
        )}
        {doc && doc.cess_paise > 0 ? (
          <TotalRow label={t('totals.cess')} paise={doc.cess_paise} />
        ) : null}

        <div className="my-2 grid gap-3 border-t border-dashed border-border pt-3">
          <FormField label={t('totals.other_charges')} hint={t('totals.other_charges_hint')}>
            <MoneyInput
              size="sm"
              value={header.other_charges_paise}
              disabled={disabled}
              onChange={(v) => onChange({ other_charges_paise: v })}
            />
          </FormField>
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{t('totals.round_off')}</span>
              <Switch
                checked={autoRound}
                disabled={disabled}
                label={t('totals.round_off_auto')}
                onCheckedChange={(on) =>
                  onChange({ round_off_manual: on ? null : (doc?.round_off_paise ?? 0) })
                }
              />
            </div>
            {autoRound ? (
              <TotalRow
                label={t('totals.round_off_auto_value')}
                paise={doc?.round_off_paise ?? 0}
                signed
                muted
              />
            ) : (
              <FormField
                label={t('totals.round_off_supplier')}
                hideLabel
                error={roundOffError}
                hint={t('totals.round_off_hint')}
              >
                <MoneyInput
                  size="sm"
                  allowNegative
                  value={header.round_off_manual}
                  disabled={disabled}
                  aria-label={t('totals.round_off_supplier')}
                  onChange={(v) => onChange({ round_off_manual: v ?? 0 })}
                />
              </FormField>
            )}
          </div>
        </div>

        <TotalRow label={t('totals.payable')} paise={doc?.total_paise ?? 0} strong />
        {header.reverse_charge && doc ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {t('totals.reverse_charge_note', {
              amount: formatMoney(doc.total_paise - doc.tax_paise),
            })}
          </p>
        ) : null}
        {!calc.itc_eligible && doc && doc.tax_paise > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">{t('totals.no_itc_note')}</p>
        ) : null}
      </div>

      {doc && doc.tax_breakup.length > 0 ? (
        <details
          className="mt-3 rounded-lg border border-border px-3 py-2"
          open={doc.tax_breakup.length > 1}
        >
          <summary className="cursor-pointer text-sm font-medium">{t('totals.tax_split')}</summary>
          <TaxBreakupTable
            rows={doc.tax_breakup}
            interstate={calc.is_interstate}
            className="mt-2"
          />
        </details>
      ) : null}

      <div className="mt-3 grid gap-1.5 rounded-lg bg-surface-2/60 p-3">
        <FormField label={t('totals.paper_total')} hint={t('totals.paper_total_hint')}>
          <MoneyInput size="sm" value={paperTotal} onChange={setPaperTotal} />
        </FormField>
        {difference !== null ? (
          difference === 0 ? (
            <Badge tone="success" icon={<Check />} className="w-fit">
              {t('totals.paper_match')}
            </Badge>
          ) : (
            <Badge tone="danger" className="w-fit">
              {t('totals.paper_diff', { amount: formatMoney(Math.abs(difference)) })}
            </Badge>
          )
        ) : null}
      </div>
    </section>
  )
}
