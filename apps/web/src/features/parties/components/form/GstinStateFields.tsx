/**
 * GSTIN + state pair for customer / supplier forms (fields `gstin` and `state_code`). The GSTIN
 * is checked live (structure, state code and checksum, the same isValidGstin the contract uses);
 * a valid one sets the state and shows the PAN it contains, so the shopkeeper sees at once
 * whether the number was typed right.
 */
import { BadgeCheck } from 'lucide-react'
import { useEffect } from 'react'
import { Controller, useFormContext, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { getState, isValidGstin, panFromGstin, stateCodeFromGstin } from '@kadai/shared/gst'
import { Input, Select } from '@/components/ui'
import { langOf } from '../../lib/labels'
import { useStateOptions } from '../../lib/use-state-options'
import { PartyField } from './PartyField'

interface GstinStateValues {
  gstin: string
  state_code: string | null
}

export function GstinStateFields({
  onValidGstin,
  disabled,
}: {
  /** Called once each time the field holds a complete, valid GSTIN. */
  onValidGstin?: (gstin: string) => void
  disabled?: boolean
}) {
  const { t, i18n } = useTranslation('parties')
  const form = useFormContext<GstinStateValues>()
  const gstin = useWatch({ control: form.control, name: 'gstin' }) ?? ''
  const stateCode = useWatch({ control: form.control, name: 'state_code' })
  const stateOptions = useStateOptions()

  const normalized = gstin.replace(/\s/g, '').toUpperCase()
  const complete = normalized.length === 15
  const valid = complete && isValidGstin(normalized)
  const gstinState = valid ? stateCodeFromGstin(normalized) : null

  useEffect(() => {
    if (!valid || !gstinState) return
    if (form.getValues('state_code') !== gstinState) {
      form.setValue('state_code', gstinState, { shouldDirty: true, shouldValidate: true })
    }
    onValidGstin?.(normalized)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to a new valid GSTIN only
  }, [valid, normalized])

  const stateLabel = gstinState
    ? ((langOf(i18n.language) === 'ta'
        ? getState(gstinState)?.name_ta
        : getState(gstinState)?.name_en) ?? gstinState)
    : ''

  const hint = valid ? (
    <span className="inline-flex flex-wrap items-center gap-1 font-medium text-success">
      <BadgeCheck className="size-3.5" aria-hidden />
      {t('gst.valid', { pan: panFromGstin(normalized) ?? '' })}
      {gstinState === stateCode ? ` · ${t('gst.state_from_gstin', { state: stateLabel })}` : ''}
    </span>
  ) : normalized.length > 0 && !complete ? (
    t('gst.length', { count: normalized.length })
  ) : (
    t('gst.hint')
  )

  // A complete but wrong GSTIN is flagged while typing, not only on submit.
  const liveError = complete && !valid ? 'gstin' : undefined

  return (
    <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
      <PartyField name="gstin" label={t('fields.gstin')} optional hint={hint} error={liveError}>
        <Input
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          maxLength={15}
          placeholder="33ABCDE1234F1Z5"
          className="font-mono uppercase tracking-wide"
          disabled={disabled}
          {...form.register('gstin', {
            setValueAs: (v: unknown) =>
              typeof v === 'string' ? v.replace(/\s/g, '').toUpperCase() : v,
          })}
        />
      </PartyField>
      <PartyField name="state_code" label={t('fields.state')} hint={t('gst.state_hint')}>
        <Controller
          control={form.control}
          name="state_code"
          render={({ field }) => (
            <Select
              value={field.value ?? undefined}
              onValueChange={(v) => field.onChange(v)}
              options={stateOptions}
              placeholder={t('gst.state_placeholder')}
              disabled={disabled}
            />
          )}
        />
      </PartyField>
    </div>
  )
}
