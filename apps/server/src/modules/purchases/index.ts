/**
 * purchases module — purchase orders, purchase bills (GRN), debit notes (purchase returns),
 * reorder suggestions and StockSense (forecast-based reorder planning, ./stocksense.ts). Owned by the purchases module (ARCHITECTURE.md §3.1).
 *
 * Endpoints: docs/API.md "purchases". Every route is registered from the `purchasesRoutes`
 * catalogue (packages/shared/src/api/purchases.ts), which carries method, path, schemas, the
 * permission (purchases.read / purchases.write) and the plan feature (`purchases`). Store
 * scoping (ctx.storeIds) is applied by each service; stock, journal, payments and numbering go
 * through the core posting services only (core/inventory, core/ledger, core/payments,
 * core/numbering). Financial creates (purchase orders, bills, debit notes) are idempotent
 * (Idempotency-Key header or body client_ref); posting / cancelling is guarded by the document
 * status under a row lock, so a retry can never post twice. CSV exports (?format=csv) are
 * audited. Background jobs: ./jobs.ts.
 */
import { purchasesRoutes } from '@kadai/shared/api/purchases'
import { audit } from '../../core/audit'
import { parsePage, routePlugins } from '../../core/http'
import { defineModule } from '../module'
import {
  billDetail,
  billFromOrder,
  billReturnable,
  billsCsv,
  createBill,
  deleteBill,
  listBills,
  updateBill,
} from './bills'
import { businessToday, sendCsv } from './common'
import {
  cancelDebitNote,
  createDebitNote,
  debitNoteDetail,
  debitNotePrefill,
  debitNotesCsv,
  listDebitNotes,
} from './debit-notes'
import {
  cancelOrder,
  closeOrder,
  createOrder,
  deleteOrder,
  listOrders,
  orderDetail,
  ordersCsv,
  sendOrder,
  updateOrder,
} from './orders'
import { cancelBill, postBill } from './posting'
import { reorderSuggestions } from './reorder'
import { importSalesHistory } from './sales-history'
import { stockSenseProduct, stockSenseReport, updateStockSenseSettings } from './stocksense'

/** Filters of an exported list for the audit entry (without sort / format). */
function exportFilters(q: Record<string, unknown>): Record<string, unknown> {
  const { sort: _sort, format: _format, limit: _limit, offset: _offset, ...rest } = q
  return rest
}

