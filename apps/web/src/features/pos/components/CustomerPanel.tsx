/**
 * Customer of the bill (F3): search by mobile number or name — the 200 recent customers cached
 * by the bootstrap answer instantly (offline too), the server fills in the rest — or add a new
 * one in two fields. The selected customer shows the khata due / advance, credit limit and
 * loyalty points. Walk-in (no customer) is the default.
 */
import { BadgeIndianRupee, Phone, Star, UserPlus, UserRound, X } from 'lucide-react'
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { partiesRoutes } from '@kadai/shared/api/parties'
import { normalizeIndianPhone } from '@kadai/shared/phone'
import { Avatar, Badge, IconButton, Kbd, Spinner } from '@/components/ui'
import { callRoute, isApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatMoney, formatPhone } from '@/lib/format'
import { localizedName } from '@/lib/i18n'
import type { CartCustomer } from '../lib/cart'
import { customerFromRow, phoneDigits, searchCachedCustomers } from '../lib/convert'
import { usePos } from '../state/pos-context'

function mergeById(a: CartCustomer[], b: CartCustomer[]): CartCustomer[] {
  const seen = new Set(a.map((c) => c.id))
  return [...a, ...b.filter((c) => !seen.has(c.id))]
}

export function CustomerBalance({ customer }: { customer: CartCustomer }) {
  const { t } = useTranslation('pos')
  if (customer.balance_paise > 0)
    return (
      <Badge tone="danger" size="sm">
        {t('customer.due', { amount: formatMoney(customer.balance_paise) })}
      </Badge>
    )
  if (customer.balance_paise < 0)
    return (
      <Badge tone="success" size="sm">
        {t('customer.advance', { amount: formatMoney(-customer.balance_paise) })}
      </Badge>
    )
  return null
}

