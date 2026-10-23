/**
 * Old balance carried over from the paper khata: which side (they owe the shop / the shop owes
 * them) + amount. Stored as one signed opening_balance_paise by the form's body builder.
 */
import { Controller, useFormContext } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { PartyType } from '@kadai/shared/enums'
import { MoneyInput, RadioGroup } from '@/components/ui'
import { PartyField } from './PartyField'

export interface OpeningBalanceValues {
  opening_side: 'due' | 'advance'
  opening_amount_paise: number | null
}

export function OpeningBalanceField({
  partyType,
  hint,
  disabled,
}: {
  partyType: PartyType
  hint?: string
  disabled?: boolean
}) {
  const { t } = useTranslation('parties')
  const form = useFormContext<OpeningBalanceValues>()
  const options =
    partyType === 'customer'
      ? [
          { value: 'due' as const, label: t('opening.customer_due') },
          { value: 'advance' as const, label: t('opening.customer_advance') },
        ]
      : [
          { value: 'due' as const, label: t('opening.supplier_due') },
          { value: 'advance' as const, label: t('opening.supplier_advance') },
        ]
  return (
    <fieldset className="grid gap-3 rounded-lg border border-border p-3 sm:p-4">
      <legend className="px-1 text-sm font-medium">{t('opening.title')}</legend>
      <Controller
        control={form.control}
        name="opening_side"
        render={({ field }) => (
          <RadioGroup
            value={field.value}
            onValueChange={field.onChange}
            options={options}
            orientation="horizontal"
            variant="cards"
            disabled={disabled}
            aria-label={t('opening.title')}
          />
        )}
      />
      <PartyField
        name="opening_amount_paise"
        label={t('opening.amount')}
        hint={hint ?? t('opening.hint')}
      >
        <Controller
          control={form.control}
          name="opening_amount_paise"
          render={({ field }) => (
            <MoneyInput
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              placeholder="0.00"
              disabled={disabled}
            />
          )}
        />
      </PartyField>
    </fieldset>
  )
}
