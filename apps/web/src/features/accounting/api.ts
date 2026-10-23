/**
 * Data hooks of the accounting feature. Every call goes through the shared route catalogue
 * (`accountingRoutes`, plus identity's file routes for bill photos), so paths, params and
 * payloads follow the contract exactly. Mutations invalidate by route: `/accounts` also refreshes
 * `/accounts/:id`, `/shifts` refreshes `/shifts/:id` and `/shifts/current`, and every posting
 * refreshes the books and statements that read the journal.
 */
import { keepPreviousData } from '@tanstack/react-query'
import {
  type CashBookQuery,
  type ChartOfAccountsQuery,
  type DayBookQuery,
  type ExpenseListQuery,
  type JournalListQuery,
  type LedgerQuery,
  type ProfitLossQuery,
  type ShiftListQuery,
  type TrialBalanceQuery,
  type BalanceSheetQuery,
  accountingRoutes as r,
} from '@kadai/shared/api/accounting'
import type { RouteDef } from '@kadai/shared/api/common'
import { useRouteMutation, useRouteQuery } from '@/lib/query'

/**
 * Mutations of this feature report their own errors (inline form errors or one specific toast
 * via notifyAccountingError), so the central mutation toast is switched off.
 */
const OWN_ERRORS = { meta: { errorToast: false } } as const

/** Everything a journal posting can change: books, statements, balances. */
export const LEDGER_ROUTES: readonly RouteDef[] = [
  r.listAccounts,
  r.listJournalEntries,
  r.dayBook,
  r.cashBook,
  r.accountLedger,
  r.trialBalance,
  r.profitLoss,
  r.balanceSheet,
]

const SHIFT_ROUTES: readonly RouteDef[] = [r.listShifts, r.currentShift]

// ---- chart of accounts -------------------------------------------------------------------------

export function useChartOfAccounts(
  query: ChartOfAccountsQuery,
  options: { enabled?: boolean } = {},
) {
  return useRouteQuery(r.listAccounts, { query }, { placeholderData: keepPreviousData, ...options })
}

export function useAccount(id: string | null) {
  return useRouteQuery(r.getAccount, { params: { id: id ?? '' } }, { enabled: Boolean(id) })
}

export function useCreateAccount() {
  return useRouteMutation(r.createAccount, { ...OWN_ERRORS, invalidates: [r.listAccounts] })
}

export function useUpdateAccount() {
  return useRouteMutation(r.updateAccount, { ...OWN_ERRORS, invalidates: LEDGER_ROUTES })
}

export function useDeleteAccount() {
  return useRouteMutation(r.deleteAccount, { ...OWN_ERRORS, invalidates: [r.listAccounts] })
}

// ---- journal -----------------------------------------------------------------------------------

export function useJournalEntries(query: JournalListQuery, options: { enabled?: boolean } = {}) {
  return useRouteQuery(
    r.listJournalEntries,
    { query },
    { placeholderData: keepPreviousData, ...options },
  )
}

export function useJournalEntry(id: string | null) {
  return useRouteQuery(r.getJournalEntry, { params: { id: id ?? '' } }, { enabled: Boolean(id) })
}

export function useCreateJournalEntry() {
  return useRouteMutation(r.createJournalEntry, { ...OWN_ERRORS, invalidates: LEDGER_ROUTES })
}

export function useReverseJournalEntry() {
  return useRouteMutation(r.reverseJournalEntry, { ...OWN_ERRORS, invalidates: LEDGER_ROUTES })
}

// ---- expenses ----------------------------------------------------------------------------------

export function useExpenses(query: ExpenseListQuery) {
  return useRouteQuery(r.listExpenses, { query }, { placeholderData: keepPreviousData })
}

export function useExpense(id: string | null) {
  return useRouteQuery(r.getExpense, { params: { id: id ?? '' } }, { enabled: Boolean(id) })
}

export function useCreateExpense() {
  return useRouteMutation(r.createExpense, {
    ...OWN_ERRORS,
    invalidates: [r.listExpenses, ...LEDGER_ROUTES, ...SHIFT_ROUTES],
  })
}

export function useCancelExpense() {
  return useRouteMutation(r.cancelExpense, {
    ...OWN_ERRORS,
    invalidates: [r.listExpenses, ...LEDGER_ROUTES, ...SHIFT_ROUTES],
  })
}

// ---- shifts ------------------------------------------------------------------------------------

export function useShifts(query: ShiftListQuery) {
  return useRouteQuery(r.listShifts, { query }, { placeholderData: keepPreviousData })
}

/** Shift detail; an open shift's live X report refreshes every minute. */
export function useShift(id: string | null) {
  return useRouteQuery(
    r.getShift,
    { params: { id: id ?? '' } },
    {
      enabled: Boolean(id),
      refetchInterval: (query) => (query.state.data?.data.status === 'open' ? 60_000 : false),
    },
  )
}

/** The register's open shift (null when none). Errors are shown by the caller, not toasted. */
export function useCurrentShift(registerId: string | null, options: { enabled?: boolean } = {}) {
  return useRouteQuery(
    r.currentShift,
    { query: { register_id: registerId ?? '' } },
    {
      enabled: Boolean(registerId) && (options.enabled ?? true),
      meta: { errorToast: false },
      refetchInterval: 2 * 60_000,
    },
  )
}

export function useOpenShift() {
  return useRouteMutation(r.openShift, { ...OWN_ERRORS, invalidates: SHIFT_ROUTES })
}

export function useAddCashEntry() {
  return useRouteMutation(r.addShiftCashEntry, {
    ...OWN_ERRORS,
    invalidates: [...SHIFT_ROUTES, ...LEDGER_ROUTES],
  })
}

export function useCloseShift() {
  return useRouteMutation(r.closeShift, {
    ...OWN_ERRORS,
    invalidates: [...SHIFT_ROUTES, ...LEDGER_ROUTES],
  })
}

// ---- books -------------------------------------------------------------------------------------

export function useDayBook(query: DayBookQuery) {
  return useRouteQuery(r.dayBook, { query }, { placeholderData: keepPreviousData })
}

export function useCashBook(query: CashBookQuery, options: { enabled?: boolean } = {}) {
  return useRouteQuery(r.cashBook, { query }, { placeholderData: keepPreviousData, ...options })
}

export function useAccountLedger(
  accountId: string | null,
  query: LedgerQuery,
  options: { enabled?: boolean } = {},
) {
  return useRouteQuery(
    r.accountLedger,
    { params: { accountId: accountId ?? '' }, query },
    {
      placeholderData: keepPreviousData,
      ...options,
      enabled: Boolean(accountId) && (options.enabled ?? true),
    },
  )
}

// ---- statements --------------------------------------------------------------------------------

export function useTrialBalance(query: TrialBalanceQuery, options: { enabled?: boolean } = {}) {
  return useRouteQuery(r.trialBalance, { query }, { placeholderData: keepPreviousData, ...options })
}

export function useProfitLoss(query: ProfitLossQuery, options: { enabled?: boolean } = {}) {
  return useRouteQuery(r.profitLoss, { query }, { placeholderData: keepPreviousData, ...options })
}

export function useBalanceSheet(query: BalanceSheetQuery, options: { enabled?: boolean } = {}) {
  return useRouteQuery(r.balanceSheet, { query }, { placeholderData: keepPreviousData, ...options })
}
