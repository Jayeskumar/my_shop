/**
 * The four everyday jobs as big buttons — New bill (F2), Add product, Purchase entry, Receive
 * payment — each shown only when the member may do it on this plan.
 */
import { HandCoins, PackagePlus, ShoppingCart, Truck, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Kbd } from '@/components/ui'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { checkAccess, type AccessRule } from '@/lib/permissions'

interface Action {
  key: 'new_bill' | 'add_product' | 'purchase_entry' | 'receive_payment'
  to: string
  icon: LucideIcon
  rule: AccessRule
  primary?: boolean
  hotkey?: string
}

const ACTIONS: readonly Action[] = [
  {
    key: 'new_bill',
    to: '/pos',
    icon: ShoppingCart,
    rule: { permission: 'pos.use', feature: 'pos' },
    primary: true,
    hotkey: 'F2',
  },
  {
    key: 'add_product',
    to: '/catalog/products/new',
    icon: PackagePlus,
    rule: { permission: 'catalog.write' },
  },
  {
    key: 'purchase_entry',
    to: '/purchases/bills/new',
    icon: Truck,
    rule: { permission: 'purchases.write', feature: 'purchases' },
  },
  {
    key: 'receive_payment',
    to: '/payments?new=receive',
    icon: HandCoins,
    rule: { permission: 'payments.collect' },
  },
]

export function QuickActions() {
  const { t } = useTranslation('dashboard')
  const auth = useAuth((s) => s)
  const allowed = ACTIONS.filter((a) => checkAccess(a.rule, auth) === 'allowed')
  if (!allowed.length) return null
  return (
    <nav aria-label={t('actions.label')} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {allowed.map((a) => {
        const Icon = a.icon
        return (
          <Link
            key={a.key}
            to={a.to}
            className={cn(
              'flex min-h-14 items-center gap-3 rounded-xl border px-3 py-2.5 text-sm font-semibold shadow-card transition-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              a.primary
                ? 'border-transparent bg-accent text-accent-foreground hover:bg-accent-hover'
                : 'border-border bg-surface text-foreground hover:border-primary/40 hover:bg-surface-2',
            )}
          >
            <span
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-lg [&_svg]:size-5',
                a.primary
                  ? 'bg-accent-foreground/10'
                  : 'bg-primary-soft text-primary-soft-foreground',
              )}
              aria-hidden
            >
              <Icon />
            </span>
            <span className="min-w-0 flex-1 leading-tight">{t(`actions.${a.key}`)}</span>
            {a.hotkey ? (
              <Kbd className="hidden border-accent-foreground/20 bg-accent-foreground/10 text-accent-foreground lg:inline-flex">
                {a.hotkey}
              </Kbd>
            ) : null}
          </Link>
        )
      })}
    </nav>
  )
}
