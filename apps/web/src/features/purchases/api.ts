/**
 * Data hooks of the purchases feature. Every call goes through the shared route catalogues
 * (`purchasesRoutes`, plus `partiesRoutes.getSupplier`, `paymentsRoutes.createPayment` and the
 * identity files routes) with the typed client — no hand-written URLs.
 *
 * Mutations invalidate the purchases lists and details they affect, plus the supplier and stock
 * queries other screens show (balances change on posting / payments / returns).
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { RouteDef, RouteResponse } from '@kadai/shared/api/common'
import { routeUrl } from '@kadai/shared/api/common'
import { catalogRoutes } from '@kadai/shared/api/catalog'
import { identityRoutes, type UploadPurpose } from '@kadai/shared/api/identity'
import { inventoryRoutes } from '@kadai/shared/api/inventory'
import { partiesRoutes } from '@kadai/shared/api/parties'
import { paymentsRoutes } from '@kadai/shared/api/payments'
import {
  type DebitNoteListQuery,
  type DebitNotePrefillQuery,
  type PurchaseBillListQuery,
  type PurchaseOrderListQuery,
  type ReorderSuggestionsQuery,
  type StockSenseProductQuery,
  type StockSenseQuery,
  purchasesRoutes as r,
} from '@kadai/shared/api/purchases'
import { request } from '@/lib/api'
import { routeQueryKey, useRouteMutation, useRouteQuery } from '@/lib/query'

/** Lists and screens outside this module that show purchase effects. */
const STOCK_AND_PARTIES: readonly RouteDef[] = [
  partiesRoutes.listSuppliers,
  partiesRoutes.getSupplier,
  inventoryRoutes.listStock,
  inventoryRoutes.listBatches,
  catalogRoutes.listProducts,
]

const BILLS: readonly RouteDef[] = [r.listBills, r.getBill, r.billReturnable]
const ORDERS: readonly RouteDef[] = [
  r.listOrders,
  r.getOrder,
  r.reorderSuggestions,
  r.stockSense,
  r.stockSenseProduct,
]
const NOTES: readonly RouteDef[] = [r.listDebitNotes, r.getDebitNote]
const STOCKSENSE: readonly RouteDef[] = [r.stockSense, r.stockSenseProduct, r.reorderSuggestions]

// ---------------------------------------------------------------------------------------------
// Purchase bills
// ---------------------------------------------------------------------------------------------

export const useBills = (query: PurchaseBillListQuery, enabled = true) =>
  useRouteQuery(r.listBills, { query }, { placeholderData: keepPreviousData, enabled })

export const useBill = (id: string | undefined) =>
  useRouteQuery(r.getBill, { params: { id: id ?? '' } }, { enabled: Boolean(id) })

export const useBillReturnable = (id: string | null | undefined) =>
  useRouteQuery(r.billReturnable, { params: { id: id ?? '' } }, { enabled: Boolean(id) })

/** Draft saves report their own errors inline (field errors / duplicate invoice). */
export const useCreateBill = () =>
  useRouteMutation(r.createBill, { invalidates: BILLS, meta: { errorToast: false } })

export const useUpdateBill = () =>
  useRouteMutation(r.updateBill, { invalidates: BILLS, meta: { errorToast: false } })

export const useDeleteBill = () =>
  useRouteMutation(r.deleteBill, {
    invalidates: [...BILLS, ...ORDERS],
    meta: { errorToast: false },
  })

export const usePostBill = () =>
  useRouteMutation(r.postBill, {
    invalidates: [...BILLS, ...ORDERS, ...STOCK_AND_PARTIES],
    meta: { errorToast: false },
  })

export const useCancelBill = () =>
  useRouteMutation(r.cancelBill, {
    invalidates: [...BILLS, ...ORDERS, ...STOCK_AND_PARTIES],
    meta: { errorToast: false },
  })

export const useBillFromOrder = () =>
  useRouteMutation(r.billFromOrder, {
    invalidates: [...BILLS, ...ORDERS],
    meta: { errorToast: false },
  })

/** Supplier payment (voucher) allocated to bills — payments contract. */
export const useCreateSupplierPayment = () =>
  useRouteMutation(paymentsRoutes.createPayment, {
    invalidates: [...BILLS, ...STOCK_AND_PARTIES, paymentsRoutes.listPayments],
    meta: { errorToast: false },
  })

// ---------------------------------------------------------------------------------------------
// Purchase orders & reorder
// ---------------------------------------------------------------------------------------------

export const useOrders = (query: PurchaseOrderListQuery, enabled = true) =>
  useRouteQuery(r.listOrders, { query }, { placeholderData: keepPreviousData, enabled })

export const useOrder = (id: string | undefined) =>
  useRouteQuery(r.getOrder, { params: { id: id ?? '' } }, { enabled: Boolean(id) })

export const useCreateOrder = () =>
  useRouteMutation(r.createOrder, { invalidates: ORDERS, meta: { errorToast: false } })

export const useUpdateOrder = () =>
  useRouteMutation(r.updateOrder, { invalidates: ORDERS, meta: { errorToast: false } })

export const useDeleteOrder = () =>
  useRouteMutation(r.deleteOrder, { invalidates: ORDERS, meta: { errorToast: false } })

export const useSendOrder = () =>
  useRouteMutation(r.sendOrder, { invalidates: ORDERS, meta: { errorToast: false } })

export const useCancelOrder = () =>
  useRouteMutation(r.cancelOrder, { invalidates: ORDERS, meta: { errorToast: false } })

