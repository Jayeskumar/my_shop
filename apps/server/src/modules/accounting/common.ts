/**
 * Helpers shared by the accounting services: tenant business calendar, the chart of accounts
 * with derived money kinds, store scoping, journal source references (document numbers and web
 * links), advisory locks and CSV replies.
 *
 * Balances are never stored by this module: every amount is derived from journal_lines, which
 * only core/ledger.ts writes (postJournal / reverseJournal).
 */
import {
  type AccountType,
  type JournalSourceType,
  type Permission,
  fyOf,
  fyRange,
  hasPermission,
  todayIn,
} from '@kadai/shared'
import {
  type AccountSubtype,
  AccountSubtypeSchema,
  type BankDetails,
  BankDetailsSchema,
  type MoneyAccountKind,
  journalSourcePath,
  moneyKindOf,
} from '@kadai/shared/api/accounting'
import type { BilingualLabel } from '@kadai/shared/api/common'
import type { FastifyReply } from 'fastify'
import { type Expression, type RawBuilder, type SqlBool, sql } from 'kysely'
import { audit } from '../../core/audit'
import { type RequestContext, canAccessStore } from '../../core/context'
import { forbidden, notFound } from '../../core/errors'
import { systemAccountId } from '../../core/ledger'
import { tenantCalendar } from '../../core/numbering'
import type { Tx } from '../../db/tenant'

export type Ctx = RequestContext
export type Locale = 'ta' | 'en'

// ---------------------------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------------------------

export interface BusinessCalendar {
  timezone: string
  fyStartMonth: number
  today: string
}

export async function businessCalendar(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
): Promise<BusinessCalendar> {
  const cal = await tenantCalendar(tx, ctx)
  return { timezone: cal.timezone, fyStartMonth: cal.fyStartMonth, today: todayIn(cal.timezone) }
}

/** First date of the financial year containing `date`. */
export function fyStartOf(date: string, fyStartMonth: number): string {
  return fyRange(fyOf(date, fyStartMonth), fyStartMonth).from
}

// ---------------------------------------------------------------------------------------------
// Permissions & store scope
// ---------------------------------------------------------------------------------------------

export function can(ctx: Pick<Ctx, 'permissions'>, permission: Permission | Permission[]): boolean {
  return hasPermission(ctx.permissions, permission)
}

/** 403 unless the member can access every store (tenant-wide statements). */
export function assertAllStores(ctx: Pick<Ctx, 'storeIds'>): void {
  if (ctx.storeIds !== null) {
    throw forbidden('This statement covers every store; it needs access to all stores', {
      reason: 'all_stores_required',
    })
  }
}

/** `column = any(storeIds)` for store-scoped members; null when the member sees every store. */
export function storeScopeCondition(
  column: string,
  ctx: Pick<Ctx, 'storeIds'>,
): Expression<SqlBool> | null {
  if (ctx.storeIds === null) return null
  return sql<SqlBool>`${sql.ref(column)} = any(${[...ctx.storeIds]}::uuid[])`
}

/** Raw `and <column> = any(storeIds)` fragment (empty for members with every store). */
export function storeScopeSql(column: string, ctx: Pick<Ctx, 'storeIds'>): RawBuilder<unknown> {
  if (ctx.storeIds === null) return sql``
  return sql`and ${sql.ref(column)} = any(${[...ctx.storeIds]}::uuid[])`
}

