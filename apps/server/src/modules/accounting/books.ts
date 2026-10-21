/**
 * Books: day book (every entry of a day with its lines and source documents), cash book (a cash
 * / bank account) and the ledger of any account (party filter for receivable / payable).
 *
 * Ledger rows are journal lines in posting order (date, entry time, entry, line) with the running
 * natural balance computed by a window function over the WHOLE range, so every page continues
 * the balance of the previous one (`page_opening_balance_paise`). Store-scoped members only see
 * lines of their stores.
 */
import { type AccountType, JournalSourceTypeSchema, normalBalanceOf } from '@kadai/shared'
import type {
  CashBookQuerySchema,
  DayBookQuerySchema,
  LedgerQuerySchema,
} from '@kadai/shared/api/accounting'
import {
  type AccountLedgerResponse,
  type AccountLedgerRow,
  type DayBookResponse,
  JOURNAL_SOURCE_LABELS,
  STATEMENT_LINE_LABELS,
} from '@kadai/shared/api/accounting'
import { toCsv } from '@kadai/shared/api/identity'
import { type RawBuilder, sql } from 'kysely'
import type { z } from 'zod'
import { canAccessStore } from '../../core/context'
import { notFound, unprocessable, validationError } from '../../core/errors'
import { systemAccountId } from '../../core/ledger'
import type { Tx } from '../../db/tenant'
import {
  CSV_MAX_ROWS,
  type ChartRow,
  type Ctx,
  type Locale,
  businessCalendar,
  csvAmount,
  findAccount,
  loadChart,
  loadStore,
  localName,
  partyNames,
  sourceInfoOf,
  sourceInfos,
  storeMoneyAccountId,
} from './common'
import {
  ENTRY_COLUMNS,
  type EntryRow,
  entryBaseQuery,
  entryDetails,
  entryScopeCondition,
  entryStoreCondition,
  journalCsvRows,
} from './journal'

type DayBookQuery = z.output<typeof DayBookQuerySchema>
type LedgerQuery = z.output<typeof LedgerQuerySchema>
type CashBookQuery = z.output<typeof CashBookQuerySchema>

const MAX_COUNTER_ACCOUNTS = 5

// ---------------------------------------------------------------------------------------------
// Day book
// ---------------------------------------------------------------------------------------------

function dayEntries(tx: Tx, ctx: Ctx, query: DayBookQuery) {
  let q = entryBaseQuery(tx, ctx).where('e.entry_date', '=', query.date)
  if (query.store_id) q = q.where(entryStoreCondition(query.store_id))
  const scope = entryScopeCondition(ctx)
  if (scope) q = q.where(scope)
  if (query.source_type?.length) q = q.where('e.source_type', 'in', query.source_type)
  return q
}

export async function dayBook(
  tx: Tx,
  ctx: Ctx,
  query: DayBookQuery,
  opts: { all?: boolean } = {},
): Promise<DayBookResponse> {
  if (query.store_id) await loadStore(tx, ctx, query.store_id)
  const base = dayEntries(tx, ctx, query)
  const bySource = await base
    .select([
      'e.source_type',
      sql<number>`count(*)::int8`.as('count'),
      sql<number>`coalesce(sum((select coalesce(sum(tl.debit_paise), 0)
        from journal_lines tl where tl.tenant_id = e.tenant_id and tl.entry_id = e.id)), 0)::int8`.as(
        'total_paise',
      ),
    ])
    .groupBy('e.source_type')
    .orderBy('e.source_type')
    .execute()
  const rows = (await base
    .select(ENTRY_COLUMNS)
    .orderBy('e.created_at')
    .orderBy('e.id')
    .limit(opts.all ? CSV_MAX_ROWS : query.limit)
    .offset(opts.all ? 0 : query.offset)
    .execute()) as EntryRow[]
  const data = await entryDetails(tx, ctx, rows)
  const count = bySource.reduce((s, r) => s + r.count, 0)
  const total = bySource.reduce((s, r) => s + r.total_paise, 0)
  return {
    data,
    page: { limit: query.limit, offset: query.offset, total: count },
    day: {
      date: query.date,
      store_id: query.store_id ?? null,
      entry_count: count,
      total_debit_paise: total,
      total_credit_paise: total,
      by_source_type: bySource.map((r) => ({
        source_type: JournalSourceTypeSchema.parse(r.source_type),
        count: r.count,
        total_paise: r.total_paise,
      })),
    },
  }
}

