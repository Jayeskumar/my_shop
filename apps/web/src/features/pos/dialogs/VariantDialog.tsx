/**
 * Size × colour matrix of an apparel / footwear variant parent: one tap adds the variant. Axes
 * come from the parent (variant_axes); cells show the price and stock of each child variant from
 * the offline catalogue. With one axis the matrix is a single row of buttons.
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, EmptyState, Skeleton } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatMoney, formatQty } from '@/lib/format'
import { getVariants } from '../lib/catalog'
import type { PosProduct } from '../lib/types'
import { type AddOptions, usePos } from '../state/pos-context'
import { productNames } from '../lib/names'

function axisValues(variants: PosProduct[], axis: string): string[] {
  const seen: string[] = []
  for (const v of variants) {
    const value = v.variant_attributes[axis]
    if (value !== undefined && !seen.includes(value)) seen.push(value)
  }
  return seen
}

export function VariantDialog({
  parent,
  options,
  onClose,
}: {
  parent: PosProduct
  options: AddOptions
  onClose: () => void
}) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const [variants, setVariants] = useState<PosProduct[] | null>(null)
  const tenantId = pos.scope?.tenantId
  useEffect(() => {
    if (!tenantId) return
    void getVariants(tenantId, parent.id).then(setVariants)
  }, [tenantId, parent.id])

  const axes = useMemo(() => {
    if (!variants?.length) return []
    const declared = parent.variant_axes.filter((a) =>
      variants.some((v) => v.variant_attributes[a] !== undefined),
    )
    if (declared.length) return declared
    return Object.keys(variants[0]?.variant_attributes ?? {})
  }, [variants, parent.variant_axes])

  const rowAxis = axes[0] ?? null
  const colAxis = axes[1] ?? null
  const rows = rowAxis && variants ? axisValues(variants, rowAxis) : []
  const cols = colAxis && variants ? axisValues(variants, colAxis) : [null]
  const find = (row: string, col: string | null): PosProduct | undefined =>
    variants?.find(
      (v) =>
        v.variant_attributes[rowAxis ?? ''] === row &&
        (col === null || v.variant_attributes[colAxis ?? ''] === col),
    )

  const pick = (v: PosProduct): void => {
    onClose()
    void pos.addProduct(v, options)
  }

  const names = productNames(parent)
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('variants.title', { name: names.primary })}
      description={t('variants.description')}
      size="xl"
    >
      {variants === null ? (
        <Skeleton className="h-48 rounded-lg" />
      ) : variants.length === 0 || !rowAxis ? (
        <EmptyState compact title={t('variants.none')} />
      ) : (
        <div className="overflow-x-auto pb-2">
          <table className="border-separate border-spacing-1.5">
            {colAxis ? (
              <thead>
                <tr>
                  <th className="px-2 text-start text-xs font-semibold uppercase text-muted-foreground">
                    {rowAxis} / {colAxis}
                  </th>
                  {cols.map((c) => (
                    <th key={c ?? '-'} className="px-2 text-center text-sm font-semibold">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
            ) : null}
            <tbody>
              {rows.map((r) => (
                <tr key={r}>
                  <th className="px-2 text-start text-sm font-semibold">{r}</th>
                  {cols.map((c) => {
                    const v = find(r, c)
                    if (!v)
                      return <td key={c ?? '-'} className="min-w-24 rounded-lg bg-surface-2/50" />
                    const out =
                      v.track_inventory && v.stock_qty_milli !== null && v.stock_qty_milli <= 0
                    return (
                      <td key={c ?? '-'}>
                        <button
                          type="button"
                          onClick={() => pick(v)}
                          className={cn(
                            'flex min-h-16 min-w-24 flex-col items-center justify-center rounded-lg border px-2 py-1.5 text-sm shadow-card transition-colors',
                            out
                              ? 'border-dashed border-border text-muted-foreground'
                              : 'border-border bg-surface hover:border-primary hover:bg-primary-soft',
                          )}
                        >
                          <span className="font-semibold tabular-nums">
                            {formatMoney(v.sale_price_paise, { decimals: 'auto' })}
                          </span>
                          {v.stock_qty_milli !== null && v.track_inventory ? (
                            <span
                              className={cn(
                                'text-xs tabular-nums',
                                out ? 'text-danger' : 'text-muted-foreground',
                              )}
                            >
                              {t('variants.stock', { qty: formatQty(v.stock_qty_milli, v.unit) })}
                            </span>
                          ) : null}
                        </button>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  )
}
