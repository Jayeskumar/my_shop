/**
 * Chart of accounts API: tree with balances as of a date, custom accounts (codes, parents, bank
 * details), system-account locking, deactivation / deletion rules, permissions (balances need
 * accounting.read; expenses.write creates expense heads only), tenant isolation, the route
 * catalogue being fully implemented, and the 0700 cash short / excess backfill migration.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { addDays, newId } from '@kadai/shared'
import {
  type AccountDetail,
  type ChartOfAccounts,
  accountingRoutes,
} from '@kadai/shared/api/accounting'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unimplementedRoutes } from '../../../core/http'
import { postJournal } from '../../../core/ledger'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import { accountingImpls } from '../index'
import {
  type Data,
  accountId,
  api,
  auditActions,
  expectError,
  expectStatus,
  get,
  post,
  today,
} from './fixtures'

describe('accounting: chart of accounts', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    other = await createTestTenant(t)
  })
  afterAll(() => t.close())

  const chart = async (query = '', as?: Parameters<typeof get>[2]) =>
    (await get<Data<ChartOfAccounts>>(shop, `/accounts${query}`, as)).data

  it('implements every route of the accounting catalogue', () => {
    expect(unimplementedRoutes(accountingRoutes, accountingImpls)).toEqual([])
  })

  it('seeds the system chart including cash short / excess (5250)', async () => {
    const c = await chart()
    const se = c.accounts.find((a) => a.subtype === 'cash_short_excess')
    expect(se).toMatchObject({ code: '5250', type: 'expense', is_system: true, depth: 0 })
    const cash = c.accounts.find((a) => a.subtype === 'cash')
    expect(cash).toMatchObject({ code: '1100', money_kind: 'cash', balance_paise: 0 })
    expect(c.accounts.find((a) => a.subtype === 'bank')?.money_kind).toBe('bank')
    expect(c.totals.map((x) => x.type)).toEqual([
      'asset',
      'liability',
      'equity',
      'income',
      'expense',
    ])
  })

  it('returns balances as of a date with roll-ups to parents', async () => {
    const parent = (
      await post<Data<AccountDetail>>(shop, '/accounts', {
        name: 'Petty cash drawers',
        type: 'asset',
        parent_id: await accountId(t, shop, 'cash'),
      })
    ).data
    expect(parent.code).toBe('1101')
    expect(parent.money_kind).toBe('cash') // inherits from the cash parent
    const yesterday = addDays(today(), -1)
    await shop.tx((tx) =>
      postJournal(tx, shop.ctx, {
        entry_date: yesterday,
        source_type: 'manual',
        source_id: newId(),
        lines: [
          { account: { id: parent.id }, debit_paise: 25_000 },
          { account: { subtype: 'capital' }, credit_paise: 25_000 },
        ],
      }),
    )
    const now = await chart()
    const child = now.accounts.find((a) => a.id === parent.id)!
    expect(child).toMatchObject({ balance_paise: 25_000, depth: 1, has_entries: true })
    const cash = now.accounts.find((a) => a.subtype === 'cash')!
    expect(cash.rollup_balance_paise).toBe((cash.balance_paise ?? 0) + 25_000)
    // Tree order: the child right after its parent.
    const idx = now.accounts.findIndex((a) => a.subtype === 'cash')
    expect(now.accounts[idx + 1]?.id).toBe(parent.id)
    const capital = now.accounts.find((a) => a.subtype === 'capital')!
    expect(capital.balance_paise).toBe(25_000) // natural sign: credit-normal

    const before = await chart(`?as_of=${addDays(yesterday, -1)}`)
    expect(before.accounts.find((a) => a.id === parent.id)?.balance_paise).toBe(0)

    const picker = await chart('?money=cash&balances=false')
    expect(picker.accounts.every((a) => a.money_kind === 'cash')).toBe(true)
    expect(picker.accounts.every((a) => a.balance_paise === null)).toBe(true)
    expect(picker.totals.every((x) => x.balance_paise === null)).toBe(true)

    const search = await chart('?q=petty&type=asset')
    expect(search.accounts.map((a) => a.id)).toEqual([parent.id])
  })

  it('creates custom accounts with suggested or explicit codes and bank details', async () => {
    const head = (
      await post<Data<AccountDetail>>(shop, '/accounts', {
        name: 'Tea & refreshments',
        name_ta: 'டீ & சிற்றுண்டி',
        type: 'expense',
      })
    ).data
    expect(head).toMatchObject({ code: '5410', is_system: false, subtype: null, can_delete: true })
    const bank = (
      await post<Data<AccountDetail>>(shop, '/accounts', {
        code: '1250',
        name: 'Indian Bank current a/c',
        type: 'asset',
        details: { bank_name: 'Indian Bank', account_last4: '4321', ifsc: 'idib000t001' },
      })
    ).data
    expect(bank.money_kind).toBe('bank')
    expect(bank.details).toMatchObject({
      bank_name: 'Indian Bank',
      account_last4: '4321',
      ifsc: 'IDIB000T001',
    })
    expect(await auditActions(t, shop)).toContain('account.create')

    // Validation: duplicate code, wrong type prefix, bad IFSC, parent of another type.
    expectError(
      await shop.inject({
        method: 'POST',
        url: api('/accounts'),
        payload: { code: '1250', name: 'Again', type: 'asset' },
      }),
      409,
      'DUPLICATE',
    )
    expectError(
      await shop.inject({
        method: 'POST',
        url: api('/accounts'),
        payload: { code: '4999', name: 'Wrong', type: 'expense' },
      }),
      400,
      'VALIDATION_ERROR',
    )
    expectError(
      await shop.inject({
        method: 'POST',
        url: api('/accounts'),
        payload: { name: 'Bad bank', type: 'asset', details: { ifsc: 'XX12' } },
      }),
      400,
      'VALIDATION_ERROR',
    )
    expectError(
      await shop.inject({
        method: 'POST',
        url: api('/accounts'),
        payload: { name: 'Child', type: 'expense', parent_id: await accountId(t, shop, 'cash') },
      }),
      422,
      'UNPROCESSABLE',
      'account_parent_type',
    )
    expectError(
      await shop.inject({
        method: 'POST',
        url: api('/accounts'),
        payload: { name: 'Bank on income', type: 'income', details: { bank_name: 'SBI' } },
      }),
      400,
      'VALIDATION_ERROR',
    )
  })

  it('locks system accounts to name / Tamil name / bank details', async () => {
    const bankId = await accountId(t, shop, 'bank')
    const renamed = expectStatus<Data<AccountDetail>>(
      await shop.inject({
        method: 'PATCH',
        url: api(`/accounts/${bankId}`),
        payload: {
          name: 'SBI current account',
          details: { bank_name: 'State Bank of India', account_last4: '9876' },
        },
      }),
      200,
    ).data
    expect(renamed).toMatchObject({ name: 'SBI current account', code: '1200', subtype: 'bank' })
    expect(renamed.editable_fields).toEqual(['name', 'name_ta', 'details'])
    expect(renamed.can_delete).toBe(false)
    expect(renamed.can_deactivate).toBe(false)
    for (const payload of [{ code: '1201' }, { is_active: false }, { parent_id: null }]) {
      expectError(
        await shop.inject({ method: 'PATCH', url: api(`/accounts/${bankId}`), payload }),
        422,
        'UNPROCESSABLE',
        'system_account_locked',
      )
    }
    expectError(
      await shop.inject({ method: 'DELETE', url: api(`/accounts/${bankId}`) }),
      422,
      'UNPROCESSABLE',
      'system_account_locked',
    )
    // Stale write.
    expectError(
      await shop.inject({
        method: 'PATCH',
        url: api(`/accounts/${bankId}`),
        payload: { name: 'X', if_updated_at: '2020-01-01T00:00:00.000Z' },
      }),
      409,
      'STALE_WRITE',
    )
    expectError(
      await shop.inject({ method: 'PATCH', url: api(`/accounts/${bankId}`), payload: {} }),
      400,
      'VALIDATION_ERROR',
    )
  })

  it('deactivates balance-sheet accounts only at zero balance; deletes unused ones', async () => {
    const drawer = (
      await post<Data<AccountDetail>>(shop, '/accounts', { name: 'Drawer 2', type: 'asset' })
    ).data
    await shop.tx((tx) =>
      postJournal(tx, shop.ctx, {
        entry_date: today(),
        source_type: 'manual',
        source_id: newId(),
        lines: [
          { account: { id: drawer.id }, debit_paise: 1_000 },
          { account: { subtype: 'capital' }, credit_paise: 1_000 },
        ],
      }),
    )
    const detail = await get<Data<AccountDetail>>(shop, `/accounts/${drawer.id}`)
    expect(detail.data).toMatchObject({
      line_count: 1,
      last_entry_date: today(),
      can_delete: false,
      can_deactivate: false,
      balance_paise: 1_000,
    })
    expectError(
      await shop.inject({
        method: 'PATCH',
        url: api(`/accounts/${drawer.id}`),
        payload: { is_active: false },
      }),
      409,
      'CONFLICT',
      'account_has_balance',
    )
    expectError(
      await shop.inject({ method: 'DELETE', url: api(`/accounts/${drawer.id}`) }),
      409,
      'CONFLICT',
      'account_has_balance',
    )

    // An expense head with history is deactivated (not deleted), even with a balance.
    const head = (
      await post<Data<AccountDetail>>(shop, '/accounts', { name: 'Diwali bonus', type: 'expense' })
    ).data
    await shop.tx((tx) =>
      postJournal(tx, shop.ctx, {
        entry_date: today(),
        source_type: 'manual',
        source_id: newId(),
        lines: [
          { account: { id: head.id }, debit_paise: 500 },
          { account: { subtype: 'cash' }, credit_paise: 500 },
        ],
      }),
    )
    const del = expectStatus<Data<{ id: string; result: string }>>(
      await shop.inject({ method: 'DELETE', url: api(`/accounts/${head.id}`) }),
      200,
    )
    expect(del.data).toEqual({ id: head.id, result: 'deactivated' })
    const listed = await chart('?include_inactive=true')
    expect(listed.accounts.find((a) => a.id === head.id)?.is_active).toBe(false)
    expect((await chart()).accounts.some((a) => a.id === head.id)).toBe(false)

    // Re-activation and an unused account deleted outright.
    expectStatus(
      await shop.inject({
        method: 'PATCH',
        url: api(`/accounts/${head.id}`),
        payload: { is_active: true, name: 'Festival bonus' },
      }),
      200,
    )
    const unused = (
      await post<Data<AccountDetail>>(shop, '/accounts', { name: 'Unused head', type: 'expense' })
    ).data
    const gone = expectStatus<Data<{ result: string }>>(
      await shop.inject({ method: 'DELETE', url: api(`/accounts/${unused.id}`) }),
      200,
    )
    expect(gone.data.result).toBe('deleted')
    expectError(
      await shop.inject({ method: 'GET', url: api(`/accounts/${unused.id}`) }),
      404,
      'NOT_FOUND',
    )
    const actions = await auditActions(t, shop)
    expect(actions).toEqual(
      expect.arrayContaining(['account.deactivate', 'account.activate', 'account.delete']),
    )
  })

  it('refuses to deactivate the settlement account of an active payment provider', async () => {
    const acc = (
      await post<Data<AccountDetail>>(shop, '/accounts', {
        name: 'Razorpay settlement',
        type: 'asset',
        details: { bank_name: 'HDFC' },
      })
    ).data
    await t.deps.db.systemDb
      .insertInto('payment_provider_accounts')
      .values({
        id: newId(),
        tenant_id: shop.tenant.id,
        provider: 'mock',
        display_name: 'Mock',
        settlement_account_id: acc.id,
      })
      .execute()
    expectError(
      await shop.inject({
        method: 'PATCH',
        url: api(`/accounts/${acc.id}`),
        payload: { is_active: false },
      }),
      409,
      'CONFLICT',
      'account_in_use',
    )
  })

  it('prevents parent cycles when moving an account', async () => {
    const a = (
      await post<Data<AccountDetail>>(shop, '/accounts', { name: 'Group A', type: 'income' })
    ).data
    const b = (
      await post<Data<AccountDetail>>(shop, '/accounts', {
        name: 'Group B',
        type: 'income',
        parent_id: a.id,
      })
    ).data
    expect(b.parent).toMatchObject({ id: a.id })
    expectError(
      await shop.inject({
        method: 'PATCH',
        url: api(`/accounts/${a.id}`),
        payload: { parent_id: b.id },
      }),
      422,
      'UNPROCESSABLE',
      'account_parent_type',
    )
  })

  it('gates permissions: balances need accounting.read; expenses.write creates expense heads', async () => {
    const cashier = await shop.asRole('cashier')
    const c = await chart('', cashier)
    expect(c.accounts.length).toBeGreaterThan(20)
    expect(c.accounts.every((a) => a.balance_paise === null && a.debit_paise === null)).toBe(true)
    expectError(
      await shop.inject({
        method: 'POST',
        url: api('/accounts'),
        payload: { name: 'X', type: 'expense' },
        as: cashier,
      }),
      403,
      'FORBIDDEN',
    )
    const clerk = await shop.asRole('expense_clerk', { permissions: ['expenses.write'] })
    const head = expectStatus<Data<AccountDetail>>(
      await shop.inject({
        method: 'POST',
        url: api('/accounts'),
        payload: { name: 'Parking', type: 'expense' },
        as: clerk,
      }),
      201,
    ).data
    expect(head.balance_paise).toBeNull()
    expect(head.editable_fields).toEqual([])
    expectError(
      await shop.inject({
        method: 'POST',
        url: api('/accounts'),
        payload: { name: 'Bank', type: 'asset' },
        as: clerk,
      }),
      403,
      'FORBIDDEN',
      'expense_accounts_only',
    )
    expectError(
      await shop.inject({
        method: 'PATCH',
        url: api(`/accounts/${head.id}`),
        payload: { name: 'Y' },
        as: clerk,
      }),
      403,
      'FORBIDDEN',
    )
    const stranger = await shop.asRole('stranger', { permissions: ['catalog.read'] })
    expectError(
      await shop.inject({ method: 'GET', url: api('/accounts'), as: stranger }),
      403,
      'FORBIDDEN',
    )
  })

  it('hides store-specific accounts of other stores from store-scoped members', async () => {
    const store2 = newId()
    await t.deps.db.systemDb
      .insertInto('stores')
      .values({
        id: store2,
        tenant_id: shop.tenant.id,
        code: 'S2',
        name: 'Branch',
        state_code: '33',
      })
      .execute()
    const branchCash = (
      await post<Data<AccountDetail>>(shop, '/accounts', {
        name: 'Branch cash',
        type: 'asset',
        parent_id: await accountId(t, shop, 'cash'),
        store_id: store2,
      })
    ).data
    expect(branchCash.store_name).toBe('Branch')
    const s1Only = await shop.asRole('s1_accountant', {
      permissions: ['accounting.read'],
      store_ids: [shop.store.id],
    })
    const c = await chart('', s1Only)
    expect(c.accounts.some((a) => a.id === branchCash.id)).toBe(false)
    expectError(
      await shop.inject({ method: 'GET', url: api(`/accounts/${branchCash.id}`), as: s1Only }),
      404,
      'NOT_FOUND',
    )
    expectError(
      await shop.inject({ method: 'GET', url: api(`/accounts?store_id=${store2}`), as: s1Only }),
      403,
      'FORBIDDEN',
    )
  })

  it('isolates tenants', async () => {
    const mine = (
      await post<Data<AccountDetail>>(shop, '/accounts', { name: 'Only mine', type: 'expense' })
    ).data
    expectError(
      await other.inject({ method: 'GET', url: api(`/accounts/${mine.id}`) }),
      404,
      'NOT_FOUND',
    )
    expectError(
      await other.inject({
        method: 'PATCH',
        url: api(`/accounts/${mine.id}`),
        payload: { name: 'Hijack' },
      }),
      404,
      'NOT_FOUND',
    )
    const theirs = (await get<Data<ChartOfAccounts>>(other, '/accounts')).data
    expect(theirs.accounts.some((a) => a.id === mine.id || a.name === 'Only mine')).toBe(false)
    // A parent from another tenant is not usable.
    expectError(
      await other.inject({
        method: 'POST',
        url: api('/accounts'),
        payload: { name: 'Cross', type: 'expense', parent_id: mine.id },
      }),
      422,
      'UNPROCESSABLE',
      'account_parent_type',
    )
  })

  it('migration 0700 backfills cash short / excess, avoiding a used code', async () => {
    const legacy = await createTestTenant(t)
    const db = t.deps.db.systemDb
    // Simulate a tenant created before 0700 that used 5250 for a custom account.
    await db
      .deleteFrom('accounts')
      .where('tenant_id', '=', legacy.tenant.id)
      .where('subtype', '=', 'cash_short_excess')
      .execute()
    await db
      .insertInto('accounts')
      .values({
        id: newId(),
        tenant_id: legacy.tenant.id,
        code: '5250',
        name: 'Generator diesel',
        type: 'expense',
      })
      .execute()
    const file = fileURLToPath(
      new URL('../../../../migrations/0700_accounting_cash_short_excess.sql', import.meta.url),
    )
    await sql.raw(await readFile(file, 'utf8')).execute(db)
    const rows = await db
      .selectFrom('accounts')
      .select(['id', 'code', 'type', 'is_system'])
      .where('tenant_id', '=', legacy.tenant.id)
      .where('subtype', '=', 'cash_short_excess')
      .execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ code: '5251', type: 'expense', is_system: true })
    expect(rows[0]!.id.charAt(14)).toBe('7') // UUID v7
    // Idempotent: running it again adds nothing.
    await sql.raw(await readFile(file, 'utf8')).execute(db)
    const again = await db
      .selectFrom('accounts')
      .select('id')
      .where('tenant_id', '=', legacy.tenant.id)
      .where('subtype', '=', 'cash_short_excess')
      .execute()
    expect(again).toHaveLength(1)
  })
})
