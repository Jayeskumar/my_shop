/**
 * inventory module — stock levels, movements, batches, adjustments, opening stock, transfers,
 * alerts. Owned by the inventory module (ARCHITECTURE.md §3.1).
 *
 * Endpoints: docs/API.md "inventory"; every route is registered from the `inventoryRoutes`
 * catalogue (packages/shared/src/api/inventory.ts), which carries method, path, schemas and the
 * permission / feature guards. Store scoping (ctx.storeIds) is applied by each service; stock,
 * journal and numbering go through the core posting services only. Background jobs: ./jobs.ts.
 *
 * Writes that post stock (post / cancel adjustments, opening stock, dispatch / receive / cancel
 * transfers) and document creates are idempotent (Idempotency-Key), so a retried request replays
 * the first response instead of posting twice.
 */
import { inventoryRoutes } from '@kadai/shared/api/inventory'
import { audit } from '../../core/audit'
import { parsePage, requireFeature, routePlugins } from '../../core/http'
import { defineModule } from '../module'
import {
  cancelAdjustment,
  createAdjustment,
  deleteAdjustment,
  listAdjustments,
  postAdjustment,
  updateAdjustment,
  adjustmentDetail,
} from './adjustments'
import { computeAlerts } from './alerts'
import { listBatches, updateBatch } from './batches'
import { businessToday, resolveStoreScope, sendCsv } from './common'
import { listMovements, movementsCsv } from './movements'
import { postOpeningStock } from './opening'
import { listStock, productStock, stockCsv } from './stock'
import {
  cancelTransfer,
  createTransfer,
  dispatchTransfer,
  listTransfers,
  receiveTransfer,
  transferDetail,
  updateTransfer,
} from './transfers'

/** Transfers also need the multi_store feature (the catalogue gates stock_transfers). */
const multiStore = { preHandler: [requireFeature('multi_store')] }

export const inventoryModule = defineModule({
  name: 'inventory',
  ...routePlugins(inventoryRoutes, {
    // ---- stock -----------------------------------------------------------------------------
    listStock: async (req, reply) => {
      const q = req.query
      const result = await req.tx(async (tx) => {
        const scope = await resolveStoreScope(tx, req.ctx, q.store_id)
        if (q.format !== 'csv') {
          return {
            kind: 'json' as const,
            body: await listStock(tx, req.ctx, scope, q, parsePage(q)),
          }
        }
        const csv = await stockCsv(tx, req.ctx, scope, q)
        const { today } = await businessToday(tx, req.ctx)
        await audit(tx, req.ctx, {
          action: 'stock.export',
          entity_type: 'stock',
          entity_id: scope.kind === 'single' ? scope.storeId : null,
          summary: `Stock exported (${String(csv.rows)} rows)`,
          changes: { rows: csv.rows, store_id: scope.kind === 'single' ? scope.storeId : 'all' },
        })
        return { kind: 'csv' as const, csv: csv.csv, filename: `stock-${today}.csv` }
      })
      if (result.kind === 'json') return result.body
      return sendCsv(reply, result.filename, result.csv)
    },
    stockAlerts: {
      tx: async (tx, req) => {
        const scope = await resolveStoreScope(tx, req.ctx, req.query.store_id)
        return { data: await computeAlerts(tx, req.ctx, scope, req.query.limit) }
      },
    },
    listMovements: async (req, reply) => {
      const q = req.query
      const result = await req.tx(async (tx) => {
        if (q.format !== 'csv') {
          return { kind: 'json' as const, body: await listMovements(tx, req.ctx, q, parsePage(q)) }
        }
        const csv = await movementsCsv(tx, req.ctx, q)
        const { today } = await businessToday(tx, req.ctx)
        await audit(tx, req.ctx, {
          action: 'stock_movements.export',
          entity_type: 'stock_movement',
          summary: `Stock movements exported (${String(csv.rows)} rows)`,
          changes: {
            rows: csv.rows,
            filters: {
              product_id: q.product_id ?? null,
              store_id: q.store_id ?? null,
              from: q.from ?? null,
              to: q.to ?? null,
            },
          },
        })
        return { kind: 'csv' as const, csv: csv.csv, filename: `stock-movements-${today}.csv` }
      })
      if (result.kind === 'json') return result.body
      return sendCsv(reply, result.filename, result.csv)
    },
    productStock: {
      tx: async (tx, req) => ({
        data: await productStock(tx, req.ctx, req.params.productId, req.query.store_id),
      }),
    },
    postOpeningStock: {
      tx: async (tx, req) => ({ data: await postOpeningStock(tx, req.ctx, req.body) }),
    },

    // ---- batches ---------------------------------------------------------------------------
    listBatches: {
      tx: async (tx, req) => listBatches(tx, req.ctx, req.query, parsePage(req.query)),
    },
    updateBatch: {
      tx: async (tx, req) => ({ data: await updateBatch(tx, req.ctx, req.params.id, req.body) }),
    },

    // ---- adjustments -----------------------------------------------------------------------
    listAdjustments: {
      tx: async (tx, req) => listAdjustments(tx, req.ctx, req.query, parsePage(req.query)),
    },
    createAdjustment: {
      tx: async (tx, req) => ({ data: await createAdjustment(tx, req.ctx, req.body) }),
    },
    getAdjustment: {
      tx: async (tx, req) => ({ data: await adjustmentDetail(tx, req.ctx, req.params.id) }),
    },
    updateAdjustment: {
      tx: async (tx, req) => ({
        data: await updateAdjustment(tx, req.ctx, req.params.id, req.body),
      }),
    },
    deleteAdjustment: {
      tx: async (tx, req) => {
        await deleteAdjustment(tx, req.ctx, req.params.id)
      },
    },
    postAdjustment: {
      tx: async (tx, req) => ({ data: await postAdjustment(tx, req.ctx, req.params.id) }),
    },
    cancelAdjustment: {
      tx: async (tx, req) => ({
        data: await cancelAdjustment(tx, req.ctx, req.params.id, req.body.reason),
      }),
    },

    // ---- transfers -------------------------------------------------------------------------
    listTransfers: {
      ...multiStore,
      tx: async (tx, req) => listTransfers(tx, req.ctx, req.query, parsePage(req.query)),
    },
    createTransfer: {
      ...multiStore,
      tx: async (tx, req) => ({ data: await createTransfer(tx, req.ctx, req.body) }),
    },
    getTransfer: {
      ...multiStore,
      tx: async (tx, req) => ({ data: await transferDetail(tx, req.ctx, req.params.id) }),
    },
    updateTransfer: {
      ...multiStore,
      tx: async (tx, req) => ({
        data: await updateTransfer(tx, req.ctx, req.params.id, req.body),
      }),
    },
    dispatchTransfer: {
      ...multiStore,
      tx: async (tx, req) => ({ data: await dispatchTransfer(tx, req.ctx, req.params.id) }),
    },
    receiveTransfer: {
      ...multiStore,
      tx: async (tx, req) => ({
        data: await receiveTransfer(tx, req.ctx, req.params.id, req.body),
      }),
    },
    cancelTransfer: {
      ...multiStore,
      tx: async (tx, req) => ({
        data: await cancelTransfer(tx, req.ctx, req.params.id, req.body.reason),
      }),
    },
  }),
})
