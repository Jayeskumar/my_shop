/** Context linking a FormField's label/hint/error to its control (ids + aria attributes). */
import { createContext, useContext } from 'react'

export interface FormFieldContextValue {
  id: string
  describedBy: string | undefined
  invalid: boolean
  required: boolean
}

export const FormFieldContext = createContext<FormFieldContextValue | null>(null)

export interface FieldControlProps {
  id?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
  'aria-required'?: boolean
}

/**
 * Accessibility props for a control rendered inside a FormField. Explicit props win over the
 * context values.
 */
export function useFormFieldControl(own: FieldControlProps = {}): FieldControlProps {
  const ctx = useContext(FormFieldContext)
  if (!ctx) return own
  return {
    id: own.id ?? ctx.id,
    'aria-describedby': own['aria-describedby'] ?? ctx.describedBy,
    'aria-invalid': own['aria-invalid'] ?? (ctx.invalid || undefined),
    'aria-required': own['aria-required'] ?? (ctx.required || undefined),
  }
}
