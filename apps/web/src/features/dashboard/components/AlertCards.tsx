/**
 * Things that need the owner's attention today, each linking into the module that fixes it: low /
 * out of stock, expiring and expired batches, supplier payables, UPI payments waiting or not yet
 * applied, and open shifts. A calm "all clear" line replaces a card with nothing to do.
 */
import type { Dashboard } from '@kadai/shared/api/reports'
import {
  AlarmClock,
  CheckCircle2,
  ChevronRight,
  PackageMinus,
  QrCode,
  Skull,
  Timer,
  Truck,
  type LucideIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Card, Money, Skeleton } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatMoney, formatNumber, formatTime } from '@/lib/format'
import { checkAccess, type AccessRule } from '@/lib/permissions'

const formatMoney0 = (paise: number): string => formatMoney(paise, { decimals: 0 })

type Tone = 'danger' | 'warning' | 'info' | 'neutral'

interface AlertItem {
  key: string
  icon: LucideIcon
  tone: Tone
  title: string
  value: ReactNode
  detail: ReactNode
  to: string | null
  linkLabel: string
  active: boolean
  /** Shown only when the member may open the target / the plan has the feature. */
  rule?: AccessRule
  extra?: ReactNode
}

const TONES: Record<Tone, string> = {
  danger: 'bg-danger-soft text-danger',
  warning: 'bg-warning-soft text-warning-soft-foreground',
  info: 'bg-info-soft text-info-soft-foreground',
  neutral: 'bg-surface-2 text-muted-foreground',
}

function AlertCard({ item }: { item: AlertItem }) {
  const Icon = item.active ? item.icon : CheckCircle2
  const body = (
    <>
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-lg [&_svg]:size-5',
          item.active ? TONES[item.tone] : 'bg-success-soft text-success',
        )}
        aria-hidden
      >
        <Icon />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-muted-foreground">{item.title}</span>
        <span className="block text-lg font-bold tabular-nums leading-tight text-foreground">
          {item.value}
        </span>
        <span className="block text-xs text-muted-foreground">{item.detail}</span>
        {item.extra}
      </span>
      {item.to && item.active ? (
        <ChevronRight
          className="mt-1 size-5 shrink-0 text-muted-foreground rtl:rotate-180"
          aria-hidden
        />
      ) : null}
    </>
  )
  const className = 'flex h-full items-start gap-3 p-4'
  return (
    <Card interactive={Boolean(item.to && item.active)} className="h-full">
      {item.to && item.active ? (
        <Link
          to={item.to}
          className={cn(className, 'rounded-xl focus-visible:outline-2 focus-visible:outline-ring')}
          aria-label={`${item.title}: ${item.linkLabel}`}
        >
          {body}
        </Link>
      ) : (
        <div className={className}>{body}</div>
      )}
    </Card>
  )
}

