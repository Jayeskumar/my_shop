/**
 * FormField for the payments forms: contract refinements and server VALIDATION_ERROR issues
 * carry snake_case keys ('vpa_invalid', 'utr_invalid', 'allocations_exceed_amount' …); this
 * wrapper translates them at render time. Other messages (zod tokens, free text) are left to
 * FormField, which localizes them itself.
 */
import { get, type FieldError, useFormContext } from 'react-hook-form'
import { FormField, type FormFieldProps } from '@/components/ui'
import { useValidationKeyText } from '../lib/validation-text'

export function PaymentsField({ name, error, ...props }: FormFieldProps) {
  const keyText = useValidationKeyText()
  // Outside a FormProvider useFormContext() returns null.
  const form = useFormContext() as ReturnType<typeof useFormContext> | null
  const fieldError: FieldError | undefined =
    name && form ? (get(form.formState.errors, name) as FieldError | undefined) : undefined
  const raw = error ?? fieldError?.message
  const localized = keyText(raw)
  return <FormField name={name} error={localized ?? error} {...props} />
}
