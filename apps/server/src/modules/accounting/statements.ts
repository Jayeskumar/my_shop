/**
 * Financial statements, all derived from journal_lines:
 *
 *  - Trial balance (as_of, tenant-wide): every account's net Σ debits − Σ credits on its side;
 *    the two columns always total equal because every entry balances.
 *  - Profit & loss (from–to, optional comparison period, optional store filter on
 *    journal_lines.store_id): income (sales − sales returns + other income + round off + discount
 *    received) − COGS (the cogs account and its sub-accounts) − expenses = net profit.
 *  - Balance sheet (as_of, tenant-wide; no closing entries): assets, liabilities, equity accounts
 *    plus this financial year's profit (= the P&L from the FY start to as_of) and the profit of
 *    earlier years; `balanced` checks Assets = Liabilities + Equity.
 */
import { type AccountType, addDays, fyOf, naturalBalance } from '@kadai/shared'
import type {
  BalanceSheetQuerySchema,
  ProfitLossQuerySchema,
  TrialBalanceQuerySchema,
} from '@kadai/shared/api/accounting'
import {
  ACCOUNT_TYPE_LABELS,
  type BalanceSheet,
  type ProfitLoss,
  STATEMENT_LINE_LABELS,
  type StatementLine,
  type TrialBalance,
  balanceSheetTotals,
  marginBp,
  profitLossTotals,
  trialBalanceSides,
} from '@kadai/shared/api/accounting'
import { toCsv } from '@kadai/shared/api/identity'
import type { z } from 'zod'
import { validationError } from '../../core/errors'
import type { Tx } from '../../db/tenant'
import { type DebitCredit, accountTotals } from './accounts'
import {
  type ChartRow,
  type Ctx,
  type Locale,
  assertAllStores,
  businessCalendar,
  csvAmount,
  fyStartOf,
  loadChart,
  loadStore,
  localName,
} from './common'

type TrialBalanceQuery = z.output<typeof TrialBalanceQuerySchema>
type ProfitLossQuery = z.output<typeof ProfitLossQuerySchema>
type BalanceSheetQuery = z.output<typeof BalanceSheetQuerySchema>

const ZERO: DebitCredit = { debit_paise: 0, credit_paise: 0 }

function natural(account: ChartRow, totals: Map<string, DebitCredit>): number {
  const t = totals.get(account.id) ?? ZERO
  return naturalBalance(account.type, t.debit_paise, t.credit_paise)
}

/** Ids of `rootIds` and all their descendants. */
function withDescendants(chart: readonly ChartRow[], rootIds: readonly string[]): Set<string> {
  const out = new Set(rootIds)
  let grew = true
  while (grew) {
    grew = false
    for (const a of chart) {
      if (a.parent_id && out.has(a.parent_id) && !out.has(a.id)) {
        out.add(a.id)
        grew = true
      }
    }
  }
  return out
}

const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0)

// ---------------------------------------------------------------------------------------------
// Trial balance
// ---------------------------------------------------------------------------------------------

export async function trialBalance(
  tx: Tx,
  ctx: Ctx,
  query: TrialBalanceQuery,
): Promise<TrialBalance> {
  assertAllStores(ctx)
  const cal = await businessCalendar(tx, ctx)
  const asOf = query.as_of ?? cal.today
  const chart = await loadChart(tx, ctx)
  const totals = await accountTotals(tx, ctx, { asOf, scoped: false })
  const rows = chart
    .map((a) => {
      const t = totals.get(a.id) ?? ZERO
      return { a, sides: trialBalanceSides(t.debit_paise, t.credit_paise) }
    })
    .filter(
      ({ a, sides }) =>
        sides.debit_paise !== 0 || sides.credit_paise !== 0 || (query.include_zero && a.is_active),
    )
    .map(({ a, sides }) => ({
      account_id: a.id,
      code: a.code,
      name: a.name,
      name_ta: a.name_ta,
      type: a.type,
      subtype: a.subtype,
      parent_id: a.parent_id,
      ...sides,
    }))
  const debit = sum(rows.map((r) => r.debit_paise))
  const credit = sum(rows.map((r) => r.credit_paise))
  return {
    as_of: asOf,
    rows,
    total_debit_paise: debit,
    total_credit_paise: credit,
    difference_paise: debit - credit,
    balanced: debit === credit,
  }
}

