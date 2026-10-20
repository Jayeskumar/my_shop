/**
 * FormField = label + control + hint + error, wired for accessibility. Inside a react-hook-form
 * <FormProvider>, pass `name` and the field's error is read from the form state and localized
 * at render time (lib/validation.ts), so switching தமிழ் / English updates messages too.
 *
 *   <FormField name="phone" label={t('auth:login.identifier')} required>
 *     <Input {...register('phone')} inputMode="tel" />
 *   </FormField>
 *
 * Kadai inputs (Input, Textarea, MoneyInput, QtyInput, NumberInput, Select trigger, DatePicker,
 * Combobox) pick up id / aria-describedby / aria-invalid from the field context automatically.
 */
import {
  createContext,
  useContext,
  useId,
  type ReactNode,
} from 'react'
import { get, useFormContext, type FieldError } from 'react-hook-form'
import { cn } from '@/lib/cn'
import { localizeValidationMessage } from '@/lib/validation'
import { useTranslation } from 'react-i18next'
import { Label } from './label'

interface FormFieldContextValue {
  id: string
  describedBy: string | undefined
  invalid: boolean
  required: boolean
}

const FormFieldContext = createContext<FormFieldContextValue | null>(null)

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

export interface FormFieldProps {
  label?: ReactNode
  /** react-hook-form field name (dotted path) to read the error from. */
  name?: string
  /** Explicit error message (overrides the form state). */
  error?: string | null
  hint?: ReactNode
  required?: boolean
  /** Shows "(Optional)" after the label. */
  optional?: boolean
  /** Element at the right end of the label row (e.g. "Forgot password?"). */
  labelAction?: ReactNode
  /** Control id (default: generated). */
  id?: string
  className?: string
  /** Hide the label visually but keep it for screen readers. */
  hideLabel?: boolean
  children: ReactNode
}

export function FormField({
  label,
  name,
  error,
  hint,
  required = false,
  optional = false,
  labelAction,
  id,
  className,
  hideLabel,
  children,
}: FormFieldProps) {
  // Re-render on language change so localized errors update.
  useTranslation()
  const generated = useId()
  const controlId = id ?? `f-${generated}`
  // useFormContext() is null outside a FormProvider (fields can be used standalone).
  const form = useFormContext() as ReturnType<typeof useFormContext> | null
  const fieldError: FieldError | undefined =
    name && form ? (get(form.formState.errors, name) as FieldError | undefined) : undefined
  const rawMessage = error ?? fieldError?.message ?? (fieldError ? 'Invalid' : undefined)
  const message = localizeValidationMessage(rawMessage ?? undefined)

  const hintId = hint ? `${controlId}-hint` : undefined
  const errorId = message ? `${controlId}-error` : undefined
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined

  return (
    <FormFieldContext.Provider
      value={{ id: controlId, describedBy, invalid: Boolean(message), required }}
    >
      <div className={cn('flex flex-col gap-1.5', className)}>
        {label || labelAction ? (
          <div className={cn('flex items-center justify-between gap-2', hideLabel && 'sr-only')}>
            {label ? (
              <Label htmlFor={controlId} required={required} optional={optional}>
                {label}
              </Label>
            ) : (
              <span />
            )}
            {labelAction}
          </div>
        ) : null}
        {children}
        {message ? (
          <p id={errorId} role="alert" className="text-sm font-medium text-danger">
            {message}
          </p>
        ) : hint ? (
          <p id={hintId} className="text-xs leading-relaxed text-muted-foreground">
            {hint}
          </p>
        ) : null}
      </div>
    </FormFieldContext.Provider>
  )
}
