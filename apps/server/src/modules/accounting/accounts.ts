/**
 * Chart of accounts: the tree with balances as of a date, custom accounts (expense heads, extra
 * cash / bank accounts with bank details), renames, deactivation and deletion.
 *
 *  - System accounts (DEFAULT_CHART, addressed by subtype in posting rules) accept only name /
 *    name_ta / details changes (422 system_account_locked) and are never deleted.
 *  - Custom accounts: code 3–6 digits starting with the type digit, unique per tenant; parent of
 *    the same type (active, no cycles); store-specific accounts are visible only to members of
 *    that store.
 *  - Deactivation keeps history: income / expense heads always; balance-sheet accounts only at
 *    a zero balance (409 account_has_balance); never the settlement account of an active payment
 *    provider (409 account_in_use). DELETE removes an account without journal lines / children /
 *    references, else deactivates it.
 *  - Balances (natural sign) are Σ journal_lines up to `as_of` (members without accounting.read
 *    get nulls); store-scoped members only see lines of their stores.
 */
import { type AccountType, naturalBalance, newId } from '@kadai/shared'
import type {
  AccountCreateSchema,
  AccountUpdateSchema,
  BankDetailsInputSchema,
  ChartOfAccountsQuerySchema,
} from '@kadai/shared/api/accounting'
import {
  type AccountBalance,
  type AccountDetail,
  type BankDetails,
  CUSTOM_ACCOUNT_EDITABLE_FIELDS,
  type ChartOfAccounts,
  SYSTEM_ACCOUNT_EDITABLE_FIELDS,
  accountCodeMatchesType,
  buildAccountTree,
  suggestAccountCode,
} from '@kadai/shared/api/accounting'
import type { DeleteResult } from '@kadai/shared/api/identity'
import { sql } from 'kysely'
import type { z } from 'zod'
import { audit, diffChanges } from '../../core/audit'
import { canAccessStore } from '../../core/context'
import {
  AppError,
  assertNotStale,
  duplicate,
  forbidden,
  unprocessable,
  validationError,
} from '../../core/errors'
import type { Tx } from '../../db/tenant'
import { jsonb } from '../../db/json'
import {
  type ChartRow,
  type Ctx,
  accountVisible,
  businessCalendar,
  can,
  findAccount,
  hasBankDetails,
  loadChart,
  loadStore,
  lockKey,
} from './common'

type ChartQuery = z.output<typeof ChartOfAccountsQuerySchema>
type BankDetailsPatch = z.output<typeof BankDetailsInputSchema>
type AccountCreateBody = z.output<typeof AccountCreateSchema>
type AccountPatch = z.output<typeof AccountUpdateSchema>

const ACCOUNT_TYPES: readonly AccountType[] = ['asset', 'liability', 'equity', 'income', 'expense']
const BALANCE_SHEET_TYPES: ReadonlySet<AccountType> = new Set(['asset', 'liability', 'equity'])

// ---------------------------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------------------------

export interface DebitCredit {
  debit_paise: number
  credit_paise: number
}

/**
 * Σ debits / credits per account of the lines dated ≤ `asOf` (and ≥ `from` when given), of
 * `storeId` (journal_lines.store_id) or, for store-scoped members, of their stores.
 */
export async function accountTotals(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId' | 'storeIds'>,
  opts: { asOf: string; from?: string; storeId?: string | null; scoped?: boolean },
): Promise<Map<string, DebitCredit>> {
  let q = tx
    .selectFrom('journal_lines')
    .select([
      'account_id',
      sql<number>`coalesce(sum(debit_paise), 0)::int8`.as('debit_paise'),
      sql<number>`coalesce(sum(credit_paise), 0)::int8`.as('credit_paise'),
    ])
    .where('tenant_id', '=', ctx.tenantId)
    .where('entry_date', '<=', opts.asOf)
    .groupBy('account_id')
  if (opts.from) q = q.where('entry_date', '>=', opts.from)
  if (opts.storeId) q = q.where('store_id', '=', opts.storeId)
  else if ((opts.scoped ?? true) && ctx.storeIds !== null) {
    q = q.where(sql<boolean>`store_id = any(${[...ctx.storeIds]}::uuid[])`)
  }
  const rows = await q.execute()
  return new Map(
    rows.map((r) => [r.account_id, { debit_paise: r.debit_paise, credit_paise: r.credit_paise }]),
  )
}

