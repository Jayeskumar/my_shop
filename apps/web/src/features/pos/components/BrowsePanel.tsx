/**
 * Touch browsing for items without barcodes (loose rice, vegetables, sweets): quick keys pinned
 * in settings, or category tiles → product tiles. Reads the offline catalogue only.
 */
import { ArrowLeft, LayoutGrid, Star } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, EmptyState, Skeleton } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatMoney } from '@/lib/format'
import { localizedName } from '@/lib/i18n'
import { getProducts, productsOfCategory } from '../lib/catalog'
import type { PosProduct } from '../lib/types'
import { usePos } from '../state/pos-context'
import { productNames } from '../lib/names'

type Mode = 'quick' | 'categories'

function ProductTile({ product, onPick }: { product: PosProduct; onPick: () => void }) {
  const names = productNames(product)
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        'flex h-[4.25rem] flex-col justify-between gap-0.5 rounded-lg border border-border bg-surface px-2.5 py-2 text-start shadow-card transition-colors',
        'hover:border-primary hover:bg-primary-soft/40 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-ring',
      )}
    >
      <span className="line-clamp-2 text-[13px] font-semibold leading-tight">{names.primary}</span>
      <span className="text-sm font-medium tabular-nums text-primary">
        {formatMoney(product.sale_price_paise, { decimals: 'auto' })}
      </span>
    </button>
  )
}

export function BrowsePanel({ className }: { className?: string }) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const context = pos.context
  const tenantId = pos.scope?.tenantId
  const hasQuickKeys = (context?.quick_keys.length ?? 0) > 0
  const [mode, setMode] = useState<Mode>(hasQuickKeys ? 'quick' : 'categories')
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const [products, setProducts] = useState<PosProduct[] | null>(null)

  const topCategories = useMemo(
    () =>
      (context?.categories ?? [])
        .filter((c) => c.is_active && c.parent_id === null)
        .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    [context],
  )

  useEffect(() => {
    if (!tenantId || !context) return
    let cancelled = false
    setProducts(null)
    const load = async (): Promise<PosProduct[]> => {
      if (mode === 'quick') {
        const rows = await getProducts(tenantId, context.quick_keys)
        const order = new Map(context.quick_keys.map((id, i) => [id, i]))
        return rows
          .filter((p) => p.is_active)
          .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      }
      if (!categoryId) return []
      const ids = [
        categoryId,
        ...context.categories.filter((c) => c.parent_id === categoryId).map((c) => c.id),
      ]
      return productsOfCategory(tenantId, ids)
    }
    void load().then((rows) => {
      if (!cancelled) setProducts(rows)
    })
    return () => {
      cancelled = true
    }
  }, [tenantId, context, mode, categoryId, pos.catalogRevision])

  const category = context?.categories.find((c) => c.id === categoryId) ?? null

  return (
    <section
      className={cn('flex min-h-0 flex-col gap-2', className)}
      aria-label={t('browse.title')}
    >
      <div className="flex items-center gap-2">
        {mode === 'categories' && category ? (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<ArrowLeft />}
            onClick={() => setCategoryId(null)}
          >
            {localizedName(category.name, category.name_ta)}
          </Button>
        ) : (
          <div className="flex gap-1 rounded-lg bg-surface-2 p-1" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'quick'}
              onClick={() => setMode('quick')}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium',
                mode === 'quick' ? 'bg-surface shadow-card' : 'text-muted-foreground',
              )}
            >
              <Star className="size-4" aria-hidden />
              {t('browse.quick_keys')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'categories'}
              onClick={() => setMode('categories')}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium',
                mode === 'categories' ? 'bg-surface shadow-card' : 'text-muted-foreground',
              )}
            >
              <LayoutGrid className="size-4" aria-hidden />
              {t('browse.categories')}
            </button>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {mode === 'categories' && !categoryId ? (
          topCategories.length === 0 ? (
            <EmptyState compact title={t('browse.no_categories')} />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
              {topCategories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCategoryId(c.id)}
                  className="h-14 rounded-lg border border-border bg-accent-soft/60 px-3 py-1.5 text-start text-[13px] font-semibold leading-tight text-accent-soft-foreground shadow-card hover:border-accent focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="line-clamp-2">{localizedName(c.name, c.name_ta)}</span>
                </button>
              ))}
            </div>
          )
        ) : products === null ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-[4.25rem] rounded-lg" />
            ))}
          </div>
        ) : products.length === 0 ? (
          <EmptyState
            compact
            title={mode === 'quick' ? t('browse.no_quick_keys') : t('browse.empty_category')}
            description={mode === 'quick' ? t('browse.no_quick_keys_hint') : undefined}
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
            {products.map((p) => (
              <ProductTile key={p.id} product={p} onPick={() => void pos.addProduct(p)} />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
