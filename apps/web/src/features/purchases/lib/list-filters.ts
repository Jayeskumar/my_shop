/**
 * Quick-filter chips of the purchases lists → contract list queries (unit-tested so the chips
 * always send what the server filters on).
 */
import type {
  DebitNoteListQuery,
  PurchaseBillListQuery,
  PurchaseOrderListQuery,
} from '@kadai/shared/api/purchases'

export const BILL_FILTERS = ['all', 'draft', 'to_pay', 'overdue', 'paid', 'cancelled'] as const
export type BillFilter = (typeof BILL_FILTERS)[number]

export function billFilterQuery(filter: BillFilter): Partial<PurchaseBillListQuery> {
  switch (filter) {
    case 'draft':
      return { status: ['draft'] }
    case 'to_pay':
      return { status: ['posted'], has_due: true }
    case 'overdue':
      return { status: ['posted'], overdue: true }
    case 'paid':
      return { status: ['posted'], payment_status: ['paid'] }
    case 'cancelled':
      return { status: ['cancelled'] }
    case 'all':
      return {}
  }
}

export const ORDER_FILTERS = ['all', 'draft', 'open', 'received', 'closed'] as const
export type OrderFilter = (typeof ORDER_FILTERS)[number]

export function orderFilterQuery(filter: OrderFilter): Partial<PurchaseOrderListQuery> {
  switch (filter) {
    case 'draft':
      return { status: ['draft'] }
    case 'open':
      return { status: ['sent', 'partially_received'] }
    case 'received':
      return { status: ['received'] }
    case 'closed':
      return { status: ['closed', 'cancelled'] }
    case 'all':
      return {}
  }
}

export const RETURN_FILTERS = ['all', 'active', 'expired', 'refunds', 'cancelled'] as const
export type ReturnFilter = (typeof RETURN_FILTERS)[number]

export function returnFilterQuery(filter: ReturnFilter): Partial<DebitNoteListQuery> {
  switch (filter) {
    case 'active':
      return { status: ['completed'] }
    case 'expired':
      return { reason: ['expired'] }
    case 'refunds':
      return { settlement: ['refund_cash', 'refund_bank'] }
    case 'cancelled':
      return { status: ['cancelled'] }
    case 'all':
      return {}
  }
}