/** Ids of the accounts that have at least one journal line (any date / store). */
async function accountsWithEntries(tx: Tx, ctx: Pick<Ctx, 'tenantId'>): Promise<Set<string>> {
  const rows = await tx
    .selectFrom('accounts as a')
    .select('a.id')
    .where('a.tenant_id', '=', ctx.tenantId)
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom('journal_lines as l')
          .select(sql`1`.as('one'))
          .whereRef('l.tenant_id', '=', 'a.tenant_id')
          .whereRef('l.account_id', '=', 'a.id'),
      ),
    )
    .execute()
  return new Set(rows.map((r) => r.id))
}

interface BalancedChart {
  as_of: string
  store_id: string | null
  /** Visible accounts in tree order (parents first, siblings by code). */
  accounts: AccountBalance[]
  withBalances: boolean
}

/** Visible accounts with balances, depth and roll-ups (tree over every visible account). */
async function balancedChart(
  tx: Tx,
  ctx: Ctx,
  chart: readonly ChartRow[],
  opts: { asOf: string; storeId: string | null; balances: boolean },
): Promise<BalancedChart> {
  const withBalances = opts.balances && can(ctx, 'accounting.read')
  const visible = chart.filter((a) => accountVisible(ctx, a))
  const totals = withBalances
    ? await accountTotals(tx, ctx, { asOf: opts.asOf, storeId: opts.storeId })
    : new Map<string, DebitCredit>()
  const entries = await accountsWithEntries(tx, ctx)
  const rows = visible.map((a) => {
    const t = totals.get(a.id) ?? { debit_paise: 0, credit_paise: 0 }
    return {
      ...a,
      created_at: a.created_at.toISOString(),
      updated_at: a.updated_at.toISOString(),
      debit_paise: withBalances ? t.debit_paise : null,
      credit_paise: withBalances ? t.credit_paise : null,
      balance_paise: withBalances ? naturalBalance(a.type, t.debit_paise, t.credit_paise) : null,
      has_entries: entries.has(a.id),
    }
  })
  const out: AccountBalance[] = []
  const walk = (nodes: ReturnType<typeof buildAccountTree<(typeof rows)[number]>>) => {
    for (const n of nodes) {
      const { children, ...row } = n
      out.push({
        ...row,
        rollup_balance_paise: withBalances ? row.rollup_balance_paise : null,
      })
      walk(children)
    }
  }
  walk(buildAccountTree(rows))
  return { as_of: opts.asOf, store_id: opts.storeId, accounts: out, withBalances }
}

// ---------------------------------------------------------------------------------------------
// List (GET /accounts)
// ---------------------------------------------------------------------------------------------

export async function listAccounts(tx: Tx, ctx: Ctx, query: ChartQuery): Promise<ChartOfAccounts> {
  const cal = await businessCalendar(tx, ctx)
  const asOf = query.as_of ?? cal.today
  if (query.store_id) await loadStore(tx, ctx, query.store_id)
  const chart = await loadChart(tx, ctx)
  const balanced = await balancedChart(tx, ctx, chart, {
    asOf,
    storeId: query.store_id ?? null,
    balances: query.balances,
  })
  const types = query.type ? new Set(query.type) : null
  const pattern = query.q ? query.q.trim().toLowerCase() : null
  const accounts = balanced.accounts.filter((a) => {
    if (!query.include_inactive && !a.is_active) return false
    if (types && !types.has(a.type)) return false
    if (query.money && a.money_kind !== query.money) return false
    if (pattern) {
      const hay = `${a.code} ${a.name} ${a.name_ta ?? ''}`.toLowerCase()
      if (!hay.includes(pattern)) return false
    }
    return true
  })
  const totals = ACCOUNT_TYPES.map((type) => ({
    type,
    balance_paise: balanced.withBalances
      ? balanced.accounts
          .filter((a) => a.type === type)
          .reduce((s, a) => s + (a.balance_paise ?? 0), 0)
      : null,
  }))
  return { as_of: asOf, store_id: query.store_id ?? null, accounts, totals }
}

// ---------------------------------------------------------------------------------------------
// Detail (GET /accounts/:id)
// ---------------------------------------------------------------------------------------------

interface AccountUsage {
  line_count: number
  last_entry_date: string | null
  children_count: number
  /** Tenant-wide all-time natural balance (deactivation rule). */
  lifetime_balance_paise: number
  /** Settlement account of an active payment provider. */
  provider_in_use: boolean
  /** Referenced by expenses / payments / shift cash entries (cannot be deleted). */
  referenced: boolean
}

