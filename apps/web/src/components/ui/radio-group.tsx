import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import { forwardRef, useId, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

export const RadioGroupRoot = forwardRef<
  ElementRef<typeof RadioGroupPrimitive.Root>,
  ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(function RadioGroupRoot({ className, ...props }, ref) {
  return <RadioGroupPrimitive.Root ref={ref} className={cn('grid gap-2', className)} {...props} />
})

export const RadioGroupItem = forwardRef<
  ElementRef<typeof RadioGroupPrimitive.Item>,
  ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(function RadioGroupItem({ className, ...props }, ref) {
  return (
    <RadioGroupPrimitive.Item
      ref={ref}
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-full border border-input bg-surface shadow-card',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-[state=checked]:border-primary',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="size-2.5 rounded-full bg-primary" />
    </RadioGroupPrimitive.Item>
  )
})

export interface RadioOption<V extends string = string> {
  value: V
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
  icon?: ReactNode
}

export interface RadioGroupProps<V extends string = string> {
  value: V | null | undefined
  onValueChange: (value: V) => void
  options: readonly RadioOption<V>[]
  /** 'list' = radio + label rows; 'cards' = selectable bordered tiles (touch friendly). */
  variant?: 'list' | 'cards'
  orientation?: 'vertical' | 'horizontal'
  name?: string
  disabled?: boolean
  className?: string
  'aria-label'?: string
  'aria-labelledby'?: string
}

export function RadioGroup<V extends string = string>({
  value,
  onValueChange,
  options,
  variant = 'list',
  orientation = 'vertical',
  name,
  disabled,
  className,
  ...aria
}: RadioGroupProps<V>) {
  const base = useId()
  return (
    <RadioGroupPrimitive.Root
      value={value ?? undefined}
      onValueChange={(v) => onValueChange(v as V)}
      name={name}
      disabled={disabled}
      orientation={orientation}
      className={cn(
        'grid gap-2',
        orientation === 'horizontal' && (variant === 'cards' ? 'sm:grid-flow-col sm:auto-cols-fr' : 'grid-flow-col auto-cols-max gap-6'),
        className,
      )}
      {...aria}
    >
      {options.map((o) => {
        const id = `${base}-${o.value}`
        if (variant === 'cards') {
          return (
            <label
              key={o.value}
              htmlFor={id}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-lg border border-input bg-surface p-3 shadow-card transition-colors',
                'hover:border-primary/60 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary-soft/60',
                o.disabled && 'cursor-not-allowed opacity-60',
              )}
            >
              <RadioGroupItem id={id} value={o.value} disabled={o.disabled} className="mt-0.5" />
              {o.icon ? <span className="text-primary [&_svg]:size-5">{o.icon}</span> : null}
              <span className="grid gap-0.5">
                <span className="text-sm font-semibold leading-snug">{o.label}</span>
                {o.description ? <span className="text-xs text-muted-foreground">{o.description}</span> : null}
              </span>
            </label>
          )
        }
        return (
          <div key={o.value} className="flex items-start gap-2.5">
            <RadioGroupItem id={id} value={o.value} disabled={o.disabled} className="mt-0.5" />
            <label htmlFor={id} className="grid cursor-pointer gap-0.5">
              <span className="text-sm font-medium leading-snug">{o.label}</span>
              {o.description ? <span className="text-xs text-muted-foreground">{o.description}</span> : null}
            </label>
          </div>
        )
      })}
    </RadioGroupPrimitive.Root>
  )
}
