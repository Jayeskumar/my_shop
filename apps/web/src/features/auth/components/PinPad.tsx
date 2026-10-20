import { Delete, X } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'

export interface PinPadProps {
  value: string
  onChange: (value: string) => void
  onSubmit?: () => void
  maxLength?: number
  minLength?: number
  disabled?: boolean
  /** Shake animation on wrong PIN. */
  error?: boolean
  /** Listen to the physical keyboard (digits, Backspace, Enter). Default true. */
  keyboard?: boolean
}

/** Large touch keypad with PIN dots (4–6 digits). */
export function PinPad({
  value,
  onChange,
  onSubmit,
  maxLength = 6,
  minLength = 4,
  disabled,
  error,
  keyboard = true,
}: PinPadProps) {
  const { t } = useTranslation('auth')

  const press = (digit: string): void => {
    if (disabled || value.length >= maxLength) return
    onChange(value + digit)
  }
  const back = (): void => {
    if (!disabled) onChange(value.slice(0, -1))
  }

  useEffect(() => {
    if (!keyboard) return
    const onKey = (event: KeyboardEvent): void => {
      if (disabled) return
      if (/^\d$/.test(event.key)) {
        event.preventDefault()
        if (value.length < maxLength) onChange(value + event.key)
      } else if (event.key === 'Backspace') {
        event.preventDefault()
        onChange(value.slice(0, -1))
      } else if (event.key === 'Enter' && value.length >= minLength) {
        event.preventDefault()
        onSubmit?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [keyboard, disabled, value, maxLength, minLength, onChange, onSubmit])

  const keyClass =
    'flex h-16 items-center justify-center rounded-xl border border-border bg-surface text-2xl font-semibold shadow-card transition-colors active:bg-primary-soft hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 sm:h-[4.5rem]'

  return (
    <div className="flex flex-col items-center gap-6">
      <div
        className={cn('flex h-6 items-center gap-3', error && 'animate-shake')}
        aria-label={t('pin.pin')}
        role="img"
        aria-roledescription={`${value.length}/${maxLength}`}
      >
        {Array.from({ length: Math.max(minLength, Math.min(maxLength, Math.max(value.length, minLength))) }, (_, i) => (
          <span
            key={i}
            className={cn(
              'size-4 rounded-full border-2 transition-colors',
              i < value.length ? (error ? 'border-danger bg-danger' : 'border-primary bg-primary') : 'border-input',
            )}
          />
        ))}
      </div>
      <div className="grid w-full max-w-xs grid-cols-3 gap-3">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} type="button" className={keyClass} disabled={disabled} onClick={() => press(d)}>
            {d}
          </button>
        ))}
        <button type="button" className={cn(keyClass, 'text-base')} disabled={disabled || !value} onClick={() => onChange('')} aria-label={t('pin.clear')}>
          <X className="size-6" />
        </button>
        <button type="button" className={keyClass} disabled={disabled} onClick={() => press('0')}>
          0
        </button>
        <button type="button" className={keyClass} disabled={disabled || !value} onClick={back} aria-label={t('pin.backspace')}>
          <Delete className="size-6" />
        </button>
      </div>
    </div>
  )
}
