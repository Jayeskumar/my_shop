/**
 * Date range with presets (today, yesterday, this week, this month, last month, this FY, …) and
 * a custom from/to. Value `{ from, to }` business dates (inclusive), as the API's ?from=&to=.
 */
import { CalendarRange, ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { compareDates, formatDateDisplay, type DateRange } from '@kadai/shared/fy'
import { cn } from '@/lib/cn'
import { useAuth } from '@/lib/auth'
import {
  DEFAULT_DATE_PRESETS,
  matchPreset,
  presetRange,
  type DatePresetKey,
} from '@/lib/date-presets'
import { Button } from './button'
import { DatePicker } from './date-picker'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import type { FieldSize } from './variants'

export interface DateRangePickerProps {
  value: DateRange | null | undefined
  onChange: (range: DateRange) => void
  presets?: readonly DatePresetKey[]
  /** Hide the custom range inputs. */
  presetsOnly?: boolean
  min?: string
  max?: string
  size?: FieldSize
  className?: string
  align?: 'start' | 'end' | 'center'
}

export function DateRangePicker({
  value,
  onChange,
  presets = DEFAULT_DATE_PRESETS,
  presetsOnly,
  min,
  max,
  size = 'md',
  className,
  align = 'start',
}: DateRangePickerProps) {
  const { t } = useTranslation(['common', 'errors'])
  const me = useAuth((s) => s.me)
  const ctx = { timezone: me?.tenant.timezone, fyStartMonth: me?.tenant.fy_start_month }
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState<string | null>(value?.from ?? null)
  const [to, setTo] = useState<string | null>(value?.to ?? null)

  const active = matchPreset(value, presets, ctx)
  const label = active
    ? t(`dates.${active}`)
    : value
      ? `${formatDateDisplay(value.from)} – ${formatDateDisplay(value.to)}`
      : t('dates.pick_range')

  const customInvalid = Boolean(from && to && compareDates(from, to) > 0)

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) {
          setFrom(value?.from ?? null)
          setTo(value?.to ?? null)
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size={size === 'xl' ? 'xl' : size === 'lg' ? 'lg' : size === 'sm' ? 'sm' : 'md'}
          className={cn('justify-between gap-2 font-normal', className)}
          leftIcon={<CalendarRange className="text-muted-foreground" />}
          rightIcon={<ChevronDown className="opacity-60" />}
        >
          <span className="truncate tabular-nums">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-[min(36rem,calc(100vw-2rem))] p-0">
        <div className="flex flex-col sm:flex-row">
          <ul className="grid grid-cols-2 gap-1 border-b border-border p-2 sm:w-48 sm:grid-cols-1 sm:border-b-0 sm:border-e">
            {presets.map((key) => {
              const range = presetRange(key, ctx)
              return (
                <li key={key}>
                  <button
                    type="button"
                    className={cn(
                      'w-full rounded-md px-3 py-2 text-start text-sm hover:bg-surface-2',
                      active === key &&
                        'bg-primary-soft font-semibold text-primary-soft-foreground',
                    )}
                    onClick={() => {
                      onChange(range)
                      setOpen(false)
                    }}
                  >
                    {t(`dates.${key}`)}
                  </button>
                </li>
              )
            })}
          </ul>
          {!presetsOnly ? (
            <div className="flex flex-1 flex-col gap-3 p-4">
              <p className="text-sm font-semibold">{t('dates.custom')}</p>
              <label className="grid gap-1 text-xs text-muted-foreground">
                {t('dates.from')}
                <DatePicker
                  value={from}
                  onChange={setFrom}
                  min={min}
                  max={to ?? max}
                  aria-label={t('dates.from')}
                />
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                {t('dates.to')}
                <DatePicker
                  value={to}
                  onChange={setTo}
                  min={from ?? min}
                  max={max}
                  aria-label={t('dates.to')}
                />
              </label>
              {customInvalid ? (
                <p className="text-xs text-danger">{t('errors:validation.date_order')}</p>
              ) : null}
              <Button
                className="mt-1 self-end"
                disabled={!from || !to || customInvalid}
                onClick={() => {
                  if (from && to) {
                    onChange({ from, to })
                    setOpen(false)
                  }
                }}
              >
                {t('actions.apply')}
              </Button>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
