/**
 * GSTR-1 of a period: one card per section (count, taxable value, tax) in the order of the form,
 * warnings badges per section, and the drill-down table of the chosen section with its own CSV.
 */
import type { Gstr1Report, Gstr1Section } from '@kadai/shared/api/reports'
import { AlertTriangle, FileSpreadsheet } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Money } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatNumber } from '@/lib/format'
import { GSTR1_CARD_SECTIONS, sectionSummary, taxOf, warningCountBySection } from '../lib/gst'
import { Gstr1SectionTable } from './Gstr1SectionTable'

export interface Gstr1ViewProps {
  report: Gstr1Report
  section: Gstr1Section
  onSectionChange: (section: Gstr1Section) => void
  onSectionCsv: (section: Gstr1Section) => void
  csvBusy: boolean
  canDownload: boolean
}

export function Gstr1View({
  report,
  section,
  onSectionChange,
  onSectionCsv,
  csvBusy,
  canDownload,
}: Gstr1ViewProps) {
  const { t } = useTranslation('reports')
  const warnings = warningCountBySection(report.warnings)

  return (
    <div className="grid grid-cols-1 gap-4">
      <div
        role="tablist"
        aria-label={t('gst.sections_label')}
        className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-9"
      >
        {GSTR1_CARD_SECTIONS.map((s) => {
          const summary = sectionSummary(report, s)
          const count = summary?.count ?? 0
          const selected = s === section
          const warn = warnings.get(s) ?? 0
          return (
            <button
              key={s}
              type="button"
              role="tab"
              id={`gstr1-tab-${s}`}
              aria-selected={selected}
              aria-controls="gstr1-section-panel"
              onClick={() => onSectionChange(s)}
              className={cn(
                'flex min-h-28 flex-col items-start gap-1 rounded-xl border bg-surface p-3 text-start shadow-card transition-colors',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                selected
                  ? 'border-primary bg-primary-soft/40 ring-1 ring-primary'
                  : 'border-border hover:border-primary/40',
                count === 0 && !selected && 'opacity-75',
              )}
            >
              <span className="flex w-full items-start justify-between gap-1">
                <span className="text-sm font-semibold leading-snug">{t(`gst.sections.${s}`)}</span>
                {warn > 0 ? (
                  <Badge tone="warning" size="sm" icon={<AlertTriangle />}>
                    {warn}
                  </Badge>
                ) : null}
              </span>
              <span className="text-xs text-muted-foreground">{t(`gst.section_hints.${s}`)}</span>
              <span className="mt-auto text-lg font-bold tabular-nums">
                {formatNumber(count)}
                <span className="ms-1 text-xs font-normal text-muted-foreground">
                  {t(s === 'b2cs' || s === 'nil' || s.startsWith('hsn') ? 'gst.rows' : 'gst.docs', {
                    count,
                  })}
                </span>
              </span>
              {summary && s !== 'doc_issue' ? (
                <span className="grid w-full gap-0.5 text-xs">
                  <span className="flex justify-between gap-2">
                    <span className="text-muted-foreground">{t('gst.taxable_short')}</span>
                    <Money paise={summary.taxable_paise} className="font-medium" />
                  </span>
                  <span className="flex justify-between gap-2">
                    <span className="text-muted-foreground">{t('gst.tax_short')}</span>
                    <Money paise={taxOf(summary)} className="font-medium" />
                  </span>
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      <section
        id="gstr1-section-panel"
        role="tabpanel"
        aria-labelledby={`gstr1-tab-${section}`}
        className="grid grid-cols-1 gap-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold">{t(`gst.sections.${section}`)}</h3>
          {canDownload ? (
            <Button
              variant="outline"
              size="sm"
              leftIcon={<FileSpreadsheet />}
              loading={csvBusy}
              onClick={() => onSectionCsv(section)}
            >
              {t('gst.section_csv')}
            </Button>
          ) : null}
        </div>
        <Gstr1SectionTable report={report} section={section} />
      </section>
    </div>
  )
}
