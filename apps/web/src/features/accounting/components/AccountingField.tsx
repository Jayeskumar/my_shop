/**
 * FormField for accounting forms. Contract refinements and server VALIDATION_ERROR issues carry
 * snake_case keys ('journal_unbalanced', 'reason_required', 'supplier_required_for_credit' …);
 * this wrapper translates them at render time (errors:validation.<key>, then
 * accounting:validation.<key>) so a language switch updates the message too. Other messages
 * (zod tokens, free text) are left to FormField.
 */
import { get, type FieldError, useFormContext } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { FormField, type FormFieldProps } from '@/components/ui'
import { validationText } from '../lib/errors'

export function AccountingField({ name, error, ...props }: FormFieldProps) {
  // Re-render on language change.
  useTranslation('accounting')
  // Outside a FormProvider useFormContext() returns null.
  const form = useFormContext() as ReturnType<typeof useFormContext> | null
  const fieldError: FieldError | undefined =
    name && form ? (get(form.formState.errors, name) as FieldError | undefined) : undefined
  const raw = error ?? fieldError?.message
  return <FormField name={name} error={raw ? (validationText(raw) ?? raw) : error} {...props} />
}
