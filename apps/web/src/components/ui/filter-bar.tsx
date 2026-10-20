/**
 * List page toolbar: debounced search + filter controls + actions.
 *
 *   <FilterBar
 *     search={{ value: q, onChange: setQ, placeholder: t('catalog:search') }}
 *     filters={<Select … />}
 *     onReset={hasFilters ? reset : undefined}
 *     actions={<Button>Export</Button>}
 *   />
 */
import { Search, X } from 'lucide-react'
import { forwardRef, useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { Button } from './button'
import { Input, type InputProps } from './input'

export function Toolbar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div role="toolbar" className={cn('flex flex-wrap items-center gap-2', className)} {...props} />
  )
}

export interface SearchInputProps extends Omit<InputProps, 'value' | 'onChange' | 'type'> {
  value: string
  /** Called after the user pauses typing (`delay` ms) or presses Enter. */
  onChange: (value: string) => void
  delay?: number
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { value, onChange, delay = 300, placeholder, className, onKeyDown, ...props },
  ref,
) {
  const { t } = useTranslation()
  const [text, setText] = useState(value)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(onChange)
  useEffect(() => {
    latest.current = onChange
  })
  useEffect(() => setText(value), [value])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const schedule = (next: string): void => {
    setText(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => latest.current(next.trim()), delay)
  }

  return (
    <Input
      ref={ref}
      type="search"
      value={text}
      placeholder={placeholder ?? t('misc.search_placeholder')}
      aria-label={typeof placeholder === 'string' ? placeholder : t('actions.search')}
      onChange={(e) => schedule(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          if (timer.current) clearTimeout(timer.current)
          latest.current(text.trim())
        } else if (e.key === 'Escape' && text) {
          e.preventDefault()
          schedule('')
        }
        onKeyDown?.(e)
      }}
      startAdornment={<Search />}
      endAdornment={
        text ? (
          <button
            type="button"
            aria-label={t('actions.clear')}
            className="pointer-events-auto rounded p-1 hover:bg-surface-2"
            onClick={() => {
              if (timer.current) clearTimeout(timer.current)
              setText('')
              latest.current('')
            }}
          >
            <X className="size-4" />
          </button>
        ) : undefined
      }
      className={cn('[&::-webkit-search-cancel-button]:hidden', className)}
      {...props}
    />
  )
})

export interface FilterBarProps {
  search?: { value: string; onChange: (value: string) => void; placeholder?: string }
  /** Filter controls (Select, DateRangePicker, Switch…). */
  filters?: ReactNode
  /** Shown when set: clears all filters. */
  onReset?: () => void
  actions?: ReactNode
  className?: string
}

export function FilterBar({ search, filters, onReset, actions, className }: FilterBarProps) {
  const { t } = useTranslation()
  return (
    <div
      className={cn(
        'flex flex-col gap-3 pb-4 lg:flex-row lg:items-center lg:justify-between',
        className,
      )}
    >
      <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        {search ? (
          <SearchInput
            value={search.value}
            onChange={search.onChange}
            placeholder={search.placeholder}
            wrapperClassName="sm:max-w-xs"
          />
        ) : null}
        {filters}
        {onReset ? (
          <Button variant="ghost" size="sm" onClick={onReset} leftIcon={<X />}>
            {t('actions.clear_filters')}
          </Button>
        ) : null}
      </div>
      {actions ? <Toolbar className="lg:justify-end">{actions}</Toolbar> : null}
    </div>
  )
}