export const purchasesModule = defineModule({
  name: 'purchases',
  ...routePlugins(purchasesRoutes, {
    // ---- purchase orders -------------------------------------------------------------------
    listOrders: async (req, reply) => {
      const q = req.query
      const result = await req.tx(async (tx) => {
        if (q.format !== 'csv') {
          return { kind: 'json' as const, body: await listOrders(tx, req.ctx, q, parsePage(q)) }
        }
        const csv = await ordersCsv(tx, req.ctx, q)
        const { today } = await businessToday(tx, req.ctx)
        await audit(tx, req.ctx, {
          action: 'purchase_order.export',
          entity_type: 'purchase_order',
          summary: `Purchase orders exported (${String(csv.rows)} rows)`,
          changes: { rows: csv.rows, filters: exportFilters(q) },
        })
        return { kind: 'csv' as const, csv: csv.csv, filename: `purchase-orders-${today}.csv` }
      })
      if (result.kind === 'json') return result.body
      return sendCsv(reply, result.filename, result.csv)
    },
    createOrder: {
      tx: async (tx, req) => ({ data: await createOrder(tx, req.ctx, req.body) }),
    },
    getOrder: {
      tx: async (tx, req) => ({ data: await orderDetail(tx, req.ctx, req.params.id) }),
    },
    updateOrder: {
      tx: async (tx, req) => ({ data: await updateOrder(tx, req.ctx, req.params.id, req.body) }),
    },
    deleteOrder: {
      tx: async (tx, req) => {
        await deleteOrder(tx, req.ctx, req.params.id)
      },
    },
    sendOrder: {
      tx: async (tx, req) => ({ data: await sendOrder(tx, req.ctx, req.params.id, req.body) }),
    },
    cancelOrder: {
      tx: async (tx, req) => ({
        data: await cancelOrder(tx, req.ctx, req.params.id, req.body.reason),
      }),
    },
    closeOrder: {
      tx: async (tx, req) => ({
        data: await closeOrder(tx, req.ctx, req.params.id, req.body.reason),
      }),
    },

    // ---- purchase bills --------------------------------------------------------------------
    listBills: async (req, reply) => {
      const q = req.query
      const result = await req.tx(async (tx) => {
        if (q.format !== 'csv') {
          return { kind: 'json' as const, body: await listBills(tx, req.ctx, q, parsePage(q)) }
        }
        const csv = await billsCsv(tx, req.ctx, q)
        const { today } = await businessToday(tx, req.ctx)
        await audit(tx, req.ctx, {
          action: 'purchase_bill.export',
          entity_type: 'purchase_bill',
          summary: `Purchase bills exported (${String(csv.rows)} rows)`,
          changes: { rows: csv.rows, filters: exportFilters(q) },
        })
        return { kind: 'csv' as const, csv: csv.csv, filename: `purchase-bills-${today}.csv` }
      })
      if (result.kind === 'json') return result.body
      return sendCsv(reply, result.filename, result.csv)
    },
    createBill: {
      tx: async (tx, req) => ({ data: await createBill(tx, req.ctx, req.body) }),
    },
    getBill: {
      tx: async (tx, req) => ({ data: await billDetail(tx, req.ctx, req.params.id) }),
    },
    updateBill: {
      tx: async (tx, req) => ({ data: await updateBill(tx, req.ctx, req.params.id, req.body) }),
    },
    deleteBill: {
      tx: async (tx, req) => {
        await deleteBill(tx, req.ctx, req.params.id)
      },
    },
    postBill: {
      tx: async (tx, req) => ({ data: await postBill(tx, req.ctx, req.params.id, req.body) }),
    },
    cancelBill: {
      tx: async (tx, req) => ({
        data: await cancelBill(tx, req.ctx, req.params.id, req.body.reason),
      }),
    },
    billFromOrder: {
      tx: async (tx, req) => ({
        data: await billFromOrder(tx, req.ctx, req.params.orderId, req.body),
      }),
    },
    billReturnable: {
      tx: async (tx, req) => ({ data: await billReturnable(tx, req.ctx, req.params.id) }),
    },

    // ---- debit notes -----------------------------------------------------------------------
    listDebitNotes: async (req, reply) => {
      const q = req.query
      const result = await req.tx(async (tx) => {
        if (q.format !== 'csv') {
          return {
            kind: 'json' as const,
            body: await listDebitNotes(tx, req.ctx, q, parsePage(q)),
          }
        }
        const csv = await debitNotesCsv(tx, req.ctx, q)
        const { today } = await businessToday(tx, req.ctx)
        await audit(tx, req.ctx, {
          action: 'debit_note.export',
          entity_type: 'debit_note',
          summary: `Debit notes exported (${String(csv.rows)} rows)`,
          changes: { rows: csv.rows, filters: exportFilters(q) },
        })
        return { kind: 'csv' as const, csv: csv.csv, filename: `debit-notes-${today}.csv` }
      })
      if (result.kind === 'json') return result.body
      return sendCsv(reply, result.filename, result.csv)
    },
    createDebitNote: {
      tx: async (tx, req) => ({ data: await createDebitNote(tx, req.ctx, req.body) }),
    },
    debitNotePrefill: {
      tx: async (tx, req) => ({ data: await debitNotePrefill(tx, req.ctx, req.query) }),
    },
    getDebitNote: {
      tx: async (tx, req) => ({ data: await debitNoteDetail(tx, req.ctx, req.params.id) }),
    },
    cancelDebitNote: {
      tx: async (tx, req) => ({
        data: await cancelDebitNote(tx, req.ctx, req.params.id, req.body.reason),
      }),
    },

    // ---- reorder ---------------------------------------------------------------------------
    reorderSuggestions: {
      tx: async (tx, req) => ({ data: await reorderSuggestions(tx, req.ctx, req.query) }),
    },
    stockSense: {
      tx: async (tx, req) => ({ data: await stockSenseReport(tx, req.ctx, req.query) }),
    },
    stockSenseProduct: {
      tx: async (tx, req) => ({
        data: await stockSenseProduct(tx, req.ctx, req.params.productId, req.query),
      }),
    },
    updateStockSenseSettings: {
      tx: async (tx, req) => ({ data: await updateStockSenseSettings(tx, req.ctx, req.body) }),
    },
    importSalesHistory: {
      tx: async (tx, req) => ({
        data: await importSalesHistory(tx, req.ctx, req.body),
      }),
    },
  }),
})
