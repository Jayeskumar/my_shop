/** GST: HSN search with suggested rate, rate, cess and the price-slab rule (apparel/footwear). */
import type { HsnEntry } from '@kadai/shared/api/catalog'
import { formatBp } from '@kadai/shared/money'
import { Lightbulb } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Controller } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { NumberInput } from '@/components/ui'
import { Field } from '../components/Field'
import { Section } from '../components/FormChrome'
import { GstRateSelect, HsnCombobox, SlabRuleSelect } from '../components/TaxInputs'
import { useProductForm, useProductFormEnv } from './env'

export function TaxSection({ icon }: { icon: ReactNode }) {
  const { t } = useTranslation('catalog')
  const env = useProductFormEnv()
  const { control, setValue, watch } = useProductForm()
  const [suggestion, setSuggestion] = useState<HsnEntry | null>(null)
  const slabRule = watch('tax_slab_rule_id')

  const onHsn = (code: string, entry: HsnEntry | null): void => {
    setValue('hsn_code', code, { shouldDirty: true, shouldValidate: true })
    setSuggestion(entry)
    if (entry?.gst_rate_bp != null)
      setValue('gst_rate_bp', entry.gst_rate_bp, { shouldDirty: true, shouldValidate: true })
  }

  return (
    <Section
      id="tax"
      icon={icon}
      title={t('form.sections.tax')}
      description={t('form.sections.tax_hint')}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field name="hsn_code" label={t('fields.hsn')} optional className="lg:col-span-2">
          <Controller
            control={control}
            name="hsn_code"
            render={({ field }) => (
              <HsnCombobox value={field.value} onChange={onHsn} disabled={env.readOnly} />
            )}
          />
        </Field>
        <Field
          name="gst_rate_bp"
          label={t('fields.gst_rate')}
          required
          hint={slabRule ? t('tax.rate_fallback') : undefined}
        >
          <Controller
            control={control}
            name="gst_rate_bp"
            render={({ field }) => (
              <GstRateSelect
                value={field.value}
                onChange={field.onChange}
                disabled={env.readOnly}
                placeholder={t('tax.pick_rate')}
              />
            )}
          />
        </Field>
        <Field name="cess_rate_bp" label={t('fields.cess')} optional>
          <Controller
            control={control}
            name="cess_rate_bp"
            render={({ field }) => (
              <NumberInput
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                scale={100}
                decimals={2}
                min={0}
                max={30_000}
                suffix="%"
                disabled={env.readOnly}
              />
            )}
          />
        </Field>
        {suggestion ? (
          <p className="flex items-start gap-2 rounded-md bg-info-soft px-3 py-2 text-sm text-info-soft-foreground sm:col-span-2 lg:col-span-4">
            <Lightbulb className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              <span className="font-medium">{suggestion.code}</span> — {suggestion.description}.{' '}
              {suggestion.gst_rate_bp != null
                ? t('tax.suggested_applied', { rate: formatBp(suggestion.gst_rate_bp) })
                : suggestion.slab_rule_hint
                  ? t('tax.suggested_slab')
                  : t('tax.suggested_check')}
            </span>
          </p>
        ) : null}
        <Field
          name="tax_slab_rule_id"
          label={t('fields.slab_rule')}
          optional
          hint={t('tax.slab_rule_hint')}
          className="sm:col-span-2 lg:col-span-4"
        >
          <Controller
            control={control}
            name="tax_slab_rule_id"
            render={({ field }) => (
              <SlabRuleSelect
                value={field.value}
                onChange={field.onChange}
                disabled={env.readOnly}
              />
            )}
          />
        </Field>
      </div>
    </Section>
  )
}
