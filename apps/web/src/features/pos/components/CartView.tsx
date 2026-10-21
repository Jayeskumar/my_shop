/**
 * The bill being rung up: a dense table on counters (line no., item with variant / batch /
 * expiry chips, unit-aware quantity stepper with direct entry, rate, discount, amount, remove)
 * and touch cards on phones. Arrow keys move the selection, Delete removes, F7 edits the
 * quantity of the selected line.
 */
import { Minus, Percent, Plus, ShoppingBasket, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge, EmptyState, IconButton, Kbd, QtyInput } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatMoney, formatPackQty, formatQty } from '@/lib/format'
import { allowsDecimalQty, packUnitOf, qtyStepMilli } from '../lib/cart'
import { qtyInputId } from '../lib/dom-ids'
import type { PricedCartLine } from '../lib/pricing'
import { usePos } from '../state/pos-context'
import { unitSymbol } from '../lib/names'
import { ProductLabel } from './ProductLabel'

function QtyCell({ line }: { line: PricedCartLine['line'] }) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const p = line.product
  const packs = p.pack_size > 1
  return (
    <div className="flex flex-col items-end gap-0.5">
      <div className="flex items-center gap-1.5">
        <div className="w-32">
          <QtyInput
            id={qtyInputId(line.key)}
            size="sm"
            unit={p.unit}
            showUnit={false}
            allowDecimal={allowsDecimalQty(p)}
            step={qtyStepMilli(p)}
            min={1}
            value={line.qty_milli}
            aria-label={t('cart.qty_of', { name: p.name })}
            onChange={(v) => {
              if (v !== null && v > 0)
                pos.dispatch({ type: 'set_qty', key: line.key, qty_milli: v })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                pos.focusSearch()
              }
            }}
          />
        </div>
        <span className="w-11 truncate text-start text-xs text-muted-foreground">
          {unitSymbol(p.unit)}
        </span>
      </div>
      {packs && line.qty_milli >= p.pack_size * 1000 ? (
        <span className="text-[11px] text-muted-foreground">
          {formatPackQty(line.qty_milli, p.pack_size, p.unit, packUnitOf(p))}
        </span>
      ) : null}
    </div>
  )
}

function DiscountCell({ priced }: { priced: PricedCartLine }) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const { line } = priced
  const manual = line.discount_bp > 0 || line.discount_paise > 0
  return (
    <button
      type="button"
      onClick={() => pos.openDialog({ name: 'line', key: line.key, focus: 'discount' })}
      className="rounded-md px-2 py-1 text-end text-sm tabular-nums hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring"
      aria-label={t('cart.edit_discount')}
    >
      {priced.discount_paise > 0 ? (
        <span className={manual ? 'text-foreground' : 'text-success'}>
          −{formatMoney(priced.discount_paise)}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      )}
      {priced.promotion_discount_paise > 0 ? (
        <span className="block text-[11px] text-success">{t('cart.offer')}</span>
      ) : null}
    </button>
  )
}

function RateCell({ priced }: { priced: PricedCartLine }) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const { price, line } = priced
  const overridden = price.source === 'manual'
  const content = (
    <>
      <span
        className={cn('tabular-nums', overridden && 'font-semibold text-accent-soft-foreground')}
      >
        {formatMoney(price.unit_price_paise)}
      </span>
      {price.mrp_paise !== null && price.mrp_paise > price.unit_price_paise ? (
        <span className="block text-[11px] text-muted-foreground line-through">
          {formatMoney(price.mrp_paise)}
        </span>
      ) : null}
    </>
  )
  if (!pos.perms.editPrice) return <div className="px-2 text-end text-sm">{content}</div>
  return (
    <button
      type="button"
      onClick={() => pos.openDialog({ name: 'line', key: line.key, focus: 'price' })}
      className="rounded-md px-2 py-1 text-end text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring"
      aria-label={t('cart.edit_price')}
    >
      {content}
    </button>
  )
}

function EmptyCart() {
  const { t } = useTranslation('pos')
  return (
    <EmptyState
      icon={<ShoppingBasket />}
      title={t('cart.empty_title')}
      description={
        <span className="inline-flex flex-wrap items-center justify-center gap-1">
          {t('cart.empty_hint')} <Kbd combo="F2" />
        </span>
      }
    />
  )
}

