import * as SwitchPrimitive from '@radix-ui/react-switch'
import {
  forwardRef,
  useId,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactNode,
} from 'react'
import { cn } from '@/lib/cn'

export interface SwitchProps extends ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> {
  label?: ReactNode
  description?: ReactNode
  size?: 'md' | 'lg'
}

export const Switch = forwardRef<ElementRef<typeof SwitchPrimitive.Root>, SwitchProps>(
  function Switch({ className, label, description, size = 'md', id, ...props }, ref) {
    const generated = useId()
    const controlId = id ?? `sw-${generated}`
    const control = (
      <SwitchPrimitive.Root
        ref={ref}
        id={controlId}
        className={cn(
          'peer inline-flex shrink-0 items-center rounded-full border-2 border-transparent transition-colors',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          'data-[state=checked]:bg-primary data-[state=unchecked]:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50',
          size === 'lg' ? 'h-8 w-14' : 'h-6 w-11',
          className,
        )}
        {...props}
      >
        <SwitchPrimitive.Thumb
          className={cn(
            'pointer-events-none block rounded-full bg-white shadow-raised ring-0 transition-transform',
            size === 'lg'
              ? 'size-7 data-[state=checked]:translate-x-6 data-[state=unchecked]:translate-x-0'
              : 'size-5 data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0',
          )}
        />
      </SwitchPrimitive.Root>
    )
    if (!label) return control
    return (
      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-0.5">
          <label htmlFor={controlId} className="cursor-pointer text-sm font-medium leading-snug">
            {label}
          </label>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {control}
      </div>
    )
  },
)
