/**
 * "Scan or search to add" field of the line editors: a ProductPicker that never keeps a value —
 * every pick (Enter on a scanned barcode does the exact lookup) is handed to `onPick` and the
 * field is ready for the next product. Services cannot be purchased into stock.
 */
import type { ProductListItem } from '@kadai/shared/api/catalog'
import { ScanBarcode } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ProductPicker } from '@/components/pickers'
import { Kbd, notify } from '@/components/ui'
import { cn } from '@/lib/cn'

export interface ProductAdderProps {
  /** Element id of the picker trigger (focus target of the grid / hotkeys). */
  id: string
  onPick: (product: ProductListItem) => void
  /** Store for the stock shown in the list (null = none). */
  storeId?: string | null
  disabled?: boolean
  /** Shortcut hint shown at the end of the field. */
  hotkey?: string
  className?: string
}

export function ProductAdder({
  id,
  onPick,
  storeId,
  disabled,
  hotkey,
  className,
}: ProductAdderProps) {
  const { t } = useTranslation('purchases')
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
        onChange={(product) => {
          if (!product) return
          if (product.kind === 'service') {
            notify.warning(t('errors.product_not_purchasable'))
            return
          }
          onPick(product)
        }}
      />
      {hotkey ? <Kbd combo={hotkey} className="hidden shrink-0 lg:inline-flex" /> : null}
    </div>
  )
}
