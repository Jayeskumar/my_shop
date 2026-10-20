/**
 * Quantity input in the product's base unit; the value is integer MILLI units (1.5 kg → 1500).
 * Decimals are accepted only for decimal units (KG, L, M, …) or when `allowDecimal` is set
 * (loose tablets, product.decimal_qty), using the shared units catalogue.
 *
 *   <QtyInput unit="KG" value={qtyMilli} onChange={setQtyMilli} size="xl" />
 */
import { Minus, Plus } from 'lucide-react'
import { forwardRef, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { getUnit, isDecimalUnit, milliToDecimalString } from '@kadai/shared/units'
import { cn } from '@/lib/cn'
import { getLanguage } from '@/lib/i18n'
import { parseQtyText } from './input-parsing'
import { Input, type InputProps } from './input'
import type { FieldSize } from './variants'

export interface QtyInputProps extends Omit<
  InputProps,
  | 'value'
  | 'defaultValue'
  | 'onChange'
  | 'type'
  | 'min'
  | 'max'
  | 'step'
  | 'endAdornment'
  | 'inputMode'
> {
  /** Milli units; null/undefined = empty. */
  value: number | null | undefined
  onChange: (qtyMilli: number | null) => void
  /** Unit code from the shared catalogue (PCS, KG, L, M, TAB, …). */
  unit: string
  /** Override the unit's default (e.g. loose tablets, product.decimal_qty). */
  allowDecimal?: boolean
  /** Stepper increment in milli (default 1 unit = 1000). */
  step?: number
  /** Minimum in milli (default 0 = zero allowed only if typed; steppers stop at it). */
  min?: number
  max?: number
  /** Show −/+ buttons (default true). */
  steppers?: boolean
  /** Show the unit symbol (default true). */
  showUnit?: boolean
}

const stepperSize: Record<FieldSize, string> = {
  sm: 'w-8 [&_svg]:size-3.5',
  md: 'w-10 [&_svg]:size-4',
  lg: 'w-12 [&_svg]:size-5',
  xl: 'w-14 [&_svg]:size-6',
}

export const QtyInput = forwardRef<HTMLInputElement, QtyInputProps>(function QtyInput(
  {
    value,
    onChange,
    unit,
    allowDecimal,
    step = 1000,
    min = 0,
    max,
    steppers = true,
    showUnit = true,
    size,
    className,
    disabled,
    onBlur,
    onKeyDown,
    ...props
  },
  ref,
) {
  const { t } = useTranslation()
  const decimals = allowDecimal ?? isDecimalUnit(unit)
  const [text, setText] = useState(() => (value == null ? '' : milliToDecimalString(value)))
  const [invalid, setInvalid] = useState(false)
  const lastEmitted = useRef<number | null | undefined>(value)

  useEffect(() => {
    if (value === lastEmitted.current) return
    lastEmitted.current = value
    setInvalid(false)
    setText(value == null ? '' : milliToDecimalString(value))
  }, [value])

  const emit = (next: number | null): void => {
    if (next === lastEmitted.current) return
    lastEmitted.current = next
    onChange(next)
  }

  const outOfRange = (milli: number): boolean => milli < min || (max !== undefined && milli > max)

  const handleText = (raw: string): void => {
    const pattern = decimals ? /^\d*(\.\d{0,3})?$/ : /^\d*$/
    if (!pattern.test(raw)) return
    setText(raw)
    const parsed = parseQtyText(raw, unit, { allowDecimal: decimals, min })
    setInvalid(raw !== '' && (parsed === null || outOfRange(parsed)))
    emit(parsed)
  }

  const bump = (direction: 1 | -1): void => {
    const current = lastEmitted.current ?? 0
    let next = current + direction * step
    if (next < min) next = min
    if (max !== undefined && next > max) next = max
    if (direction === -1 && next <= 0 && min > 0) next = min
    setInvalid(false)
    setText(milliToDecimalString(next))
    emit(next)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      bump(1)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      bump(-1)
    }
    onKeyDown?.(event)
  }

  const handleBlur = (event: FocusEvent<HTMLInputElement>): void => {
    const parsed = parseQtyText(text, unit, { allowDecimal: decimals, min })
    if (parsed !== null && !outOfRange(parsed)) setText(milliToDecimalString(parsed))
    onBlur?.(event)
  }

  const def = getUnit(unit)
  const symbol = def ? (getLanguage() === 'ta' ? def.symbol_ta : def.symbol_en_plural) : unit
  const s: FieldSize = size ?? 'md'

  const input = (
    <Input
      ref={ref}
      type="text"
      inputMode={decimals ? 'decimal' : 'numeric'}
      autoComplete="off"
      value={text}
      size={s}
      disabled={disabled}
      onChange={(e) => handleText(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      onFocus={(e) => e.currentTarget.select()}
      endAdornment={showUnit ? <span className="text-xs font-medium">{symbol}</span> : undefined}
      className={cn('text-end tabular-nums', steppers && 'rounded-none', className)}
      {...(invalid ? { 'aria-invalid': true } : {})}
      {...props}
    />
  )

  if (!steppers) return input

  const stepClass = cn(
    'flex shrink-0 items-center justify-center border border-input bg-surface-2 text-foreground transition-colors',
    'hover:bg-surface-3 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring',
    stepperSize[s],
  )
  const atMin = (value ?? 0) <= min
  const atMax = max !== undefined && (value ?? 0) >= max
  return (
    <div className="flex w-full items-stretch">
      <button
        type="button"
        tabIndex={-1}
        aria-label={t('actions.decrease')}
        className={cn(stepClass, 'rounded-s-md border-e-0')}
        disabled={disabled || atMin}
        onClick={() => bump(-1)}
      >
        <Minus />
      </button>
      {input}
      <button
        type="button"
        tabIndex={-1}
        aria-label={t('actions.increase')}
        className={cn(stepClass, 'rounded-e-md border-s-0')}
        disabled={disabled || atMax}
        onClick={() => bump(1)}
      >
        <Plus />
      </button>
    </div>
  )
})
