import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { useFormFieldControl } from './form-field'

/** Shared look of text-like controls (Input, Textarea, Select trigger, DatePicker…). */
export const fieldVariants = cva(
  [
    'w-full min-w-0 rounded-md border border-input bg-surface text-foreground shadow-card',
    'placeholder:text-muted-foreground/70 transition-[color,box-shadow,border-color]',
    'focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25',
    'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:opacity-70',
    'aria-[invalid=true]:border-danger aria-[invalid=true]:focus-visible:ring-danger/25',
    'read-only:bg-surface-2',
  ],
  {
    variants: {
      size: {
        // 16px text on phones avoids iOS zoom-on-focus; 14px from sm up.
        sm: 'h-8 px-2.5 text-sm',
        md: 'h-10 px-3 text-base sm:text-sm',
        lg: 'h-12 px-3.5 text-base',
        xl: 'h-14 px-4 text-lg font-medium',
      },
    },
    defaultVariants: { size: 'md' },
  },
)

export type FieldSize = NonNullable<VariantProps<typeof fieldVariants>['size']>

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
