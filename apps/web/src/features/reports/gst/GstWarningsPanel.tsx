/**
 * Problems to fix before filing (customer without a valid GSTIN reported as B2C, missing HSN,
 * unknown place of supply …), errors first, each with a "Fix" link to the record.
 */
import type { GstWarning } from '@kadai/shared/api/reports'
import { AlertTriangle, CheckCircle2, ChevronRight, OctagonAlert } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Badge, Button, Card } from '@/components/ui'
import { cn } from '@/lib/cn'
import { sortWarnings, warningParams } from '../lib/gst'

const COLLAPSED = 6

export function GstWarningsPanel({ warnings }: { warnings: readonly GstWarning[] }) {
  const { t } = useTranslation('reports')
  const [all, setAll] = useState(false)
  const sorted = sortWarnings(warnings)
  const errors = sorted.filter((w) => w.severity === 'error').length

  if (!sorted.length) {
    return (
      <Card
        role="status"
        className="flex items-center gap-3 border-success/30 bg-success-soft/40 p-4 text-sm"
      >
        <CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden />
        <span>{t('gst.no_warnings')}</span>
      </Card>
    )
  }

  const shown = all ? sorted : sorted.slice(0, COLLAPSED)
  return (
    <Card
      className={cn('p-4', errors > 0 ? 'border-danger/40' : 'border-warning/40')}
      role="region"
      aria-label={t('gst.warnings_title')}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <AlertTriangle
          className={cn('size-5', errors > 0 ? 'text-danger' : 'text-warning')}
          aria-hidden
        />
        <h2 className="text-base font-semibold">{t('gst.warnings_title')}</h2>
        {errors > 0 ? (
          <Badge tone="danger" size="sm">
            {t('gst.errors_count', { count: errors })}
          </Badge>
        ) : null}
        {sorted.length - errors > 0 ? (
          <Badge tone="warning" size="sm">
            {t('gst.warnings_count', { count: sorted.length - errors })}
          </Badge>
        ) : null}
      </div>
      <p className="mb-3 text-sm text-muted-foreground">{t('gst.warnings_hint')}</p>
      <ul className="divide-y divide-border">
        {shown.map((w, i) => (
          <li
            key={`${w.code}-${w.ref_id ?? i}`}
            className="flex flex-wrap items-start gap-x-3 gap-y-2 py-2.5"
          >
            {w.severity === 'error' ? (
              <OctagonAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
            ) : (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            )}
            <div className="min-w-48 flex-1">
              <p className="text-sm">
                <span className="sr-only">
                  {w.severity === 'error' ? t('gst.severity_error') : t('gst.severity_warning')}
                  :{' '}
                </span>
                {t(`gst_warnings.${w.code}`, warningParams(w))}
              </p>
            </div>
            {w.path ? (
              <Button asChild variant="outline" size="sm" className="ms-7 shrink-0 sm:ms-0">
                <Link to={w.path} aria-label={`${t('gst.fix')}: ${w.label ?? ''}`}>
                  {t('gst.fix')}
                  <ChevronRight className="rtl:rotate-180" aria-hidden />
                </Link>
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {sorted.length > COLLAPSED ? (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setAll((v) => !v)}>
          {all ? t('gst.show_less') : t('gst.show_all', { count: sorted.length })}
        </Button>
      ) : null}
    </Card>
  )
}
