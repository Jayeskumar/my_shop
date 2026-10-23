/**
 * Cached queries to refresh after anything that moves stock (posting an adjustment, opening
 * stock, dispatching / receiving a transfer, cancelling either). `invalidateRoutes` also covers
 * routes nested under a path (/stock → /stock/alerts, /stock/movements, /stock/products/:id).
 */
import { catalogRoutes } from '@kadai/shared/api/catalog'
import type { RouteDef } from '@kadai/shared/api/common'
import { inventoryRoutes } from '@kadai/shared/api/inventory'

export const STOCK_ROUTES: readonly RouteDef[] = [
  inventoryRoutes.listStock,
  inventoryRoutes.listBatches,
  inventoryRoutes.listAdjustments,
  inventoryRoutes.listTransfers,
  catalogRoutes.listProducts,
]
