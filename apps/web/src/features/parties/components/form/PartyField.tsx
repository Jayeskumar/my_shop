/**
 * FormField for party forms. Contract refinements and server VALIDATION_ERROR issues carry
 * snake_case keys ('gstin', 'ifsc', 'vpa', 'pan_gstin_mismatch', 'allocations_exceed_amount' …);
 * this wrapper translates them at render time (errors:validation.<key>, then
 * parties:validation.<key>) so a language switch updates the message too. Other messages (zod
 * tokens, free text) are left to FormField.
 */
import { get, type FieldError, useFormContext } from 'react-hook-form'
import { FormField, type FormFieldProps } from '@/components/ui'
import { useValidationKeyText } from '../../lib/validation-text'

export function PartyField({ name, error, ...props }: FormFieldProps) {
  const keyText = useValidationKeyText()
  // Outside a FormProvider useFormContext() returns null.
  const form = useFormContext() as ReturnType<typeof useFormContext> | null
  const fieldError: FieldError | undefined =
    name && form ? (get(form.formState.errors, name) as FieldError | undefined) : undefined
  const raw = error ?? fieldError?.message
  const localized = keyText(raw)
  return <FormField name={name} error={localized ?? error} {...props} />
}