export const useCloseOrder = () =>
  useRouteMutation(r.closeOrder, { invalidates: ORDERS, meta: { errorToast: false } })

export const useReorderSuggestions = (query: ReorderSuggestionsQuery | null) =>
  useRouteQuery(
    r.reorderSuggestions,
    { query: query ?? { store_id: '' } },
    { enabled: Boolean(query?.store_id), placeholderData: keepPreviousData },
  )

// ---------------------------------------------------------------------------------------------
// StockSense (forecast, ranked reorder plan, slow and expiring stock)
// ---------------------------------------------------------------------------------------------

export const useStockSense = (query: StockSenseQuery | null) =>
  useRouteQuery(
    r.stockSense,
    { query: query ?? { store_id: '' } },
    { enabled: Boolean(query?.store_id), placeholderData: keepPreviousData },
  )

export const useStockSenseProduct = (
  productId: string | null | undefined,
  query: StockSenseProductQuery | null,
) =>
  useRouteQuery(
    r.stockSenseProduct,
    { params: { productId: productId ?? '' }, query: query ?? { store_id: '' } },
    { enabled: Boolean(productId && query?.store_id), placeholderData: keepPreviousData },
  )

/** Supplier lead times / product shelf lives; refreshes the plan and the reorder list. */
export const useUpdateStockSenseSettings = () =>
  useRouteMutation(r.updateStockSenseSettings, {
    invalidates: STOCKSENSE,
    meta: { errorToast: false },
  })

/** Historical sales for StockSense. Does not change stock; refreshes the plan. */
export const useImportSalesHistory = () =>
  useRouteMutation(r.importSalesHistory, {
    invalidates: STOCKSENSE,
    meta: { errorToast: false },
  })

// ---------------------------------------------------------------------------------------------
// Debit notes (purchase returns)
// ---------------------------------------------------------------------------------------------

export const useDebitNotes = (query: DebitNoteListQuery, enabled = true) =>
  useRouteQuery(r.listDebitNotes, { query }, { placeholderData: keepPreviousData, enabled })

export const useDebitNote = (id: string | undefined) =>
  useRouteQuery(r.getDebitNote, { params: { id: id ?? '' } }, { enabled: Boolean(id) })

export const useDebitNotePrefill = (query: DebitNotePrefillQuery | null) =>
  useRouteQuery(
    r.debitNotePrefill,
    { query: query ?? { batch_ids: [], store_id: '' } },
    { enabled: Boolean(query && query.store_id && query.batch_ids.length > 0) },
  )

export const useCreateDebitNote = () =>
  useRouteMutation(r.createDebitNote, {
    invalidates: [...NOTES, ...BILLS, ...STOCK_AND_PARTIES],
    meta: { errorToast: false },
  })

export const useCancelDebitNote = () =>
  useRouteMutation(r.cancelDebitNote, {
    invalidates: [...NOTES, ...BILLS, ...STOCK_AND_PARTIES],
    meta: { errorToast: false },
  })

// ---------------------------------------------------------------------------------------------
// Suppliers (parties contract)
// ---------------------------------------------------------------------------------------------

export const useSupplier = (id: string | null | undefined, enabled = true) =>
  useRouteQuery(
    partiesRoutes.getSupplier,
    { params: { id: id ?? '' } },
    { enabled: Boolean(id) && enabled, meta: { errorToast: false } },
  )

// ---------------------------------------------------------------------------------------------
// Files (supplier invoice photo / PDF)
// ---------------------------------------------------------------------------------------------

export type UploadedFile = RouteResponse<typeof identityRoutes.uploadFile>['data']

/**
 * Multipart upload through the catalogue's `uploadFile` route (POST /files?purpose=). The
 * catalogue describes no JSON body (the body is multipart), so the request is built from the
 * route definition with the low-level client instead of callRoute.
 */
export async function uploadFile(
  file: File,
  purpose: UploadPurpose,
  signal?: AbortSignal,
): Promise<UploadedFile> {
  const route = identityRoutes.uploadFile
  const body = new FormData()
  body.append('file', file, file.name)
  const res = await request<RouteResponse<typeof route>>(route.method, routeUrl(route), {
    query: { purpose },
    body,
    signal,
    timeoutMs: 120_000,
  })
  return res.data
}

/** File metadata (name, type) of a stored attachment. */
export const useFileInfo = (id: string | null | undefined) =>
  useRouteQuery(
    identityRoutes.getFile,
    { params: { id: id ?? '' } },
    { enabled: Boolean(id), staleTime: Infinity, meta: { errorToast: false } },
  )

/**
 * Object URL of a stored file's content. The content route needs the bearer token, so it is
 * fetched as a blob (cached by the query client); the URL is revoked when it changes / unmounts.
 */
export function useFileObjectUrl(fileId: string | null | undefined): {
  url: string | null
  type: string | null
  loading: boolean
  error: unknown
} {
  const route = identityRoutes.getFileContent
  const query = useQuery({
    queryKey: routeQueryKey(route, { params: { id: fileId ?? '' } }),
    queryFn: ({ signal }) =>
      request<Blob>(route.method, routeUrl(route, { id: fileId ?? '' }), {
        signal,
        responseType: 'blob',
      }),
    enabled: Boolean(fileId),
    staleTime: Infinity,
    meta: { errorToast: false },
  })
  const [url, setUrl] = useState<string | null>(null)
  const blob = fileId ? query.data : undefined
  useEffect(() => {
    if (!blob) {
      setUrl(null)
      return
    }
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob])
  return { url, type: blob?.type ?? null, loading: query.isLoading, error: query.error }
}
