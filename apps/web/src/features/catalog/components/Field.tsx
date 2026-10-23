/**
 * FormField that also translates the catalog contract's snake_case validation keys
 * (lib/messages.ts). Use it instead of FormField inside the catalog forms.
 */
import { get, useFormContext, useFormState, type FieldError } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { FormField, type FormFieldProps } from '@/components/ui'
import { catalogValidationText } from '../lib/messages'

export function Field({ name, error, ...props }: FormFieldProps) {
  // Re-render on language change.
  useTranslation()
  const form = useFormContext()
  const { errors } = useFormState({ control: form.control, ...(name ? { name } : {}) })
  const fieldError: FieldError | undefined = name
    ? (get(errors, name) as FieldError | undefined)
    : undefined
  const translated = catalogValidationText(error ?? fieldError?.message)
  return <FormField name={name} error={translated ?? error} {...props} />
}
