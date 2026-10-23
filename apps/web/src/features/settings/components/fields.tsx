/**
 * Field groups shared by the business and store forms: GSTIN with live check-character feedback
 * (and the state / PAN it encodes), the GST state select (Tamil Nadu and Puducherry first) and
 * the postal address with Tamil Nadu district suggestions.
 */
import { CheckCircle2, CircleAlert } from 'lucide-react'
import { useId } from 'react'
import { get, useFormContext, useWatch, type FieldValues, type Path } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { TAMIL_NADU_DISTRICTS } from '@kadai/shared/api/identity'
import { Input, Select } from '@/components/ui'
import { getLanguage } from '@/lib/i18n'
import type { AddressFormValues } from '../lib/forms'
import { cleanGstin, GSTIN_LENGTH, gstinStatus } from '../lib/gstin'
import { stateName, useStateOptions } from '../lib/states'
import { SettingsField } from './SettingsField'

/**
 * GSTIN input with live feedback. `onValid` fires with the normalised GSTIN, its state code and
 * PAN whenever the value becomes a valid GSTIN (forms derive the state / PAN from it).
 */
export function GstinField<V extends FieldValues>({
  name,
  label,
  hint,
  required,
  disabled,
  onValid,
}: {
  name: Path<V>
  label: string
  hint?: string
  required?: boolean
  disabled?: boolean
  onValid?: (info: { gstin: string; stateCode: string; pan: string | null }) => void
}) {
  const { t } = useTranslation('settings')
  const form = useFormContext<V>()
  const value = useWatch({ control: form.control, name }) as string | null | undefined
  const status = gstinStatus(value)
  // A submit-time error is shown by the field itself; live feedback would repeat it.
  const hasError = Boolean(get(form.formState.errors, name))
  const feedback = (() => {
    switch (status.kind) {
      case 'empty':
        return hint ? <span>{hint}</span> : null
      case 'typing':
        return <span>{t('gstin.typing', { count: status.length, total: GSTIN_LENGTH })}</span>
      case 'too_long':
        return <span className="text-danger">{t('gstin.too_long', { total: GSTIN_LENGTH })}</span>
      case 'state':
        return <span className="text-danger">{t('gstin.bad_state', { code: status.code })}</span>
      case 'format':
        return <span className="text-danger">{t('gstin.bad_format')}</span>
      case 'checksum':
        return (
          <span className="inline-flex items-center gap-1 text-danger">
            <CircleAlert className="size-3.5 shrink-0" aria-hidden />
            {t('gstin.bad_checksum')}
          </span>
        )
      case 'valid':
        return (
          <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-success">
            <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
            {t('gstin.valid', { state: stateName(status.stateCode) })}
            {status.pan ? <span className="text-muted-foreground">· PAN {status.pan}</span> : null}
          </span>
        )
    }
  })()
  const registration = form.register(name, {
    setValueAs: (v: unknown) => (typeof v === 'string' ? cleanGstin(v) : v),
    onChange: (e: { target: { value: string } }) => {
      const next = gstinStatus(e.target.value)
      if (next.kind === 'valid')
        onValid?.({ gstin: cleanGstin(e.target.value), stateCode: next.stateCode, pan: next.pan })
    },
  })
  return (
    <SettingsField name={name} label={label} required={required} optional={!required}>
      <div className="flex flex-col gap-1.5">
        <Input
          {...registration}
          disabled={disabled}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={20}
          placeholder="33AAAPL1234C1ZL"
          className="font-mono uppercase tracking-wide"
        />
        {feedback && !hasError ? (
          <p className="text-xs leading-relaxed text-muted-foreground" aria-live="polite">
            {feedback}
          </p>
        ) : null}
      </div>
    </SettingsField>
  )
}

/** Postal address (`address.*`); the state is a separate field next to it. */
export function AddressFields({
  disabled,
  prefix = 'address',
}: {
  disabled?: boolean
  prefix?: string
}) {
  const { t } = useTranslation('settings')
  const form = useFormContext<Record<string, AddressFormValues>>()
  const listId = `districts-${useId()}`
  const ta = getLanguage() === 'ta'
  const path = (k: keyof AddressFormValues) =>
    `${prefix}.${k}` as `${string}.${keyof AddressFormValues}`
  return (
    <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
      <SettingsField name={path('line1')} label={t('address.line1')} className="sm:col-span-2">
        <Input
          autoComplete="address-line1"
          placeholder={t('address.line1_placeholder')}
          disabled={disabled}
          {...form.register(path('line1'))}
        />
      </SettingsField>
      <SettingsField
        name={path('line2')}
        label={t('address.line2')}
        optional
        className="sm:col-span-2"
      >
        <Input
          autoComplete="address-line2"
          placeholder={t('address.line2_placeholder')}
          disabled={disabled}
          {...form.register(path('line2'))}
        />
      </SettingsField>
      <SettingsField name={path('city')} label={t('address.city')}>
        <Input
          autoComplete="address-level2"
          placeholder={t('address.city_placeholder')}
          disabled={disabled}
          {...form.register(path('city'))}
        />
      </SettingsField>
      <SettingsField
        name={path('district')}
        label={t('address.district')}
        hint={t('address.district_hint')}
      >
        <Input
          list={listId}
          autoComplete="off"
          disabled={disabled}
          {...form.register(path('district'))}
        />
      </SettingsField>
      <datalist id={listId}>
        {TAMIL_NADU_DISTRICTS.map((d) => (
          <option key={d.en} value={ta ? d.ta : d.en}>
            {ta ? d.en : d.ta}
          </option>
        ))}
      </datalist>
      <SettingsField name={path('pincode')} label={t('address.pincode')}>
        <Input
          inputMode="numeric"
          autoComplete="postal-code"
          maxLength={6}
          placeholder="625001"
          className="tabular-nums"
          disabled={disabled}
          {...form.register(path('pincode'))}
        />
      </SettingsField>
    </div>
  )
}

/** GST state select bound to a form field. */
export function StateSelectField<V extends FieldValues>({
  name,
  label,
  hint,
  disabled,
}: {
  name: Path<V>
  label: string
  hint?: string
  disabled?: boolean
}) {
  const form = useFormContext<V>()
  const options = useStateOptions()
  const value = useWatch({ control: form.control, name }) as string | null | undefined
  return (
    <SettingsField name={name} label={label} hint={hint} required>
      <Select
        value={value ?? null}
        onValueChange={(v) =>
          form.setValue(name, v as V[Path<V>], { shouldDirty: true, shouldValidate: true })
        }
        options={options}
        disabled={disabled}
      />
    </SettingsField>
  )
}
