/**
 * Plain numeric input with exact decimal handling. `scale` stores the value as an integer:
 * e.g. a discount percentage in basis points → `<NumberInput scale={100} decimals={2} suffix="%" />`
 * shows "12.5" and emits 1250. Without scale the value is the number shown (integers by default).
 */
import { forwardRef, useEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
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

/** "12.5" with scale 100 → 1250 (string arithmetic, no float error). */
export function parseScaled(text: string, scale: number, decimals: number, allowNegative: boolean): number | null {
  const trimmed = text.trim()
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(trimmed)
  if (!m || trimmed === '' || trimmed === '-' || trimmed === '.') return null
  const [, sign, int = '', frac = ''] = m
  if (sign && !allowNegative) return null
  if (frac.length > decimals) return null
  if (int === '' && frac === '') return null
  const scaleDigits = Math.round(Math.log10(scale))
  if (scale === 1) {
    if (decimals === 0) {
      const n = Number(int || '0')
      return Number.isSafeInteger(n) ? (sign ? -n : n) : null
    }
    const n = Number(`${int || '0'}.${frac || '0'}`)
    return Number.isFinite(n) ? (sign ? -n : n) : null
  }
  if (frac.length > scaleDigits) return null
  const n = Number(int || '0') * scale + Number(frac.padEnd(scaleDigits, '0') || '0')
  if (!Number.isSafeInteger(n)) return null
  return sign ? -n : n
}

export function formatScaled(value: number, scale: number): string {
  if (scale === 1) return String(value)
  const digits = Math.round(Math.log10(scale))
  const abs = Math.abs(value)
  const whole = Math.trunc(abs / scale)
  const frac = abs % scale
  const fracText = frac === 0 ? '' : `.${String(frac).padStart(digits, '0').replace(/0+$/, '')}`
  return `${value < 0 ? '-' : ''}${whole}${fracText}`
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
