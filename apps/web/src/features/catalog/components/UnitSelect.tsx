/** Unit select from GET /units (the vertical's suggested units first). */
import { catalogRoutes } from '@kadai/shared/api/catalog'
import { UNITS } from '@kadai/shared/units'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Select } from '@/components/ui'
import { getLanguage } from '@/lib/i18n'
import { useRouteQuery } from '@/lib/query'

export interface UnitSelectProps {
  value: string
  onChange: (code: string) => void
  id?: string
  disabled?: boolean
}

export function UnitSelect({ value, onChange, id, disabled }: UnitSelectProps) {
  const { t } = useTranslation('catalog')
  const units = useRouteQuery(catalogRoutes.listUnits, {}, { staleTime: Infinity })
  const lng = getLanguage()
  const options = useMemo(() => {
    const list = units.data?.data.units ?? UNITS
    const suggested = new Set(units.data?.data.suggested ?? [])
    const sorted = [...list].sort(
      (a, b) => Number(suggested.has(b.code)) - Number(suggested.has(a.code)),
    )
    return sorted.map((u) => ({
      value: u.code,
      label: `${lng === 'ta' ? u.name_ta : u.name_en} (${u.code})`,
      description: suggested.has(u.code) ? t('units.suggested') : undefined,
    }))
  }, [units.data, lng, t])
  return (
    <Select id={id} disabled={disabled} value={value} onValueChange={onChange} options={options} />
  )
}