export function dayBookCsv(book: DayBookResponse, locale: Locale): string {
  const rows = [...journalCsvRows(book.data, locale, true)]
  rows.push([
    '',
    '',
    '',
    '',
    locale === 'ta' ? 'மொத்தம்' : 'Total',
    '',
    '',
    '',
    '',
    csvAmount(book.day.total_debit_paise),
    csvAmount(book.day.total_credit_paise),
  ])
  return toCsv(rows)
}

// ---------------------------------------------------------------------------------------------
// Ledger / cash book
// ---------------------------------------------------------------------------------------------

interface LedgerFilter {
  account: ChartRow
  from: string
  to: string
  storeId: string | null
  party: { type: 'customer' | 'supplier'; id: string } | null
}

/** Natural amount of a line `l` for an account type: + on the account's normal side. */
function naturalSql(type: AccountType): RawBuilder<number> {
  return normalBalanceOf(type) === 'debit'
    ? sql<number>`(l.debit_paise - l.credit_paise)`
    : sql<number>`(l.credit_paise - l.debit_paise)`
}

function lineFilterSql(ctx: Ctx, f: LedgerFilter): RawBuilder<unknown> {
  const parts = [sql`l.tenant_id = ${ctx.tenantId}`, sql`l.account_id = ${f.account.id}`]
  if (f.storeId) parts.push(sql`l.store_id = ${f.storeId}`)
  else if (ctx.storeIds !== null) parts.push(sql`l.store_id = any(${[...ctx.storeIds]}::uuid[])`)
  if (f.party) parts.push(sql`l.party_type = ${f.party.type} and l.party_id = ${f.party.id}`)
  return sql.join(parts, sql` and `)
}

interface LedgerLine {
  entry_id: string
  line_id: string
  date: string
  source_type: string
  source_id: string | null
  narration: string | null
  memo: string | null
  party_type: 'customer' | 'supplier' | null
  party_id: string | null
  debit_paise: number
  credit_paise: number
  balance_paise: number
}

