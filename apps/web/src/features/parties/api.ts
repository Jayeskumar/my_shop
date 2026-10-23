/**
 * Data hooks of the parties feature. Every call goes through the shared route catalogues
 * (`partiesRoutes` plus the payments / sales / purchases / notifications entries this feature
 * uses), so paths and payloads follow the contract exactly. Mutations invalidate by route: the
 * `/customers` prefix also refreshes `/customers/:id`, its ledger, summary and loyalty.
 */
import { keepPreviousData } from '@tanstack/react-query'
import { accountingRoutes } from '@kadai/shared/api/accounting'
import { notificationsRoutes } from '@kadai/shared/api/notifications'
import {
  type CustomerListQuery,
  type DoctorListQuery,
  type LoyaltyListQuery,
  type PartyLedgerQuery,
  type SupplierListQuery,
  partiesRoutes,
} from '@kadai/shared/api/parties'
import {
  type OpenItemsQuery,
  type PaymentListQuery,
  paymentsRoutes,
} from '@kadai/shared/api/payments'
import { type PurchaseBillListQuery, purchasesRoutes } from '@kadai/shared/api/purchases'
import { type InvoiceListQuery, salesRoutes } from '@kadai/shared/api/sales'
import { useRouteMutation, useRouteQuery } from '@/lib/query'

/**
 * Mutations of this feature report their own errors — field errors in the form, or one
 * notify.error — so the central mutation toast is switched off (it would show a second toast).
 */
const OWN_ERRORS = { meta: { errorToast: false } } as const

/** Everything a money movement for a party can change (balances, dues, statements). */
const MONEY_ROUTES = [
  partiesRoutes.listCustomers,
  partiesRoutes.listSuppliers,
  paymentsRoutes.listPayments,
  paymentsRoutes.openItems,
  salesRoutes.listInvoices,
  purchasesRoutes.listBills,
] as const

// ---- customers ---------------------------------------------------------------------------------

export function useCustomers(query: CustomerListQuery) {
  return useRouteQuery(
    partiesRoutes.listCustomers,
    { query },
    { placeholderData: keepPreviousData },
  )
}

export function useCustomer(id: string) {
  return useRouteQuery(partiesRoutes.getCustomer, { params: { id } })
}

export function useCustomerSummary(id: string, options: { enabled?: boolean } = {}) {
  return useRouteQuery(partiesRoutes.customerSummary, { params: { id } }, options)
}

export function useCustomerLedger(id: string, query: PartyLedgerQuery) {
  return useRouteQuery(
    partiesRoutes.customerLedger,
    { params: { id }, query },
    { placeholderData: keepPreviousData },
  )
}

export function useCustomerLoyalty(
  id: string,
  query: LoyaltyListQuery,
  options: { enabled?: boolean } = {},
) {
  return useRouteQuery(
    partiesRoutes.customerLoyalty,
    { params: { id }, query },
    { placeholderData: keepPreviousData, ...options },
  )
}

export function useCreateCustomer() {
  return useRouteMutation(partiesRoutes.createCustomer, {
    ...OWN_ERRORS,
    invalidates: [partiesRoutes.listCustomers],
  })
}

export function useUpdateCustomer() {
  return useRouteMutation(partiesRoutes.updateCustomer, {
    ...OWN_ERRORS,
    invalidates: [partiesRoutes.listCustomers],
  })
}

export function useDeleteCustomer() {
  return useRouteMutation(partiesRoutes.deleteCustomer, {
    ...OWN_ERRORS,
    invalidates: [partiesRoutes.listCustomers],
  })
}

export function useAdjustLoyalty() {
  return useRouteMutation(partiesRoutes.adjustLoyalty, {
    ...OWN_ERRORS,
    invalidates: [partiesRoutes.listCustomers],
  })
}

export function useImportCustomers() {
  return useRouteMutation(partiesRoutes.importCustomers, {
    ...OWN_ERRORS,
    invalidates: [partiesRoutes.listCustomers],
  })
}

// ---- suppliers ---------------------------------------------------------------------------------

export function useSuppliers(query: SupplierListQuery) {
  return useRouteQuery(
    partiesRoutes.listSuppliers,
    { query },
    { placeholderData: keepPreviousData },
  )
}

export function useSupplier(id: string) {
  return useRouteQuery(partiesRoutes.getSupplier, { params: { id } })
}

