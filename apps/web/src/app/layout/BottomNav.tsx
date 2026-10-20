import { Home, Menu, Package, ReceiptText, ShoppingCart } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router'
import { cn } from '@/lib/cn'
import { usePermission } from '@/lib/permissions'
import { useFeature } from '@/lib/auth'

/** Phone quick actions (below md): Home, Sales, New bill (centre), Products, Menu. */
export function BottomNav({ onMenu }: { onMenu: () => void }) {
  const { t } = useTranslation('nav')
  const posPermission = usePermission('pos.use')
  const posFeature = useFeature('pos')
  const canPos = posPermission && posFeature
  const canSales = usePermission('sales.read')
  const canProducts = usePermission('catalog.read')
  const item = (active: boolean): string =>
    cn(
      'flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-medium',
      active ? 'text-primary' : 'text-muted-foreground',
    )
  return (
    <nav
      aria-label={t('shell.menu')}
      className="no-print fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 pb-safe backdrop-blur md:hidden"
    >
      <div className="mx-auto flex h-16 max-w-lg items-stretch px-2">
        <NavLink to="/" end className={({ isActive }) => item(isActive)}>
          <Home className="size-5" />
          <span className="truncate">{t('shell.bottom_home')}</span>
        </NavLink>
        {canSales ? (
          <NavLink to="/sales/invoices" className={({ isActive }) => item(isActive)}>
            <ReceiptText className="size-5" />
            <span className="truncate">{t('shell.bottom_sales')}</span>
          </NavLink>
        ) : (
          <span className="flex-1" />
        )}
        <div className="flex flex-1 items-start justify-center">
          {canPos ? (
            <NavLink
              to="/pos"
              aria-label={t('shell.new_bill')}
              className="-mt-5 flex size-14 flex-col items-center justify-center rounded-full bg-accent text-accent-foreground shadow-raised ring-4 ring-surface active:bg-accent-hover"
            >
              <ShoppingCart className="size-6" />
              <span className="sr-only">{t('shell.bottom_bill')}</span>
            </NavLink>
          ) : null}
        </div>
        {canProducts ? (
          <NavLink to="/catalog/products" className={({ isActive }) => item(isActive)}>
            <Package className="size-5" />
            <span className="truncate">{t('shell.bottom_products')}</span>
          </NavLink>
        ) : (
          <span className="flex-1" />
        )}
        <button type="button" onClick={onMenu} className={item(false)}>
          <Menu className="size-5" />
          <span className="truncate">{t('shell.bottom_menu')}</span>
        </button>
      </div>
    </nav>
  )
}
