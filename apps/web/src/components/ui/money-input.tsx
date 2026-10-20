/**
 * Rupee amount input. The value is integer PAISE (never floats); text is parsed with the shared
 * `tryParseRupees` and shown with Indian grouping on blur (1,23,456.50).
 *
 *   <MoneyInput value={field.value} onChange={field.onChange} />   // via RHF <Controller>
 */
import { forwardRef, useEffect, useRef, useState, type ClipboardEvent, type FocusEvent } from 'react'
import { tryParseRupees } from '@kadai/shared/money'
import { cn } from '@/lib/cn'
import { formatMoneyInputValue, moneyEditingText, parseMoneyText } from './input-parsing'
import { Input, type InputProps } from './input'

export interface MoneyInputProps
  extends Omit<InputProps, 'value' | 'defaultValue' | 'onChange' | 'type' | 'startAdornment' | 'inputMode'> {
  /** Paise; null/undefined = empty. */
  value: number | null | undefined
  onChange: (paise: number | null) => void
  /** Allow negative amounts (opening balances, adjustments). */
  allowNegative?: boolean
  /** Show the ₹ symbol inside the field (default true). */
  showSymbol?: boolean
}

const ALLOWED = /^-?[\d,]*(\.\d{0,2})?$/

export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(function MoneyInput(
  { value, onChange, allowNegative = false, showSymbol = true, onBlur, onFocus, className, ...props },
  ref,
) {
  const [text, setText] = useState(() => formatMoneyInputValue(value))
  const [invalid, setInvalid] = useState(false)
  const focused = useRef(false)
  const lastEmitted = useRef<number | null | undefined>(value)

  // External value changes (form reset, programmatic set) replace the text.
  useEffect(() => {
    if (value === lastEmitted.current) return
    lastEmitted.current = value
    setInvalid(false)
    setText(focused.current ? moneyEditingText(value) : formatMoneyInputValue(value))
  }, [value])

  const emit = (next: number | null): void => {
    if (next === lastEmitted.current) return
    lastEmitted.current = next
    onChange(next)
  }

  const handleText = (raw: string): void => {
    const candidate = raw.replace(/[^\d.,-]/g, '')
    if (!ALLOWED.test(candidate) || (!allowNegative && candidate.includes('-'))) return
    setText(candidate)
    const parsed = parseMoneyText(candidate, allowNegative)
    const isEmpty = candidate.replace(/[,-]/g, '') === ''
    setInvalid(!isEmpty && parsed === null)
    emit(parsed)
  }

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>): void => {
    // Accept "₹ 1,234.50", "Rs. 99", "500/-" from WhatsApp messages / spreadsheets.
    const pasted = event.clipboardData.getData('text')
    const parsed = tryParseRupees(pasted.trim(), { allowNegative })
    if (parsed !== null) {
      event.preventDefault()
      setInvalid(false)
      setText(moneyEditingText(parsed))
      emit(parsed)
    }
  }

  const handleFocus = (event: FocusEvent<HTMLInputElement>): void => {
    focused.current = true
    if (!invalid) setText(moneyEditingText(lastEmitted.current))
    onFocus?.(event)
    // Select all so the cashier can just type the new amount.
    const target = event.currentTarget
    requestAnimationFrame(() => {
      if (document.activeElement === target) target.select()
    })
  }

  const handleBlur = (event: FocusEvent<HTMLInputElement>): void => {
    focused.current = false
    const parsed = parseMoneyText(text, allowNegative)
    if (parsed !== null) {
      setInvalid(false)
      setText(formatMoneyInputValue(parsed))
      emit(parsed)
    } else if (text.replace(/[,-]/g, '').trim() === '') {
      setText('')
      setInvalid(false)
      emit(null)
    }
    onBlur?.(event)
  }

  return (
    <Input
      ref={ref}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={text}
      onChange={(e) => handleText(e.target.value)}
      onPaste={handlePaste}
      onFocus={handleFocus}
      onBlur={handleBlur}
      startAdornment={showSymbol ? <span className="text-[0.95em] font-medium">₹</span> : undefined}
      className={cn('text-end tabular-nums', className)}
      {...(invalid ? { 'aria-invalid': true } : {})}
      {...props}
    />
  )
})