async function ledger(
  tx: Tx,
  ctx: Ctx,
  f: LedgerFilter,
  page: { limit: number; offset: number },
): Promise<AccountLedgerResponse> {
  const where = lineFilterSql(ctx, f)
  const natural = naturalSql(f.account.type)
  const totals = await sql<{
    opening: number
    debit: number
    credit: number
    n: number
  }>`
    select
      coalesce(sum(${natural}) filter (where l.entry_date < ${f.from}), 0)::int8 as opening,
      coalesce(sum(l.debit_paise) filter (where l.entry_date >= ${f.from}), 0)::int8 as debit,
      coalesce(sum(l.credit_paise) filter (where l.entry_date >= ${f.from}), 0)::int8 as credit,
      count(*) filter (where l.entry_date >= ${f.from})::int8 as n
    from journal_lines l
    where ${where} and l.entry_date <= ${f.to}`.execute(tx)
  const t = totals.rows[0] ?? { opening: 0, debit: 0, credit: 0, n: 0 }

  const lines = await sql<LedgerLine>`
    select * from (
      select
        l.entry_id, l.id as line_id, l.entry_date::text as date,
        e.source_type, e.source_id, e.narration, l.memo, l.party_type, l.party_id,
        l.debit_paise, l.credit_paise,
        (${t.opening}::int8 + sum(${natural}) over (
          order by l.entry_date, e.created_at, l.entry_id, l.id
          rows between unbounded preceding and current row))::int8 as balance_paise,
        e.created_at
      from journal_lines l
      join journal_entries e on e.tenant_id = l.tenant_id and e.id = l.entry_id
      where ${where} and l.entry_date >= ${f.from} and l.entry_date <= ${f.to}
    ) r
    order by r.date, r.created_at, r.entry_id, r.line_id
    limit ${page.limit} offset ${page.offset}`.execute(tx)

  const rows = lines.rows
  const entryIds = [...new Set(rows.map((r) => r.entry_id))]
  const others = entryIds.length
    ? await tx
        .selectFrom('journal_lines as ol')
        .innerJoin('accounts as a', (j) =>
          j.onRef('a.tenant_id', '=', 'ol.tenant_id').onRef('a.id', '=', 'ol.account_id'),
        )
        .select(['ol.entry_id', 'ol.account_id', 'ol.debit_paise', 'a.name', 'a.name_ta', 'a.code'])
        .where('ol.tenant_id', '=', ctx.tenantId)
        .where('ol.entry_id', 'in', entryIds)
        .orderBy('a.code')
        .execute()
    : []
  const sources = await sourceInfos(
    tx,
    ctx,
    rows.map((r) => ({
      source_type: JournalSourceTypeSchema.parse(r.source_type),
      source_id: r.source_id,
    })),
  )
  const parties = await partyNames(tx, ctx, rows)

  const data: AccountLedgerRow[] = rows.map((r) => {
    const sourceType = JournalSourceTypeSchema.parse(r.source_type)
    const src = sourceInfoOf(sources, { source_type: sourceType, source_id: r.source_id })
    const isDebit = r.debit_paise > 0
    const counter: string[] = []
    for (const o of others) {
      if (o.entry_id !== r.entry_id || o.account_id === f.account.id) continue
      if (isDebit === o.debit_paise > 0) continue
      const name = localName(o, ctx.locale)
      if (!counter.includes(name)) counter.push(name)
      if (counter.length >= MAX_COUNTER_ACCOUNTS) break
    }
    return {
      entry_id: r.entry_id,
      line_id: r.line_id,
      date: r.date,
      source_type: sourceType,
      source_id: r.source_id,
      source_number: src.number,
      source_path: src.path,
      narration: r.narration,
      memo: r.memo,
      counter_accounts: counter,
      party_type: r.party_type,
      party_id: r.party_id,
      party_name:
        r.party_type && r.party_id ? (parties.get(`${r.party_type}:${r.party_id}`) ?? null) : null,
      debit_paise: r.debit_paise,
      credit_paise: r.credit_paise,
      balance_paise: r.balance_paise,
    }
  })

  const closing =
    t.opening +
    (normalBalanceOf(f.account.type) === 'debit' ? t.debit - t.credit : t.credit - t.debit)
  const first = data[0]
  const pageOpening = first
    ? first.balance_paise -
      (normalBalanceOf(f.account.type) === 'debit'
        ? first.debit_paise - first.credit_paise
        : first.credit_paise - first.debit_paise)
    : page.offset > 0
      ? closing
      : t.opening

  let partyMeta: AccountLedgerResponse['ledger']['party'] = null
  if (f.party) {
    const names = await partyNames(tx, ctx, [{ party_type: f.party.type, party_id: f.party.id }])
    const name = names.get(`${f.party.type}:${f.party.id}`)
    if (!name) throw notFound(f.party.type, f.party.id)
    partyMeta = { type: f.party.type, id: f.party.id, name }
  }

  return {
    data,
    page: { limit: page.limit, offset: page.offset, total: t.n },
    ledger: {
      account: {
        id: f.account.id,
        code: f.account.code,
        name: f.account.name,
        name_ta: f.account.name_ta,
        type: f.account.type,
        subtype: f.account.subtype,
      },
      party: partyMeta,
      store_id: f.storeId,
      from: f.from,
      to: f.to,
      opening_balance_paise: t.opening,
      total_debit_paise: t.debit,
      total_credit_paise: t.credit,
      closing_balance_paise: closing,
      page_opening_balance_paise: pageOpening,
    },
  }
}

