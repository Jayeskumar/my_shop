/**
 * Business date picker. The value is 'YYYY-MM-DD' (or null); the field shows and accepts
 * dd-MM-yyyy (also dd/MM/yyyy, dd.MM.yyyy) so dates can be typed quickly, and the calendar
 * button opens the browser's native date picker (good on Android and desktop alike).
 */
import { CalendarDays } from 'lucide-react'
import { forwardRef, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { compareDates, formatDateDisplay, isDateStr, parseDisplayDate } from '@kadai/shared/fy'
import { cn } from '@/lib/cn'
import { useFormFieldControl } from './form-field'
import { fieldVariants, type FieldSize } from './input'

export interface DatePickerProps {
  value: string | null | undefined
  onChange: (value: string | null) => void
  min?: string
  max?: string
  placeholder?: string
  size?: FieldSize
  disabled?: boolean
  id?: string
  name?: string
  className?: string
  'aria-label'?: string
  onBlur?: () => void
}

function inRange(date: string, min?: string, max?: string): boolean {
  if (min && compareDates(date, min) < 0) return false
  if (max && compareDates(date, max) > 0) return false
  return true
}

export const DatePicker = forwardRef<HTMLInputElement, DatePickerProps>(function DatePicker(
  { value, onChange, min, max, placeholder, size = 'md', disabled, id, name, className, onBlur, ...aria },
  ref,
) {
  const { t } = useTranslation()
  const control = useFormFieldControl({ id })
  const nativeRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState(() => (value && isDateStr(value) ? formatDateDisplay(value) : ''))
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    setText(value && isDateStr(value) ? formatDateDisplay(value) : '')
    setInvalid(false)
  }, [value])

  const commit = (): void => {
    const trimmed = text.trim()
    if (trimmed === '') {
      setInvalid(false)
      if (value !== null) onChange(null)
      return
    }
    const parsed = parseDisplayDate(trimmed)
    if (parsed && inRange(parsed, min, max)) {
      setInvalid(false)
      setText(formatDateDisplay(parsed))
      if (parsed !== value) onChange(parsed)
    } else {
      setInvalid(true)
    }
  }

  const openNative = (): void => {
    const el = nativeRef.current
    if (!el || disabled) return
    try {
      el.showPicker()
    } catch {
      el.focus()
      el.click()
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') commit()
    if (event.key === 'ArrowDown' && event.altKey) {
      event.preventDefault()
      openNative()
    }
  }

  return (
    <div className={cn('relative flex w-full items-center', className)}>
      <input
        ref={ref}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        name={name}
        disabled={disabled}
        value={text}
        placeholder={placeholder ?? t('dates.date_hint')}
        onChange={(e) => setText(e.target.value.replace(/[^\d/.-]/g, '').slice(0, 10))}
        onBlur={() => {
          commit()
          onBlur?.()
        }}
        onKeyDown={onKeyDown}
        className={cn(fieldVariants({ size }), 'pe-11 tabular-nums')}
        {...control}
        {...(invalid ? { 'aria-invalid': true } : {})}
        {...aria}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        aria-label={t('actions.open_calendar')}
        onClick={openNative}
        className="absolute inset-y-0 end-0 flex w-10 items-center justify-center rounded-e-md text-muted-foreground hover:text-primary disabled:opacity-50"
      >
        <CalendarDays className="size-4" />
      </button>
      {/* Native picker anchored under the button; only used for its calendar UI. */}
      <input
        ref={nativeRef}
        type="date"
        tabIndex={-1}
        aria-hidden
        min={min}
        max={max}
        value={value ?? ''}
        onChange={(e) => {
          const next = e.target.value
          if (next && isDateStr(next)) onChange(next)
        }}
        className="pointer-events-none absolute bottom-0 end-0 h-0 w-10 opacity-0"
      />
    </div>
  )
})