export function AlertCards({ data }: { data: Dashboard | null }) {
  const { t } = useTranslation('dashboard')
  const auth = useAuth((s) => s)
  if (!data) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
    )
  }
  const { stock, payables, upi, shifts } = data
  const lowTotal = stock.low_stock + stock.out_of_stock
  const can = (rule?: AccessRule): boolean => !rule || checkAccess(rule, auth) === 'allowed'

  const items: AlertItem[] = [
    {
      key: 'low_stock',
      icon: PackageMinus,
      tone: stock.out_of_stock > 0 ? 'danger' : 'warning',
      title: t('alerts.low_stock'),
      value: formatNumber(lowTotal),
      detail:
        lowTotal > 0
          ? t('alerts.low_stock_detail', { low: stock.low_stock, out: stock.out_of_stock })
          : t('alerts.low_stock_ok'),
      to: can({ permission: 'inventory.read' }) ? '/inventory/stock?filter=low' : null,
      linkLabel: t('alerts.open_stock'),
      active: lowTotal > 0,
    },
    {
      key: 'expiring',
      icon: Timer,
      tone: 'warning',
      title: t('alerts.expiring', { days: stock.expiry_warning_days }),
      value: formatNumber(stock.expiring),
      detail:
        stock.expiring > 0 ? (
          <>
            {t('alerts.value_at_cost')} <Money paise={stock.expiring_value_paise} decimals={0} />
          </>
        ) : (
          t('alerts.expiring_ok')
        ),
      to: `/reports/expiry?days=${stock.expiry_warning_days}&include_expired=false`,
      linkLabel: t('alerts.open_expiry'),
      active: stock.expiring > 0,
      rule: { feature: 'batches_expiry' },
    },
    {
      key: 'expired',
      icon: Skull,
      tone: 'danger',
      title: t('alerts.expired'),
      value: formatNumber(stock.expired),
      detail:
        stock.expired > 0 ? (
          <>
            {t('alerts.remove_from_shelf')} ·{' '}
            <Money paise={stock.expired_value_paise} decimals={0} />
          </>
        ) : (
          t('alerts.expired_ok')
        ),
      to: can({ permission: 'inventory.read' })
        ? '/inventory/batches?tab=expired'
        : '/reports/expiry?days=0&include_expired=true',
      linkLabel: t('alerts.open_expired'),
      active: stock.expired > 0,
      rule: { feature: 'batches_expiry' },
    },
    {
      key: 'payables',
      icon: Truck,
      tone: payables.overdue_paise > 0 ? 'danger' : 'info',
      title: t('alerts.payables'),
      value: <Money paise={payables.total_paise} decimals={0} />,
      detail:
        payables.total_paise > 0
          ? t('alerts.payables_detail', {
              count: payables.suppliers_with_due,
              due7: formatMoney0(payables.due_next_7_days_paise),
              overdue: formatMoney0(payables.overdue_paise),
            })
          : t('alerts.payables_ok'),
      to: '/reports/supplier-outstanding',
      linkLabel: t('alerts.open_payables'),
      active: payables.total_paise > 0,
      rule: { feature: 'purchases' },
    },
    {
      key: 'upi',
      icon: QrCode,
      tone: upi.unapplied_count > 0 ? 'warning' : 'info',
      title: t('alerts.upi'),
      value: formatNumber(upi.pending_intents + upi.unapplied_count),
      detail:
        upi.pending_intents + upi.unapplied_count > 0
          ? t('alerts.upi_detail', {
              pending: upi.pending_intents,
              unapplied: upi.unapplied_count,
              amount: formatMoney0(upi.unapplied_paise),
            })
          : t('alerts.upi_ok'),
      to: can({ permission: 'payments.read' })
        ? `/payments/upi${upi.unapplied_count > 0 ? '?tab=unapplied' : ''}`
        : null,
      linkLabel: t('alerts.open_upi'),
      active: upi.pending_intents + upi.unapplied_count > 0,
    },
  ]
  if (shifts) {
    const open = shifts.open
    items.push({
      key: 'shifts',
      icon: AlarmClock,
      tone: 'info',
      title: t('alerts.open_shifts'),
      value: formatNumber(shifts.open_count),
      detail: shifts.open_count > 0 ? t('alerts.open_shifts_detail') : t('alerts.open_shifts_ok'),
      to: null,
      linkLabel: '',
      active: shifts.open_count > 0,
      extra:
        open.length > 0 ? (
          <ul className="mt-1.5 grid gap-1">
            {open.slice(0, 3).map((s) => {
              const text = t('alerts.shift_line', {
                counter: s.register_code,
                name: s.opened_by_name ?? '—',
                time: formatTime(s.opened_at),
              })
              return (
                <li key={s.shift_id} className="text-xs">
                  {can({ permission: ['shifts.operate', 'shifts.manage'], feature: 'shifts' }) ? (
                    <Link
                      to={`/accounting/shifts/${s.shift_id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {text}
                    </Link>
                  ) : (
                    text
                  )}
                </li>
              )
            })}
          </ul>
        ) : null,
    })
  }

  const visible = items.filter((i) => can(i.rule))
  return (
    <section
      aria-label={t('alerts.label')}
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
    >
      {visible.map((item) => (
        <AlertCard key={item.key} item={item} />
      ))}
    </section>
  )
}
