/**
 * Branch prices (feature store_pricing): per-store selling price / MRP overrides
 * (GET /store-prices?store_id=) edited in a grid and saved in one PUT /store-prices
 * {store_id, upserts, deletes}; clearing a price removes the override (the product price applies).
 */
import {
  type StorePriceRow,
  StorePricesUpdateSchema,
  catalogRoutes,
} from '@kadai/shared/api/catalog'
import { keepPreviousData } from '@tanstack/react-query'
import { RotateCcw, Save, Store } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CategoryPicker, StorePicker } from '@/components/pickers'
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  Money,
  MoneyInput,
  PageHeader,
  Pagination,
  SearchInput,
  Skeleton,
  Switch,
  notify,
  useConfirm,
} from '@/components/ui'
import { useCurrentStore } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { localizedName } from '@/lib/i18n'
import { useRouteMutation, useRouteQuery } from '@/lib/query'
import { useBreakpoint } from '@/lib/use-media-query'
import { UnsavedChangesGuard } from '../components/FormChrome'
import { catalogValidationText, firstIssueText } from '../lib/messages'
import { type StorePriceEdit, storePricesBody } from '../lib/store-prices'

const PAGE = 50

export default function StorePricesPage() {
  const { t } = useTranslation(['catalog', 'common'])
  const confirm = useConfirm()
  const current = useCurrentStore()
  const [storeId, setStoreId] = useState<string | null>(current?.id ?? null)
  const [q, setQ] = useState('')
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const [overridesOnly, setOverridesOnly] = useState(false)
  const [offset, setOffset] = useState(0)
  const [edits, setEdits] = useState<Record<string, StorePriceEdit>>({})
  const [error, setError] = useState<string | null>(null)
  /** Tablet / desktop: price grid; phones: one card per product. */
  const wide = useBreakpoint('md')

  const list = useRouteQuery(
    catalogRoutes.listStorePrices,
    {
      query: {
        store_id: storeId ?? '',
        ...(q ? { q } : {}),
        ...(categoryId ? { category_id: categoryId } : {}),
        overrides_only: overridesOnly,
        limit: PAGE,
        offset,
      },
    },
    { enabled: Boolean(storeId), placeholderData: keepPreviousData },
  )
  const rows = useMemo(() => list.data?.data ?? [], [list.data])
  const [seen, setSeen] = useState<Record<string, StorePriceRow>>({})
  const save = useRouteMutation(catalogRoutes.updateStorePrices, {
    invalidates: [catalogRoutes.listStorePrices, catalogRoutes.listProducts],
    onError: (e) => {
      const text = firstIssueText(e)
      if (text) setError(text)
      else notify.error(e)
    },
  })
  const changed = Object.keys(edits).length

  const edit = (row: StorePriceRow, patch: Partial<StorePriceEdit>): void => {
    setError(null)
    setSeen((m) => ({ ...m, [row.product_id]: row }))
    setEdits((m) => {
      const base = m[row.product_id] ?? {
        sale: row.store_sale_price_paise,
        mrp: row.store_mrp_paise,
      }
      const next = { ...base, ...patch }
      const unchanged = next.sale === row.store_sale_price_paise && next.mrp === row.store_mrp_paise
      const copy = { ...m }
      if (unchanged) delete copy[row.product_id]
      else copy[row.product_id] = next
      return copy
    })
  }

  const submit = (): void => {
    if (!storeId) return
    const body = storePricesBody(storeId, edits, Object.values(seen))
    const parsed = StorePricesUpdateSchema.safeParse(body)
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message
      setError(catalogValidationText(msg) ?? msg ?? null)
      return
    }
    save.mutate(
      { body },
      {
        onSuccess: (res) => {
          notify.success(t('store_prices.saved', { count: res.data.upserted + res.data.deleted }))
          setEdits({})
        },
      },
    )
  }

  const switchStore = async (id: string | null): Promise<void> => {
    if (
      changed &&
      !(await confirm({
        title: t('common:confirm.discard_title'),
        description: t('store_prices.discard_confirm'),
        tone: 'danger',
        confirmLabel: t('common:actions.continue'),
      }))
    )
      return
    setEdits({})
    setStoreId(id)
    setOffset(0)
  }

  return (
    <div className="mx-auto max-w-6xl">
      <UnsavedChangesGuard when={changed > 0 && !save.isPending} />
      <PageHeader
        title={t('pages.store_prices')}
        description={t('store_prices.description')}
        breadcrumbs={[
          { label: t('pages.products'), to: '/catalog/products' },
          { label: t('pages.store_prices') },
        ]}
      />
      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4 lg:items-center">
        <StorePicker
          value={storeId}
          onChange={(id) => void switchStore(id)}
          aria-label={t('common:fields.store')}
          clearable={false}
        />
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v)
            setOffset(0)
          }}
          placeholder={t('store_prices.search')}
        />
        <CategoryPicker
          value={categoryId}
          onChange={(id) => {
            setCategoryId(id)
            setOffset(0)
          }}
          placeholder={t('products.filter_category')}
          aria-label={t('products.filter_category')}
        />
        <div className="flex h-10 items-center rounded-md border border-border px-3">
          <Switch
            checked={overridesOnly}
            onCheckedChange={(v) => {
              setOverridesOnly(v)
              setOffset(0)
            }}
            label={t('store_prices.overrides_only')}
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
        {!storeId ? (
          <EmptyState compact icon={<Store />} title={t('store_prices.pick_store')} />
        ) : list.isPending ? (
          <div className="grid grid-cols-1 gap-2 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            compact
            icon={<Store />}
            title={t('store_prices.empty_title')}
            description={t('store_prices.empty_description')}
          />
        ) : !wide ? (
          <ul
            className={cn('divide-y divide-border', list.isFetching && 'opacity-60')}
            aria-label={t('pages.store_prices')}
          >
            {rows.map((r) => {
              const e = edits[r.product_id]
              const sale = e ? e.sale : r.store_sale_price_paise
              const mrp = e ? e.mrp : r.store_mrp_paise
              const name = localizedName(r.name, r.name_ta)
              return (
                <li
                  key={r.product_id}
                  className={cn('grid grid-cols-1 gap-2 px-3 py-3', e && 'bg-warning-soft/40')}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium leading-snug">{name}</p>
                      <p className="font-mono text-xs text-muted-foreground">{r.sku ?? '—'}</p>
                    </div>
                    <div className="shrink-0 text-end tabular-nums">
                      <Money paise={r.base_sale_price_paise} />
                      {r.base_mrp_paise !== null ? (
                        <span className="block text-xs text-muted-foreground">
                          {t('products.mrp_short')} <Money paise={r.base_mrp_paise} />
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.5rem] items-end gap-2">
                    <label className="grid min-w-0 gap-1 text-xs font-medium">
                      {t('store_prices.store_price')}
                      <MoneyInput
                        value={sale}
                        onChange={(v) => edit(r, { sale: v })}
                        placeholder={t('store_prices.same_as_base')}
                        aria-label={t('store_prices.price_of', { name })}
                      />
                    </label>
                    <label className="grid min-w-0 gap-1 text-xs font-medium">
                      {t('store_prices.store_mrp')}
                      <MoneyInput
                        value={mrp}
                        onChange={(v) => edit(r, { mrp: v })}
                        disabled={sale === null}
                        placeholder={t('store_prices.same_as_base')}
                        aria-label={t('store_prices.mrp_of', { name })}
                      />
                    </label>
                    {r.store_sale_price_paise !== null || e ? (
                      <IconButton
                        icon={<RotateCcw />}
                        label={t('store_prices.reset', { name })}
                        variant="ghost"
                        onClick={() => edit(r, { sale: null, mrp: null })}
                      />
                    ) : (
                      <span aria-hidden />
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm" aria-label={t('pages.store_prices')}>
              <thead className="bg-surface-2 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-start">{t('products.col_product')}</th>
                  <th className="px-3 py-2 text-end">{t('store_prices.base_price')}</th>
                  <th className="w-40 px-3 py-2 text-end">{t('store_prices.store_price')}</th>
                  <th className="w-40 px-3 py-2 text-end">{t('store_prices.store_mrp')}</th>
                  <th className="w-12 px-3 py-2" />
                </tr>
              </thead>
              <tbody className={list.isFetching ? 'opacity-60' : undefined}>
                {rows.map((r) => {
                  const e = edits[r.product_id]
                  const sale = e ? e.sale : r.store_sale_price_paise
                  const mrp = e ? e.mrp : r.store_mrp_paise
                  const name = localizedName(r.name, r.name_ta)
                  return (
                    <tr
                      key={r.product_id}
                      className={
                        e ? 'border-t border-border bg-warning-soft/40' : 'border-t border-border'
                      }
                    >
                      <td className="px-3 py-2">
                        <p className="font-medium">{name}</p>
                        <p className="font-mono text-xs text-muted-foreground">{r.sku ?? '—'}</p>
                      </td>
                      <td className="px-3 py-2 text-end tabular-nums">
                        <Money paise={r.base_sale_price_paise} />
                        {r.base_mrp_paise !== null ? (
                          <span className="block text-xs text-muted-foreground">
                            {t('products.mrp_short')} <Money paise={r.base_mrp_paise} />
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <MoneyInput
                          size="sm"
                          value={sale}
                          onChange={(v) => edit(r, { sale: v })}
                          placeholder={t('store_prices.same_as_base')}
                          aria-label={t('store_prices.price_of', { name })}
                          className="text-end"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <MoneyInput
                          size="sm"
                          value={mrp}
                          onChange={(v) => edit(r, { mrp: v })}
                          disabled={sale === null}
                          placeholder={t('store_prices.same_as_base')}
                          aria-label={t('store_prices.mrp_of', { name })}
                          className="text-end"
                        />
                      </td>
                      <td className="px-3 py-2 text-center">
                        {r.store_sale_price_paise !== null || e ? (
                          <IconButton
                            icon={<RotateCcw />}
                            label={t('store_prices.reset', { name })}
                            variant="ghost"
                            size="sm"
                            onClick={() => edit(r, { sale: null, mrp: null })}
                          />
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {list.data && list.data.page.total > PAGE ? (
          <div className="border-t border-border px-3">
            <Pagination {...list.data.page} onChange={(n) => setOffset(n.offset)} hidePageSize />
          </div>
        ) : null}
      </div>

      {changed > 0 ? (
        <div className="sticky bottom-0 z-20 -mx-4 mt-4 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur max-md:bottom-16 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
            <div className="grid grid-cols-1 gap-0.5">
              <Badge tone="warning">{t('store_prices.changed', { count: changed })}</Badge>
              {error ? (
                <p role="alert" className="text-sm font-medium text-danger">
                  {error}
                </p>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setEdits({})} disabled={save.isPending}>
                {t('form.discard')}
              </Button>
              <Button size="lg" leftIcon={<Save />} onClick={submit} loading={save.isPending}>
                {t('store_prices.save', { count: changed })}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
