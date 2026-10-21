/**
 * Batch picker for one product (sales returns, adjustments, transfers, debit notes): batches with
 * stock in the store from GET /batches?product_id=&store_id=, in FEFO order (earliest expiry
 * first, no expiry last). Expired batches are shown but disabled unless `allowExpired`
 * (expiry write-offs / returns to the supplier). A batch is still sellable on its expiry date.
 */
import { type BatchRow, inventoryRoutes } from '@kadai/shared/api/inventory'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Combobox, Qty } from '@/components/ui'
import { formatDate, formatMoney } from '@/lib/format'
import { useCurrentStore } from '@/lib/auth'
import { useRouteQuery } from '@/lib/query'
import { PickerRow } from './picker-row'
import { type PickerBaseProps, fefoOrder, joinParts, keywordsOf } from './shared'

/** Most batches listed for one product. */
const BATCH_LIMIT = 200

export interface BatchPickerProps extends PickerBaseProps {
  /** The product whose batches are listed (null → disabled). */
  productId: string | null | undefined
  /** Batch id. */
  value: string | null | undefined
  onChange: (batchId: string | null, batch: BatchRow | null) => void
  /** Store for stock (default the current store; null = every accessible store). */
  storeId?: string | null
  /** Let expired batches be picked (write-offs, supplier returns). */
  allowExpired?: boolean
  /** Only batches with stock (default true). */
  withStockOnly?: boolean
}

export function BatchPicker({
  productId,
  value,
  onChange,
  storeId,
  allowExpired = false,
  withStockOnly = true,
  placeholder,
  ...base
}: BatchPickerProps) {
  const { t } = useTranslation('common')
  const currentStore = useCurrentStore()
  const store = storeId === undefined ? currentStore?.id : (storeId ?? undefined)
  const batches = useRouteQuery(
    inventoryRoutes.listBatches,
    {
      query: {
        product_id: productId ?? undefined,
        ...(store ? { store_id: store } : {}),
        with_stock_only: withStockOnly,
        sort: 'expiry_date',
        limit: BATCH_LIMIT,
      },
    },
    { enabled: Boolean(productId) },
  )
  const options = useMemo(() => [...(batches.data?.data ?? [])].sort(fefoOrder), [batches.data])
  const selected = useMemo(() => options.find((b) => b.id === value) ?? null, [options, value])
  return (
    <Combobox<BatchRow>
      {...base}
      disabled={base.disabled || !productId}
      value={selected}
      onChange={(b) => onChange(b?.id ?? null, b)}
      options={options}
      isOptionDisabled={allowExpired ? undefined : (b) => b.expiry_status === 'expired'}
      getOptionValue={(b) => b.id}
      getOptionLabel={(b) => keywordsOf(b.batch_no, b.supplier_name)}
      renderValue={(b) =>
        joinParts(
          b.batch_no,
          b.expiry_date ? t('pickers.batch.expiry', { date: formatDate(b.expiry_date) }) : null,
        )
      }
      renderOption={(b) => <BatchOption batch={b} />}
      emptyText={t('pickers.batch.none')}
      placeholder={
        placeholder ??
        (productId ? t('pickers.batch.placeholder') : t('pickers.batch.select_product_first'))
      }
      searchPlaceholder={t('pickers.batch.search_placeholder')}
    />
  )
}

function BatchOption({ batch }: { batch: BatchRow }) {
  const { t } = useTranslation('common')
  const expiry =
    batch.expiry_status === 'expired' ? (
      <Badge tone="danger" size="sm">
        {t('pickers.batch.expired')}
      </Badge>
    ) : batch.expiry_status === 'expiring' && batch.days_to_expiry !== null ? (
      <Badge tone="warning" size="sm">
        {batch.days_to_expiry === 0
          ? t('pickers.batch.expires_today')
          : t('pickers.batch.expiring', { count: batch.days_to_expiry })}
      </Badge>
    ) : null
  return (
    <PickerRow
      title={
        <span className="flex items-center gap-2">
          <span className="truncate">{batch.batch_no}</span>
          {expiry}
        </span>
      }
      subtitle={joinParts(
        batch.expiry_date
          ? t('pickers.batch.expiry', { date: formatDate(batch.expiry_date) })
          : t('pickers.batch.no_expiry'),
        batch.mrp_paise !== null
          ? t('pickers.batch.mrp', { amount: formatMoney(batch.mrp_paise) })
          : null,
        batch.supplier_name,
      )}
      aside={
        <Qty
          milli={batch.qty_milli}
          unit={batch.unit}
          packSize={batch.pack_size}
          colorize
          className="font-medium"
        />
      }
    />
  )
}
