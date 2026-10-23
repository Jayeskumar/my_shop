/**
 * Postal address block (`address.line1 … address.pincode`); the state comes from the GSTIN /
 * state field next to it. District suggests the Tamil Nadu districts in both languages.
 */
import { useId } from 'react'
import { useFormContext } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { TAMIL_NADU_DISTRICTS } from '@kadai/shared/api/identity'
import { Input } from '@/components/ui'
import type { AddressFormValues } from '../../lib/forms'
import { langOf } from '../../lib/labels'
import { PartyField } from './PartyField'

export function AddressFields({ disabled }: { disabled?: boolean }) {
  const { t, i18n } = useTranslation('parties')
  const form = useFormContext<{ address: AddressFormValues }>()
  const listId = `districts-${useId()}`
  const ta = langOf(i18n.language) === 'ta'
  return (
    <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
      <PartyField name="address.line1" label={t('fields.address_line1')} className="sm:col-span-2">
        <Input
          autoComplete="address-line1"
          placeholder={t('placeholders.address_line1')}
          disabled={disabled}
          {...form.register('address.line1')}
        />
      </PartyField>
      <PartyField name="address.line2" label={t('fields.address_line2')} className="sm:col-span-2">
        <Input
          autoComplete="address-line2"
          placeholder={t('placeholders.address_line2')}
          disabled={disabled}
          {...form.register('address.line2')}
        />
      </PartyField>
      <PartyField name="address.city" label={t('fields.city')}>
        <Input
          autoComplete="address-level2"
          placeholder={t('placeholders.city')}
          disabled={disabled}
          {...form.register('address.city')}
        />
      </PartyField>
      <PartyField name="address.district" label={t('fields.district')}>
        <Input
          list={listId}
          autoComplete="off"
          disabled={disabled}
          {...form.register('address.district')}
        />
      </PartyField>
      <datalist id={listId}>
        {TAMIL_NADU_DISTRICTS.map((d) => (
          <option key={d.en} value={ta ? d.ta : d.en}>
            {ta ? d.en : d.ta}
          </option>
        ))}
      </datalist>
      <PartyField name="address.pincode" label={t('fields.pincode')}>
        <Input
          inputMode="numeric"
          autoComplete="postal-code"
          maxLength={6}
          placeholder="625001"
          className="tabular-nums"
          disabled={disabled}
          {...form.register('address.pincode')}
        />
      </PartyField>
    </div>
  )
}
