/**
 * Searchable select (cmdk + Radix Popover) for products, customers, suppliers…
 *
 * Async (server search, debounced, previous requests aborted):
 *   <Combobox value={customer} onChange={setCustomer}
 *     loadOptions={(q, signal) => api.get<ListEnvelope<Customer>>('/customers', { query: { q, limit: 20 }, signal }).then((r) => r.data)}
 *     getOptionValue={(c) => c.id} getOptionLabel={(c) => c.name}
 *     renderOption={(c) => <CustomerRow c={c} />} onCreate={(q) => openNewCustomer(q)} />
 *
 * Static: pass `options` instead of `loadOptions` (filtered locally by label).
 * Keyboard: type to search, ↑/↓ to move, Enter to pick, Esc to close.
 */
import { Command } from 'cmdk'
import { Check, ChevronsUpDown, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { describeError } from '@/lib/errors'
import { useFormFieldControl } from './form-field-context'
import { fieldVariants, type FieldSize } from './variants'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { Spinner } from './spinner'

export interface ComboboxProps<T> {
  value: T | null | undefined
  onChange: (value: T | null) => void
  loadOptions?: (query: string, signal: AbortSignal) => Promise<readonly T[]>
  options?: readonly T[]
  getOptionValue: (option: T) => string
  getOptionLabel: (option: T) => string
  renderOption?: (option: T) => ReactNode
  renderValue?: (option: T) => ReactNode
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: ReactNode
  /** Characters needed before searching (async). Default 0 = load suggestions on open. */
  minQueryLength?: number
  debounceMs?: number
  disabled?: boolean
  clearable?: boolean
  size?: FieldSize
  /** Offer "Add “query”" when nothing matches. */
  onCreate?: (query: string) => void
  id?: string
  className?: string
  'aria-label'?: string
}

export function Combobox<T>({
  value,
  onChange,
  loadOptions,
  options,
  getOptionValue,
  getOptionLabel,
  renderOption,
  renderValue,
  placeholder,
  searchPlaceholder,
  emptyText,
  minQueryLength = 0,
  debounceMs = 200,
  disabled,
  clearable = true,
  size = 'md',
  onCreate,
  id,
  className,
  'aria-label': ariaLabel,
}: ComboboxProps<T>) {
  const { t } = useTranslation()
  const control = useFormFieldControl({ id })
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<readonly T[]>(options ?? [])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const loadRef = useRef(loadOptions)
  useEffect(() => {
    loadRef.current = loadOptions
  })

  const isAsync = Boolean(loadOptions)

  useEffect(() => {
    if (!isAsync) {
      setResults(options ?? [])
      return
    }
    if (!open) return
    const q = query.trim()
    if (q.length < minQueryLength) {
      setResults([])
      setLoading(false)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    const timer = setTimeout(
      () => {
        loadRef
          .current?.(q, controller.signal)
          .then((rows) => {
            if (!controller.signal.aborted) setResults(rows)
          })
          .catch((e: unknown) => {
            if (!controller.signal.aborted) setError(e)
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false)
          })
      },
      q === '' ? 0 : debounceMs,
    )
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, open, isAsync, minQueryLength, debounceMs, options])

  const select = (option: T | null): void => {
    onChange(option)
    setOpen(false)
    setQuery('')
  }

  const selectedValue = value ? getOptionValue(value) : null
  const trimmed = query.trim()

  return (
    <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
      <div className={cn('relative w-full', className)}>
        <PopoverTrigger asChild>
          <button
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-label={ariaLabel}
            disabled={disabled}
            className={cn(
              fieldVariants({ size }),
              'flex items-center justify-between gap-2 text-start',
              clearable && value ? 'pe-16' : 'pe-9',
            )}
            {...control}
          >
            <span className={cn('min-w-0 flex-1 truncate', !value && 'text-muted-foreground/80')}>
              {value
                ? renderValue
                  ? renderValue(value)
                  : getOptionLabel(value)
                : (placeholder ?? t('misc.select_placeholder'))}
            </span>
          </button>
        </PopoverTrigger>
        <span className="pointer-events-none absolute inset-y-0 end-0 flex w-9 items-center justify-center text-muted-foreground">
          <ChevronsUpDown className="size-4" />
        </span>
        {clearable && value && !disabled ? (
          <button
            type="button"
            aria-label={t('actions.clear')}
            onClick={() => onChange(null)}
            className="absolute inset-y-0 end-8 my-auto flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-surface-2 hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>
      <PopoverContent
        className="w-[max(var(--radix-popover-trigger-width),18rem)] p-0"
        align="start"
      >
        <Command shouldFilter={!isAsync} loop className="flex flex-col">
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder={searchPlaceholder ?? t('misc.search_placeholder')}
              className="h-11 w-full bg-transparent text-base outline-none placeholder:text-muted-foreground/70 sm:text-sm"
            />
            {loading ? (
              <Spinner size="sm" className="text-muted-foreground" label={t('misc.searching')} />
            ) : null}
          </div>
          <Command.List className="max-h-72 overflow-y-auto p-1">
            {error ? (
              <div className="px-3 py-6 text-center text-sm text-danger">
                {describeError(error).title}
              </div>
            ) : null}
            {!loading && !error ? (
              <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">
                {isAsync && trimmed.length < minQueryLength
                  ? t('misc.type_to_search')
                  : (emptyText ?? t('misc.no_options'))}
              </Command.Empty>
            ) : null}
            {results.map((option) => {
              const optionValue = getOptionValue(option)
              const label = getOptionLabel(option)
              return (
                <Command.Item
                  key={optionValue}
                  value={optionValue}
                  keywords={[label]}
                  onSelect={() => select(option)}
                  className="flex cursor-default select-none items-center gap-2 rounded-md px-2.5 py-2 text-sm aria-selected:bg-primary-soft aria-selected:text-primary-soft-foreground"
                >
                  <Check
                    className={cn(
                      'size-4 shrink-0',
                      optionValue === selectedValue ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    {renderOption ? renderOption(option) : label}
                  </div>
                </Command.Item>
              )
            })}
            {onCreate && trimmed && !loading ? (
              <Command.Item
                value={`__create__${trimmed}`}
                keywords={[trimmed]}
                onSelect={() => {
                  onCreate(trimmed)
                  setOpen(false)
                  setQuery('')
                }}
                className="flex cursor-default select-none items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium text-primary aria-selected:bg-primary-soft"
              >
                <Plus className="size-4" />
                {t('misc.add_new', { query: trimmed })}
              </Command.Item>
            ) : null}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
