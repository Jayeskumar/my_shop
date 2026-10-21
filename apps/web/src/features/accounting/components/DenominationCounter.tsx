/**
 * Cash count by note: ₹2000 / 500 / 200 / 100 / 50 / 20 / 10 counts plus coins as an amount →
 * the counted total (denominationsTotalPaise, the same maths the server checks). Large steppers
 * for touch, Enter moves to the next row, ↑ / ↓ change the count — counting a drawer is quick
 * with one hand on the keypad.
 */
import { Minus, Plus } from 'lucide-react'
import { useRef, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DENOMINATION_NOTES,
  type DenominationNote,
  type DenominationsInput,
  denominationsTotalPaise,
} from '@kadai/shared/api/accounting'
import { IconButton, MoneyInput, NumberInput } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatMoney } from '@/lib/format'

const MAX_COUNT = 1_000_000

type NoteKey = `${DenominationNote}`

function countOf(value: DenominationsInput, note: DenominationNote): number {
  return value[String(note) as NoteKey] ?? 0
}

export interface DenominationCounterProps {
  value: DenominationsInput
  onChange: (next: DenominationsInput) => void
  /** Focus the first note on mount (dialogs). */
  autoFocus?: boolean
  disabled?: boolean
  className?: string
}

export function DenominationCounter({
  value,
  onChange,
  autoFocus,
  disabled,
  className,
}: DenominationCounterProps) {
  const { t } = useTranslation('accounting')
  const inputs = useRef<Array<HTMLInputElement | null>>([])
  const total = denominationsTotalPaise(value)

  const setCount = (note: DenominationNote, count: number | null): void => {
    const next = Math.min(MAX_COUNT, Math.max(0, count ?? 0))
    onChange({ ...value, [String(note) as NoteKey]: next })
  }

  const onKeyDown = (index: number, note: DenominationNote | null) => (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      inputs.current[index + 1]?.focus()
      inputs.current[index + 1]?.select()
    } else if (note !== null && e.key === 'ArrowUp') {
      e.preventDefault()
      setCount(note, countOf(value, note) + 1)
    } else if (note !== null && e.key === 'ArrowDown') {
      e.preventDefault()
      setCount(note, countOf(value, note) - 1)
    }
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div role="group" aria-label={t('denominations.label')} className="flex flex-col gap-1.5">
        {DENOMINATION_NOTES.map((note, index) => {
          const count = countOf(value, note)
          const label = t('denominations.note', { value: note })
          return (
            <div
              key={note}
              className="grid grid-cols-[4.25rem_minmax(0,1fr)_minmax(5.5rem,auto)] items-center gap-2"
            >
              <span className="rounded-md bg-surface-2 px-2 py-2 text-center text-sm font-semibold tabular-nums">
                ₹{note}
              </span>
              <div className="flex items-center gap-1">
                <IconButton
                  icon={<Minus />}
                  label={t('denominations.less', { value: note })}
                  variant="outline"
                  size="md"
                  tooltip={false}
                  disabled={disabled || count === 0}
                  onClick={() => setCount(note, count - 1)}
                  tabIndex={-1}
                />
                <NumberInput
                  ref={(el) => {
                    inputs.current[index] = el
                  }}
                  aria-label={label}
                  value={count === 0 ? null : count}
                  onChange={(n) => setCount(note, n)}
                  min={0}
                  max={MAX_COUNT}
                  placeholder="0"
                  autoFocus={autoFocus && index === 0}
                  disabled={disabled}
                  onKeyDown={onKeyDown(index, note)}
                  onFocus={(e) => e.currentTarget.select()}
                  className="h-10 min-w-0 text-center text-base font-medium"
                />
                <IconButton
                  icon={<Plus />}
                  label={t('denominations.more', { value: note })}
                  variant="outline"
                  size="md"
                  tooltip={false}
                  disabled={disabled}
                  onClick={() => setCount(note, count + 1)}
                  tabIndex={-1}
                />
              </div>
              <span
                className={cn(
                  'text-end text-sm tabular-nums',
                  count === 0 ? 'text-muted-foreground' : 'font-medium',
                )}
              >
                {formatMoney(count * note * 100, { decimals: 'auto' })}
              </span>
            </div>
          )
        })}
        <div className="grid grid-cols-[4.25rem_minmax(0,1fr)_minmax(5.5rem,auto)] items-center gap-2">
          <span className="rounded-md bg-surface-2 px-2 py-2 text-center text-xs font-semibold leading-tight">
            {t('denominations.coins_short')}
          </span>
          <MoneyInput
            ref={(el) => {
              inputs.current[DENOMINATION_NOTES.length] = el
            }}
            aria-label={t('denominations.coins')}
            value={value.coins ? value.coins : null}
            onChange={(paise) => onChange({ ...value, coins: paise ?? 0 })}
            disabled={disabled}
            onKeyDown={onKeyDown(DENOMINATION_NOTES.length, null)}
            className="h-10"
          />
          <span className="text-end text-sm tabular-nums text-muted-foreground">
            {formatMoney(value.coins ?? 0, { decimals: 'auto' })}
          </span>
        </div>
      </div>
      <div
        className="flex items-center justify-between rounded-lg bg-primary-soft px-3 py-2.5 text-primary-soft-foreground"
        aria-live="polite"
      >
        <span className="text-sm font-medium">{t('denominations.total')}</span>
        <span className="text-xl font-semibold tabular-nums" data-testid="denomination-total">
          {formatMoney(total)}
        </span>
      </div>
    </div>
  )
}
