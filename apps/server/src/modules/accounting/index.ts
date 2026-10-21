/**
 * accounting module — accounts, journals, expenses, shifts, books, financial statements.
 * Owned by the accounting module (ARCHITECTURE.md §3.1).
 *
 * Endpoints: docs/API.md "accounting". Every route is registered from the shared catalogue
 * (`accountingRoutes` in @kadai/shared/api/accounting): method, path, schemas, permission and
 * feature guards and the idempotency-key check come from the contract. `{ tx }` implementations
 * run in ONE tenant transaction (RLS); idempotent creates (manual journals, expenses, shift open,
 * cash entries) are replayed through idempotentTx. `?format=csv` on lists, books and statements
 * streams the whole filtered range and is audited as a data export.
 *
 * Postings go through core/ledger (postJournal / reverseJournal) and numbering through
 * core/numbering — this module never writes journal tables or balances itself.
 */
import { accountingRoutes } from '@kadai/shared/api/accounting'
import { type RouteImpls, routePlugins } from '../../core/http'
import { defineModule } from '../module'
import {
  createAccount,
  deleteAccount,
  getAccountDetail,
  listAccounts,
  updateAccount,
} from './accounts'
import { accountLedger, cashBook, dayBook, dayBookCsv, ledgerCsv } from './books'
import { auditExport, sendCsv } from './common'
import { cancelExpense, createExpense, expensesCsv, getExpense, listExpenses } from './expenses'
import {
  createManualJournal,
  getJournalEntry,
  journalCsv,
  listJournalEntries,
  reverseManualJournal,
} from './journal'
import {
  addCashEntry,
  closeShift,
  currentShift,
  getShift,
  listShifts,
  openShift,
  shiftsCsv,
} from './shifts'
import {
  balanceSheet,
  balanceSheetCsv,
  profitLoss,
  profitLossCsv,
  trialBalance,
  trialBalanceCsv,
} from './statements'

type Routes = typeof accountingRoutes

const range = (q: { from?: string; to?: string }) => `${q.from ?? 'start'}-${q.to ?? 'today'}`