export function trialBalanceCsv(tb: TrialBalance, locale: Locale): string {
  const rows: string[][] = [
    [
      locale === 'ta' ? 'குறியீடு' : 'Code',
      locale === 'ta' ? 'கணக்கு' : 'Account',
      locale === 'ta' ? 'வகை' : 'Type',
      STATEMENT_LINE_LABELS.debit[locale],
      STATEMENT_LINE_LABELS.credit[locale],
    ],
  ]
  for (const r of tb.rows) {
    rows.push([
      r.code,
      localName(r, locale),
      ACCOUNT_TYPE_LABELS[r.type][locale],
      csvAmount(r.debit_paise || null),
      csvAmount(r.credit_paise || null),
    ])
  }
  rows.push([
    '',
    locale === 'ta' ? 'மொத்தம்' : 'Total',
    '',
    csvAmount(tb.total_debit_paise),
    csvAmount(tb.total_credit_paise),
  ])
  return toCsv(rows)
}

// ---------------------------------------------------------------------------------------------
// Profit & loss
// ---------------------------------------------------------------------------------------------

interface PeriodTotals {
  current: Map<string, DebitCredit>
  compare: Map<string, DebitCredit> | null
}

function statementLines(
  accounts: readonly ChartRow[],
  totals: PeriodTotals,
): { lines: StatementLine[]; total: number; compareTotal: number | null } {
  const lines: StatementLine[] = []
  for (const a of accounts) {
    const amount = natural(a, totals.current)
    const compare = totals.compare ? natural(a, totals.compare) : null
    if (amount === 0 && (compare === null || compare === 0)) continue
    lines.push({
      account_id: a.id,
      code: a.code,
      name: a.name,
      name_ta: a.name_ta,
      subtype: a.subtype,
      parent_id: a.parent_id,
      amount_paise: amount,
      compare_paise: compare,
    })
  }
  return {
    lines,
    total: sum(lines.map((l) => l.amount_paise)),
    compareTotal: totals.compare ? sum(lines.map((l) => l.compare_paise ?? 0)) : null,
  }
}