/** Loads a store of the tenant the member can access (404 / 403). */
export async function loadStore(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId' | 'storeIds'>,
  storeId: string,
): Promise<{ id: string; code: string; name: string; state_code: string; is_active: boolean }> {
  const store = await tx
    .selectFrom('stores')
    .select(['id', 'code', 'name', 'state_code', 'is_active'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', storeId)
    .executeTakeFirst()
  if (!store) throw notFound('store', storeId)
  if (!canAccessStore(ctx, store.id)) {
    throw forbidden('You do not have access to this store', { store_id: store.id })
  }
  return store
}

/** The member's default store: the first accessible active store by code. */
export async function defaultStoreId(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId' | 'storeIds'>,
): Promise<string> {
  let q = tx
    .selectFrom('stores')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .orderBy('is_active', 'desc')
    .orderBy('code')
    .limit(1)
  const scope = storeScopeCondition('id', ctx)
  if (scope) q = q.where(scope)
  const row = await q.executeTakeFirst()
  if (!row) throw forbidden('You do not have access to any store', { reason: 'no_store' })
  return row.id
}

// ---------------------------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------------------------

export interface ChartRow {
  id: string
  code: string
  name: string
  name_ta: string | null
  type: AccountType
  subtype: AccountSubtype | null
  parent_id: string | null
  is_system: boolean
  is_active: boolean
  store_id: string | null
  details: BankDetails
  money_kind: MoneyAccountKind | null
  created_at: Date
  updated_at: Date
}

const EMPTY_BANK_DETAILS: BankDetails = BankDetailsSchema.parse({})

/** accounts.details read leniently (unknown keys dropped, invalid → empty). */
export function readBankDetails(value: unknown): BankDetails {
  const parsed = BankDetailsSchema.safeParse(value ?? {})
  return parsed.success ? parsed.data : EMPTY_BANK_DETAILS
}

export function hasBankDetails(d: BankDetails): boolean {
  return Boolean(d.bank_name || d.account_last4 || d.ifsc)
}

function readSubtype(value: string | null): AccountSubtype | null {
  if (value === null) return null
  const parsed = AccountSubtypeSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

const ACCOUNT_TYPES: ReadonlySet<string> = new Set([
  'asset',
  'liability',
  'equity',
  'income',
  'expense',
])

function readType(value: string): AccountType {
  if (!ACCOUNT_TYPES.has(value)) throw new RangeError(`unknown account type ${value}`)
  return value as AccountType
}

/**
 * The whole chart of the tenant (every account, active or not) with money kinds derived from the
 * account's own / nearest ancestor's subtype (cash / bank) or bank details.
 */
export async function loadChart(tx: Tx, ctx: Pick<Ctx, 'tenantId'>): Promise<ChartRow[]> {
  const rows = await tx
    .selectFrom('accounts')
    .select([
      'id',
      'code',
      'name',
      'name_ta',
      'type',
      'subtype',
      'parent_id',
      'is_system',
      'is_active',
      'store_id',
      'details',
      'created_at',
      'updated_at',
    ])
    .where('tenant_id', '=', ctx.tenantId)
    .orderBy('code')
    .execute()
  const byId = new Map(rows.map((r) => [r.id, r]))
  return rows.map((r) => {
    const ancestors: (string | null)[] = []
    const seen = new Set<string>([r.id])
    let parent = r.parent_id ? byId.get(r.parent_id) : undefined
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id)
      ancestors.push(parent.subtype)
      parent = parent.parent_id ? byId.get(parent.parent_id) : undefined
    }
    const details = readBankDetails(r.details)
    const type = readType(r.type)
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      name_ta: r.name_ta,
      type,
      subtype: readSubtype(r.subtype),
      parent_id: r.parent_id,
      is_system: r.is_system,
      is_active: r.is_active,
      store_id: r.store_id,
      details,
      money_kind: moneyKindOf({
        type,
        subtype: r.subtype,
        ancestor_subtypes: ancestors,
        has_bank_details: hasBankDetails(details),
      }),
      created_at: r.created_at,
      updated_at: r.updated_at,
    }
  })
}

/** Store-specific accounts of other stores are hidden from store-scoped members. */
export function accountVisible(ctx: Pick<Ctx, 'storeIds'>, account: { store_id: string | null }) {
  return account.store_id === null || canAccessStore(ctx, account.store_id)
}

/** The account (visible to the member) or 404. */
export function findAccount(
  chart: readonly ChartRow[],
  ctx: Pick<Ctx, 'storeIds'>,
  id: string,
): ChartRow {
  const account = chart.find((a) => a.id === id)
  if (!account || !accountVisible(ctx, account)) throw notFound('account', id)
  return account
}

/**
 * Drawer / default cash account of a store: its own active cash account (lowest code), else the
 * system cash account (where POS cash tenders post).
 */
export async function storeCashAccountId(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  chart: readonly ChartRow[],
  storeId: string,
): Promise<string> {
  const own = chart.find((a) => a.is_active && a.store_id === storeId && a.money_kind === 'cash')
  return own ? own.id : systemAccountId(tx, ctx, 'cash')
}

/** Default money account of a store for a kind: its own active account, else the system one. */
export async function storeMoneyAccountId(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  chart: readonly ChartRow[],
  storeId: string,
  kind: MoneyAccountKind,
): Promise<string> {
  if (kind === 'cash') return storeCashAccountId(tx, ctx, chart, storeId)
  const own = chart.find((a) => a.is_active && a.store_id === storeId && a.money_kind === 'bank')
  return own ? own.id : systemAccountId(tx, ctx, 'bank')
}

export function localName(row: { name: string; name_ta: string | null }, locale: Locale): string {
  return locale === 'ta' && row.name_ta ? row.name_ta : row.name
}

// ---------------------------------------------------------------------------------------------
// Journal sources: document numbers and web links
// ---------------------------------------------------------------------------------------------

export interface SourceKey {
  source_type: JournalSourceType
  source_id: string | null
}

export interface SourceInfo {
  number: string | null
  path: string | null
}

const SOURCE_TABLES = {
  sales_invoice: 'sales_invoices',
  credit_note: 'credit_notes',
  purchase_bill: 'purchase_bills',
  debit_note: 'debit_notes',
  payment: 'payments',
  expense: 'expenses',
  stock_adjustment: 'stock_adjustments',
  stock_transfer: 'stock_transfers',
} as const

const sourceKey = (type: string, id: string | null) => `${type}:${id ?? ''}`

