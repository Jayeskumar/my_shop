/**
 * Unit & pack: stock unit, decimal quantities for weighed / measured goods, pack size and loose
 * sale (pharmacy strips) with the live "1 strip = 10 tablets, ₹2.50 per tablet" helper.
 */
import { isDecimalUnit, unitPriceFromPack } from '@kadai/shared/units'
import { Calculator } from 'lucide-react'
import type { ReactNode } from 'react'
import { Controller } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { NumberInput, Switch } from '@/components/ui'
import { formatMoney } from '@/lib/format'
import { Field } from '../components/Field'
import { Section } from '../components/FormChrome'
import { UnitSelect } from '../components/UnitSelect'
import { unitCountWord, unitNameInline, unitSymbol } from '../lib/format'
import { useProductForm, useProductFormEnv } from './env'

export function UnitsSection({ icon }: { icon: ReactNode }) {
  const { t } = useTranslation('catalog')
  const env = useProductFormEnv()
  const { control, setValue, getFieldState, watch } = useProductForm()
  const unit = watch('unit')
  const pack = watch('pack_size')
  const sale = watch('sale_price_paise')
  const mrp = watch('mrp_paise')
  const loose = watch('allow_loose')
  const decimalAllowed = isDecimalUnit(unit)
  const lockedUnit = env.mode === 'edit'
  const pharmacy = env.businessType === 'pharmacy'
  const packWord = pharmacy ? t('units.strip') : t('units.pack')
  /** 'tabs' / 'pcs' (English sentences), the Tamil unit name in Tamil. */
  const units = unitCountWord(unit, 2)

  const onUnit = (code: string): void => {
    setValue('unit', code, { shouldDirty: true, shouldValidate: true })
    if (!isDecimalUnit(code)) setValue('decimal_qty', false, { shouldDirty: true })
    else if (!getFieldState('decimal_qty').isDirty)
      setValue('decimal_qty', true, { shouldDirty: true })
  }

  const perUnit = pack && pack > 1 && sale !== null ? unitPriceFromPack(sale, pack) : null
  const perUnitMrp = pack && pack > 1 && mrp !== null ? unitPriceFromPack(mrp, pack) : null

  return (
    <Section
      id="units"
      icon={icon}
      title={t('form.sections.units')}
      description={t('form.sections.units_hint')}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field
          name="unit"
          label={t('fields.unit')}
          required
          hint={lockedUnit ? t('units.locked_hint') : undefined}
        >
          <Controller
            control={control}
            name="unit"
            render={({ field }) => (
              <UnitSelect value={field.value} onChange={onUnit} disabled={env.readOnly} />
            )}
          />
        </Field>
        <Field
          name="pack_size"
          label={t('fields.pack_size')}
          required
          hint={t('units.pack_size_hint', { unit: unitNameInline(unit), units })}
        >
          <Controller
            control={control}
            name="pack_size"
            render={({ field }) => (
              <NumberInput
                value={field.value}
                onChange={(n) => {
                  field.onChange(n)
                  if (n !== null && n <= 1) setValue('allow_loose', false, { shouldDirty: true })
                }}
                onBlur={field.onBlur}
                min={1}
                max={100_000}
                suffix={unitSymbol(unit)}
                disabled={env.readOnly}
              />
            )}
          />
        </Field>
        <div className="grid grid-cols-1 content-start gap-3 rounded-lg bg-surface-2 p-3 sm:col-span-2 lg:col-span-1">
          <Controller
            control={control}
            name="allow_loose"
            render={({ field }) => (
              <Switch
                checked={field.value}
                onCheckedChange={field.onChange}
                disabled={env.readOnly || !pack || pack <= 1}
                label={t('units.allow_loose', { unit: unitNameInline(unit) })}
                description={t('units.allow_loose_hint', { pack: packWord, units })}
              />
            )}
          />
          <Controller
            control={control}
            name="decimal_qty"
            render={({ field }) => (
              <Switch
                checked={field.value}
                onCheckedChange={field.onChange}
                disabled={env.readOnly || !decimalAllowed}
                label={t('units.decimal_qty')}
                description={
                  decimalAllowed
                    ? t('units.decimal_qty_hint')
                    : t('units.decimal_qty_off', { unit: unitNameInline(unit) })
                }
              />
            )}
          />
        </div>
      </div>
      {pack && pack > 1 ? (
        <div
          className="mt-4 flex items-start gap-3 rounded-lg border border-info/30 bg-info-soft px-4 py-3 text-sm text-info-soft-foreground"
          aria-live="polite"
        >
          <Calculator className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="grid grid-cols-1 gap-0.5">
            <p className="font-medium">
              {t('units.pack_helper', {
                pack: packWord,
                count: pack,
                unit: unitNameInline(unit),
                units: unitCountWord(unit, pack),
              })}
              {perUnit !== null
                ? ` · ${t('units.per_unit_price', { price: formatMoney(perUnit), unit: unitSymbol(unit) })}`
                : ''}
            </p>
            {perUnitMrp !== null ? (
              <p className="text-xs opacity-80">
                {t('units.per_unit_mrp', {
                  price: formatMoney(perUnitMrp),
                  unit: unitSymbol(unit),
                })}
              </p>
            ) : null}
            {loose ? (
              <p className="text-xs opacity-80">
                {t('units.loose_on', { unit: unitNameInline(unit), units })}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </Section>
  )
}
