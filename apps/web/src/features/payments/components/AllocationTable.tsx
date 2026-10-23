/**
 * Allocation of a receipt / voucher over the party's open items (GET /payments/open-items, FIFO
 * order: opening balance first, then oldest documents). In auto mode the amounts follow the
 * shared allocateFifo() — exactly what the server's `auto_allocate: 'fifo'` does; typing in a
 * row (or ticking / unticking it) switches to manual amounts. Whatever is not allocated stays
 * as the party's advance.
 */
import { Wand2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { OpenItem } from '@kadai/shared/api/payments'
import { Badge, Button, Checkbox, MoneyInput } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatDate, formatMoney } from '@/lib/format'
import { itemKey } from '../lib/allocation'

export function AllocationTable({
  items,
  amounts,
  mode,
  onChange,
  onAutoFill,
  totalPaise,
}: {
  items: readonly OpenItem[]
  /** Key → allocated paise (auto mode: the FIFO amounts). */
  amounts: Readonly<Record<string, number>>
  mode: 'auto' | 'manual'
  /** A manual edit of one row (null = not allocated). */
  onChange: (key: string, amount: number | null) => void
  onAutoFill: () => void
  /** The payment amount. */
  totalPaise: number
}) {
  const { t } = useTranslation('payments')
  const allocated = Object.values(amounts).reduce((s, v) => s + v, 0)
  const advance = totalPaise - allocated
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {mode === 'auto' ? t('allocation.auto_title') : t('allocation.manual_title')}
        </p>
        {mode === 'manual' ? (
          <Button type="button" variant="ghost" size="sm" leftIcon={<Wand2 />} onClick={onAutoFill}>
            {t('allocation.auto_fill')}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">{t('allocation.auto_hint')}</span>
        )}
      </div>
      <ul className="grid max-h-72 gap-1 overflow-y-auto" aria-label={t('allocation.list_label')}>
        {items.map((item) => {
          const key = itemKey(item)
          const amount = amounts[key] ?? 0
          const label =
            item.target_type === 'opening_balance'
              ? t('allocation.opening_balance')
              : (item.number ?? t('allocation.unnumbered'))
          const cleared = amount >= item.due_paise
          return (
            <li
              key={key}
              className={cn(
                'grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-md px-2 py-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)_auto_8rem]',
                amount > 0 && cleared && 'bg-success-soft/50',
                amount > 0 && !cleared && 'bg-warning-soft/50',
              )}
            >
              <Checkbox
                checked={amount > 0}
                aria-label={t('allocation.select', { number: label })}
                onCheckedChange={(v) => onChange(key, v === true ? item.due_paise : null)}
              />
              <div className="min-w-0">
                <div className="truncate font-medium">{label}</div>
                <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  {item.date ? <span>{formatDate(item.date)}</span> : null}
                  {item.days_overdue && item.days_overdue > 0 ? (
                    <Badge tone="danger" size="sm">
                      {t('allocation.days_overdue', { count: item.days_overdue })}
                    </Badge>
                  ) : null}
                </div>
              </div>
              <div className="text-end">
                <div className="tabular-nums">{formatMoney(item.due_paise)}</div>
                <div className="text-xs text-muted-foreground">{t('allocation.due')}</div>
              </div>
              <MoneyInput
                value={amount > 0 ? amount : null}
                onChange={(v) =>
                  onChange(key, v !== null && v > item.due_paise ? item.due_paise : v)
                }
                size="sm"
                className="col-span-3 sm:col-span-1"
                aria-label={t('allocation.amount_for', { number: label })}
              />
            </li>
          )
        })}
      </ul>
      <div className="grid gap-1 rounded-md bg-surface-2 px-3 py-2 text-sm">
        <div className="flex justify-between gap-2">
          <span>{t('allocation.allocated')}</span>
          <span className="font-medium tabular-nums">{formatMoney(allocated)}</span>
        </div>
        {advance > 0 ? (
          <div className="flex justify-between gap-2 text-muted-foreground">
            <span>{t('allocation.advance')}</span>
            <span className="tabular-nums">{formatMoney(advance)}</span>
          </div>
        ) : null}
        {advance < 0 ? (
          <p role="alert" className="font-medium text-danger">
            {t('validation.allocations_exceed_amount')}
          </p>
        ) : null}
      </div>
    </div>
  )
}