async function ledgerFilter(
  tx: Tx,
  ctx: Ctx,
  account: ChartRow,
  query: LedgerQuery | CashBookQuery,
): Promise<LedgerFilter> {
  const cal = await businessCalendar(tx, ctx)
  const to = query.to ?? cal.today
  const from = query.from ?? `${to.slice(0, 7)}-01`
  if (from > to) throw validationError([{ path: 'to', message: 'date_order' }])
  if (query.store_id) await loadStore(tx, ctx, query.store_id)
  if (account.store_id && !canAccessStore(ctx, account.store_id))
    throw notFound('account', account.id)
  return {
    account,
    from,
    to,
    storeId: query.store_id ?? null,
    party:
      query.party_type && query.party_id ? { type: query.party_type, id: query.party_id } : null,
  }
}

export async function accountLedger(
  tx: Tx,
  ctx: Ctx,
  accountId: string,
  query: LedgerQuery,
  opts: { all?: boolean } = {},
): Promise<AccountLedgerResponse> {
  const chart = await loadChart(tx, ctx)
  const account = findAccount(chart, ctx, accountId)
  const filter = await ledgerFilter(tx, ctx, account, query)
  return ledger(tx, ctx, filter, opts.all ? { limit: CSV_MAX_ROWS, offset: 0 } : query)
}

export async function cashBook(
  tx: Tx,
  ctx: Ctx,
  query: CashBookQuery,
  opts: { all?: boolean } = {},
): Promise<AccountLedgerResponse> {
  const chart = await loadChart(tx, ctx)
  let account: ChartRow
  if (query.account_id) {
    account = findAccount(chart, ctx, query.account_id)
    if (!account.money_kind) {
      throw unprocessable('The cash book is kept for cash and bank accounts only', {
        reason: 'money_account_required',
        path: 'account_id',
      })
    }
  } else {
    const id = query.store_id
      ? await storeMoneyAccountId(tx, ctx, chart, query.store_id, 'cash')
      : await systemAccountId(tx, ctx, 'cash')
    account = findAccount(chart, ctx, id)
  }
  const filter = await ledgerFilter(tx, ctx, account, query)
  return ledger(tx, ctx, filter, opts.all ? { limit: CSV_MAX_ROWS, offset: 0 } : query)
}

const LEDGER_CSV_HEADERS = {
  date: { en: 'Date', ta: 'தேதி' },
  type: { en: 'Type', ta: 'வகை' },
  document: { en: 'Document no.', ta: 'ஆவண எண்' },
  particulars: { en: 'Particulars', ta: 'விவரங்கள்' },
  party: { en: 'Party', ta: 'நபர்' },
  narration: { en: 'Narration', ta: 'விவரம்' },
  debit: { en: 'Debit', ta: 'பற்று' },
  credit: { en: 'Credit', ta: 'வரவு' },
  balance: { en: 'Balance', ta: 'இருப்பு' },
} as const

export function ledgerCsv(book: AccountLedgerResponse, locale: Locale): string {
  const m = book.ledger
  const rows: string[][] = [
    [`${m.account.code} ${localName(m.account, locale)}`, `${m.from} – ${m.to}`],
    Object.values(LEDGER_CSV_HEADERS).map((h) => h[locale]),
    [
      m.from,
      '',
      '',
      STATEMENT_LINE_LABELS.opening_balance[locale],
      '',
      '',
      '',
      '',
      csvAmount(m.opening_balance_paise),
    ],
  ]
  for (const r of book.data) {
    rows.push([
      r.date,
      JOURNAL_SOURCE_LABELS[r.source_type][locale],
      r.source_number ?? '',
      r.counter_accounts.join('; '),
      r.party_name ?? '',
      r.narration ?? '',
      csvAmount(r.debit_paise || null),
      csvAmount(r.credit_paise || null),
      csvAmount(r.balance_paise),
    ])
  }
  rows.push([
    m.to,
    '',
    '',
    STATEMENT_LINE_LABELS.closing_balance[locale],
    '',
    '',
    csvAmount(m.total_debit_paise),
    csvAmount(m.total_credit_paise),
    csvAmount(m.closing_balance_paise),
  ])
  return toCsv(rows)
}