export function useSupplierLedger(id: string, query: PartyLedgerQuery) {
  return useRouteQuery(
    partiesRoutes.supplierLedger,
    { params: { id }, query },
    { placeholderData: keepPreviousData },
  )
}

export function useCreateSupplier() {
  return useRouteMutation(partiesRoutes.createSupplier, {
    ...OWN_ERRORS,
    invalidates: [partiesRoutes.listSuppliers],
  })
}

export function useUpdateSupplier() {
  return useRouteMutation(partiesRoutes.updateSupplier, {
    ...OWN_ERRORS,
    invalidates: [partiesRoutes.listSuppliers],
  })
}

export function useDeleteSupplier() {
  return useRouteMutation(partiesRoutes.deleteSupplier, {
    ...OWN_ERRORS,
    invalidates: [partiesRoutes.listSuppliers],
  })
}

// ---- doctors -----------------------------------------------------------------------------------

export function useDoctors(query: DoctorListQuery) {
  return useRouteQuery(partiesRoutes.listDoctors, { query }, { placeholderData: keepPreviousData })
}

export function useCreateDoctor() {
  return useRouteMutation(partiesRoutes.createDoctor, {
    ...OWN_ERRORS,
    invalidates: [partiesRoutes.listDoctors],
  })
}

export function useUpdateDoctor() {
  return useRouteMutation(partiesRoutes.updateDoctor, {
    ...OWN_ERRORS,
    invalidates: [partiesRoutes.listDoctors],
  })
}

export function useDeleteDoctor() {
  return useRouteMutation(partiesRoutes.deleteDoctor, {
    ...OWN_ERRORS,
    invalidates: [partiesRoutes.listDoctors],
  })
}

// ---- other modules used by the khata screens ---------------------------------------------------

/** Sales bills of a customer (sales contract). */
export function usePartyInvoices(query: InvoiceListQuery, options: { enabled?: boolean } = {}) {
  return useRouteQuery(
    salesRoutes.listInvoices,
    { query },
    { placeholderData: keepPreviousData, ...options },
  )
}

/** Purchase bills of a supplier (purchases contract). */
export function usePartyBills(query: PurchaseBillListQuery, options: { enabled?: boolean } = {}) {
  return useRouteQuery(
    purchasesRoutes.listBills,
    { query },
    { placeholderData: keepPreviousData, ...options },
  )
}

/** Receipts / vouchers of a party (payments contract). */
export function usePartyPayments(query: PaymentListQuery, options: { enabled?: boolean } = {}) {
  return useRouteQuery(
    paymentsRoutes.listPayments,
    { query },
    { placeholderData: keepPreviousData, ...options },
  )
}

/** Open documents of a party in FIFO order (allocation table of a receipt / voucher). */
export function useOpenItems(query: OpenItemsQuery, options: { enabled?: boolean } = {}) {
  // The payment dialog shows a failure in place (with retry), so no toast.
  return useRouteQuery(
    paymentsRoutes.openItems,
    { query },
    { ...options, meta: { errorToast: false } },
  )
}

/**
 * The open shift of a counter (accounting contract GET /shifts/current; `{data: null}` when none).
 * Quiet on failure: it only decides whether cash goes into a drawer.
 */
export function useCurrentShift(registerId: string | null, options: { enabled?: boolean } = {}) {
  return useRouteQuery(
    accountingRoutes.currentShift,
    { query: { register_id: registerId ?? '' } },
    {
      enabled: Boolean(registerId) && (options.enabled ?? true),
      retry: false,
      meta: { errorToast: false },
    },
  )
}

/** POST /payments — receipt (in) or supplier payment voucher (out). */
export function useCreatePayment() {
  return useRouteMutation(paymentsRoutes.createPayment, {
    ...OWN_ERRORS,
    invalidates: MONEY_ROUTES,
  })
}

/** POST /payments/links — payment link for a customer's dues. */
export function useCreatePaymentLink() {
  return useRouteMutation(paymentsRoutes.createLink, {
    ...OWN_ERRORS,
    invalidates: [partiesRoutes.customerSummary],
  })
}

/** POST /customers/:id/remind — due reminder (notifications contract). */
export function useRemindCustomer() {
  return useRouteMutation(notificationsRoutes.remindCustomer, {
    ...OWN_ERRORS,
    invalidates: [partiesRoutes.customerSummary],
  })
}
