/**
 * Line grid of the purchase-order editor: product (stock now, last cost), quantity (pack-priced
 * products in packs), rate per pack excluding tax (blank = the product's purchase price), GST and
 * the estimated amount. Enter moves to the next cell (Shift+Enter back) and after the last cell
 * to the product search; Ctrl+Delete removes the row. Below lg every line is a card.
 */
import { GST_RATES_BP } from '@kadai/shared/gst'
import { isDecimalUnit } from '@kadai/shared/units'
import { Trash2 } from 'lucide-react'
import type { KeyboardEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { IconButton, Money, MoneyInput, NumberInput, Qty, fieldVariants } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatBp, formatMoney } from '@/lib/format'
import { localizedName } from '@/lib/i18n'
import { fromPackMilli, toPackMilli } from '../lib/bill-form'
import { packUnitFor, unitLabel } from '../lib/labels'
import {
  type OrderErrors,
  type OrderLineDraft,
  type OrderTotals,
  QTY_BELOW_RECEIVED,
} from '../lib/order-form'
import { validationText } from '../lib/errors'
import { ORDER_COLUMNS, orderCellId } from '../lib/grid'

export interface OrderLineGridProps {
  lines: OrderLineDraft[]
  totals: OrderTotals
  errors: OrderErrors['lines']
  layout: 'table' | 'cards'
  adderId: string
  disabled?: boolean
  onChange: (key: string, patch: Partial<OrderLineDraft>) => void
  onRemove: (key: string) => void
}

