/**
 * Vertical attributes (products.attributes, validated by @kadai/shared/verticals): pharmacy
 * drug details and schedule, apparel / footwear details, electronics warranty & serials,
 * grocery veg / non-veg marking and loose sale.
 */
import { Pill } from 'lucide-react'
import type { ReactNode } from 'react'
import { Controller } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Input, NumberInput, RadioGroup, Select, Switch } from '@/components/ui'
import type { TranslationKey } from '@/lib/i18n-resources'
import { translate } from '@/lib/i18n'
import { Field } from '../components/Field'
import { Section } from '../components/FormChrome'
import { ATTRIBUTE_FIELDS, type AttrField } from '../lib/attributes'
import type { AttributeValue } from '../lib/product-form'
import { useProductForm, useProductFormEnv } from './env'

const SCHEDULES = ['OTC', 'G', 'H', 'H1', 'X'] as const
const NONE = '__none'

const label = (key: string): string => translate(`catalog:attributes.${key}` as TranslationKey)
const optionLabel = (key: string, value: string): string =>
  translate(`catalog:attributes.options.${key}.${value}` as TranslationKey)

export function AttributesSection({ icon }: { icon: ReactNode }) {
  const { t } = useTranslation('catalog')
  const env = useProductFormEnv()
  const { control } = useProductForm()
  const fields = ATTRIBUTE_FIELDS[env.businessType]
  if (!fields.length) return null
  const title =
    env.businessType === 'pharmacy'
      ? t('form.sections.attributes_pharmacy')
      : t('form.sections.attributes')
  return (
    <Section
      id="attributes"
      icon={env.businessType === 'pharmacy' ? <Pill /> : icon}
      title={title}
      description={t('form.sections.attributes_hint')}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {fields.map((f) => (
          <Controller
            key={f.key}
            control={control}
            name={`attributes.${f.key}`}
            render={({ field }) => (
              <AttributeInput
                field={f}
                value={field.value as AttributeValue | undefined}
                onChange={field.onChange}
                disabled={env.readOnly}
              />
            )}
          />
        ))}
      </div>
    </Section>
  )
}

function AttributeInput({
  field: f,
  value,
  onChange,
  disabled,
}: {
  field: AttrField
  value: AttributeValue | undefined
  onChange: (v: AttributeValue) => void
  disabled: boolean
}) {
  const { t } = useTranslation('catalog')
  const name = `attributes.${f.key}`
  switch (f.kind) {
    case 'text':
      return (
        <Field
          name={name}
          label={label(f.key)}
          optional
          className={f.wide ? 'sm:col-span-2' : undefined}
        >
          <Input
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            maxLength={f.max}
            disabled={disabled}
          />
        </Field>
      )
    case 'int':
      return (
        <Field name={name} label={label(f.key)} optional>
          <NumberInput
            value={typeof value === 'number' ? value : null}
            onChange={(n) => onChange(n)}
            min={f.min}
            max={f.max}
            suffix={f.suffix ? t(`attributes.suffix_${f.suffix}`) : undefined}
            disabled={disabled}
          />
        </Field>
      )
    case 'enum':
      return (
        <Field name={name} label={label(f.key)} optional>
          <Select
            value={typeof value === 'string' ? value : NONE}
            onValueChange={(v) => onChange(v === NONE ? null : v)}
            disabled={disabled}
            options={[
              { value: NONE, label: t('attributes.not_set') },
              ...f.options.map((o) => ({ value: o, label: optionLabel(f.key, o) })),
            ]}
          />
        </Field>
      )
    case 'bool':
      return (
        <div className="grid content-center rounded-lg border border-border px-3 py-2.5">
          <Switch
            checked={value === true}
            onCheckedChange={(v) => onChange(v)}
            disabled={disabled}
            label={label(f.key)}
            description={translate(`catalog:attributes.hints.${f.key}` as TranslationKey)}
          />
        </div>
      )
    case 'veg':
      return (
        <Field name={name} label={label(f.key)} optional className="sm:col-span-2">
          <RadioGroup
            value={value === true ? 'veg' : value === false ? 'nonveg' : 'unset'}
            onValueChange={(v) => onChange(v === 'veg' ? true : v === 'nonveg' ? false : null)}
            orientation="horizontal"
            className="flex flex-wrap gap-x-5 gap-y-2"
            disabled={disabled}
            options={[
              {
                value: 'veg',
                label: t('attributes.veg_yes'),
                icon: (
                  <span className="inline-flex size-4 items-center justify-center border-2 border-success">
                    <span className="size-2 rounded-full bg-success" />
                  </span>
                ),
              },
              {
                value: 'nonveg',
                label: t('attributes.veg_no'),
                icon: (
                  <span className="inline-flex size-4 items-center justify-center border-2 border-danger">
                    <span className="size-2 rounded-full bg-danger" />
                  </span>
                ),
              },
              { value: 'unset', label: t('attributes.not_set') },
            ]}
          />
        </Field>
      )
    case 'schedule': {
      const current = typeof value === 'string' ? value : 'OTC'
      return (
        <Field
          name={name}
          label={label('schedule')}
          className="sm:col-span-2"
          hint={translate(`catalog:attributes.schedule_help.${current}` as TranslationKey)}
        >
          <RadioGroup
            value={current}
            onValueChange={(v) => onChange(v)}
            disabled={disabled}
            variant="cards"
            className="grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"
            options={SCHEDULES.map((s) => ({
              value: s,
              label:
                s === 'OTC'
                  ? t('attributes.options.schedule.OTC')
                  : t('attributes.schedule_label', { code: s }),
            }))}
          />
        </Field>
      )
    }
  }
}
