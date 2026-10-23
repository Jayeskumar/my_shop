/**
 * Journal entries: list / detail of every posted entry with its lines and source document, manual
 * journal vouchers (JV series) and their one-time reversal.
 *
 * Every write goes through core/ledger (postJournal / reverseJournal): a manual JV is source
 * 'manual' with source_id = a voucher id, so reverseJournal can mirror it exactly once (the unique
 * index on reverses_entry_id is the backstop; an advisory lock serialises concurrent attempts).
 * Store-scoped members only see entries of their stores (entry or line store).
 */
import { type JournalSourceType, newId, sumSafe } from '@kadai/shared'
import {
  type AccountSubtype,
  JOURNAL_SOURCE_LABELS,
  type JournalEntry,
  type JournalEntryDetail,
  type JournalLine,
  type JournalListQuerySchema,
  type JournalListResponse,
  type JournalReverseSchema,
  type ManualJournalCreateSchema,
} from '@kadai/shared/api/accounting'
import { toCsv } from '@kadai/shared/api/identity'
import { type Expression, type SqlBool, sql } from 'kysely'
import type { z } from 'zod'
import { audit } from '../../core/audit'
import { AppError, conflict, notFound, unprocessable, validationError } from '../../core/errors'
import { postJournal, reverseJournal } from '../../core/ledger'
import { nextNumber } from '../../core/numbering'
import type { Tx } from '../../db/tenant'
import {
  CSV_MAX_ROWS,
  type Ctx,
  type Locale,
  businessCalendar,
  can,
  csvAmount,
  defaultStoreId,
  findAccount,
  likePattern,
  loadChart,
  loadStore,
  localName,
  lockKey,
  partyNames,
  rupees,
  sourceInfoOf,
  sourceInfos,
} from './common'

type JournalListQuery = z.output<typeof JournalListQuerySchema>
type ManualJournalBody = z.output<typeof ManualJournalCreateSchema>
type JournalReverseBody = z.output<typeof JournalReverseSchema>

const MAX_LIST_ACCOUNT_NAMES = 3

// ---------------------------------------------------------------------------------------------
// Loading entries (list rows and details)
// ---------------------------------------------------------------------------------------------

interface EntryRow {
  id: string
  entry_date: string
  number: string | null
  source_type: JournalSourceType
  source_id: string | null
  narration: string | null
  store_id: string | null
  store_name: string | null
  reverses_entry_id: string | null
  reversed_by_entry_id: string | null
  created_by: string | null
  created_by_name: string | null
  created_at: Date
}

interface LineRow {
  id: string
  entry_id: string
  account_id: string
  account_code: string
  account_name: string
  account_name_ta: string | null
  account_type: JournalLine['account_type']
  account_subtype: AccountSubtype | null
  debit_paise: number
  credit_paise: number
  party_type: 'customer' | 'supplier' | null
  party_id: string | null
  store_id: string | null
  memo: string | null
}

/** Base select of journal_entries `e` with store, creator and reversal links. */
export function entryBaseQuery(tx: Tx, ctx: Pick<Ctx, 'tenantId'>) {
  return tx
    .selectFrom('journal_entries as e')
    .leftJoin('stores as s', (j) =>
      j.onRef('s.tenant_id', '=', 'e.tenant_id').onRef('s.id', '=', 'e.store_id'),
    )
    .leftJoin('users as u', 'u.id', 'e.created_by')
    .leftJoin('journal_entries as r', (j) =>
      j.onRef('r.tenant_id', '=', 'e.tenant_id').onRef('r.reverses_entry_id', '=', 'e.id'),
    )
    .where('e.tenant_id', '=', ctx.tenantId)
}

const ENTRY_COLUMNS = [
  'e.id',
  'e.entry_date',
  'e.number',
  'e.source_type',
  'e.source_id',
  'e.narration',
  'e.store_id',
  's.name as store_name',
  'e.reverses_entry_id',
  'r.id as reversed_by_entry_id',
  'e.created_by',
  'u.full_name as created_by_name',
  'e.created_at',
] as const

/** Entry visibility for store-scoped members: entry store or any line store is theirs. */
export function entryScopeCondition(ctx: Pick<Ctx, 'storeIds'>): Expression<SqlBool> | null {
  if (ctx.storeIds === null) return null
  const ids = [...ctx.storeIds]
  return sql<SqlBool>`(e.store_id = any(${ids}::uuid[]) or exists (
    select 1 from journal_lines sl
     where sl.tenant_id = e.tenant_id and sl.entry_id = e.id and sl.store_id = any(${ids}::uuid[])))`
}