export function CartTable({ className }: { className?: string }) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const lines = pos.pricing.lines
  const warning = pos.context?.settings.inventory.expiry_warning_days ?? 90
  if (lines.length === 0)
    return (
      <div className={className}>
        <EmptyCart />
      </div>
    )
  return (
    <div className={cn('min-h-0 overflow-y-auto', className)}>
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead className="sticky top-0 z-10 bg-surface-2 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="w-10 px-2 py-2 text-center font-semibold">#</th>
            <th className="px-2 py-2 text-start font-semibold">{t('cart.item')}</th>
            <th className="px-2 py-2 text-end font-semibold">{t('cart.qty')}</th>
            <th className="px-2 py-2 text-end font-semibold">{t('cart.rate')}</th>
            <th className="px-2 py-2 text-end font-semibold">{t('cart.discount')}</th>
            <th className="px-2 py-2 text-end font-semibold">{t('cart.amount')}</th>
            <th className="w-12 px-1 py-2">
              <span className="sr-only">{t('cart.remove')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((priced, i) => {
            const { line } = priced
            const selected = pos.cart.selected_key === line.key
            return (
              <tr
                key={line.key}
                aria-selected={selected}
                onClick={() => pos.dispatch({ type: 'select', key: line.key })}
                className={cn(
                  'cursor-default align-top transition-colors [&>td]:border-b [&>td]:border-border',
                  selected ? 'bg-primary-soft/50' : 'hover:bg-surface-2/60',
                )}
              >
                <td className="px-2 py-2.5 text-center tabular-nums text-muted-foreground">
                  {selected ? <span className="font-bold text-primary">{i + 1}</span> : i + 1}
                </td>
                <td className="px-2 py-2">
                  <ProductLabel
                    product={line.product}
                    batch={line.batch}
                    today={pos.today}
                    warningDays={warning}
                    note={line.note}
                    onBatchClick={
                      line.product.track_batches
                        ? () => pos.openDialog({ name: 'batch', key: line.key })
                        : undefined
                    }
                  />
                </td>
                <td className="px-2 py-1.5">
                  <QtyCell line={line} />
                </td>
                <td className="py-1.5">
                  <RateCell priced={priced} />
                </td>
                <td className="py-1.5">
                  <DiscountCell priced={priced} />
                </td>
                <td className="px-2 py-2.5 text-end text-base font-semibold tabular-nums">
                  {formatMoney(priced.total_paise)}
                </td>
                <td className="px-1 py-1.5 text-center">
                  <IconButton
                    icon={<Trash2 />}
                    label={t('cart.remove_item', { name: line.product.name })}
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-danger"
                    onClick={(e) => {
                      e.stopPropagation()
                      pos.dispatch({ type: 'remove', key: line.key })
                    }}
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Phone layout: one card per line, big steppers. */
export function CartCards({ className }: { className?: string }) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const lines = pos.pricing.lines
  const warning = pos.context?.settings.inventory.expiry_warning_days ?? 90
  if (lines.length === 0)
    return (
      <div className={className}>
        <EmptyCart />
      </div>
    )
  return (
    <ul className={cn('flex flex-col gap-2', className)}>
      {lines.map((priced) => {
        const { line } = priced
        const p = line.product
        return (
          <li key={line.key} className="rounded-xl border border-border bg-surface p-3 shadow-card">
            <div className="flex items-start gap-2">
              <button
                type="button"
                className="min-w-0 flex-1 text-start"
                onClick={() => pos.openDialog({ name: 'line', key: line.key, focus: 'qty' })}
              >
                <ProductLabel
                  product={p}
                  batch={line.batch}
                  today={pos.today}
                  warningDays={warning}
                  note={line.note}
                />
                <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                  {formatQty(line.qty_milli, p.unit)} × {formatMoney(priced.price.unit_price_paise)}
                  {priced.discount_paise > 0 ? (
                    <Badge tone="success" size="sm" className="ms-1.5" icon={<Percent />}>
                      −{formatMoney(priced.discount_paise)}
                    </Badge>
                  ) : null}
                </div>
              </button>
              <div className="text-end text-base font-bold tabular-nums">
                {formatMoney(priced.total_paise)}
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <IconButton
                  icon={<Minus />}
                  label={t('cart.decrease')}
                  variant="outline"
                  size="lg"
                  onClick={() => pos.dispatch({ type: 'step_qty', key: line.key, direction: -1 })}
                />
                <span className="min-w-16 text-center text-base font-semibold tabular-nums">
                  {formatQty(line.qty_milli, p.unit)}
                </span>
                <IconButton
                  icon={<Plus />}
                  label={t('cart.increase')}
                  variant="outline"
                  size="lg"
                  onClick={() => pos.dispatch({ type: 'step_qty', key: line.key, direction: 1 })}
                />
              </div>
              <IconButton
                icon={<Trash2 />}
                label={t('cart.remove_item', { name: p.name })}
                variant="ghost"
                size="lg"
                className="text-muted-foreground hover:text-danger"
                onClick={() => pos.dispatch({ type: 'remove', key: line.key })}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}
