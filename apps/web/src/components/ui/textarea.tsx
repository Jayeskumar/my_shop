import { forwardRef, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'
import { useFormFieldControl } from './form-field-context'

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, id, rows = 3, 'aria-describedby': describedBy, ...props },
  ref,
) {
  const control = useFormFieldControl({ id, 'aria-describedby': describedBy })
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(
        'w-full min-w-0 rounded-md border border-input bg-surface px-3 py-2 text-base text-foreground shadow-card sm:text-sm',
        'placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25',
        'disabled:cursor-not-allowed disabled:opacity-70 aria-[invalid=true]:border-danger',
        className,
      )}
      {...control}
      {...props}
    />
  )
})