/** Entries with a line of `storeId`, or whose own store is `storeId`. */
export function entryStoreCondition(storeId: string): Expression<SqlBool> {
  return sql<SqlBool>`(e.store_id = ${storeId} or exists (
    select 1 from journal_lines fl
     where fl.tenant_id = e.tenant_id and fl.entry_id = e.id and fl.store_id = ${storeId}))`
}

async function loadLines(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  entryIds: readonly string[],
): Promise<LineRow[]> {
  if (entryIds.length === 0) return []
  const rows = await tx
    .selectFrom('journal_lines as l')
    .innerJoin('accounts as a', (j) =>
      j.onRef('a.tenant_id', '=', 'l.tenant_id').onRef('a.id', '=', 'l.account_id'),
    )
    .select([
      'l.id',
      'l.entry_id',
      'l.account_id',
      'a.code as account_code',
      'a.name as account_name',
      'a.name_ta as account_name_ta',
      'a.type as account_type',
      'a.subtype as account_subtype',
      'l.debit_paise',
      'l.credit_paise',
      'l.party_type',
      'l.party_id',
      'l.store_id',
      'l.memo',
    ])
    .where('l.tenant_id', '=', ctx.tenantId)
    .where('l.entry_id', 'in', [...entryIds])
    // Debits first, then credits; by account code.
    .orderBy(sql`l.debit_paise = 0`)
    .orderBy('a.code')
    .orderBy('l.id')
    .execute()
  return rows as LineRow[]
}

function accountNames(lines: readonly LineRow[], side: 'debit' | 'credit', locale: Locale) {
  const names: string[] = []
  for (const l of lines) {
    if ((side === 'debit' ? l.debit_paise : l.credit_paise) <= 0) continue
    const name = localName({ name: l.account_name, name_ta: l.account_name_ta }, locale)
    if (!names.includes(name)) names.push(name)
    if (names.length >= MAX_LIST_ACCOUNT_NAMES) break
  }
  return names
}

/** List rows (JournalEntry) for loaded entry rows. */
async function toEntries(
  tx: Tx,
  ctx: Ctx,
  rows: readonly EntryRow[],
): Promise<{ entries: JournalEntry[]; lines: Map<string, LineRow[]> }> {
  const lines = await loadLines(
    tx,
    ctx,
    rows.map((r) => r.id),
  )
  const byEntry = new Map<string, LineRow[]>()
  for (const l of lines) byEntry.set(l.entry_id, [...(byEntry.get(l.entry_id) ?? []), l])
  const sources = await sourceInfos(tx, ctx, rows)
  const entries = rows.map((r): JournalEntry => {
    const own = byEntry.get(r.id) ?? []
    const src = sourceInfoOf(sources, r)
    return {
      id: r.id,
      entry_date: r.entry_date,
      number: r.number,
      source_type: r.source_type,
      source_id: r.source_id,
      source_number: src.number,
      source_path: src.path,
      narration: r.narration,
      store_id: r.store_id,
      store_name: r.store_name,
      total_paise: sumSafe(own.map((l) => l.debit_paise)),
      line_count: own.length,
      debit_accounts: accountNames(own, 'debit', ctx.locale),
      credit_accounts: accountNames(own, 'credit', ctx.locale),
      reverses_entry_id: r.reverses_entry_id,
      reversed_by_entry_id: r.reversed_by_entry_id,
      created_by: r.created_by,
      created_by_name: r.created_by_name,
      created_at: r.created_at.toISOString(),
    }
  })
  return { entries, lines: byEntry }
}

