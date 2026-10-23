/**
 * Tax-period (month) picker: ‹ previous · month select · next › — "செப்டம்பர் 2026" in Tamil,
 * "September 2026" in English. Values are 'YYYY-MM'; future months are not offered.
 */
import { addPeriods } from '@kadai/shared/fy'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { IconButton, Select } from '@/components/ui'
import { cn } from '@/lib/cn'
import { periodLabel } from '../lib/periods'
import { useLang } from '../lib/labels'

export interface MonthPickerProps {
  value: string
  onChange: (period: string) => void
  /** Latest selectable period (default: the current month). */
  max: string
  /** How many months back are offered (default 24). */
  months?: number
  label: string
  className?: string
}

export function MonthPicker({
  value,
  onChange,
  max,
  months = 24,
  label,
  className,
}: MonthPickerProps) {
  const { t } = useTranslation('reports')
  const lng = useLang()
  const options = useMemo(() => {
    const list: { value: string; label: string }[] = []
    for (let i = 0; i < months; i++) {
      const p = addPeriods(max, -i)
      list.push({ value: p, label: periodLabel(p, lng) })
    }
    if (!list.some((o) => o.value === value)) list.push({ value, label: periodLabel(value, lng) })
    return list
  }, [max, months, value, lng])
  const min = addPeriods(max, -(months - 1))
  return (
    <div className={cn('flex items-center gap-1', className)} role="group" aria-label={label}>
      <IconButton
        icon={<ChevronLeft className="rtl:rotate-180" />}
        label={t('period.previous')}
        variant="outline"
        disabled={value <= min}
        onClick={() => onChange(addPeriods(value, -1))}
      />
      <Select
        value={value}
        onValueChange={onChange}
        options={options}
        aria-label={label}
        className="min-w-44"
      />
      <IconButton
        icon={<ChevronRight className="rtl:rotate-180" />}
        label={t('period.next')}
        variant="outline"
        disabled={value >= max}
        onClick={() => onChange(addPeriods(value, 1))}
      />
    </div>
  )
}
