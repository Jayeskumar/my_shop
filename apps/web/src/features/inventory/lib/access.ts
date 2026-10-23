/**
 * What the signed-in member may do on the inventory screens (permission + plan feature), the
 * business date "today" in the tenant timezone, and the default store of the forms.
 * Buttons the member cannot use are hidden; the server enforces the same rules.
 */
import { type TransferAction, transferAccessStoreId } from '@kadai/shared/api/inventory'
import { DEFAULT_TIMEZONE, todayIn } from '@kadai/shared/fy'
import { useCallback, useMemo } from 'react'
import { useCan, useCurrentStore, useFeature, useMe } from '@/lib/auth'

export interface InventoryAccess {
  read: boolean
  /** Adjustments, stock takes, opening stock, write-offs, batch dates. */
  adjust: boolean
  /** Transfers: permission and the stock_transfers + multi_store plan features. */
  transfer: boolean
  /** Batch & expiry screens (plan feature batches_expiry). */
  batches: boolean
  /** Batch price edits (inventory.adjust or catalog.write). */
  editBatchPrices: boolean
  /** Purchase orders / returns can be opened (reorder, return to supplier). */
  purchases: boolean
  exportData: boolean
}

export function useInventoryAccess(): InventoryAccess {
  const read = useCan('inventory.read')
  const adjust = useCan('inventory.adjust')
  const transferPerm = useCan('inventory.transfer')
  const transfersFeature = useFeature('stock_transfers')
  const multiStore = useFeature('multi_store')
  const batches = useFeature('batches_expiry')
  const catalogWrite = useCan('catalog.write')
  const purchasesPerm = useCan('purchases.write')
  const purchasesFeature = useFeature('purchases')
  const exportData = useCan(['data.export', 'inventory.read'])
  return useMemo(
    () => ({
      read,
      adjust,
      transfer: transferPerm && transfersFeature && multiStore,
      batches,
      editBatchPrices: adjust || catalogWrite,
      purchases: purchasesPerm && purchasesFeature,
      exportData,
    }),
    [
      read,
      adjust,
      transferPerm,
      transfersFeature,
      multiStore,
      batches,
      catalogWrite,
      purchasesPerm,
      purchasesFeature,
      exportData,
    ],
  )
}

/** Today (YYYY-MM-DD) in the tenant timezone. */
export function useToday(): string {
  const me = useMe()
  return todayIn(me?.tenant.timezone ?? DEFAULT_TIMEZONE)
}

/** The member's current store, else the first active store they can use. */
export function useDefaultStoreId(): string | null {
  const current = useCurrentStore()
  const me = useMe()
  return current?.id ?? me?.stores.find((s) => s.is_active)?.id ?? null
}

/** True when the member can work in the store (store-scoped members see only theirs). */
export function useStoreAccess(): (storeId: string | null | undefined) => boolean {
  const me = useMe()
  return useCallback(
    (storeId) => Boolean(storeId && me?.stores.some((s) => s.id === storeId)),
    [me],
  )
}

/** Whether the member may perform a transfer action (permission, plan and store scope). */
export function useTransferActionAllowed(): (
  action: TransferAction,
  transfer: { from_store_id: string; to_store_id: string },
) => boolean {
  const access = useInventoryAccess()
  const storeAccess = useStoreAccess()
  return useCallback(
    (action, transfer) => access.transfer && storeAccess(transferAccessStoreId(action, transfer)),
    [access.transfer, storeAccess],
  )
}