/** Full details (lines, source, reversal links) of the given entries, in the given order. */
export async function entryDetails(
  tx: Tx,
  ctx: Ctx,
  rows: readonly EntryRow[],
): Promise<JournalEntryDetail[]> {
  const { entries, lines } = await toEntries(tx, ctx, rows)
  const parties = await partyNames(tx, ctx, [...lines.values()].flat())
  const linkIds = [
    ...new Set(
      rows.flatMap((r) =>
        [r.reverses_entry_id, r.reversed_by_entry_id].filter((x): x is string => x !== null),
      ),
    ),
  ]
  const links = new Map<string, { id: string; number: string | null; entry_date: string }>()
  if (linkIds.length) {
    const linkRows = await tx
      .selectFrom('journal_entries')
      .select(['id', 'number', 'entry_date'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', 'in', linkIds)
      .execute()
    for (const l of linkRows) links.set(l.id, l)
  }
  const writer = can(ctx, 'accounting.write')
  return entries.map((e) => ({
    ...e,
    lines: (lines.get(e.id) ?? []).map((l): JournalLine => ({
      id: l.id,
      account_id: l.account_id,
      account_code: l.account_code,
      account_name: l.account_name,
      account_name_ta: l.account_name_ta,
      account_type: l.account_type,
      account_subtype: l.account_subtype,
      debit_paise: l.debit_paise,
      credit_paise: l.credit_paise,
      party_type: l.party_type,
      party_id: l.party_id,
      party_name:
        l.party_type && l.party_id ? (parties.get(`${l.party_type}:${l.party_id}`) ?? null) : null,
      store_id: l.store_id,
      memo: l.memo,
    })),
    source: {
      type: e.source_type,
      id: e.source_id,
      number: e.source_number,
      path: e.source_path,
    },
    reverses: e.reverses_entry_id ? (links.get(e.reverses_entry_id) ?? null) : null,
    reversed_by: e.reversed_by_entry_id ? (links.get(e.reversed_by_entry_id) ?? null) : null,
    can_reverse:
      writer &&
      e.source_type === 'manual' &&
      e.reverses_entry_id === null &&
      e.reversed_by_entry_id === null,
  }))
}

async function loadEntryRow(tx: Tx, ctx: Ctx, id: string): Promise<EntryRow> {
  let q = entryBaseQuery(tx, ctx).select(ENTRY_COLUMNS).where('e.id', '=', id)
  const scope = entryScopeCondition(ctx)
  if (scope) q = q.where(scope)
  const row = await q.executeTakeFirst()
  if (!row) throw notFound('journal_entry', id)
  return row as EntryRow
}

export async function getJournalEntry(tx: Tx, ctx: Ctx, id: string): Promise<JournalEntryDetail> {
  const row = await loadEntryRow(tx, ctx, id)
  const [detail] = await entryDetails(tx, ctx, [row])
  if (!detail) throw new AppError('INTERNAL', 'journal entry detail missing')
  return detail
}

// ---------------------------------------------------------------------------------------------
// List (GET /journal-entries)
// ---------------------------------------------------------------------------------------------

/** Source documents whose number matches `pattern` (q search). */
function sourceNumberMatch(pattern: string): Expression<SqlBool> {
  const doc = (type: JournalSourceType, table: string) =>
    sql`(e.source_type = ${type} and exists (
      select 1 from ${sql.table(table)} d
       where d.tenant_id = e.tenant_id and d.id = e.source_id and d.number ilike ${pattern}))`
  return sql<SqlBool>`(
    e.number ilike ${pattern}
    or e.narration ilike ${pattern}
    or ${doc('sales_invoice', 'sales_invoices')}
    or ${doc('credit_note', 'credit_notes')}
    or ${doc('purchase_bill', 'purchase_bills')}
    or ${doc('debit_note', 'debit_notes')}
    or ${doc('payment', 'payments')}
    or ${doc('expense', 'expenses')}
    or ${doc('stock_adjustment', 'stock_adjustments')}
    or ${doc('stock_transfer', 'stock_transfers')}
    or (e.source_type = 'manual' and exists (
      select 1 from journal_entries o
       where o.tenant_id = e.tenant_id and o.source_type = 'manual'
         and o.source_id = e.source_id and o.number ilike ${pattern})))`
}

function filteredEntries(tx: Tx, ctx: Ctx, query: JournalListQuery) {
  let q = entryBaseQuery(tx, ctx)
  if (query.from) q = q.where('e.entry_date', '>=', query.from)
  if (query.to) q = q.where('e.entry_date', '<=', query.to)
  if (query.source_type?.length) q = q.where('e.source_type', 'in', query.source_type)
  if (query.source_id) q = q.where('e.source_id', '=', query.source_id)
  if (query.account_id) {
    const accountId = query.account_id
    q = q.where(
      sql<SqlBool>`exists (select 1 from journal_lines al
        where al.tenant_id = e.tenant_id and al.entry_id = e.id and al.account_id = ${accountId})`,
    )
  }
  if (query.party_type && query.party_id) {
    const { party_type: pt, party_id: pid } = query
    q = q.where(
      sql<SqlBool>`exists (select 1 from journal_lines pl
        where pl.tenant_id = e.tenant_id and pl.entry_id = e.id
          and pl.party_type = ${pt} and pl.party_id = ${pid})`,
    )
  }
  if (query.store_id) q = q.where(entryStoreCondition(query.store_id))
  const scope = entryScopeCondition(ctx)
  if (scope) q = q.where(scope)
  if (query.reversals === true) q = q.where('e.reverses_entry_id', 'is not', null)
  if (query.reversals === false) {
    q = q.where('e.reverses_entry_id', 'is', null).where('r.id', 'is', null)
  }
  if (query.q) q = q.where(sourceNumberMatch(likePattern(query.q)))
  return q
}

const entryTotalSql = sql<number>`(select coalesce(sum(tl.debit_paise), 0)::int8
  from journal_lines tl where tl.tenant_id = e.tenant_id and tl.entry_id = e.id)`

export async function listJournalEntries(
  tx: Tx,
  ctx: Ctx,
  query: JournalListQuery,
  opts: { all?: boolean } = {},
): Promise<JournalListResponse> {
  const base = filteredEntries(tx, ctx, query)
  const summary = await base
    .select([
      sql<number>`count(*)::int8`.as('count'),
      sql<number>`coalesce(sum(${entryTotalSql}), 0)::int8`.as('total_paise'),
    ])
    .executeTakeFirstOrThrow()
  const dir = query.sort.direction
  let rowsQ = base.select([...ENTRY_COLUMNS, entryTotalSql.as('total_paise')])
  rowsQ =
    query.sort.field === 'total_paise'
      ? rowsQ.orderBy(sql`total_paise`, dir)
      : rowsQ.orderBy(`e.${query.sort.field}`, dir)
  rowsQ = rowsQ.orderBy('e.created_at', dir).orderBy('e.id', dir)
  const limit = opts.all ? CSV_MAX_ROWS : query.limit
  const offset = opts.all ? 0 : query.offset
  const rows = (await rowsQ.limit(limit).offset(offset).execute()) as EntryRow[]
  const { entries } = await toEntries(tx, ctx, rows)
  return {
    data: entries,
    page: { limit: query.limit, offset: query.offset, total: summary.count },
    summary: { count: summary.count, total_paise: summary.total_paise },
  }
}

/** CSV of the filtered journal (one row per line). */
export async function journalCsv(tx: Tx, ctx: Ctx, query: JournalListQuery): Promise<string> {
  const base = filteredEntries(tx, ctx, query)
  const rows = (await base
    .select(ENTRY_COLUMNS)
    .orderBy('e.entry_date')
    .orderBy('e.created_at')
    .orderBy('e.id')
    .limit(CSV_MAX_ROWS)
    .execute()) as EntryRow[]
  const details = await entryDetails(tx, ctx, rows)
  return toCsv([...journalCsvRows(details, ctx.locale, true)])
}

const CSV_HEADERS = {
  date: { en: 'Date', ta: 'தேதி' },
  voucher: { en: 'Voucher', ta: 'வவுச்சர்' },
  source: { en: 'Type', ta: 'வகை' },
  document: { en: 'Document no.', ta: 'ஆவண எண்' },
  narration: { en: 'Narration', ta: 'விவரம்' },
  code: { en: 'Account code', ta: 'கணக்கு குறியீடு' },
  account: { en: 'Account', ta: 'கணக்கு' },
  party: { en: 'Party', ta: 'நபர்' },
  memo: { en: 'Memo', ta: 'குறிப்பு' },
  debit: { en: 'Debit', ta: 'பற்று' },
  credit: { en: 'Credit', ta: 'வரவு' },
} as const

/** CSV rows of journal entries with their lines (header first when `header`). */
export function* journalCsvRows(
  entries: readonly JournalEntryDetail[],
  locale: Locale,
  header: boolean,
): Generator<string[]> {
  if (header) yield Object.values(CSV_HEADERS).map((h) => h[locale])
  for (const e of entries) {
    for (const l of e.lines) {
      yield [
        e.entry_date,
        e.number ?? '',
        JOURNAL_SOURCE_LABELS[e.source_type][locale],
        e.source_number ?? '',
        e.narration ?? '',
        l.account_code,
        localName({ name: l.account_name, name_ta: l.account_name_ta }, locale),
        l.party_name ?? '',
        l.memo ?? '',
        csvAmount(l.debit_paise || null),
        csvAmount(l.credit_paise || null),
      ]
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Manual journal voucher (POST /journal-entries)
// ---------------------------------------------------------------------------------------------

export async function createManualJournal(
  tx: Tx,
  ctx: Ctx,
  body: ManualJournalBody,
): Promise<JournalEntryDetail> {
  const storeId = body.store_id ?? (await defaultStoreId(tx, ctx))
  await loadStore(tx, ctx, storeId)
  const chart = await loadChart(tx, ctx)
  const lineStores = new Set<string>()
  const lines = body.lines.map((l, i) => {
    const account = findAccount(chart, ctx, l.account_id)
    if (!account.is_active) {
      throw unprocessable(`Account ${account.code} ${account.name} is inactive`, {
        reason: 'account_inactive',
        line: i,
        account_id: account.id,
      })
    }
    const partyType = l.party_type ?? null
    if (account.subtype === 'receivable' || account.subtype === 'payable') {
      const expected = account.subtype === 'receivable' ? 'customer' : 'supplier'
      if (!partyType || !l.party_id) {
        throw unprocessable(`Line ${i + 1}: choose the ${expected} for ${account.name}`, {
          reason: 'party_required',
          line: i,
          path: `lines.${i}.party_id`,
        })
      }
      if (partyType !== expected) {
        throw unprocessable(`Line ${i + 1}: ${account.name} takes a ${expected}`, {
          reason: 'party_not_allowed',
          line: i,
          path: `lines.${i}.party_type`,
        })
      }
    }
    if (l.store_id) lineStores.add(l.store_id)
    return {
      account: { id: account.id },
      debit_paise: l.debit_paise,
      credit_paise: l.credit_paise,
      party: partyType && l.party_id ? { type: partyType, id: l.party_id } : null,
      memo: l.memo ?? null,
      ...(l.store_id !== undefined ? { store_id: l.store_id } : {}),
    }
  })
  for (const s of lineStores) await loadStore(tx, ctx, s)

  const numbered = await nextNumber(tx, ctx, {
    docType: 'journal',
    storeId,
    date: body.entry_date,
  })
  const voucherId = newId()
  const posted = await postJournal(tx, ctx, {
    entry_date: body.entry_date,
    store_id: storeId,
    source_type: 'manual',
    source_id: voucherId,
    narration: body.narration,
    number: numbered.number,
    lines,
  })
  if (!posted.entry_id) throw new AppError('INTERNAL', 'manual journal posted no lines')
  const total = sumSafe(body.lines.map((l) => l.debit_paise))
  await audit(tx, ctx, {
    action: 'journal.create',
    entity_type: 'journal_entry',
    entity_id: posted.entry_id,
    summary: `Journal ${numbered.number} of ${rupees(total)} posted: ${body.narration}`,
    changes: {
      number: numbered.number,
      entry_date: body.entry_date,
      store_id: storeId,
      total_paise: total,
      lines: body.lines,
    },
  })
  return getJournalEntry(tx, ctx, posted.entry_id)
}

// ---------------------------------------------------------------------------------------------
// Reversal (POST /journal-entries/:id/reverse)
// ---------------------------------------------------------------------------------------------

export async function reverseManualJournal(
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: JournalReverseBody,
): Promise<JournalEntryDetail> {
  await lockKey(tx, `journal-reverse:${ctx.tenantId}:${id}`)
  const entry = await loadEntryRow(tx, ctx, id)
  if (entry.source_type !== 'manual' || entry.reverses_entry_id !== null || !entry.source_id) {
    throw conflict(
      'Only manual journal vouchers can be reversed here; cancel the source document instead',
      { reason: 'not_manual', source_type: entry.source_type },
    )
  }
  if (entry.reversed_by_entry_id) {
    throw conflict('This journal entry was already reversed', {
      reason: 'already_reversed',
      reversed_by_entry_id: entry.reversed_by_entry_id,
    })
  }
  const cal = await businessCalendar(tx, ctx)
  // Default: today, or the voucher's own (future) date — a reversal never precedes its entry.
  const date = body.entry_date ?? (cal.today > entry.entry_date ? cal.today : entry.entry_date)
  if (date < entry.entry_date) {
    throw validationError([{ path: 'entry_date', message: 'date_order' }])
  }
  const reversed = await reverseJournal(tx, ctx, {
    source_type: 'manual',
    source_id: entry.source_id,
    entry_date: date,
    narration: `Reversal of ${entry.number ?? 'journal'}: ${body.reason}`,
  })
  if (!reversed.entry_id) throw new AppError('INTERNAL', 'reversal posted nothing')
  await audit(tx, ctx, {
    action: 'journal.reverse',
    entity_type: 'journal_entry',
    entity_id: entry.id,
    summary: `Journal ${entry.number ?? entry.id.slice(-8)} reversed: ${body.reason}`,
    changes: { reason: body.reason, entry_date: date, reversal_entry_id: reversed.entry_id },
  })
  return getJournalEntry(tx, ctx, reversed.entry_id)
}

export type { EntryRow }
export { ENTRY_COLUMNS }
