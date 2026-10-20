import type { VariantProps } from 'class-variance-authority'
import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { useFormFieldControl } from './form-field-context'
import { fieldVariants, type FieldSize } from './variants'


export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>,
    VariantProps<typeof fieldVariants> {
  /** Content inside the border on the left (icon, "₹", "+91"). */
  startAdornment?: ReactNode
  /** Content inside the border on the right (unit, clear button, show-password toggle). */
  endAdornment?: ReactNode
  /** Classes for the wrapper when adornments are used. */
  wrapperClassName?: string
}

const adornmentPadding: Record<FieldSize, { start: string; end: string }> = {
  sm: { start: 'ps-8', end: 'pe-8' },
  md: { start: 'ps-10', end: 'pe-10' },
  lg: { start: 'ps-11', end: 'pe-11' },
  xl: { start: 'ps-12', end: 'pe-12' },
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    className,
    size,
    startAdornment,
    endAdornment,
    wrapperClassName,
    id,
    type = 'text',
    'aria-describedby': describedBy,
    'aria-invalid': ariaInvalid,
    ...props
  },
  ref,
) {
  const control = useFormFieldControl({
    id,
    'aria-describedby': describedBy,
    'aria-invalid': ariaInvalid === undefined ? undefined : ariaInvalid === true || ariaInvalid === 'true',
  })
  const s: FieldSize = size ?? 'md'
  const input = (
    <input
      ref={ref}
      type={type}
      className={cn(
        fieldVariants({ size: s }),
        startAdornment ? adornmentPadding[s].start : undefined,
        endAdornment ? adornmentPadding[s].end : undefined,
        className,
      )}
      {...control}
      {...props}
    />
  )
  if (!startAdornment && !endAdornment) return input
  return (
    <div className={cn('relative flex w-full items-center', wrapperClassName)}>
      {startAdornment ? (
        <span className="pointer-events-none absolute inset-y-0 start-0 flex min-w-10 items-center justify-center ps-1 text-muted-foreground [&_svg]:size-4">
          {startAdornment}
        </span>
      ) : null}
      {input}
      {endAdornment ? (
        <span className="absolute inset-y-0 end-0 flex min-w-10 items-center justify-center pe-1 text-muted-foreground [&_svg]:size-4">
          {endAdornment}
        </span>
      ) : null}
    </div>
  )
})
