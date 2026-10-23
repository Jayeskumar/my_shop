/**
 * "Scan or search to add" field of the line editors: a ProductPicker that never keeps a value —
 * every pick (Enter on a scanned barcode does the exact lookup) is handed to `onPick` and the
 * field is ready for the next scan (focus returns to it when the list closes).
 */
import type { ProductListItem } from '@kadai/shared/api/catalog'
import { ScanBarcode } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ProductPicker } from '@/components/pickers'
import { notify } from '@/components/ui'
import { cn } from '@/lib/cn'

export interface ProductAdderProps {
  onPick: (product: ProductListItem) => void
  /** Store for the stock shown in the list (null = none). */
  storeId?: string | null
  /** Only batch-tracked products (expiry write-offs). */
  batchTrackedOnly?: boolean
  disabled?: boolean
  id?: string
  className?: string
}

export function ProductAdder({
  onPick,
  storeId,
  batchTrackedOnly,
  disabled,
  id,
  className,
}: ProductAdderProps) {
  const { t } = useTranslation('inventory')
  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)}>
      <ScanBarcode className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <ProductPicker
        id={id}
        value={null}
        storeId={storeId}
        clearable={false}
        disabled={disabled}
        size="lg"
        className="min-w-0 flex-1"
        aria-label={t('lines.add_product')}
        placeholder={t('lines.add_placeholder')}
        {...(batchTrackedOnly ? { filters: { track_batches: true } } : {})}
        onChange={(product) => {
          if (!product) return
          if (!product.track_inventory || product.kind === 'service') {
            notify.warning(t('errors.not_stock_item'))
            return
          }
          onPick(product)
        }}
      />
    </div>
  )
}
