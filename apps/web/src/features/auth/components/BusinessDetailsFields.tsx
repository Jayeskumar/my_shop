/**
 * Business step of signup / on-prem setup: name (+ Tamil name), state, GSTIN with live checksum
 * validation (state auto-filled from the GSTIN), GST registration type.
 */
import { BadgeCheck, Building, ReceiptIndianRupee, Store } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Controller, useFormContext, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import {
  ACTIVE_STATE_CODES,
  getState,
  isValidGstin,
  panFromGstin,
  stateCodeFromGstin,
  TAMIL_NADU_STATE_CODE,
} from '@kadai/shared/gst'
import { FormField, Input, RadioGroup, Select } from '@/components/ui'
import type { BusinessFormValues } from '../business-rules'

export function BusinessDetailsFields({ setup = false }: { setup?: boolean }) {
  const { t, i18n } = useTranslation(['auth', 'common'])
  const form = useFormContext<BusinessFormValues>()
  const gstin = useWatch({ control: form.control, name: 'gstin' }) ?? ''
  const stateCode = useWatch({ control: form.control, name: 'state_code' })
  const [stateFromGstin, setStateFromGstin] = useState<string | null>(null)
  const ta = i18n.language !== 'en'

  const stateOptions = useMemo(() => {
    const codes = [
      TAMIL_NADU_STATE_CODE,
      ...ACTIVE_STATE_CODES.filter((c) => c !== TAMIL_NADU_STATE_CODE),
    ]
    return codes.flatMap((code) => {
      const st = getState(code)
      if (!st) return []
      return [{ value: code, label: ta ? `${st.name_ta} · ${st.name_en}` : st.name_en }]
    })
  }, [ta])

  const normalized = gstin.trim().toUpperCase()
  const complete = normalized.length === 15
  const valid = complete && isValidGstin(normalized)

  // A valid GSTIN determines the state and implies a GST registration.
  useEffect(() => {
    if (!valid) return
    const code = stateCodeFromGstin(normalized)
    if (code && code !== form.getValues('state_code')) {
      form.setValue('state_code', code, { shouldValidate: true })
      setStateFromGstin(code)
    }
    if (form.getValues('gst_scheme') === 'unregistered')
      form.setValue('gst_scheme', 'regular', { shouldValidate: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to GSTIN changes only
  }, [valid, normalized])

  useEffect(() => {
    if (normalized === '' && form.getValues('gst_scheme') !== 'unregistered') {
      form.setValue('gst_scheme', 'unregistered')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to GSTIN changes only
  }, [normalized === ''])

  const gstinHint = valid ? (
    <span className="inline-flex items-center gap-1 font-medium text-success">
      <BadgeCheck className="size-3.5" />
      {t('signup.gstin_valid', { pan: panFromGstin(normalized) ?? '' })}
      {stateFromGstin && stateFromGstin === stateCode
        ? ` · ${t('signup.gstin_state_set', { state: (ta ? getState(stateFromGstin)?.name_ta : getState(stateFromGstin)?.name_en) ?? '' })}`
        : ''}
    </span>
  ) : (
    t('signup.gstin_hint')
  )

  return (
    <div className="grid gap-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <FormField
          name="business_name"
          label={t('signup.business_name')}
          required
          className="sm:col-span-2"
        >
          <Input
            size="lg"
            autoComplete="organization"
            placeholder={t('signup.business_name_placeholder')}
            startAdornment={<Store />}
            {...form.register('business_name')}
          />
        </FormField>
        <FormField
          name="business_name_ta"
          label={t('signup.business_name_ta')}
          optional
          className="sm:col-span-2"
        >
          <Input
            size="lg"
            lang="ta"
            placeholder={t('signup.business_name_ta_placeholder')}
            {...form.register('business_name_ta')}
          />
        </FormField>
        {setup ? (
          <>
            <FormField name="legal_name" label={t('setup.legal_name')} optional>
              <Input size="lg" startAdornment={<Building />} {...form.register('legal_name')} />
            </FormField>
            <FormField name="store_name" label={t('setup.store_name')} optional>
              <Input
                size="lg"
                placeholder={t('setup.store_name_placeholder')}
                {...form.register('store_name')}
              />
            </FormField>
          </>
        ) : null}
        <FormField name="state_code" label={t('signup.state')} required>
          <Controller
            control={form.control}
            name="state_code"
            render={({ field }) => (
              <Select
                size="lg"
                value={field.value}
                onValueChange={(v) => {
                  field.onChange(v)
                  setStateFromGstin(null)
                }}
                options={stateOptions}
              />
            )}
          />
        </FormField>
        <FormField name="gstin" label={t('signup.gstin')} optional hint={gstinHint}>
          <Input
            size="lg"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            maxLength={15}
            placeholder={t('signup.gstin_placeholder')}
            startAdornment={<ReceiptIndianRupee />}
            className="font-mono uppercase tracking-wider"
            {...form.register('gstin', {
              setValueAs: (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v),
            })}
            aria-invalid={complete && !valid ? true : undefined}
          />
        </FormField>
      </div>
      <FormField name="gst_scheme" label={t('signup.gst_scheme')}>
        <Controller
          control={form.control}
          name="gst_scheme"
          render={({ field }) => (
            <RadioGroup
              variant="cards"
              orientation="horizontal"
              value={field.value ?? null}
              onValueChange={field.onChange}
              aria-label={t('signup.gst_scheme')}
              options={[
                {
                  value: 'regular',
                  label: t('signup.scheme.regular'),
                  description: t('signup.scheme.regular_hint'),
                },
                {
                  value: 'composition',
                  label: t('signup.scheme.composition'),
                  description: t('signup.scheme.composition_hint'),
                },
                {
                  value: 'unregistered',
                  label: t('signup.scheme.unregistered'),
                  description: t('signup.scheme.unregistered_hint'),
                },
              ]}
            />
          )}
        />
      </FormField>
    </div>
  )
}
