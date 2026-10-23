/**
 * Quick keys of the billing screen (settings.pos.quick_keys, ≤ 60 product ids): add with the
 * shared product picker, reorder (the POS shows them in this order) and remove. Names come from
 * GET /products?ids=… (catalog).
 */
import { ArrowDown, ArrowUp, PackageX, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { catalogRoutes } from '@kadai/shared/api/catalog'
import { ProductPicker } from '@/components/pickers'
import { IconButton, Skeleton } from '@/components/ui'
import { useCan } from '@/lib/auth'
import { formatMoney } from '@/lib/format'
import { localizedName } from '@/lib/i18n'
import { useRouteQuery } from '@/lib/query'

export const QUICK_KEYS_MAX = 60

export function QuickKeysEditor({
  value,
  onChange,
  disabled,
}: {
  value: readonly string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}) {
  const { t } = useTranslation('settings')
  const canReadCatalog = useCan('catalog.read')
  const products = useRouteQuery(
    catalogRoutes.listProducts,
    { query: { ids: [...value], limit: QUICK_KEYS_MAX } },
    { enabled: canReadCatalog && value.length > 0 },
  )
  const byId = new Map((products.data?.data ?? []).map((p) => [p.id, p]))
  const full = value.length >= QUICK_KEYS_MAX

  const move = (index: number, delta: -1 | 1): void => {
    const next = [...value]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-3">
      {canReadCatalog && !disabled ? (
        <ProductPicker
          value={null}
          onChange={(p) => {
            if (!p || value.includes(p.id) || full) return
            onChange([...value, p.id])
          }}
          disabled={full}
          placeholder={
            full ? t('pos.quick_keys_full', { max: QUICK_KEYS_MAX }) : t('pos.quick_keys_add')
          }
          aria-label={t('pos.quick_keys_add')}
          clearable={false}
        />
      ) : null}
      {value.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
          {t('pos.quick_keys_empty')}
        </p>
      ) : (
        <ol className="grid gap-2 sm:grid-cols-2" aria-label={t('pos.quick_keys')}>
          {value.map((id, index) => {
            const p = byId.get(id)
            const loading = products.isLoading && canReadCatalog
            return (
              <li
                key={id}
                className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1.5"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary-soft text-xs font-semibold tabular-nums text-primary">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  {loading ? (
                    <Skeleton className="h-4 w-32" />
                  ) : p ? (
                    <>
                      <span className="block truncate text-sm font-medium">
                        {localizedName(p.name, p.name_ta)}
                      </span>
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        {formatMoney(p.sale_price_paise)}
                      </span>
                    </>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                      <PackageX className="size-4" aria-hidden />
                      {canReadCatalog ? t('pos.quick_key_missing') : t('pos.quick_key_hidden')}
                    </span>
                  )}
                </span>
                {!disabled ? (
                  <span className="flex shrink-0 items-center">
                    <IconButton
                      size="sm"
                      variant="ghost"
                      icon={<ArrowUp />}
                      label={t('pos.quick_key_up')}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    />
                    <IconButton
                      size="sm"
                      variant="ghost"
                      icon={<ArrowDown />}
                      label={t('pos.quick_key_down')}
                      disabled={index === value.length - 1}
                      onClick={() => move(index, 1)}
                    />
                    <IconButton
                      size="sm"
                      variant="ghost"
                      icon={<X />}
                      label={t('pos.quick_key_remove')}
                      onClick={() => onChange(value.filter((x) => x !== id))}
                    />
                  </span>
                ) : null}
              </li>
            )
          })}
        </ol>
      )}
      <p className="text-xs text-muted-foreground">
        {t('pos.quick_keys_count', { count: value.length, max: QUICK_KEYS_MAX })}
      </p>
    </div>
  )
}