export async function profitLoss(tx: Tx, ctx: Ctx, query: ProfitLossQuery): Promise<ProfitLoss> {
  const cal = await businessCalendar(tx, ctx)
  const to = query.to ?? cal.today
  const from = query.from ?? fyStartOf(to, cal.fyStartMonth)
  if (from > to) throw validationError([{ path: 'to', message: 'date_order' }])
  if (query.store_id) await loadStore(tx, ctx, query.store_id)
  const storeId = query.store_id ?? null
  const chart = await loadChart(tx, ctx)
  const compare =
    query.compare_from && query.compare_to
      ? { from: query.compare_from, to: query.compare_to }
      : null
  const totals: PeriodTotals = {
    current: await accountTotals(tx, ctx, { asOf: to, from, storeId }),
    compare: compare
      ? await accountTotals(tx, ctx, { asOf: compare.to, from: compare.from, storeId })
      : null,
  }

  const byType = (type: AccountType) => chart.filter((a) => a.type === type)
  const cogsIds = withDescendants(
    chart,
    chart.filter((a) => a.subtype === 'cogs').map((a) => a.id),
  )
  const salesIds = withDescendants(
    chart,
    chart.filter((a) => a.subtype === 'sales' || a.subtype === 'sales_returns').map((a) => a.id),
  )
  const income = statementLines(byType('income'), totals)
  const cogs = statementLines(
    byType('expense').filter((a) => cogsIds.has(a.id)),
    totals,
  )
  const expenses = statementLines(
    byType('expense').filter((a) => !cogsIds.has(a.id)),
    totals,
  )
  const netSales = sum(
    chart.filter((a) => salesIds.has(a.id)).map((a) => natural(a, totals.current)),
  )
  const netSalesCompare = totals.compare
    ? sum(chart.filter((a) => salesIds.has(a.id)).map((a) => natural(a, totals.compare!)))
    : null
  const current = profitLossTotals({
    income: income.total,
    cogs: cogs.total,
    expenses: expenses.total,
  })
  const previous =
    income.compareTotal !== null && cogs.compareTotal !== null && expenses.compareTotal !== null
      ? profitLossTotals({
          income: income.compareTotal,
          cogs: cogs.compareTotal,
          expenses: expenses.compareTotal,
        })
      : null
  return {
    from,
    to,
    store_id: storeId,
    compare,
    income: {
      lines: income.lines,
      total_paise: income.total,
      compare_total_paise: income.compareTotal,
    },
    cogs: { lines: cogs.lines, total_paise: cogs.total, compare_total_paise: cogs.compareTotal },
    expenses: {
      lines: expenses.lines,
      total_paise: expenses.total,
      compare_total_paise: expenses.compareTotal,
    },
    net_sales_paise: netSales,
    net_sales_compare_paise: netSalesCompare,
    gross_profit_paise: current.gross_profit_paise,
    gross_profit_compare_paise: previous?.gross_profit_paise ?? null,
    net_profit_paise: current.net_profit_paise,
    net_profit_compare_paise: previous?.net_profit_paise ?? null,
    gross_margin_bp: marginBp(current.gross_profit_paise, netSales),
    net_margin_bp: marginBp(current.net_profit_paise, netSales),
  }
}

function sectionRows(
  title: string,
  section: { lines: StatementLine[]; total_paise: number; compare_total_paise?: number | null },
  locale: Locale,
  withCompare: boolean,
): string[][] {
  const rows: string[][] = []
  for (const l of section.lines) {
    rows.push([
      title,
      l.code,
      localName(l, locale),
      csvAmount(l.amount_paise),
      ...(withCompare ? [csvAmount(l.compare_paise)] : []),
    ])
  }
  rows.push([
    title,
    '',
    locale === 'ta' ? 'மொத்தம்' : 'Total',
    csvAmount(section.total_paise),
    ...(withCompare ? [csvAmount(section.compare_total_paise ?? null)] : []),
  ])
  return rows
}

export function profitLossCsv(pl: ProfitLoss, locale: Locale): string {
  const withCompare = pl.compare !== null
  const amountHeader = `${pl.from} – ${pl.to}`
  const rows: string[][] = [
    [
      locale === 'ta' ? 'பிரிவு' : 'Section',
      locale === 'ta' ? 'குறியீடு' : 'Code',
      locale === 'ta' ? 'கணக்கு' : 'Account',
      amountHeader,
      ...(pl.compare ? [`${pl.compare.from} – ${pl.compare.to}`] : []),
    ],
    ...sectionRows(STATEMENT_LINE_LABELS.income[locale], pl.income, locale, withCompare),
    ...sectionRows(STATEMENT_LINE_LABELS.cogs[locale], pl.cogs, locale, withCompare),
    [
      STATEMENT_LINE_LABELS.gross_profit[locale],
      '',
      '',
      csvAmount(pl.gross_profit_paise),
      ...(withCompare ? [csvAmount(pl.gross_profit_compare_paise)] : []),
    ],
    ...sectionRows(STATEMENT_LINE_LABELS.expenses[locale], pl.expenses, locale, withCompare),
    [
      pl.net_profit_paise < 0
        ? STATEMENT_LINE_LABELS.net_loss[locale]
        : STATEMENT_LINE_LABELS.net_profit[locale],
      '',
      '',
      csvAmount(pl.net_profit_paise),
      ...(withCompare ? [csvAmount(pl.net_profit_compare_paise)] : []),
    ],
  ]
  return toCsv(rows)
}

