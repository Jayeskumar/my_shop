import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { Check, Minus } from 'lucide-react'
import {
  forwardRef,
  useId,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactNode,
} from 'react'
import { cn } from '@/lib/cn'

export interface CheckboxProps extends ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root> {
  /** Optional inline label (clickable). */
  label?: ReactNode
  description?: ReactNode
}

export const Checkbox = forwardRef<ElementRef<typeof CheckboxPrimitive.Root>, CheckboxProps>(
  function Checkbox({ className, label, description, id, ...props }, ref) {
    const generated = useId()
    const controlId = id ?? `cb-${generated}`
    const box = (
      <CheckboxPrimitive.Root
        ref={ref}
        id={controlId}
        className={cn(
          'peer flex size-5 shrink-0 items-center justify-center rounded-[5px] border border-input bg-surface shadow-card',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          'data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
          'data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      >
        <CheckboxPrimitive.Indicator className="flex items-center justify-center">
          {props.checked === 'indeterminate' ? (
            <Minus className="size-3.5" strokeWidth={3} />
          ) : (
            <Check className="size-3.5" strokeWidth={3} />
          )}
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
    )
    if (!label) return box
    return (
      <div className="flex items-start gap-2.5">
        <div className="pt-0.5">{box}</div>
        <div className="grid gap-0.5">
          <label
            htmlFor={controlId}
            className="cursor-pointer text-sm font-medium leading-snug peer-disabled:opacity-60"
          >
            {label}
          </label>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
      </div>
    )
  },
)
