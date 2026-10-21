/**
 * Mini khata card for the POS and other screens that pick a customer: name, mobile, current due
 * or advance, overdue warning, credit still available against the limit, and loyalty points
 * with their rupee value (plan feature + settings). Pass the CustomerListItem the picker gave;
 * the card loads GET /customers/:id/summary for the credit and loyalty details.
 *
 *   <CustomerSummaryCard customer={customer} onClear={() => setCustomer(null)} />
 */
import { AlertTriangle, Gift, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { type CustomerListItem, loyaltyValuePaise } from '@kadai/shared/api/parties'
import { Avatar, Badge, IconButton, PhoneLink, Skeleton } from '@/components/ui'
import { useCan, useFeature, useMe } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatMoney, formatNumber } from '@/lib/format'
import { useCustomerSummary } from '../api'
import { partyNames } from '../lib/labels'
import { BalanceAmount } from './BalanceAmount'
import { CreditLimitBar } from './CreditLimitBar'

export interface CustomerSummaryCardProps {
  customer: CustomerListItem
  /** Shows a ✕ to remove the customer from the bill. */
  onClear?: () => void
  /** Extra actions (e.g. "Redeem points") under the facts. */
  actions?: ReactNode
  /** Link the name to the khata page (default true). */
  linkToKhata?: boolean
  className?: string
}

export function CustomerSummaryCard({
  customer,
  onClear,
  actions,
  linkToKhata = true,
  className,
}: CustomerSummaryCardProps) {
  const { t, i18n } = useTranslation('parties')
  const me = useMe()
  const canRead = useCan('customers.read')
  const loyaltyFeature = useFeature('loyalty')
  const loyalty = me?.settings.loyalty
  const showLoyalty = loyaltyFeature && Boolean(loyalty?.enabled)
  const summary = useCustomerSummary(customer.id, { enabled: canRead })
  const s = summary.data?.data
  const names = partyNames(customer.name, customer.name_ta, i18n.language)
  const balance = s?.balance_paise ?? customer.balance_paise
  const overdue = s?.overdue_paise ?? customer.overdue_paise
  const points = s?.loyalty_points ?? customer.loyalty_points

  return (
    <div
      className={cn(
        'grid gap-3 rounded-xl border border-border bg-surface p-3 shadow-card',
        overdue > 0 && 'border-danger/40',
        className,
      )}
      data-testid="customer-summary-card"
    >
      <div className="flex items-start gap-3">
        <Avatar name={names.primary} size="md" />
        <div className="min-w-0 flex-1">
          {linkToKhata ? (
            <Link
              to={`/parties/customers/${customer.id}`}
              className="block truncate font-semibold hover:text-primary hover:underline"
            >
              {names.primary}
            </Link>
          ) : (
            <div className="truncate font-semibold">{names.primary}</div>
          )}
          <PhoneLink phone={customer.phone} whatsapp className="text-sm" />
        </div>
        {onClear ? (
          <IconButton icon={<X />} label={t('summary_card.remove')} size="sm" onClick={onClear} />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <BalanceAmount partyType="customer" balancePaise={balance} size="lg" />
        {overdue > 0 ? (
          <Badge tone="danger" icon={<AlertTriangle className="size-3.5" />}>
            {t('summary_card.overdue', { amount: formatMoney(overdue, { decimals: 'auto' }) })}
          </Badge>
        ) : null}
      </div>

      {summary.isLoading ? (
        <Skeleton className="h-2 w-full" />
      ) : s?.credit_limit_paise != null ? (
        <CreditLimitBar balancePaise={balance} creditLimitPaise={s.credit_limit_paise} />
      ) : null}

      {showLoyalty && loyalty ? (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-accent-soft/60 px-3 py-2 text-sm">
          <span className="inline-flex items-center gap-1.5 font-medium text-accent-soft-foreground">
            <Gift className="size-4" aria-hidden />
            {t('summary_card.points', { points: formatNumber(points) })}
          </span>
          <span className="tabular-nums text-muted-foreground">
            {t('summary_card.worth', {
              amount: formatMoney(s?.loyalty_value_paise ?? loyaltyValuePaise(points, loyalty)),
            })}
          </span>
        </div>
      ) : null}

      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  )
}
