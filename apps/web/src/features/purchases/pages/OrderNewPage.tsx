/**
 * New purchase order (/purchases/orders/new). Prefills:
 *  - ?source=reorder&store_id=&product_ids=… (inventory's reorderPrefillPath, or "Open in editor"
 *    on the reorder tab): those products with their suggested quantity and last cost; the
 *    supplier when they share one (or ?supplier_id=).
 *  - ?supplier_id= alone preselects the supplier.
 */
import { parseInventoryPrefill } from '@kadai/shared/api/inventory'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router'
import { useCurrentStore, useMe } from '@/lib/auth'
import { useReorderSuggestions, useSupplier } from '../api'
import { OrderEditor } from '../components/OrderEditor'
import { DetailSkeleton } from '../components/PageState'
import { type OrderDraft, orderLineFromReorder } from '../lib/order-form'

export default function OrderNewPage() {
  const { t } = useTranslation('purchases')
  const location = useLocation()
  const me = useMe()
  const current = useCurrentStore()
  const prefill = useMemo(() => parseInventoryPrefill(location.search), [location.search])
  const storeId =
    (prefill.store_id && me?.stores.some((s) => s.id === prefill.store_id)
      ? prefill.store_id
      : null) ??
    current?.id ??
    null
  const fromReorder =
    prefill.source === 'reorder' && prefill.product_ids.length > 0 && Boolean(storeId)
  const suggestions = useReorderSuggestions(
    fromReorder && storeId ? { store_id: storeId, product_ids: prefill.product_ids } : null,
  )
  const supplier = useSupplier(prefill.supplier_id)

  const initial = useMemo<Partial<OrderDraft> | undefined>(() => {
    const s = supplier.data?.data
    const chosen = s ? { id: s.id, name: s.name, phone: s.phone, state_code: s.state_code } : null
    const base: Partial<OrderDraft> = {
      ...(storeId ? { store_id: storeId } : {}),
      ...(chosen ? { supplier: chosen } : {}),
    }
    const groups = suggestions.data?.data.groups
    if (!fromReorder || !groups) return base
    const wanted = new Set(prefill.product_ids)
    const items = groups.flatMap((g) => g.items.filter((i) => wanted.has(i.product_id)))
    const suppliers = new Set(
      groups
        .filter((g) => g.items.some((i) => wanted.has(i.product_id)))
        .map((g) => g.supplier?.id ?? ''),
    )
    const only = groups.find(
      (g) => g.supplier && suppliers.size === 1 && suppliers.has(g.supplier.id),
    )?.supplier
    return {
      ...base,
      lines: items.map((i) => orderLineFromReorder(i)),
      ...(chosen
        ? {}
        : only
          ? { supplier: { id: only.id, name: only.name, phone: only.phone, state_code: null } }
          : {}),
    }
  }, [fromReorder, suggestions.data, supplier.data, storeId, prefill.product_ids])

  if ((fromReorder && suggestions.isLoading) || (prefill.supplier_id && supplier.isLoading)) {
    return <DetailSkeleton />
  }
  return (
    <OrderEditor
      initial={initial}
      prefillNote={
        fromReorder && initial?.lines?.length
          ? t('orders.prefill_note', { count: initial.lines.length })
          : null
      }
    />
  )
}
