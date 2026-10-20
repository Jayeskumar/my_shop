/**
 * Plain numeric input with exact decimal handling. `scale` stores the value as an integer:
 * e.g. a discount percentage in basis points → `<NumberInput scale={100} decimals={2} suffix="%" />`
 * shows "12.5" and emits 1250. Without scale the value is the number shown (integers by default).
 */
import { forwardRef, useEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { formatScaled, parseScaled } from './input-parsing'
import { Input, type InputProps } from './input'

export interface NumberInputProps
  extends Omit<
    InputProps,
    'value' | 'defaultValue' | 'onChange' | 'type' | 'min' | 'max' | 'inputMode' | 'prefix'
  > {
  value: number | null | undefined
  onChange: (value: number | null) => void
  /** Fraction digits the user may type (default 0). */
  decimals?: number
  /** Power of ten the shown number is multiplied by to get the stored integer (e.g. 100 for bp). */
  scale?: 1 | 10 | 100 | 1000 | 10000
  min?: number
  max?: number
  allowNegative?: boolean
  suffix?: ReactNode
  prefix?: ReactNode
}

export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  { value, onChange, decimals = 0, scale = 1, min, max, allowNegative = false, suffix, prefix, className, onBlur, ...props },
  ref,
) {
  const [text, setText] = useState(() => (value == null ? '' : formatScaled(value, scale)))
  const [invalid, setInvalid] = useState(false)
  const lastEmitted = useRef<number | null | undefined>(value)

  useEffect(() => {
    if (value === lastEmitted.current) return
    lastEmitted.current = value
    setInvalid(false)
    setText(value == null ? '' : formatScaled(value, scale))
  }, [value, scale])

  const handleText = (raw: string): void => {
    const pattern = decimals > 0 ? /^-?\d*(\.\d*)?$/ : /^-?\d*$/
    if (!pattern.test(raw) || (!allowNegative && raw.includes('-'))) return
    const fraction = raw.split('.')[1]
    if (fraction !== undefined && fraction.length > decimals) return
    setText(raw)
    const parsed = parseScaled(raw, scale, decimals, allowNegative)
    const bad =
      raw !== '' && raw !== '-' &&
      (parsed === null || (min !== undefined && parsed < min) || (max !== undefined && parsed > max))
    setInvalid(bad)
    if (parsed !== lastEmitted.current) {
      lastEmitted.current = parsed
      onChange(parsed)
    }
  }

  const handleBlur = (event: FocusEvent<HTMLInputElement>): void => {
    if (lastEmitted.current != null && !invalid) setText(formatScaled(lastEmitted.current, scale))
    onBlur?.(event)
  }

  return (
    <Input
      ref={ref}
      type="text"
      inputMode={decimals > 0 ? 'decimal' : 'numeric'}
      autoComplete="off"
      value={text}
      onChange={(e) => handleText(e.target.value)}
      onBlur={handleBlur}
      startAdornment={prefix}
      endAdornment={suffix}
      className={cn('tabular-nums', className)}
      {...(invalid ? { 'aria-invalid': true } : {})}
      {...props}
    />
  )
})
