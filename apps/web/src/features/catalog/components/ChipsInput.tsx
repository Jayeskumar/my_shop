/**
 * Free-text chips: type and press Enter / comma to add, Backspace on an empty field removes the
 * last chip. Used for search aliases (Tanglish words) and variant values.
 */
import { X } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useFormFieldControl } from '@/components/ui'
import { cn } from '@/lib/cn'

export interface ChipsInputProps {
  value: readonly string[]
  onChange: (next: string[]) => void
  placeholder?: string
  id?: string
  max?: number
  maxLength?: number
  disabled?: boolean
  /** Label of a chip (e.g. "Red · சிவப்பு"). */
  renderChip?: (value: string) => ReactNode
  'aria-label'?: string
  'aria-describedby'?: string
  className?: string
}

export function ChipsInput({
  value,
  onChange,
  placeholder,
  id,
  max = 60,
  maxLength = 60,
  disabled,
  renderChip,
  className,
  ...aria
}: ChipsInputProps) {
  const { t } = useTranslation('catalog')
  const [text, setText] = useState('')
  const control = useFormFieldControl({ id, 'aria-describedby': aria['aria-describedby'] })

  const add = (raw: string): void => {
    const parts = raw
      .split(/[,\n|]/)
      .map((p) => p.trim().slice(0, maxLength))
      .filter(Boolean)
    if (!parts.length) return
    const seen = new Set(value.map((v) => v.toLocaleLowerCase()))
    const next = [...value]
    for (const p of parts) {
      if (next.length >= max) break
      if (seen.has(p.toLocaleLowerCase())) continue
      seen.add(p.toLocaleLowerCase())
      next.push(p)
    }
    onChange(next)
    setText('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      add(text)
    } else if (e.key === 'Backspace' && text === '' && value.length) {
      onChange(value.slice(0, -1))
    }
  }

  return (
    <div
      className={cn(
        'flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-surface px-2 py-1.5 shadow-card',
        'focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25',
        disabled && 'cursor-not-allowed bg-surface-2 opacity-70',
        className,
      )}
    >
      {value.map((v) => (
        <span
          key={v}
          className="inline-flex max-w-full items-center gap-1 rounded-full bg-primary-soft py-1 pe-1 ps-2.5 text-sm text-primary-soft-foreground"
        >
          <span className="truncate">{renderChip ? renderChip(v) : v}</span>
          {!disabled ? (
            <button
              type="button"
              className="rounded-full p-0.5 hover:bg-primary/15"
              aria-label={t('chips.remove', { value: v })}
              onClick={() => onChange(value.filter((x) => x !== v))}
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </span>
      ))}
      <input
        {...control}
        aria-label={aria['aria-label']}
        value={text}
        disabled={disabled || value.length >= max}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => add(text)}
        onPaste={(e) => {
          const pasted = e.clipboardData.getData('text')
          if (/[,\n|]/.test(pasted)) {
            e.preventDefault()
            add(pasted)
          }
        }}
        placeholder={value.length ? undefined : placeholder}
        className="h-7 min-w-[8rem] flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground/70 sm:text-sm"
      />
    </div>
  )
}