export function CustomerPanel({ className }: { className?: string }) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const listId = useId()
  const customer = pos.cart.customer
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CartCustomer[]>([])
  const [active, setActive] = useState(0)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)
  const cached = pos.context?.customers ?? []
  const canSearchServer = pos.online && pos.perms.customersRead
  const canAdd = pos.online && pos.perms.customersWrite

  useEffect(() => {
    const q = query.trim()
    const local = searchCachedCustomers(cached, q).map(customerFromRow)
    setResults(local)
    setActive(0)
    if (!canSearchServer || q.length < 2) {
      setLoading(false)
      return
    }
    const mine = ++seq.current
    const controller = new AbortController()
    setLoading(true)
    const timer = setTimeout(() => {
      const phone = normalizeIndianPhone(q.replace(/[\s-]/g, ''))
      const work = phone
        ? callRoute(partiesRoutes.lookupCustomer, { query: { phone }, signal: controller.signal })
            .then((r) => [customerFromRow(r.data)])
            .catch((e: unknown) => {
              if (isApiError(e) && e.status === 404) return []
              throw e
            })
        : callRoute(partiesRoutes.listCustomers, {
            query: { q, limit: 8, is_active: true },
            signal: controller.signal,
          }).then((r) => r.data.map(customerFromRow))
      void work
        .then((remote) => {
          if (mine === seq.current) setResults(mergeById(local, remote))
        })
        .catch(() => undefined)
        .finally(() => {
          if (mine === seq.current) setLoading(false)
        })
    }, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // `cached` changes identity with every context refresh; its content is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, canSearchServer, cached.length])

  const choose = (c: CartCustomer): void => {
    pos.setCustomer(c)
    setQuery('')
    setOpen(false)
    pos.focusSearch()
  }

  const startAdd = (): void => {
    const q = query.trim()
    const phone = normalizeIndianPhone(q.replace(/[\s-]/g, ''))
    pos.openDialog({ name: 'customer_add', draft: phone ? { phone } : q ? { name: q } : {} })
    setOpen(false)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, results.length - (canAdd ? 0 : 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(0, a - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = results[active]
      if (hit) choose(hit)
      else if (canAdd && query.trim()) startAdd()
    } else if (e.key === 'Escape' && query) {
      e.preventDefault()
      e.stopPropagation()
      setQuery('')
    }
  }

  if (customer) {
    const name = localizedName(customer.name, customer.name_ta)
    return (
      <section
        className={cn('rounded-xl border border-border bg-surface p-3 shadow-card', className)}
        aria-label={t('customer.title')}
      >
        <div className="flex items-start gap-3">
          <Avatar name={customer.name} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{name}</div>
            {customer.phone ? (
              <div className="flex items-center gap-1 text-sm text-muted-foreground">
                <Phone className="size-3.5" aria-hidden /> {formatPhone(customer.phone)}
              </div>
            ) : null}
            <div className="mt-1.5 flex flex-wrap gap-1">
              <CustomerBalance customer={customer} />
              {customer.credit_limit_paise !== null ? (
                <Badge tone="neutral" size="sm" icon={<BadgeIndianRupee />}>
                  {t('customer.limit', { amount: formatMoney(customer.credit_limit_paise) })}
                </Badge>
              ) : null}
              {pos.hasFeature('loyalty') && customer.loyalty_points > 0 ? (
                <Badge tone="accent" size="sm" icon={<Star />}>
                  {t('customer.points', { points: customer.loyalty_points })}
                </Badge>
              ) : null}
              {customer.price_tier === 'wholesale' ? (
                <Badge tone="info" size="sm">
                  {t('customer.wholesale')}
                </Badge>
              ) : null}
            </div>
          </div>
          <IconButton
            icon={<X />}
            label={t('customer.remove')}
            size="sm"
            onClick={() => pos.setCustomer(null)}
          />
        </div>
      </section>
    )
  }

  const showList = open && (results.length > 0 || query.trim().length > 0)
  return (
    <section className={cn('relative', className)} aria-label={t('customer.title')}>
      <label htmlFor={`${listId}-input`} className="sr-only">
        {t('customer.search_label')}
      </label>
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 start-3 flex items-center text-muted-foreground">
          {loading ? <Spinner size="sm" label="" /> : <UserRound className="size-5" aria-hidden />}
        </span>
        <input
          ref={pos.customerRef}
          id={`${listId}-input`}
          role="combobox"
          aria-expanded={showList}
          aria-controls={`${listId}-list`}
          autoComplete="off"
          inputMode="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKeyDown}
          placeholder={t('customer.placeholder')}
          className="h-12 w-full rounded-lg border border-input bg-surface ps-10 pe-14 text-base shadow-card placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25"
        />
        <span className="pointer-events-none absolute inset-y-0 end-3 hidden items-center sm:flex">
          <Kbd combo="F3" />
        </span>
      </div>
      {showList ? (
        <ul
          id={`${listId}-list`}
          role="listbox"
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-80 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-overlay"
        >
          {results.map((c, i) => (
            <li
              key={c.id}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(c)}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-md px-3 py-2',
                i === active ? 'bg-primary-soft' : 'hover:bg-surface-2',
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{localizedName(c.name, c.name_ta)}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {c.phone ? formatPhone(c.phone) : ''}
                </div>
              </div>
              <CustomerBalance customer={c} />
            </li>
          ))}
          {results.length === 0 && query.trim() ? (
            <li className="px-3 py-3 text-sm text-muted-foreground">
              {phoneDigits(query).length >= 10
                ? t('customer.no_match_phone')
                : t('customer.no_match')}
            </li>
          ) : null}
          {canAdd ? (
            <li
              role="option"
              aria-selected={active === results.length}
              onMouseDown={(e) => e.preventDefault()}
              onClick={startAdd}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-md px-3 py-2.5 font-medium text-primary',
                active === results.length ? 'bg-primary-soft' : 'hover:bg-surface-2',
              )}
            >
              <UserPlus className="size-4" aria-hidden />
              {query.trim() ? t('customer.add_named', { query: query.trim() }) : t('customer.add')}
            </li>
          ) : !pos.online ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">{t('customer.add_offline')}</li>
          ) : null}
        </ul>
      ) : null}
    </section>
  )
}
