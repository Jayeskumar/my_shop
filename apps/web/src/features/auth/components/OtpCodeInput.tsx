/**
 * Six single-digit boxes for an OTP: auto-advance, Backspace goes back, arrow keys move, and a
 * pasted / autofilled code ("123456", "123 456", "Your OTP is 123456") fills every box.
 */
import { useRef, type ClipboardEvent, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'

export interface OtpCodeInputProps {
  value: string
  onChange: (value: string) => void
  /** Called once all digits are entered. */
  onComplete?: (value: string) => void
  length?: number
  disabled?: boolean
  invalid?: boolean
  autoFocus?: boolean
  'aria-describedby'?: string
}

export function OtpCodeInput({
  value,
  onChange,
  onComplete,
  length = 6,
  disabled,
  invalid,
  autoFocus,
  'aria-describedby': describedBy,
}: OtpCodeInputProps) {
  const { t } = useTranslation('auth')
  const refs = useRef<(HTMLInputElement | null)[]>([])
  const digits = Array.from({ length }, (_, i) => value[i] ?? '')

  const focus = (i: number): void => {
    const el = refs.current[Math.max(0, Math.min(length - 1, i))]
    el?.focus()
    el?.select()
  }

  const setDigits = (next: string, focusIndex?: number): void => {
    const clean = next.replace(/\D/g, '').slice(0, length)
    onChange(clean)
    if (focusIndex !== undefined) focus(focusIndex)
    if (clean.length === length) onComplete?.(clean)
  }

  const handleInput = (index: number, raw: string): void => {
    const typed = raw.replace(/\D/g, '')
    if (!typed) return
    if (typed.length > 1) {
      // SMS autofill / IME delivered several digits into one box.
      setDigits(value.slice(0, index) + typed, Math.min(length - 1, index + typed.length))
      return
    }
    // The value is a contiguous prefix: typing into a later empty box appends at the end.
    const chars = digits.slice()
    chars[index] = typed
    const next = chars.join('')
    setDigits(next, Math.min(next.length, length - 1))
  }

  const handleKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Backspace') {
      event.preventDefault()
      if (digits[index]) {
        const chars = digits.slice()
        chars[index] = ''
        onChange(chars.join(''))
      } else if (index > 0) {
        const chars = digits.slice()
        chars[index - 1] = ''
        onChange(chars.join(''))
        focus(index - 1)
      }
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      focus(index - 1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      focus(index + 1)
    }
  }

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>): void => {
    const text = event.clipboardData.getData('text')
    const match = text.match(new RegExp(`\\d{${length}}`)) ?? [text.replace(/\D/g, '')]
    const code = (match[0] ?? '').slice(0, length)
    if (!code) return
    event.preventDefault()
    setDigits(code, Math.min(length - 1, code.length))
  }

  return (
    <div className="flex justify-between gap-2 sm:gap-3" role="group" aria-label={t('otp.code')}>
      {digits.map((digit, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          type="text"
          inputMode="numeric"
          pattern="\d*"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={i === 0 ? length : 1}
          value={digit}
          disabled={disabled}
          autoFocus={autoFocus && i === 0}
          aria-label={t('otp.digit', { index: i + 1 })}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(e) => handleInput(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={handlePaste}
          onFocus={(e) => e.currentTarget.select()}
          className={cn(
            'h-14 w-full min-w-0 rounded-lg border border-input bg-surface text-center text-2xl font-semibold tabular-nums shadow-card sm:h-16',
            'focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25',
            'disabled:opacity-60 aria-[invalid=true]:border-danger',
          )}
        />
      ))}
    </div>
  )
}
