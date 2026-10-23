/**
 * FormField for settings forms: snake_case validation keys from the contract refinements and
 * server issues ('gstin', 'store_code', 'series_too_long' …) are translated at render time
 * (errors:validation.<key>, then settings:validation.<key>); zod tokens and other messages are
 * left to FormField.
 */
import { get, type FieldError, useFormContext } from 'react-hook-form'
import { FormField, type FormFieldProps } from '@/components/ui'
import { useValidationKeyText } from '../lib/messages'

export function SettingsField({ name, error, ...props }: FormFieldProps) {
  const keyText = useValidationKeyText()
  // Outside a FormProvider useFormContext() returns null.
  const form = useFormContext() as ReturnType<typeof useFormContext> | null
  const fieldError: FieldError | undefined =
    name && form ? (get(form.formState.errors, name) as FieldError | undefined) : undefined
  const raw = error ?? fieldError?.message
  const localized = keyText(raw)
  return <FormField name={name} error={localized ?? error} {...props} />
}
