import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'

export interface WizardStepperProps {
  steps: { id: string; label: string }[]
  current: number
  /** Allow jumping back to completed steps. */
  onStepClick?: (index: number) => void
}

export function WizardStepper({ steps, current, onStepClick }: WizardStepperProps) {
  const { t } = useTranslation('auth')
  return (
    <nav
      aria-label={t('signup.step', { current: current + 1, total: steps.length })}
      className="mb-6"
    >
      <ol className="flex items-center gap-2">
        {steps.map((step, i) => {
          const done = i < current
          const active = i === current
          return (
            <li key={step.id} className="flex flex-1 items-center gap-2">
              <button
                type="button"
                disabled={!done || !onStepClick}
                onClick={() => onStepClick?.(i)}
                aria-current={active ? 'step' : undefined}
                className="flex min-w-0 items-center gap-2 rounded-md text-start disabled:cursor-default"
              >
                <span
                  className={cn(
                    'flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold transition-colors',
                    done && 'bg-primary text-primary-foreground',
                    active && 'bg-primary text-primary-foreground ring-4 ring-primary/20',
                    !done && !active && 'bg-surface-2 text-muted-foreground',
                  )}
                >
                  {done ? <Check className="size-4" strokeWidth={3} /> : i + 1}
                </span>
                <span
                  className={cn(
                    'hidden truncate text-sm font-medium sm:block',
                    active ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {step.label}
                </span>
              </button>
              {i < steps.length - 1 ? (
                <span
                  className={cn('h-0.5 flex-1 rounded-full', done ? 'bg-primary' : 'bg-surface-3')}
                  aria-hidden
                />
              ) : null}
            </li>
          )
        })}
      </ol>
      <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:hidden">
        {t('signup.step', { current: current + 1, total: steps.length })} · {steps[current]?.label}
      </p>
    </nav>
  )
}
