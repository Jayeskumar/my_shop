/**
 * Server state of the payments screens, all through the shared route catalogue
 * (`paymentsRoutes` in @kadai/shared/api/payments) — no hand-written URLs. Query keys are the
 * route keys of useRouteQuery, so a mutation invalidates by route.
 *
 * Mutations set `meta.errorToast: false`: every call site handles its errors (field errors on
 * the form, the rest through notifyPaymentError, which knows the payments `details.reason`s).
 */
import { keepPreviousData } from '@tanstack/react-query'
import { accountingRoutes } from '@kadai/shared/api/accounting'
import {
  type OpenItemsQuery,
  type PaymentIntentListQuery,
  type PaymentListQuery,
  type PaymentProviderListQuery,
  paymentsRoutes,
  type UpiQrQuery,
} from '@kadai/shared/api/payments'
import { salesRoutes, type InvoiceListQuery } from '@kadai/shared/api/sales'
import { useRouteMutation, useRouteQuery } from '@/lib/query'

const FORM_ERRORS = { meta: { errorToast: false } } as const

/** Everything that shows payment state (lists, details, open items, invoices' due). */
const PAYMENT_VIEWS = [
  paymentsRoutes.listPayments,
  paymentsRoutes.openItems,
  paymentsRoutes.listIntents,
  salesRoutes.listInvoices,
] as const

// ---- providers -------------------------------------------------------------------------------

export function useProviders(query: PaymentProviderListQuery = {}, enabled = true) {
  return useRouteQuery(paymentsRoutes.listProviders, { query }, { enabled })
}

export function useCreateProvider() {
  return useRouteMutation(paymentsRoutes.createProvider, {
    ...FORM_ERRORS,
    invalidates: [paymentsRoutes.listProviders],
  })
}

export function useUpdateProvider() {
  return useRouteMutation(paymentsRoutes.updateProvider, {
    ...FORM_ERRORS,
    invalidates: [paymentsRoutes.listProviders],
  })
}

export function useDeactivateProvider() {
  return useRouteMutation(paymentsRoutes.deleteProvider, {
    ...FORM_ERRORS,
    invalidates: [paymentsRoutes.listProviders],
  })
}

export function useTestProvider() {
  return useRouteMutation(paymentsRoutes.testProvider, {
    ...FORM_ERRORS,
    invalidates: [paymentsRoutes.listProviders],
  })
}

export function useUpiQr(query: UpiQrQuery, enabled = true) {
  return useRouteQuery(paymentsRoutes.upiQr, { query }, { enabled, staleTime: 5 * 60_000 })
}

// ---- intents ---------------------------------------------------------------------------------

export function useIntents(
  query: PaymentIntentListQuery,
  options: { enabled?: boolean; refetchInterval?: number | false } = {},
) {
  return useRouteQuery(
    paymentsRoutes.listIntents,
    { query },
    {
      placeholderData: keepPreviousData,
      enabled: options.enabled ?? true,
      refetchInterval: options.refetchInterval ?? false,
      refetchIntervalInBackground: false,
    },
  )
}

export function useConfirmIntent() {
  return useRouteMutation(paymentsRoutes.confirmIntent, {
    ...FORM_ERRORS,
    invalidates: PAYMENT_VIEWS,
  })
}

export function useCancelIntent() {
  return useRouteMutation(paymentsRoutes.cancelIntent, {
    ...FORM_ERRORS,
    invalidates: [paymentsRoutes.listIntents],
  })
}

export function useApplyIntent() {
  return useRouteMutation(paymentsRoutes.applyIntent, {
    ...FORM_ERRORS,
    invalidates: PAYMENT_VIEWS,
  })
}

// ---- receipts & vouchers ---------------------------------------------------------------------

export function usePayments(query: PaymentListQuery) {
  return useRouteQuery(
    paymentsRoutes.listPayments,
    { query },
    { placeholderData: keepPreviousData },
  )
}

export function usePayment(id: string | null) {
  return useRouteQuery(
    paymentsRoutes.getPayment,
    { params: { id: id ?? '' } },
    { enabled: Boolean(id) },
  )
}

export function useOpenItems(query: OpenItemsQuery | null) {
  return useRouteQuery(
    paymentsRoutes.openItems,
    { query: query ?? { party_type: 'customer', party_id: '' } },
    { enabled: Boolean(query?.party_id), staleTime: 0 },
  )
}

export function useCreatePayment() {
  return useRouteMutation(paymentsRoutes.createPayment, {
    ...FORM_ERRORS,
    invalidates: PAYMENT_VIEWS,
  })
}

export function useCancelPayment() {
  return useRouteMutation(paymentsRoutes.cancelPayment, {
    ...FORM_ERRORS,
    invalidates: [...PAYMENT_VIEWS, paymentsRoutes.getPayment],
  })
}

// ---- other modules ---------------------------------------------------------------------------

/** Due invoices of a customer (apply an unapplied UPI payment to one of them). */
export function useDueInvoices(query: InvoiceListQuery, enabled = true) {
  return useRouteQuery(
    salesRoutes.listInvoices,
    {
      query: {
        has_due: true,
        doc_type: ['tax_invoice', 'bill_of_supply'],
        status: ['completed'],
        sort: 'invoice_date',
        limit: 50,
        ...query,
      },
    },
    { enabled, placeholderData: keepPreviousData },
  )
}

/** The open shift of this counter (cash received at the counter goes into its drawer). */
export function useCurrentShift(registerId: string | null, enabled: boolean) {
  return useRouteQuery(
    accountingRoutes.currentShift,
    { query: { register_id: registerId ?? '' } },
    { enabled: enabled && Boolean(registerId), meta: { errorToast: false }, staleTime: 60_000 },
  )
}
