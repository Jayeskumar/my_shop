/**
 * Select (Radix). Simple form: `<Select value onValueChange options placeholder />`.
 * Primitives (SelectRoot, SelectTrigger, SelectContent, SelectItem, SelectGroup, SelectLabel,
 * SelectSeparator) are exported for custom layouts.
 *
 * Radix forbids an empty-string item value; use `null`-able values in your form and map them.
 */
import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { useFormFieldControl } from './form-field-context'
import { fieldVariants, type FieldSize } from './variants'

export const SelectRoot = SelectPrimitive.Root
export const SelectGroup = SelectPrimitive.Group
export const SelectValue = SelectPrimitive.Value

export interface SelectTriggerProps extends ComponentPropsWithoutRef<
  typeof SelectPrimitive.Trigger
> {
  size?: FieldSize
}

export const SelectTrigger = forwardRef<
  ElementRef<typeof SelectPrimitive.Trigger>,
  SelectTriggerProps
>(function SelectTrigger({ className, children, size = 'md', id, ...props }, ref) {
  const control = useFormFieldControl({ id, 'aria-describedby': props['aria-describedby'] })
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(
        fieldVariants({ size }),
        'flex items-center justify-between gap-2 text-start data-[placeholder]:text-muted-foreground/80 [&>span]:truncate',
        className,
      )}
      {...control}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 shrink-0 opacity-60" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
})

export const SelectContent = forwardRef<
  ElementRef<typeof SelectPrimitive.Content>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(function SelectContent({ className, children, position = 'popper', ...props }, ref) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        className={cn(
          'relative z-50 max-h-[min(24rem,var(--radix-select-content-available-height))] min-w-[8rem] overflow-hidden rounded-lg border border-border bg-surface text-foreground shadow-overlay',
          'data-[state=open]:animate-pop-in',
          position === 'popper' && 'w-[var(--radix-select-trigger-width)] translate-y-1',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center">
          <ChevronUp className="size-4" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center">
          <ChevronDown className="size-4" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
})

export const SelectLabel = forwardRef<
  ElementRef<typeof SelectPrimitive.Label>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(function SelectLabel({ className, ...props }, ref) {
  return (
    <SelectPrimitive.Label
      ref={ref}
      className={cn('px-2 py-1.5 text-xs font-semibold text-muted-foreground', className)}
      {...props}
    />
  )
})

export const SelectItem = forwardRef<
  ElementRef<typeof SelectPrimitive.Item>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Item> & { description?: ReactNode }
>(function SelectItem({ className, children, description, ...props }, ref) {
  return (
    <SelectPrimitive.Item
      ref={ref}
      className={cn(
        'relative flex w-full cursor-default select-none items-start gap-2 rounded-md py-2 ps-8 pe-2 text-sm outline-none',
        'data-[highlighted]:bg-primary-soft data-[highlighted]:text-primary-soft-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <span className="absolute start-2 top-2.5 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <span className="flex min-w-0 flex-col">
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        {description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
      </span>
    </SelectPrimitive.Item>
  )
})

export const SelectSeparator = forwardRef<
  ElementRef<typeof SelectPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(function SelectSeparator({ className, ...props }, ref) {
  return (
    <SelectPrimitive.Separator
      ref={ref}
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  )
})

export interface SelectOption<V extends string = string> {
  value: V
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
}

export interface SelectProps<V extends string = string> {
  value: V | null | undefined
  onValueChange: (value: V) => void
  options: readonly SelectOption<V>[]
  placeholder?: ReactNode
  size?: FieldSize
  disabled?: boolean
  name?: string
  id?: string
  className?: string
  contentClassName?: string
  'aria-label'?: string
}

export function Select<V extends string = string>({
  value,
  onValueChange,
  options,
  placeholder,
  size,
  disabled,
  name,
  id,
  className,
  contentClassName,
  'aria-label': ariaLabel,
}: SelectProps<V>) {
  const { t } = useTranslation()
  return (
    <SelectPrimitive.Root
      value={value ?? ''}
      onValueChange={(v) => onValueChange(v as V)}
      disabled={disabled}
      name={name}
    >
      <SelectTrigger id={id} size={size} className={className} aria-label={ariaLabel}>
        <SelectPrimitive.Value placeholder={placeholder ?? t('misc.select_placeholder')} />
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        {options.map((o) => (
          <SelectItem
            key={o.value}
            value={o.value}
            disabled={o.disabled}
            description={o.description}
          >
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectPrimitive.Root>
  )
}