// ---------------------------------------------------------------------------------------------
// Balance sheet
// ---------------------------------------------------------------------------------------------

function profitOf(chart: readonly ChartRow[], totals: Map<string, DebitCredit>): number {
  let income = 0
  let expense = 0
  for (const a of chart) {
    if (a.type === 'income') income += natural(a, totals)
    else if (a.type === 'expense') expense += natural(a, totals)
  }
  return income - expense
}

export async function balanceSheet(
  tx: Tx,
  ctx: Ctx,
  query: BalanceSheetQuery,
): Promise<BalanceSheet> {
  assertAllStores(ctx)
  const cal = await businessCalendar(tx, ctx)
  const asOf = query.as_of ?? cal.today
  const fy = fyOf(asOf, cal.fyStartMonth)
  const fyStart = fyStartOf(asOf, cal.fyStartMonth)
  const chart = await loadChart(tx, ctx)
  const balances = await accountTotals(tx, ctx, { asOf, scoped: false })
  const thisYear = await accountTotals(tx, ctx, { asOf, from: fyStart, scoped: false })
  const earlier = await accountTotals(tx, ctx, { asOf: addDays(fyStart, -1), scoped: false })

  const section = (type: AccountType) => {
    const s = statementLines(
      chart.filter((a) => a.type === type),
      { current: balances, compare: null },
    )
    return { lines: s.lines, total_paise: s.total }
  }
  const assets = section('asset')
  const liabilities = section('liability')
  const equity = section('equity')
  const currentProfit = profitOf(chart, thisYear)
  const retained = profitOf(chart, earlier)
  const totals = balanceSheetTotals({
    assets: assets.total_paise,
    liabilities: liabilities.total_paise,
    equity: equity.total_paise,
    current_period_profit: currentProfit,
    retained_earnings: retained,
  })
  return {
    as_of: asOf,
    fy,
    fy_start: fyStart,
    assets,
    liabilities,
    equity,
    current_period_profit_paise: currentProfit,
    retained_earnings_paise: retained,
    total_equity_paise: totals.total_equity_paise,
    total_assets_paise: assets.total_paise,
    total_liabilities_equity_paise: totals.total_liabilities_equity_paise,
    difference_paise: totals.difference_paise,
    balanced: totals.balanced,
  }
}

export function balanceSheetCsv(bs: BalanceSheet, locale: Locale): string {
  const rows: string[][] = [
    [
      locale === 'ta' ? 'பிரிவு' : 'Section',
      locale === 'ta' ? 'குறியீடு' : 'Code',
      locale === 'ta' ? 'கணக்கு' : 'Account',
      bs.as_of,
    ],
    ...sectionRows(STATEMENT_LINE_LABELS.assets[locale], bs.assets, locale, false),
    ...sectionRows(STATEMENT_LINE_LABELS.liabilities[locale], bs.liabilities, locale, false),
    ...sectionRows(STATEMENT_LINE_LABELS.equity[locale], bs.equity, locale, false),
    [
      STATEMENT_LINE_LABELS.equity[locale],
      '',
      STATEMENT_LINE_LABELS.current_period_profit[locale],
      csvAmount(bs.current_period_profit_paise),
    ],
    [
      STATEMENT_LINE_LABELS.equity[locale],
      '',
      STATEMENT_LINE_LABELS.retained_earnings[locale],
      csvAmount(bs.retained_earnings_paise),
    ],
    [
      STATEMENT_LINE_LABELS.total_liabilities_equity[locale],
      '',
      '',
      csvAmount(bs.total_liabilities_equity_paise),
    ],
  ]
  return toCsv(rows)
}