/**
 * Number and web path of each source document (one query per source type). Manual journals
 * resolve to their original JV (number + /accounting/journal?id=<entry id>); shifts link to the
 * shift page; opening balances have no document.
 */
export async function sourceInfos(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  keys: readonly SourceKey[],
): Promise<Map<string, SourceInfo>> {
  const out = new Map<string, SourceInfo>()
  const byType = new Map<JournalSourceType, Set<string>>()
  for (const k of keys) {
    if (!k.source_id) continue
    const set = byType.get(k.source_type) ?? new Set<string>()
    set.add(k.source_id)
    byType.set(k.source_type, set)
  }
  for (const [type, idSet] of byType) {
    const ids = [...idSet]
    if (type === 'manual') {
      const rows = await tx
        .selectFrom('journal_entries')
        .select(['id', 'source_id', 'number'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('source_type', '=', 'manual')
        .where('source_id', 'in', ids)
        .where('reverses_entry_id', 'is', null)
        .execute()
      for (const r of rows) {
        out.set(sourceKey(type, r.source_id), {
          number: r.number,
          path: journalSourcePath('manual', r.id),
        })
      }
      continue
    }
    if (type === 'shift') {
      const rows = await tx
        .selectFrom('register_shifts as s')
        .innerJoin('registers as r', (j) =>
          j.onRef('r.tenant_id', '=', 's.tenant_id').onRef('r.id', '=', 's.register_id'),
        )
        .select(['s.id', 'r.code'])
        .where('s.tenant_id', '=', ctx.tenantId)
        .where('s.id', 'in', ids)
        .execute()
      for (const r of rows) {
        out.set(sourceKey(type, r.id), {
          number: r.code,
          path: journalSourcePath('shift', r.id),
        })
      }
      continue
    }
    if (type === 'opening') continue
    const table = SOURCE_TABLES[type]
    const rows = await tx
      .selectFrom(table)
      .select(['id', 'number'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', 'in', ids)
      .execute()
    for (const r of rows) {
      out.set(sourceKey(type, r.id), { number: r.number, path: journalSourcePath(type, r.id) })
    }
  }
  return out
}

export function sourceInfoOf(map: Map<string, SourceInfo>, k: SourceKey): SourceInfo {
  return (
    map.get(sourceKey(k.source_type, k.source_id)) ?? {
      number: null,
      path: k.source_type === 'manual' ? null : journalSourcePath(k.source_type, k.source_id),
    }
  )
}

/** Party display names (customers / suppliers) by `${type}:${id}`. */
export async function partyNames(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  parties: ReadonlyArray<{ party_type: string | null; party_id: string | null }>,
): Promise<Map<string, string>> {
  const customers = new Set<string>()
  const suppliers = new Set<string>()
  for (const p of parties) {
    if (!p.party_id) continue
    if (p.party_type === 'customer') customers.add(p.party_id)
    else if (p.party_type === 'supplier') suppliers.add(p.party_id)
  }
  const out = new Map<string, string>()
  if (customers.size) {
    const rows = await tx
      .selectFrom('customers')
      .select(['id', 'name'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', 'in', [...customers])
      .execute()
    for (const r of rows) out.set(`customer:${r.id}`, r.name)
  }
  if (suppliers.size) {
    const rows = await tx
      .selectFrom('suppliers')
      .select(['id', 'name'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', 'in', [...suppliers])
      .execute()
    for (const r of rows) out.set(`supplier:${r.id}`, r.name)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------------------------

/** Escapes LIKE wildcards (backslash is PostgreSQL's default LIKE escape character). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export const likePattern = (q: string): string => `%${escapeLike(q.trim())}%`

/** Transaction-scoped advisory lock on an arbitrary key. */
export async function lockKey(tx: Tx, key: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(tx)
}

export function rupees(paise: number): string {
  const sign = paise < 0 ? '-' : ''
  const abs = Math.abs(paise)
  return `${sign}₹${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------------------------
// CSV exports
// ---------------------------------------------------------------------------------------------

/** Most rows a CSV export streams (whole filtered range, not paginated). */
export const CSV_MAX_ROWS = 100_000

export const label = (l: BilingualLabel, locale: Locale): string => l[locale]

/** Sends a CSV document (BOM-prefixed by toCsv) as a download. */
export function sendCsv(reply: FastifyReply, filename: string, csv: string): FastifyReply {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_')
  return reply
    .code(200)
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${safe}"`)
    .send(Buffer.from(csv, 'utf8'))
}

/** Audits a data export (ARCHITECTURE.md §7.7). */
export async function auditExport(
  tx: Tx,
  ctx: Ctx,
  what: string,
  summary: string,
  filters: unknown,
): Promise<void> {
  await audit(tx, ctx, {
    action: 'accounting.export',
    entity_type: what,
    summary,
    changes: { filters },
  })
}

/** Amount column of CSV exports: rupees with two decimals ('1234.50', '-12.00'). */
export function csvAmount(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return ''
  const sign = paise < 0 ? '-' : ''
  const abs = Math.abs(paise)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}
