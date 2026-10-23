/** The fixtures answer exactly what the contract allows (so MSW tests exercise real shapes). */
import { accountingRoutes as r } from '@kadai/shared/api/accounting'
import { identityRoutes } from '@kadai/shared/api/identity'
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

describe('accounting fixtures', () => {
  it('match the chart of accounts and journal schemas', () => {
    ok(r.listAccounts.response, { data: F.chart() })
    ok(r.listAccounts.response, { data: F.chart({ balances: false, type: ['expense'] }) })
    ok(r.getAccount.response, { data: F.accountDetail(F.A.rent) })
    ok(r.getAccount.response, { data: F.accountDetail(F.A.godownRent) })
    ok(r.listJournalEntries.response, F.journalList())
    ok(r.getJournalEntry.response, { data: F.journalDetail() })
    ok(r.getJournalEntry.response, { data: F.expenseJournalDetail() })
  })

  it('match the expense and shift schemas', () => {
    ok(r.listExpenses.response, F.expenseList())
    ok(r.getExpense.response, { data: F.expenseDetail() })
    ok(r.listShifts.response, F.shiftList())
    ok(r.getShift.response, { data: F.shiftDetail() })
    ok(r.getShift.response, { data: F.closedShiftDetail() })
    ok(r.currentShift.response, { data: null })
    ok(r.addShiftCashEntry.response, { data: F.cashEntry() })
  })

  it('match the books and statements schemas', () => {
    ok(r.dayBook.response, F.dayBook())
    ok(r.cashBook.response, F.ledger())
    ok(r.accountLedger.response, F.ledger(F.A.receivable))
    ok(r.trialBalance.response, { data: F.trialBalance() })
    ok(r.profitLoss.response, { data: F.profitLoss() })
    ok(r.profitLoss.response, {
      data: F.profitLoss({ compare_from: '2025-04-01', compare_to: '2025-10-20' }),
    })
    ok(r.balanceSheet.response, { data: F.balanceSheet() })
  })

  it('match the schemas of the other modules the pickers call', () => {
    ok(partiesRoutes.listSuppliers.response, { data: [F.supplier()], page: F.page(1, 20) })
    ok(identityRoutes.userDirectory.response, { data: F.users() })
  })
})
