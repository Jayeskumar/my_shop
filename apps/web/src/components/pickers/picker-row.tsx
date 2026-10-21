import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatMoney } from '@/lib/format'

/** Two-line option row: title + muted subtitle, optional right-aligned facts. */
export function PickerRow({
  title,
  subtitle,
  aside,
  indent = 0,
  className,
}: {
  title: ReactNode
  subtitle?: ReactNode
  aside?: ReactNode
  /** Tree depth (0 = top level) — indents the row. */
  indent?: number
  className?: string
}) {
  return (
    <div
      className={cn('flex min-w-0 items-center gap-3', className)}
      style={indent ? { paddingInlineStart: `${indent * 0.875}rem` } : undefined}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{title}</div>
        {subtitle ? <div className="truncate text-xs text-muted-foreground">{subtitle}</div> : null}
      </div>
      {aside ? (
        <div className="flex shrink-0 flex-col items-end gap-0.5 text-xs">{aside}</div>
      ) : null}
    </div>
  )
}

/**
 * Party balance chip: customers (receivable) — due / overdue / advance; suppliers (payable) —
 * to pay / advance. Nothing for a zero balance.
 */
export function BalanceBadge({
  kind,
  balancePaise,
  overduePaise = 0,
}: {
  kind: 'customer' | 'supplier'
  balancePaise: number
  overduePaise?: number
}) {
  const { t } = useTranslation('common')
  if (balancePaise === 0) return null
  if (balancePaise < 0) {
    return (
      <Badge tone="success" size="sm">
        {t(kind === 'customer' ? 'pickers.customer.advance' : 'pickers.supplier.advance', {
          amount: formatMoney(-balancePaise),
        })}
      </Badge>
    )
  }
  if (kind === 'supplier') {
    return (
      <Badge tone={overduePaise > 0 ? 'danger' : 'warning'} size="sm">
        {t('pickers.supplier.payable', { amount: formatMoney(balancePaise) })}
      </Badge>
    )
  }
  return overduePaise > 0 ? (
    <Badge tone="danger" size="sm">
      {t('pickers.customer.overdue', { amount: formatMoney(overduePaise) })}
    </Badge>
  ) : (
    <Badge tone="warning" size="sm">
      {t('pickers.customer.due', { amount: formatMoney(balancePaise) })}
    </Badge>
  )
}
