/**
 * Period picker of the report viewer: the contract's presets (today … this quarter, this FY, last
 * FY — quarters and FYs follow the tenant's FY start month) plus a custom from / to, checked with
 * the same rules as the server (from ≤ to, at most REPORT_MAX_RANGE_DAYS).
 */
import {
  REPORT_DATE_PRESET_LABELS,
  REPORT_MAX_RANGE_DAYS,
  type ReportDatePreset,
  reportRangeIssue,
} from '@kadai/shared/api/reports'
import { CalendarRange, ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, DatePicker, Popover, PopoverContent, PopoverTrigger } from '@/components/ui'
import { cn } from '@/lib/cn'
import type { ReportCalendar } from '../lib/calendar'
import { presetValue, rangeText, type RangeValue } from '../lib/filters'
import { pick, useLang } from '../lib/labels'

export interface ReportDateRangeProps {
  value: RangeValue
  onChange: (value: RangeValue) => void
  presets: readonly ReportDatePreset[]
  calendar: ReportCalendar
  label: string
  className?: string
}

export function ReportDateRange({
  value,
  onChange,
  presets,
  calendar,
  label,
  className,
}: ReportDateRangeProps) {
  const { t } = useTranslation(['reports', 'common'])
  const lng = useLang()
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState<string | null>(value.from)
  const [to, setTo] = useState<string | null>(value.to)
  const issue = from && to ? reportRangeIssue(from, to) : null

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) {
          setFrom(value.from)
          setTo(value.to)
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          aria-label={`${label}: ${value.preset ? pick(REPORT_DATE_PRESET_LABELS[value.preset], lng) : ''} ${rangeText(value)}`}
          className={cn('h-10 justify-between gap-2 font-normal', className)}
          leftIcon={<CalendarRange className="text-muted-foreground" />}
          rightIcon={<ChevronDown className="opacity-60" />}
        >
          <span className="flex min-w-0 items-baseline gap-2 truncate">
            {value.preset ? (
              <span className="truncate font-medium">
                {pick(REPORT_DATE_PRESET_LABELS[value.preset], lng)}
              </span>
            ) : null}
            <span
              className={cn(
                'truncate tabular-nums',
                value.preset && 'hidden text-xs text-muted-foreground sm:inline',
              )}
            >
              {rangeText(value)}
            </span>
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(36rem,calc(100vw-2rem))] p-0">
        <div className="flex flex-col sm:flex-row">
          <ul
            aria-label={label}
            className="grid grid-cols-2 gap-1 border-b border-border p-2 sm:w-52 sm:grid-cols-1 sm:border-b-0 sm:border-e"
          >
            {presets.map((preset) => (
              <li key={preset}>
                <button
                  type="button"
                  aria-pressed={value.preset === preset}
                  className={cn(
                    'min-h-10 w-full rounded-md px-3 py-2 text-start text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring',
                    value.preset === preset &&
                      'bg-primary-soft font-semibold text-primary-soft-foreground',
                  )}
                  onClick={() => {
                    onChange(presetValue(preset, calendar))
                    setOpen(false)
                  }}
                >
                  {pick(REPORT_DATE_PRESET_LABELS[preset], lng)}
                </button>
              </li>
            ))}
          </ul>
          <form
            className="flex flex-1 flex-col gap-3 p-4"
            onSubmit={(e) => {
              e.preventDefault()
              if (from && to && !issue) {
                onChange({ preset: null, from, to })
                setOpen(false)
              }
            }}
          >
            <p className="text-sm font-semibold">{t('common:dates.custom')}</p>
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t('common:dates.from')}
              <DatePicker
                value={from}
                onChange={setFrom}
                max={calendar.today}
                aria-label={t('common:dates.from')}
              />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t('common:dates.to')}
              <DatePicker
                value={to}
                onChange={setTo}
                min={from ?? undefined}
                max={calendar.today}
                aria-label={t('common:dates.to')}
              />
            </label>
            {issue ? (
              <p role="alert" className="text-xs text-danger">
                {t(`reports:validation.${issue}`, { days: REPORT_MAX_RANGE_DAYS })}
              </p>
            ) : null}
            <Button type="submit" className="mt-1 self-end" disabled={!from || !to || !!issue}>
              {t('common:actions.apply')}
            </Button>
          </form>
        </div>
      </PopoverContent>
    </Popover>
  )
}