export function OrderLineGrid({
  lines,
  totals,
  errors,
  layout,
  adderId,
  disabled,
  onChange,
  onRemove,
}: OrderLineGridProps) {
  const { t } = useTranslation('purchases')
  const order = lines.flatMap((l) =>
    ORDER_COLUMNS.map((c) => ({ key: l.key, col: c, id: orderCellId(l.key, c) })),
  )

  const focus = (id: string): void => {
    const el = document.getElementById(id)
    el?.focus()
    if (el instanceof HTMLInputElement) el.select()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement
    const cell = target.dataset.cell
    if (!cell || event.nativeEvent.isComposing) return
    const at = order.findIndex((c) => c.id === cell)
    if (at < 0) return
    const here = order[at]!
    if (event.key === 'Enter') {
      event.preventDefault()
      const next = event.shiftKey ? order[at - 1] : order[at + 1]
      if (next) focus(next.id)
      else if (!event.shiftKey) focus(adderId)
      return
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && target.tagName !== 'SELECT') {
      const row = lines.findIndex((l) => l.key === here.key)
      const nextLine = lines[row + (event.key === 'ArrowDown' ? 1 : -1)]
      event.preventDefault()
      if (nextLine) focus(orderCellId(nextLine.key, here.col))
      else if (event.key === 'ArrowDown') focus(adderId)
      return
    }
    if (event.key === 'Delete' && (event.ctrlKey || event.metaKey)) {
      const line = lines.find((l) => l.key === here.key)
      if (!line || line.received_qty_milli > 0) return
      event.preventDefault()
      const neighbour = order.find((c, i) => i > at && c.key !== here.key)
      onRemove(here.key)
      window.setTimeout(() => focus(neighbour?.id ?? adderId), 0)
    }
  }

  if (lines.length === 0) return null

  const cellsOf = (line: OrderLineDraft, index: number) => {
    const p = line.product
    const packed = p.pack_size > 1
    const decimals = packed || isDecimalUnit(p.unit) ? 3 : 0
    const e = errors[line.key] ?? {}
    const label = (col: string): string => t('lines.cell_label', { col, n: index + 1 })
    const qtyError =
      e.qty === QTY_BELOW_RECEIVED ? t('orders.qty_below_received') : validationText(e.qty)
    const amounts = totals.byKey.get(line.key)
    return {
      product: (
        <div className="min-w-0">
          <div className="font-medium leading-snug [overflow-wrap:anywhere]">
            <span className="tabular-nums text-muted-foreground">{index + 1}. </span>
            {localizedName(p.name, p.name_ta)}
          </div>
          <div className="text-xs text-muted-foreground">
            {[
              p.sku,
              packed
                ? t('lines.pack_of', {
                    count: p.pack_size,
                    unit: unitLabel(p.unit),
                    pack: unitLabel(packUnitFor(p.unit)),
                  })
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            {p.stock_qty_milli !== null ? (
              <>
                {p.sku || packed ? ' · ' : ''}
                {t('lines.stock')}{' '}
                <Qty
                  milli={p.stock_qty_milli}
                  unit={p.unit}
                  packSize={p.pack_size}
                  packUnit={packUnitFor(p.unit)}
                />
              </>
            ) : null}
            {p.last_cost_paise !== null
              ? ` · ${t('orders.last_cost', { amount: formatMoney(p.last_cost_paise) })}`
              : ''}
          </div>
          {line.suggested_qty_milli !== null && line.suggested_qty_milli > 0 ? (
            <div className="text-xs text-info">
              {t('orders.suggested')}{' '}
              <Qty
                milli={line.suggested_qty_milli}
                unit={p.unit}
                packSize={p.pack_size}
                packUnit={packUnitFor(p.unit)}
              />
            </div>
          ) : null}
          {line.received_qty_milli > 0 ? (
            <div className="text-xs text-success">
              {t('orders.received_so_far')}{' '}
              <Qty
                milli={line.received_qty_milli}
                unit={p.unit}
                packSize={p.pack_size}
                packUnit={packUnitFor(p.unit)}
              />
            </div>
          ) : null}
        </div>
      ),
      qty: (
        <NumberInput
          id={orderCellId(line.key, 'qty')}
          data-cell={orderCellId(line.key, 'qty')}
          size="sm"
          decimals={decimals}
          scale={1000}
          value={packed ? toPackMilli(line.qty_milli, p.pack_size) : line.qty_milli}
          disabled={disabled}
          aria-label={label(t('lines.qty'))}
          className="text-end"
          onFocus={(ev) => ev.currentTarget.select()}
          onChange={(v) =>
            onChange(line.key, { qty_milli: packed ? fromPackMilli(v, p.pack_size) : v })
          }
          {...(e.qty ? { 'aria-invalid': true as const } : {})}
        />
      ),
      qtyError,
      packWord: packed ? unitLabel(packUnitFor(p.unit)) : null,
      rate: (
        <MoneyInput
          id={orderCellId(line.key, 'rate')}
          data-cell={orderCellId(line.key, 'rate')}
          size="sm"
          showSymbol={false}
          value={line.unit_cost_paise}
          placeholder={
            p.purchase_price_paise > 0
              ? formatMoney(p.purchase_price_paise, { symbol: false })
              : undefined
          }
          disabled={disabled}
          aria-label={label(t('lines.rate'))}
          onChange={(v) => onChange(line.key, { unit_cost_paise: v })}
        />
      ),
      gst: (
        <select
          id={orderCellId(line.key, 'gst')}
          data-cell={orderCellId(line.key, 'gst')}
          value={line.gst_rate_bp}
          disabled={disabled}
          aria-label={label(t('lines.gst'))}
          className={cn(fieldVariants({ size: 'sm' }), 'pe-1 text-end tabular-nums')}
          onChange={(ev) => onChange(line.key, { gst_rate_bp: Number(ev.target.value) })}
        >
          {GST_RATES_BP.map((r) => (
            <option key={r} value={r}>
              {formatBp(r)}
            </option>
          ))}
        </select>
      ),
      amount: <Money paise={amounts?.total_paise ?? null} className="font-semibold" />,
      taxable: <Money paise={amounts?.taxable_paise ?? null} />,
      remove: (
        <IconButton
          icon={<Trash2 />}
          label={t('lines.remove_line', { n: index + 1 })}
          variant="ghost"
          size="sm"
          tabIndex={layout === 'table' ? -1 : undefined}
          disabled={disabled || line.received_qty_milli > 0}
          className="text-muted-foreground hover:text-danger"
          onClick={() => onRemove(line.key)}
        />
      ),
    }
  }

  if (layout === 'cards') {
    return (
      <ol
        className="grid grid-cols-[minmax(0,1fr)] gap-3"
        onKeyDown={onKeyDown}
        aria-label={t('lines.title')}
      >
        {lines.map((line, i) => {
          const c = cellsOf(line, i)
          return (
            <li
              key={line.key}
              className={cn(
                'min-w-0 rounded-xl border bg-surface p-3 shadow-card',
                errors[line.key] ? 'border-danger/60' : 'border-border',
              )}
            >
              <div className="mb-3 flex items-start justify-between gap-2">
                {c.product}
                {c.remove}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Field
                  label={c.packWord ? t('lines.qty_in', { unit: c.packWord }) : t('lines.qty')}
                  error={c.qtyError}
                >
                  {c.qty}
                </Field>
                <Field label={t('lines.rate')}>{c.rate}</Field>
                <Field label={t('lines.gst')}>{c.gst}</Field>
              </div>
              <div className="mt-2 flex items-center justify-between border-t border-border pt-2 text-sm">
                <span className="text-muted-foreground">{t('lines.amount')}</span>
                {c.amount}
              </div>
            </li>
          )
        })}
      </ol>
    )
  }

  return (
    <div className="scrollbar-thin relative min-w-0 overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="w-full min-w-[760px] border-collapse text-sm" onKeyDown={onKeyDown}>
        <caption className="sr-only">{t('lines.title')}</caption>
        <thead className="bg-surface-2 text-xs text-muted-foreground">
          <tr>
            <Th>{t('lines.item')}</Th>
            <Th align="end" className="w-28">
              {t('lines.qty')}
            </Th>
            <Th align="end" className="w-28">
              {t('lines.rate')}
            </Th>
            <Th align="end" className="w-24">
              {t('lines.gst')}
            </Th>
            <Th align="end" className="w-28">
              {t('lines.taxable')}
            </Th>
            <Th align="end" className="w-28">
              {t('lines.amount')}
            </Th>
            <Th className="w-10">
              <span className="sr-only">{t('lines.remove')}</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, i) => {
            const c = cellsOf(line, i)
            const td = 'border-b border-border/70 px-2 py-1.5 align-top first:ps-3 last:pe-3'
            return (
              <tr key={line.key} className={cn(errors[line.key] && 'bg-danger-soft/30')}>
                <td className={td}>{c.product}</td>
                <td className={td}>
                  {c.qty}
                  {c.packWord ? (
                    <div className="mt-0.5 text-end text-[11px] text-muted-foreground">
                      {c.packWord}
                    </div>
                  ) : null}
                  {c.qtyError ? (
                    <div role="alert" className="mt-0.5 text-[11px] font-medium text-danger">
                      {c.qtyError}
                    </div>
                  ) : null}
                </td>
                <td className={td}>{c.rate}</td>
                <td className={td}>{c.gst}</td>
                <td className={cn(td, 'pt-3 text-end')}>{c.taxable}</td>
                <td className={cn(td, 'pt-3 text-end')}>{c.amount}</td>
                <td className={cn(td, 'text-end')}>{c.remove}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Th({
  children,
  align,
  className,
}: {
  children: ReactNode
  align?: 'end'
  className?: string
}) {
  return (
    <th
      scope="col"
      className={cn(
        'whitespace-nowrap border-b border-border px-2 py-2 font-semibold first:ps-3 last:pe-3',
        align === 'end' ? 'text-end' : 'text-start',
        className,
      )}
    >
      {children}
    </th>
  )
}

function Field({ label, children, error }: { label: string; children: ReactNode; error?: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {error ? (
        <span role="alert" className="text-[11px] font-medium text-danger">
          {error}
        </span>
      ) : null}
    </div>
  )
}