async function accountUsage(tx: Tx, ctx: Ctx, account: ChartRow): Promise<AccountUsage> {
  const t = ctx.tenantId
  const agg = await tx
    .selectFrom('journal_lines')
    .select([
      sql<number>`count(*)::int8`.as('n'),
      sql<string | null>`max(entry_date)::text`.as('last_date'),
      sql<number>`coalesce(sum(debit_paise), 0)::int8`.as('debit_paise'),
      sql<number>`coalesce(sum(credit_paise), 0)::int8`.as('credit_paise'),
    ])
    .where('tenant_id', '=', t)
    .where('account_id', '=', account.id)
    .executeTakeFirstOrThrow()
  const children = await tx
    .selectFrom('accounts')
    .select(sql<number>`count(*)::int8`.as('n'))
    .where('tenant_id', '=', t)
    .where('parent_id', '=', account.id)
    .executeTakeFirstOrThrow()
  const provider = await tx
    .selectFrom('payment_provider_accounts')
    .select('id')
    .where('tenant_id', '=', t)
    .where('settlement_account_id', '=', account.id)
    .where('is_active', '=', true)
    .limit(1)
    .executeTakeFirst()
  const refs = await sql<{ n: number }>`
    select (
      (select count(*) from expenses
        where tenant_id = ${t} and (expense_account_id = ${account.id} or paid_from_account_id = ${account.id}))
      + (select count(*) from payments where tenant_id = ${t} and account_id = ${account.id})
      + (select count(*) from shift_cash_entries where tenant_id = ${t} and account_id = ${account.id})
      + (select count(*) from payment_provider_accounts
          where tenant_id = ${t} and settlement_account_id = ${account.id})
    )::int8 as n`.execute(tx)
  return {
    line_count: agg.n,
    last_entry_date: agg.last_date,
    children_count: children.n,
    lifetime_balance_paise: naturalBalance(account.type, agg.debit_paise, agg.credit_paise),
    provider_in_use: Boolean(provider),
    referenced: (refs.rows[0]?.n ?? 0) > 0,
  }
}

function canDeactivate(account: ChartRow, usage: AccountUsage): boolean {
  if (account.is_system || !account.is_active || usage.provider_in_use) return false
  return !BALANCE_SHEET_TYPES.has(account.type) || usage.lifetime_balance_paise === 0
}

function canDelete(account: ChartRow, usage: AccountUsage): boolean {
  return (
    !account.is_system && usage.line_count === 0 && usage.children_count === 0 && !usage.referenced
  )
}

export async function getAccountDetail(tx: Tx, ctx: Ctx, id: string): Promise<AccountDetail> {
  const chart = await loadChart(tx, ctx)
  const account = findAccount(chart, ctx, id)
  const cal = await businessCalendar(tx, ctx)
  const balanced = await balancedChart(tx, ctx, chart, {
    asOf: cal.today,
    storeId: null,
    balances: true,
  })
  const row = balanced.accounts.find((a) => a.id === account.id)
  if (!row) throw new AppError('INTERNAL', 'account missing from the chart tree')
  const usage = await accountUsage(tx, ctx, account)
  const parent = account.parent_id ? chart.find((a) => a.id === account.parent_id) : undefined
  const store = account.store_id
    ? await tx
        .selectFrom('stores')
        .select('name')
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', account.store_id)
        .executeTakeFirst()
    : undefined
  const writer = can(ctx, 'accounting.write')
  return {
    ...row,
    parent: parent ? { id: parent.id, code: parent.code, name: parent.name } : null,
    store_name: store?.name ?? null,
    children_count: usage.children_count,
    line_count: usage.line_count,
    last_entry_date: usage.last_entry_date,
    editable_fields: writer
      ? account.is_system
        ? [...SYSTEM_ACCOUNT_EDITABLE_FIELDS]
        : [...CUSTOM_ACCOUNT_EDITABLE_FIELDS]
      : [],
    can_delete: writer && canDelete(account, usage),
    can_deactivate: writer && canDeactivate(account, usage),
  }
}

// ---------------------------------------------------------------------------------------------
// Create / update / delete
// ---------------------------------------------------------------------------------------------

function mergeBankDetails(current: BankDetails, patch: BankDetailsPatch | undefined): BankDetails {
  if (!patch) return current
  const pick = (v: string | null | undefined, cur: string | null) => (v === undefined ? cur : v)
  return {
    bank_name: pick(patch.bank_name, current.bank_name),
    account_last4: pick(patch.account_last4, current.account_last4),
    ifsc: pick(patch.ifsc, current.ifsc),
    branch: pick(patch.branch, current.branch),
    account_holder: pick(patch.account_holder, current.account_holder),
  }
}

const EMPTY_DETAILS: BankDetails = {
  bank_name: null,
  account_last4: null,
  ifsc: null,
  branch: null,
  account_holder: null,
}

