/**
 * Data hooks of the sales back office. Every call goes through the shared route catalogues
 * (`salesRoutes`, plus the payments entries the collect dialog uses), so paths and payloads
 * follow the contract exactly. Mutations invalidate by route: `/sales/invoices` also refreshes
 * `/sales/invoices/:id` and its returnable lines; money movements also refresh customer balances.
 */
import { keepPreviousData } from '@tanstack/react-query'
import { partiesRoutes } from '@kadai/shared/api/parties'
import { type UpiQrQuery, paymentsRoutes } from '@kadai/shared/api/payments'
import {
  type CreditNoteListQuery,
  type InvoiceListQuery,
  salesRoutes,
} from '@kadai/shared/api/sales'
import { useRouteMutation, useRouteQuery } from '@/lib/query'

/**
 * Mutations of this feature report their own errors (inline in the dialog, or one notify.error),
 * so the central mutation toast is switched off — it would show a second toast.
 */
const OWN_ERRORS = { meta: { errorToast: false } } as const

/** Everything a sale / return / payment can change. */
const SALES_DATA = [
  salesRoutes.listInvoices,
  salesRoutes.listCreditNotes,
  partiesRoutes.listCustomers,
  paymentsRoutes.listPayments,
  paymentsRoutes.openItems,
] as const

// ---- invoices & estimates ------------------------------------------------------------------------

export function useInvoices(query: InvoiceListQuery, options: { enabled?: boolean } = {}) {
  return useRouteQuery(
    salesRoutes.listInvoices,
    { query },
    { placeholderData: keepPreviousData, ...options },
  )
}

export function useInvoice(id: string, options: { enabled?: boolean } = {}) {
  return useRouteQuery(salesRoutes.getInvoice, { params: { id } }, options)
}

export function useReturnable(id: string | null) {
  return useRouteQuery(
    salesRoutes.returnable,
    { params: { id: id ?? '' } },
    { enabled: id !== null, meta: { errorToast: false } },
  )
}

export function useCancelInvoice() {
  return useRouteMutation(salesRoutes.cancelInvoice, { invalidates: SALES_DATA, ...OWN_ERRORS })
}

export function useCollectPayment() {
  return useRouteMutation(salesRoutes.collectPayment, { invalidates: SALES_DATA, ...OWN_ERRORS })
}

export function useShareInvoice() {
  return useRouteMutation(salesRoutes.shareInvoice, {
    invalidates: [salesRoutes.getInvoice],
    ...OWN_ERRORS,
  })
}

export function useDeleteInvoice() {
  return useRouteMutation(salesRoutes.deleteInvoice, {
    invalidates: [salesRoutes.listInvoices, salesRoutes.listHeld],
    ...OWN_ERRORS,
  })
}

export function useConvertEstimate() {
  return useRouteMutation(salesRoutes.convertEstimate, { invalidates: SALES_DATA, ...OWN_ERRORS })
}

// ---- credit notes ----------------------------------------------------------------------------------

export function useCreditNotes(query: CreditNoteListQuery) {
  return useRouteQuery(
    salesRoutes.listCreditNotes,
    { query },
    { placeholderData: keepPreviousData },
  )
}

export function useCreditNote(id: string) {
  return useRouteQuery(salesRoutes.getCreditNote, { params: { id } })
}

export function useCreateCreditNote() {
  return useRouteMutation(salesRoutes.createCreditNote, { invalidates: SALES_DATA, ...OWN_ERRORS })
}

export function useCancelCreditNote() {
  return useRouteMutation(salesRoutes.cancelCreditNote, { invalidates: SALES_DATA, ...OWN_ERRORS })
}

// ---- public invoice --------------------------------------------------------------------------------

export function usePublicInvoice(shareToken: string, options: { enabled?: boolean } = {}) {
  return useRouteQuery(
    salesRoutes.publicInvoice,
    { params: { shareToken } },
    { ...options, retry: false, meta: { errorToast: false }, staleTime: 5 * 60_000 },
  )
}

// ---- UPI (collect dialog) --------------------------------------------------------------------------

/** Static UPI QR payload of the store's UPI ID for an amount (GET /payments/upi-qr). */
export function useUpiQr(query: UpiQrQuery, options: { enabled?: boolean } = {}) {
  return useRouteQuery(
    paymentsRoutes.upiQr,
    { query },
    { ...options, retry: false, meta: { errorToast: false } },
  )
}

export function useCreateIntent() {
  return useRouteMutation(paymentsRoutes.createIntent, OWN_ERRORS)
}

export function useConfirmIntent() {
  return useRouteMutation(paymentsRoutes.confirmIntent, OWN_ERRORS)
}

export function useCancelIntent() {
  return useRouteMutation(paymentsRoutes.cancelIntent, OWN_ERRORS)
}
