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
 * Keyboard: type to search (typing on the closed field opens it), ↑/↓ to move, Enter to pick,
 * Esc to close.
 *
 * Pickers (components/pickers) also use:
 *  - `resolveQuery` — Enter on a code-like query (`shouldResolveQuery`) asks the server for an
 *    exact match first (barcode / SKU / phone lookup); without one the highlighted row is picked;
 *  - `onOptionSelect` — return false to keep the list open (e.g. expand a variant parent) — the
 *    search restarts and `reloadKey` re-runs `loadOptions`;
 *  - `isOptionDisabled` — rows shown but not selectable (expired batches).
 */
import { Command } from 'cmdk'
import { Check, ChevronsUpDown, Plus, X } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
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
  /** Label of the create row (default "Add “query”"). */
  createLabel?: (query: string) => ReactNode
  /** Shown but not selectable. */
  isOptionDisabled?: (option: T) => boolean
  /**
   * Enter on a non-empty query: exact lookup (barcode, SKU, phone…). A match is selected; null
   * falls back to the highlighted row, else `notFoundText` is shown.
   */
  resolveQuery?: (query: string, signal: AbortSignal) => Promise<T | null | undefined>
  /** Which queries go to `resolveQuery` on Enter (default: all). */
  shouldResolveQuery?: (query: string) => boolean
  notFoundText?: (query: string) => ReactNode
  /** Called before a row is chosen; return false to keep the list open (the search restarts). */
  onOptionSelect?: (option: T) => boolean | void
  /** Changing it re-runs `loadOptions` (async mode), e.g. after drilling into a group. */
  reloadKey?: string | number
  /** Rendered above the rows (e.g. the group being browsed). */
  header?: ReactNode
  onOpenChange?: (open: boolean) => void
  id?: string
  className?: string
  'aria-label'?: string
}

/**
 * Local filter for static options: every search word must occur in the label / keywords
 * (case-insensitive substring — predictable for codes like "1100" and for Tamil). Matches at the
 * start of the text or of a word rank higher. Values (ids) are ignored.
 */
function matchKeywords(_value: string, search: string, keywords?: string[]): number {
  const haystack = (keywords ?? []).join(' ').toLocaleLowerCase()
  const terms = search.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  let score = 1
  for (const term of terms) {
    const at = haystack.indexOf(term)
    if (at < 0) return 0
    if (at > 0) score *= /\s/.test(haystack[at - 1] ?? '') ? 0.9 : 0.6
  }
  return score
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
  createLabel,
  isOptionDisabled,
  resolveQuery,
  shouldResolveQuery,
  notFoundText,
  onOptionSelect,
  reloadKey,
  header,
  onOpenChange,
  id,
  className,
  'aria-label': ariaLabel,
}: ComboboxProps<T>) {
  const { t } = useTranslation()
  const control = useFormFieldControl({ id })
  const [open, setOpenState] = useState(false)
  const onOpenChangeRef = useRef(onOpenChange)
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  })
  const setOpen = (next: boolean): void => {
    setOpenState(next)
    onOpenChangeRef.current?.(next)
  }
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<readonly T[]>(options ?? [])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  /** Highlighted row (cmdk value = getOptionValue). */
  const [active, setActive] = useState('')
  const [resolving, setResolving] = useState(false)
  const [notFound, setNotFound] = useState<string | null>(null)
  const resolveAbort = useRef<AbortController | null>(null)
  const loadRef = useRef(loadOptions)
  useEffect(() => {
    loadRef.current = loadOptions
  })
  useEffect(() => () => resolveAbort.current?.abort(), [])

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
  }, [query, open, isAsync, minQueryLength, debounceMs, options, reloadKey])

  const changeQuery = (q: string): void => {
    setQuery(q)
    setNotFound(null)
  }

  const select = (option: T | null): void => {
    if (option && onOptionSelect?.(option) === false) {
      changeQuery('')
      return
    }
    onChange(option)
    setOpen(false)
    changeQuery('')
  }

  const pickActive = (): boolean => {
    const option = results.find((o) => getOptionValue(o) === active)
    if (!option || isOptionDisabled?.(option)) return false
    select(option)
    return true
  }

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || !resolveQuery || event.nativeEvent.isComposing) return
    const q = query.trim()
    if (!q || (shouldResolveQuery && !shouldResolveQuery(q))) return
    // Exact lookup first (a scanner types the code and presses Enter before the search ran).
    event.preventDefault()
    event.stopPropagation()
    resolveAbort.current?.abort()
    const controller = new AbortController()
    resolveAbort.current = controller
    setResolving(true)
    setError(null)
    resolveQuery(q, controller.signal)
      .then((match) => {
        if (controller.signal.aborted) return
        if (match) select(match)
        else if (!pickActive()) setNotFound(q)
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(e)
      })
      .finally(() => {
        if (!controller.signal.aborted) setResolving(false)
      })
  }

  /** Typing on the closed field opens it with that character as the search. */
  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (open || disabled) return
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key === ' ') return
    event.preventDefault()
    setOpen(true)
    changeQuery(event.key)
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
            onKeyDown={onTriggerKeyDown}
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
        <Command
          shouldFilter={!isAsync}
          // Match the label / keywords only: values are ids (UUIDs would fuzzy-match digits).
          filter={matchKeywords}
          loop
          value={active}
          onValueChange={setActive}
          className="flex flex-col"
        >
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Command.Input
              autoFocus
              value={query}
              onValueChange={changeQuery}
              onKeyDown={onInputKeyDown}
              placeholder={searchPlaceholder ?? t('misc.search_placeholder')}
              className="h-11 w-full bg-transparent text-base outline-none placeholder:text-muted-foreground/70 sm:text-sm"
            />
            {loading || resolving ? (
              <Spinner size="sm" className="text-muted-foreground" label={t('misc.searching')} />
            ) : null}
          </div>
          {header}
          <Command.List className="max-h-72 overflow-y-auto p-1">
            {notFound !== null ? (
              <div role="status" className="px-3 py-2 text-sm text-warning">
                {notFoundText ? notFoundText(notFound) : t('misc.no_options')}
              </div>
            ) : null}
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
                  disabled={isOptionDisabled?.(option) ?? false}
                  onSelect={() => select(option)}
                  className="flex cursor-default select-none items-center gap-2 rounded-md px-2.5 py-2 text-sm aria-selected:bg-primary-soft aria-selected:text-primary-soft-foreground data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50"
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
                  changeQuery('')
                }}
                className="flex cursor-default select-none items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium text-primary aria-selected:bg-primary-soft"
              >
                <Plus className="size-4" />
                {createLabel ? createLabel(trimmed) : t('misc.add_new', { query: trimmed })}
              </Command.Item>
            ) : null}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