function assertDetailsAllowed(type: AccountType, details: BankDetails): void {
  if (type !== 'asset' && hasBankDetails(details)) {
    throw validationError(
      [{ path: 'details', message: 'Bank details apply to asset (cash / bank) accounts only' }],
      'Bank details apply to asset accounts only',
    )
  }
}

function checkParent(
  chart: readonly ChartRow[],
  ctx: Ctx,
  type: AccountType,
  parentId: string,
  selfId: string | null,
): ChartRow {
  const parent = chart.find((a) => a.id === parentId)
  if (!parent || !accountVisible(ctx, parent) || !parent.is_active || parent.type !== type) {
    throw unprocessable('The parent must be an active account of the same type', {
      reason: 'account_parent_type',
      parent_id: parentId,
    })
  }
  if (selfId) {
    // No cycles: the new parent may not be the account itself or one of its descendants.
    const byId = new Map(chart.map((a) => [a.id, a]))
    let cursor: ChartRow | undefined = parent
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor.id)) {
      if (cursor.id === selfId) {
        throw unprocessable('An account cannot be placed under itself or its sub-accounts', {
          reason: 'account_parent_type',
          parent_id: parentId,
        })
      }
      seen.add(cursor.id)
      cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined
    }
  }
  return parent
}

async function checkStore(tx: Tx, ctx: Ctx, storeId: string | null | undefined): Promise<void> {
  if (storeId) await loadStore(tx, ctx, storeId)
}

function assertCodeFree(chart: readonly ChartRow[], code: string, selfId: string | null): void {
  const existing = chart.find((a) => a.code === code && a.id !== selfId)
  if (existing) {
    throw duplicate(`Account code ${code} is already used by "${existing.name}"`, {
      field: 'code',
      code,
      existing_id: existing.id,
    })
  }
}

export async function createAccount(
  tx: Tx,
  ctx: Ctx,
  body: AccountCreateBody,
): Promise<AccountDetail> {
  if (!can(ctx, 'accounting.write') && body.type !== 'expense') {
    throw forbidden('Without accounting permission only expense heads can be created', {
      reason: 'expense_accounts_only',
      required: ['accounting.write'],
    })
  }
  // Serialises code suggestion / uniqueness per tenant.
  await lockKey(tx, `accounts:${ctx.tenantId}`)
  const chart = await loadChart(tx, ctx)
  const parent = body.parent_id ? checkParent(chart, ctx, body.type, body.parent_id, null) : null
  await checkStore(tx, ctx, body.store_id)
  const details = mergeBankDetails(EMPTY_DETAILS, body.details)
  assertDetailsAllowed(body.type, details)
  const code =
    body.code ??
    suggestAccountCode(
      body.type,
      chart.map((a) => a.code),
      parent?.code ?? null,
    )
  if (!code) {
    throw unprocessable('No free account code is left for this type; enter a code', {
      field: 'code',
    })
  }
  if (!accountCodeMatchesType(code, body.type)) {
    throw validationError([{ path: 'code', message: 'account_code_type' }])
  }
  assertCodeFree(chart, code, null)
  const id = newId()
  await tx
    .insertInto('accounts')
    .values({
      id,
      tenant_id: ctx.tenantId,
      code,
      name: body.name,
      name_ta: body.name_ta ?? null,
      type: body.type,
      subtype: null,
      parent_id: parent?.id ?? null,
      is_system: false,
      is_active: true,
      store_id: body.store_id ?? null,
      details: jsonb(details),
    })
    .execute()
  await audit(tx, ctx, {
    action: 'account.create',
    entity_type: 'account',
    entity_id: id,
    summary: `Account ${code} ${body.name} (${body.type}) created`,
    changes: { code, name: body.name, type: body.type, parent_id: parent?.id ?? null },
  })
  return getAccountDetail(tx, ctx, id)
}

/** Throws when `is_active: false` is not allowed for the account. */
async function assertDeactivatable(tx: Tx, ctx: Ctx, account: ChartRow): Promise<void> {
  const usage = await accountUsage(tx, ctx, account)
  if (usage.provider_in_use) {
    throw new AppError(
      'CONFLICT',
      'This account receives the settlements of an active payment provider',
      { reason: 'account_in_use', account_id: account.id },
    )
  }
  if (BALANCE_SHEET_TYPES.has(account.type) && usage.lifetime_balance_paise !== 0) {
    throw new AppError('CONFLICT', 'Only an account with a zero balance can be deactivated', {
      reason: 'account_has_balance',
      account_id: account.id,
      balance_paise: usage.lifetime_balance_paise,
    })
  }
}

