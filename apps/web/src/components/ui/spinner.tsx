import { cva, type VariantProps } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'

const spinnerVariants = cva('animate-spin shrink-0', {
  variants: {
    size: { xs: 'size-3', sm: 'size-4', md: 'size-5', lg: 'size-8', xl: 'size-12' },
  },
  defaultVariants: { size: 'md' },
})

export interface SpinnerProps extends VariantProps<typeof spinnerVariants> {
  className?: string
  /** Accessible label; omit when a visible text already says "loading". */
  label?: string
}

export function Spinner({ size, className, label }: SpinnerProps) {
  const { t } = useTranslation()
  // label="" = decorative (e.g. inside a button that already says what is happening)
  if (label === '') {
    return <Loader2 aria-hidden className={cn(spinnerVariants({ size }), className)} />
  }
  return (
    <Loader2
      role="status"
      aria-label={label ?? t('a11y.loading')}
      className={cn(spinnerVariants({ size }), className)}
    />
  )
}

/** Full-area centred loader (route transitions, first load). */
export function PageSpinner({ label, className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex min-h-[40vh] flex-col items-center justify-center gap-3', className)}>
      <Spinner size="lg" className="text-primary" label={label} />
      {label ? <p className="text-sm text-muted-foreground">{label}</p> : null}
    </div>
  )
}
