/** The fixtures answer exactly what the contract allows (so MSW tests exercise real shapes). */
import { catalogRoutes } from '@kadai/shared/api/catalog'
import { identityRoutes } from '@kadai/shared/api/identity'
import { inventoryRoutes } from '@kadai/shared/api/inventory'
import { partiesRoutes } from '@kadai/shared/api/parties'
import { describe, expect, it } from 'vitest'
import * as F from './fixtures'

function ok(
  schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } },
  value: unknown,
) {
  const res = schema.safeParse(value)
  if (!res.success) throw new Error(JSON.stringify(res.error, null, 2))
  expect(res.success).toBe(true)
}

describe('inventory fixtures', () => {
  it('match the inventory response schemas', () => {
    ok(inventoryRoutes.listStock.response, F.stockList())
    ok(inventoryRoutes.stockAlerts.response, { data: F.stockAlerts() })
    ok(inventoryRoutes.listMovements.response, { data: F.movements(), page: F.page(3) })
    ok(inventoryRoutes.productStock.response, { data: F.productStock() })
    ok(inventoryRoutes.listBatches.response, { data: F.batches(), page: F.page(3) })
    ok(inventoryRoutes.listAdjustments.response, {
      data: [F.adjustment(), F.draftAdjustmentRow()],
      page: F.page(2),
    })
    ok(inventoryRoutes.getAdjustment.response, { data: F.adjustmentDetail() })
    ok(inventoryRoutes.getAdjustment.response, { data: F.draftStockTake() })
    ok(inventoryRoutes.listTransfers.response, { data: [F.transfer()], page: F.page(1) })
    ok(inventoryRoutes.getTransfer.response, { data: F.transferDetail() })
  })

  it('match the catalogue and parties schemas used by the pickers', () => {
    ok(catalogRoutes.listProducts.response, { data: F.catalog(), page: F.page(3, 20) })
    ok(catalogRoutes.lookupProduct.response, {
      data: F.lookupResult(F.product(), '8901234500017'),
    })
    ok(catalogRoutes.listCategories.response, { data: [{ ...F.category(), children: [] }] })
    ok(partiesRoutes.listSuppliers.response, { data: [F.supplier()], page: F.page(1, 20) })
    ok(identityRoutes.listStores.response, { data: F.stores(), page: F.page(2, 200) })
  })

  it('keeps stock values consistent with pack pricing', () => {
    const totals = F.stockRows().reduce((s, r) => s + r.value_cost_paise, 0)
    expect(totals).toBe(F.stockTotals().value_cost_paise)
  })
})