export async function updateAccount(
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: AccountPatch,
): Promise<AccountDetail> {
  await lockKey(tx, `accounts:${ctx.tenantId}`)
  const chart = await loadChart(tx, ctx)
  const account = findAccount(chart, ctx, id)
  assertNotStale(account.updated_at, body.if_updated_at, 'account', id)

  if (account.is_system) {
    const locked = (['code', 'parent_id', 'store_id', 'is_active'] as const).filter(
      (k) => body[k] !== undefined,
    )
    if (locked.length) {
      throw unprocessable('System accounts accept only a new name, Tamil name or bank details', {
        reason: 'system_account_locked',
        fields: locked,
      })
    }
  }

  const next = {
    code: body.code ?? account.code,
    name: body.name ?? account.name,
    name_ta: body.name_ta === undefined ? account.name_ta : body.name_ta,
    parent_id: body.parent_id === undefined ? account.parent_id : body.parent_id,
    store_id: body.store_id === undefined ? account.store_id : body.store_id,
    details: mergeBankDetails(account.details, body.details),
    is_active: body.is_active ?? account.is_active,
  }
  if (body.code !== undefined && body.code !== account.code) {
    if (!accountCodeMatchesType(body.code, account.type)) {
      throw validationError([{ path: 'code', message: 'account_code_type' }])
    }
    assertCodeFree(chart, body.code, account.id)
  }
  if (
    body.parent_id !== undefined &&
    body.parent_id !== null &&
    body.parent_id !== account.parent_id
  ) {
    checkParent(chart, ctx, account.type, body.parent_id, account.id)
  }
  if (body.store_id !== undefined && body.store_id !== account.store_id) {
    await checkStore(tx, ctx, body.store_id)
  }
  assertDetailsAllowed(account.type, next.details)
  if (account.is_active && next.is_active === false) await assertDeactivatable(tx, ctx, account)

  const before = {
    code: account.code,
    name: account.name,
    name_ta: account.name_ta,
    parent_id: account.parent_id,
    store_id: account.store_id,
    details: account.details,
    is_active: account.is_active,
  }
  const changes = diffChanges(before, next)
  if (changes) {
    await tx
      .updateTable('accounts')
      .set({
        code: next.code,
        name: next.name,
        name_ta: next.name_ta,
        parent_id: next.parent_id,
        store_id: next.store_id,
        details: jsonb(next.details),
        is_active: next.is_active,
        updated_at: new Date(),
      })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', account.id)
      .execute()
    await audit(tx, ctx, {
      action:
        account.is_active && !next.is_active
          ? 'account.deactivate'
          : !account.is_active && next.is_active
            ? 'account.activate'
            : 'account.update',
      entity_type: 'account',
      entity_id: account.id,
      summary: `Account ${next.code} ${next.name} updated`,
      changes,
    })
  }
  return getAccountDetail(tx, ctx, account.id)
}

export async function deleteAccount(tx: Tx, ctx: Ctx, id: string): Promise<DeleteResult> {
  await lockKey(tx, `accounts:${ctx.tenantId}`)
  const chart = await loadChart(tx, ctx)
  const account = findAccount(chart, ctx, id)
  if (account.is_system) {
    throw unprocessable('System accounts cannot be deleted; rename them instead', {
      reason: 'system_account_locked',
    })
  }
  const usage = await accountUsage(tx, ctx, account)
  if (canDelete(account, usage)) {
    await tx
      .deleteFrom('accounts')
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', account.id)
      .execute()
    await audit(tx, ctx, {
      action: 'account.delete',
      entity_type: 'account',
      entity_id: account.id,
      summary: `Account ${account.code} ${account.name} deleted`,
    })
    return { id: account.id, result: 'deleted' }
  }
  if (account.is_active) {
    await assertDeactivatable(tx, ctx, account)
    await tx
      .updateTable('accounts')
      .set({ is_active: false, updated_at: new Date() })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', account.id)
      .execute()
    await audit(tx, ctx, {
      action: 'account.deactivate',
      entity_type: 'account',
      entity_id: account.id,
      summary: `Account ${account.code} ${account.name} deactivated (it has history)`,
    })
  }
  return { id: account.id, result: 'deactivated' }
}

/** Store access check for accounts with a store (pickers, postings). */
export function assertAccountStoreAccess(ctx: Ctx, account: { store_id: string | null }): void {
  if (account.store_id && !canAccessStore(ctx, account.store_id)) {
    throw forbidden('You do not have access to this store', { store_id: account.store_id })
  }
}
