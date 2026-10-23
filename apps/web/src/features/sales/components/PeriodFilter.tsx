/** Date period filter of the sales lists: presets / custom range, plus "all dates". */
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { DateRange } from '@kadai/shared/fy'
import { DateRangePicker, IconButton } from '@/components/ui'
import { LIST_DATE_PRESETS } from '../lib/period'

export function PeriodFilter({
  value,
  onChange,
  className,
}: {
  value: DateRange | null
  onChange: (range: DateRange | null) => void
  className?: string
}) {
  const { t } = useTranslation('sales')
  return (
    <div className="flex items-center gap-1">
      <DateRangePicker
        value={value}
        onChange={onChange}
        presets={LIST_DATE_PRESETS}
        className={className}
      />
      {value ? (
        <IconButton
          icon={<X />}
          label={t('filters.all_dates')}
          variant="ghost"
          size="sm"
          onClick={() => onChange(null)}
        />
      ) : null}
    </div>
  )
}