export const accountingImpls: RouteImpls<Routes> = {
  // ---- chart of accounts -------------------------------------------------------------------
  listAccounts: { tx: async (tx, req) => ({ data: await listAccounts(tx, req.ctx, req.query) }) },
  createAccount: { tx: async (tx, req) => ({ data: await createAccount(tx, req.ctx, req.body) }) },
  getAccount: {
    tx: async (tx, req) => ({ data: await getAccountDetail(tx, req.ctx, req.params.id) }),
  },
  updateAccount: {
    tx: async (tx, req) => ({
      data: await updateAccount(tx, req.ctx, req.params.id, req.body),
    }),
  },
  deleteAccount: {
    tx: async (tx, req) => ({ data: await deleteAccount(tx, req.ctx, req.params.id) }),
  },

  // ---- journal -----------------------------------------------------------------------------
  listJournalEntries: async (req, reply) => {
    if (req.query.format === 'csv') {
      const csv = await req.tx(async (tx) => {
        await auditExport(tx, req.ctx, 'journal_entries', 'Journal entries exported', req.query)
        return journalCsv(tx, req.ctx, req.query)
      })
      return sendCsv(reply, `journal-${range(req.query)}.csv`, csv)
    }
    return req.tx((tx) => listJournalEntries(tx, req.ctx, req.query))
  },
  getJournalEntry: {
    tx: async (tx, req) => ({ data: await getJournalEntry(tx, req.ctx, req.params.id) }),
  },
  createJournalEntry: {
    tx: async (tx, req) => ({ data: await createManualJournal(tx, req.ctx, req.body) }),
  },
  reverseJournalEntry: {
    tx: async (tx, req) => ({
      data: await reverseManualJournal(tx, req.ctx, req.params.id, req.body),
    }),
  },

  // ---- expenses ----------------------------------------------------------------------------
  listExpenses: async (req, reply) => {
    if (req.query.format === 'csv') {
      const csv = await req.tx(async (tx) => {
        await auditExport(tx, req.ctx, 'expenses', 'Expenses exported', req.query)
        const list = await listExpenses(tx, req.ctx, req.query, { all: true })
        return expensesCsv(list, req.ctx.locale)
      })
      return sendCsv(reply, `expenses-${range(req.query)}.csv`, csv)
    }
    return req.tx((tx) => listExpenses(tx, req.ctx, req.query))
  },
  createExpense: { tx: async (tx, req) => ({ data: await createExpense(tx, req.ctx, req.body) }) },
  getExpense: { tx: async (tx, req) => ({ data: await getExpense(tx, req.ctx, req.params.id) }) },
  cancelExpense: {
    tx: async (tx, req) => ({
      data: await cancelExpense(tx, req.ctx, req.params.id, req.body),
    }),
  },

  // ---- shifts ------------------------------------------------------------------------------
  openShift: { tx: async (tx, req) => ({ data: await openShift(tx, req.ctx, req.body) }) },
  currentShift: {
    tx: async (tx, req) => ({ data: await currentShift(tx, req.ctx, req.query.register_id) }),
  },
  listShifts: async (req, reply) => {
    if (req.query.format === 'csv') {
      const csv = await req.tx(async (tx) => {
        await auditExport(tx, req.ctx, 'shifts', 'Shifts exported', req.query)
        const list = await listShifts(tx, req.ctx, req.query, { all: true })
        return shiftsCsv(list, req.ctx.locale)
      })
      return sendCsv(reply, `shifts-${range(req.query)}.csv`, csv)
    }
    return req.tx((tx) => listShifts(tx, req.ctx, req.query))
  },
  getShift: { tx: async (tx, req) => ({ data: await getShift(tx, req.ctx, req.params.id) }) },
  addShiftCashEntry: {
    tx: async (tx, req) => ({
      data: await addCashEntry(tx, req.ctx, req.params.id, req.body),
    }),
  },
  closeShift: {
    tx: async (tx, req) => ({ data: await closeShift(tx, req.ctx, req.params.id, req.body) }),
  },

  // ---- books -------------------------------------------------------------------------------
  dayBook: async (req, reply) => {
    if (req.query.format === 'csv') {
      const csv = await req.tx(async (tx) => {
        const summary = `Day book of ${req.query.date} exported`
        await auditExport(tx, req.ctx, 'day_book', summary, req.query)
        return dayBookCsv(await dayBook(tx, req.ctx, req.query, { all: true }), req.ctx.locale)
      })
      return sendCsv(reply, `day-book-${req.query.date}.csv`, csv)
    }
    return req.tx((tx) => dayBook(tx, req.ctx, req.query))
  },
  cashBook: async (req, reply) => {
    if (req.query.format === 'csv') {
      const { csv, name } = await req.tx(async (tx) => {
        const book = await cashBook(tx, req.ctx, req.query, { all: true })
        const m = book.ledger
        await auditExport(
          tx,
          req.ctx,
          'cash_book',
          `Cash book of ${m.account.code} (${m.from} to ${m.to}) exported`,
          req.query,
        )
        return {
          csv: ledgerCsv(book, req.ctx.locale),
          name: `cash-book-${m.account.code}-${m.from}-${m.to}.csv`,
        }
      })
      return sendCsv(reply, name, csv)
    }
    return req.tx((tx) => cashBook(tx, req.ctx, req.query))
  },
  accountLedger: async (req, reply) => {
    if (req.query.format === 'csv') {
      const { csv, name } = await req.tx(async (tx) => {
        const book = await accountLedger(tx, req.ctx, req.params.accountId, req.query, {
          all: true,
        })
        const m = book.ledger
        await auditExport(
          tx,
          req.ctx,
          'ledger',
          `Ledger of ${m.account.code} (${m.from} to ${m.to}) exported`,
          req.query,
        )
        return {
          csv: ledgerCsv(book, req.ctx.locale),
          name: `ledger-${m.account.code}-${m.from}-${m.to}.csv`,
        }
      })
      return sendCsv(reply, name, csv)
    }
    return req.tx((tx) => accountLedger(tx, req.ctx, req.params.accountId, req.query))
  },

  // ---- statements --------------------------------------------------------------------------
  trialBalance: async (req, reply) => {
    const csv = req.query.format === 'csv'
    const tb = await req.tx(async (tx) => {
      const result = await trialBalance(tx, req.ctx, req.query)
      if (csv) {
        const summary = `Trial balance as of ${result.as_of} exported`
        await auditExport(tx, req.ctx, 'trial_balance', summary, req.query)
      }
      return result
    })
    if (csv) {
      return sendCsv(reply, `trial-balance-${tb.as_of}.csv`, trialBalanceCsv(tb, req.ctx.locale))
    }
    return { data: tb }
  },
  profitLoss: async (req, reply) => {
    const csv = req.query.format === 'csv'
    const pl = await req.tx(async (tx) => {
      const result = await profitLoss(tx, req.ctx, req.query)
      if (csv) {
        const summary = `Profit & loss ${result.from} to ${result.to} exported`
        await auditExport(tx, req.ctx, 'profit_loss', summary, req.query)
      }
      return result
    })
    if (csv) {
      return sendCsv(
        reply,
        `profit-loss-${pl.from}-${pl.to}.csv`,
        profitLossCsv(pl, req.ctx.locale),
      )
    }
    return { data: pl }
  },
  balanceSheet: async (req, reply) => {
    const csv = req.query.format === 'csv'
    const bs = await req.tx(async (tx) => {
      const result = await balanceSheet(tx, req.ctx, req.query)
      if (csv) {
        const summary = `Balance sheet as of ${result.as_of} exported`
        await auditExport(tx, req.ctx, 'balance_sheet', summary, req.query)
      }
      return result
    })
    if (csv) {
      return sendCsv(reply, `balance-sheet-${bs.as_of}.csv`, balanceSheetCsv(bs, req.ctx.locale))
    }
    return { data: bs }
  },
}

export const accountingModule = defineModule({
  name: 'accounting',
  ...routePlugins(accountingRoutes, accountingImpls),
})
