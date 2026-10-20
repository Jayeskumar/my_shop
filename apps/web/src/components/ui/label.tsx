import * as LabelPrimitive from '@radix-ui/react-label'
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'

export interface LabelProps extends ComponentPropsWithoutRef<typeof LabelPrimitive.Root> {
  required?: boolean
  optional?: boolean
}

export const Label = forwardRef<ElementRef<typeof LabelPrimitive.Root>, LabelProps>(function Label(
  { className, required, optional, children, ...props },
  ref,
) {
  const { t } = useTranslation()
  return (
    <LabelPrimitive.Root
      ref={ref}
      className={cn(
        'text-sm font-medium leading-snug text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-60',
        className,
      )}
      {...props}
    >
      {children}
      {required ? (
        <span className="ms-0.5 text-danger" aria-hidden>
          *
        </span>
      ) : null}
      {optional ? (
        <span className="ms-1.5 text-xs font-normal text-muted-foreground">({t('misc.optional')})</span>
      ) : null}
    </LabelPrimitive.Root>
  )
})
