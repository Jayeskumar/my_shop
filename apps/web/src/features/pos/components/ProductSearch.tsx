/**
 * The counter's search box (F2): barcode scanners type into it (a keystroke burst + Enter is a
 * code lookup: barcode → SKU → scale barcode, from the offline catalogue, then the server), and
 * typing searches name / Tamil name / aliases / SKU in IndexedDB instantly — offline too.
 * "3*" before a scan or search sets the quantity (3 × the item).
 */
import { Barcode, Search, X } from 'lucide-react'
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { milliToDecimalString } from '@kadai/shared/units'
import { Badge, Kbd, Spinner } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatMoney, formatQty } from '@/lib/format'
import { createWedgeDetector, looksLikeCode } from '../lib/barcode-wedge'
import { searchProducts } from '../lib/catalog'
import { parseMultiplier } from '../lib/search'
import type { PosProduct } from '../lib/types'
import { usePos } from '../state/pos-context'
import { productNames } from '../lib/names'

export function ProductSearch({ className }: { className?: string }) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const listId = useId()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PosProduct[]>([])
  const [active, setActive] = useState(0)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const detector = useMemo(() => createWedgeDetector(), [])
  const searchSeq = useRef(0)
  const tenantId = pos.scope?.tenantId ?? null
  const { qty_milli: multiplier, rest } = parseMultiplier(query)

  useEffect(() => {
    if (!tenantId || rest.length < 1) {
      setResults([])
      return
    }
    const seq = ++searchSeq.current
    const timer = setTimeout(() => {
      void searchProducts(tenantId, rest, 12).then((rows) => {
        if (seq !== searchSeq.current) return
        setResults(rows)
        setActive(0)
      })
    }, 60)
    return () => clearTimeout(timer)
  }, [tenantId, rest, pos.catalogRevision])

  const reset = (): void => {
    setQuery('')
    setResults([])
    setOpen(false)
    detector.reset()
  }

  const pick = async (product: PosProduct): Promise<void> => {
    reset()
    await pos.addProduct(product, multiplier ? { qty_milli: multiplier, confirmed: true } : {})
  }

  const lookup = async (code: string): Promise<void> => {
    setBusy(true)
    try {
      const ok = await pos.addByCode(code, multiplier)
      if (ok) reset()
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const result = detector.push({
      key: event.key,
      time: event.timeStamp,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
    })
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setActive((a) => Math.min(a + 1, Math.max(0, results.length - 1)))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((a) => Math.max(0, a - 1))
      return
    }
    if (event.key === 'Escape') {
      if (query) {
        event.preventDefault()
        event.stopPropagation()
        reset()
      }
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    const text = rest
    if (!text) return
    // Scanner burst, or a code typed by hand: exact lookup first.
    if (
      result.kind === 'scan' ||
      (looksLikeCode(text) && (results.length === 0 || /^\d+$/.test(text)))
    ) {
      void lookup(text)
      return
    }
    const hit = results[active]
    if (hit) void pick(hit)
    else void lookup(text)
  }

  const showList = open && rest.length > 0
  return (
    <div className={cn('relative', className)}>
      <label htmlFor={`${listId}-input`} className="sr-only">
        {t('search.label')}
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 start-3 flex items-center text-muted-foreground">
          {busy ? <Spinner size="sm" label="" /> : <Search className="size-5" aria-hidden />}
        </span>
        <input
          ref={pos.searchRef}
          id={`${listId}-input`}
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={`${listId}-list`}
          aria-activedescendant={
            showList && results[active] ? `${listId}-opt-${active}` : undefined
          }
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          value={query}
          placeholder={t('search.placeholder')}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKeyDown}
          className={cn(
            'h-14 w-full rounded-lg border border-input bg-surface ps-11 pe-24 text-lg font-medium shadow-card',
            'placeholder:text-base placeholder:font-normal placeholder:text-muted-foreground/70',
            'focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25',
          )}
        />
        <div className="absolute inset-y-0 end-2 flex items-center gap-2">
          {multiplier ? (
            <Badge tone="accent" size="md">
              ×{milliToDecimalString(multiplier)}
            </Badge>
          ) : null}
          {query ? (
            <button
              type="button"
              className="rounded-md p-1.5 text-muted-foreground hover:bg-surface-2"
              aria-label={t('search.clear')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={reset}
            >
              <X className="size-5" />
            </button>
          ) : (
            <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
              <Barcode className="size-4" aria-hidden />
              <Kbd combo="F2" />
            </span>
          )}
        </div>
      </div>
      {showList ? (
        <ul
          id={`${listId}-list`}
          role="listbox"
          aria-label={t('search.results')}
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-[min(60vh,28rem)] overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-overlay"
        >
          {results.length === 0 ? (
            <li className="px-3 py-4 text-sm text-muted-foreground">
              {looksLikeCode(rest)
                ? t('search.enter_to_lookup', { code: rest })
                : t('search.no_match')}
            </li>
          ) : (
            results.map((p, i) => {
              const names = productNames(p)
              return (
                <li
                  key={p.id}
                  id={`${listId}-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => void pick(p)}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5',
                    i === active
                      ? 'bg-primary-soft text-primary-soft-foreground'
                      : 'hover:bg-surface-2',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{names.primary}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {[names.secondary, p.sku].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  {p.kind === 'variant_parent' ? (
                    <Badge tone="info" size="sm">
                      {t('search.choose_variant')}
                    </Badge>
                  ) : (
                    <div className="text-end">
                      <div className="font-semibold tabular-nums">
                        {formatMoney(p.sale_price_paise)}
                      </div>
                      {p.stock_qty_milli !== null && p.track_inventory ? (
                        <div
                          className={cn(
                            'text-xs tabular-nums',
                            p.stock_qty_milli <= 0 ? 'text-danger' : 'text-muted-foreground',
                          )}
                        >
                          {t('search.stock', { qty: formatQty(p.stock_qty_milli, p.unit) })}
                        </div>
                      ) : null}
                    </div>
                  )}
                </li>
              )
            })
          )}
        </ul>
      ) : null}
    </div>
  )
}
