import { newId } from '@kadai/shared'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Tx } from '../db/tenant'
import { type TestApp, buildTestApp } from '../test/helpers'
import {
  type TestShop,
  createTestTenant,
  insertTestCustomer,
  insertTestSupplier,
} from '../test/tenants'
import { postJournal, reverseJournal, systemAccountId } from './ledger'

/** Σ(debit − credit) on receivable lines of a customer / Σ(credit − debit) on payable of a supplier. */
async function ledgerBalance(
  tx: Tx,
  tenantId: string,
  party: { type: 'customer' | 'supplier'; id: string },
) {
  const subtype = party.type === 'customer' ? 'receivable' : 'payable'
  const r = await sql<{ bal: number }>`
    select coalesce(sum(case when ${party.type} = 'customer' then l.debit_paise - l.credit_paise
                             else l.credit_paise - l.debit_paise end), 0)::bigint as bal
      from journal_lines l join accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
     where l.tenant_id = ${tenantId} and a.subtype = ${subtype}
       and l.party_type = ${party.type} and l.party_id = ${party.id}`.execute(tx)
  return Number(r.rows[0]?.bal ?? 0)
}

async function partyBalance(tx: Tx, party: { type: 'customer' | 'supplier'; id: string }) {
  const row =
    party.type === 'customer'
      ? await tx
          .selectFrom('customers')
          .select('balance_paise')
          .where('id', '=', party.id)
          .executeTakeFirstOrThrow()
      : await tx
          .selectFrom('suppliers')
          .select('balance_paise')
          .where('id', '=', party.id)
          .executeTakeFirstOrThrow()
  return row.balance_paise
}

describe('core/ledger', () => {
  let t: TestApp
  let shop: TestShop

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
  })
  afterAll(() => t.close())

  it('posts a balanced sale with merged lines, drops zero lines and updates the customer balance', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id)
    const saleId = newId()
    const res = await shop.tx(async (tx) => {
      const posted = await postJournal(tx, shop.ctx, {
        entry_date: '2026-10-20',
        store_id: shop.store.id,
        source_type: 'sales_invoice',
        source_id: saleId,
        narration: 'Invoice S1-A/2627/00001',
        lines: [
          {
            account: { subtype: 'receivable' },
            debit_paise: 11_800,
            party: { type: 'customer', id: c.id },
          },
          { account: { subtype: 'sales' }, credit_paise: 6_000, memo: 'line 1' },
          { account: { subtype: 'sales' }, credit_paise: 4_000, memo: 'line 2' },
          { account: { subtype: 'output_cgst' }, credit_paise: 900 },
          { account: { subtype: 'output_sgst' }, credit_paise: 900 },
          { account: { subtype: 'output_igst' }, credit_paise: 0 },
          { account: { subtype: 'cogs' }, debit_paise: 7_000 },
          { account: { subtype: 'inventory' }, credit_paise: 7_000 },
        ],
      })
      const lines = await tx
        .selectFrom('journal_lines as l')
        .innerJoin('accounts as a', 'a.id', 'l.account_id')
        .select([
          'a.subtype',
          'l.debit_paise',
          'l.credit_paise',
          'l.memo',
          'l.store_id',
          'l.entry_date',
        ])
        .where('l.entry_id', '=', posted.entry_id!)
        .orderBy('a.code')
        .execute()
      return { posted, lines, balance: await partyBalance(tx, { type: 'customer', id: c.id }) }
    })
    expect(res.posted.entry_id).toEqual(expect.any(String))
    expect(res.lines.map((l) => [l.subtype, l.debit_paise, l.credit_paise])).toEqual([
      ['receivable', 11_800, 0],
      ['inventory', 0, 7_000],
      ['output_cgst', 0, 900],
      ['output_sgst', 0, 900],
      ['sales', 0, 10_000],
      ['cogs', 7_000, 0],
    ])
    expect(res.lines.find((l) => l.subtype === 'sales')?.memo).toBe('line 1; line 2')
    expect(
      res.lines.every((l) => l.store_id === shop.store.id && l.entry_date === '2026-10-20'),
    ).toBe(true)
    expect(res.balance).toBe(11_800)
  })

  it('rejects an unbalanced entry before touching the database', async () => {
    const before = await shop.tx((tx) =>
      tx
        .selectFrom('journal_entries')
        .select(sql<number>`count(*)::int`.as('n'))
        .executeTakeFirstOrThrow(),
    )
    const err = await shop
      .tx((tx) =>
        postJournal(tx, shop.ctx, {
          entry_date: '2026-10-20',
          source_type: 'manual',
          lines: [
            { account: { subtype: 'cash' }, debit_paise: 1000 },
            { account: { subtype: 'capital' }, credit_paise: 999 },
          ],
        }),
      )
      .catch((e: unknown) => e)
    expect(err).toMatchObject({
      code: 'UNPROCESSABLE',
      details: { debit_paise: 1000, credit_paise: 999, difference_paise: 1 },
    })
    const after = await shop.tx((tx) =>
      tx
        .selectFrom('journal_entries')
        .select(sql<number>`count(*)::int`.as('n'))
        .executeTakeFirstOrThrow(),
    )
    expect(after.n).toBe(before.n)
    await expect(
      shop.tx((tx) =>
        postJournal(tx, shop.ctx, {
          entry_date: '2026-10-20',
          source_type: 'manual',
          lines: [{ account: { subtype: 'cash' }, debit_paise: -5 }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('has a deferred database trigger as a backstop for unbalanced entries', async () => {
    const err = await shop
      .tx(async (tx) => {
        const cash = await systemAccountId(tx, shop.ctx, 'cash')
        const entryId = newId()
        await tx
          .insertInto('journal_entries')
          .values({
            id: entryId,
            tenant_id: shop.tenant.id,
            entry_date: '2026-10-20',
            source_type: 'manual',
          })
          .execute()
        await tx
          .insertInto('journal_lines')
          .values({
            tenant_id: shop.tenant.id,
            entry_id: entryId,
            account_id: cash,
            debit_paise: 100,
            entry_date: '2026-10-20',
          })
          .execute()
      })
      .catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'P0001' })
    expect(String((err as Error).message)).toMatch(/not balanced/)
  })

  it('keeps party balances equal to their AR / AP ledger balances', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id)
    const s = await insertTestSupplier(t.deps, shop.tenant.id)
    const customer = { type: 'customer' as const, id: c.id }
    const supplier = { type: 'supplier' as const, id: s.id }
    await shop.tx(async (tx) => {
      const post = (
        lines: Parameters<typeof postJournal>[2]['lines'],
        source_type: 'manual' | 'payment' = 'manual',
      ) =>
        postJournal(tx, shop.ctx, {
          entry_date: '2026-10-21',
          store_id: shop.store.id,
          source_type,
          source_id: newId(),
          lines,
        })
      await post([
        { account: { subtype: 'receivable' }, debit_paise: 50_000, party: customer },
        { account: { subtype: 'sales' }, credit_paise: 50_000 },
      ])
      await post(
        [
          { account: { subtype: 'cash' }, debit_paise: 20_000 },
          { account: { subtype: 'receivable' }, credit_paise: 20_000, party: customer },
        ],
        'payment',
      )
      await post([
        { account: { subtype: 'inventory' }, debit_paise: 80_000 },
        { account: { subtype: 'payable' }, credit_paise: 80_000, party: supplier },
      ])
      await post(
        [
          { account: { subtype: 'payable' }, debit_paise: 30_000, party: supplier },
          { account: { subtype: 'bank' }, credit_paise: 30_000 },
        ],
        'payment',
      )
      // A party on a non-AR/AP account is an annotation only.
      await post([
        { account: { subtype: 'cash' }, debit_paise: 5_000 },
        { account: { subtype: 'customer_advance' }, credit_paise: 5_000, party: customer },
      ])
      expect(await partyBalance(tx, customer)).toBe(30_000)
      expect(await ledgerBalance(tx, shop.tenant.id, customer)).toBe(30_000)
      expect(await partyBalance(tx, supplier)).toBe(50_000)
      expect(await ledgerBalance(tx, shop.tenant.id, supplier)).toBe(50_000)
    })
  })

  it('reverses a source exactly once, restoring party balances', async () => {
    const c = await insertTestCustomer(t.deps, shop.tenant.id)
    const customer = { type: 'customer' as const, id: c.id }
    const sourceId = newId()
    await shop.tx(async (tx) => {
      const original = await postJournal(tx, shop.ctx, {
        entry_date: '2026-10-22',
        store_id: shop.store.id,
        source_type: 'sales_invoice',
        source_id: sourceId,
        narration: 'Invoice 7',
        lines: [
          { account: { subtype: 'receivable' }, debit_paise: 10_500, party: customer },
          { account: { subtype: 'sales' }, credit_paise: 10_000 },
          { account: { subtype: 'output_igst' }, credit_paise: 500 },
        ],
      })
      expect(await partyBalance(tx, customer)).toBe(10_500)
      const rev = await reverseJournal(tx, shop.ctx, {
        source_type: 'sales_invoice',
        source_id: sourceId,
        entry_date: '2026-10-23',
      })
      expect(rev.entry_ids).toHaveLength(1)
      const entry = await tx
        .selectFrom('journal_entries')
        .select(['reverses_entry_id', 'entry_date', 'source_type', 'source_id', 'narration'])
        .where('id', '=', rev.entry_id!)
        .executeTakeFirstOrThrow()
      expect(entry).toMatchObject({
        reverses_entry_id: original.entry_id,
        entry_date: '2026-10-23',
        source_type: 'sales_invoice',
        source_id: sourceId,
      })
      expect(entry.narration).toMatch(/^Reversal/)
      const lines = await tx
        .selectFrom('journal_lines as l')
        .innerJoin('accounts as a', 'a.id', 'l.account_id')
        .select(['a.subtype', 'l.debit_paise', 'l.credit_paise', 'l.party_id'])
        .where('l.entry_id', '=', rev.entry_id!)
        .orderBy('a.code')
        .execute()
      expect(lines).toEqual([
        { subtype: 'receivable', debit_paise: 0, credit_paise: 10_500, party_id: c.id },
        { subtype: 'output_igst', debit_paise: 500, credit_paise: 0, party_id: null },
        { subtype: 'sales', debit_paise: 10_000, credit_paise: 0, party_id: null },
      ])
      expect(await partyBalance(tx, customer)).toBe(0)
      await expect(
        reverseJournal(tx, shop.ctx, {
          source_type: 'sales_invoice',
          source_id: sourceId,
          entry_date: '2026-10-23',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      // Nothing ever posted for a source: nothing to reverse.
      expect(
        await reverseJournal(tx, shop.ctx, {
          source_type: 'expense',
          source_id: newId(),
          entry_date: '2026-10-23',
        }),
      ).toEqual({ entry_id: null, entry_ids: [] })
    })
  })

  it("rejects another tenant's or an inactive account, wrong parties and unknown parties", async () => {
    const other = await createTestTenant(t)
    const foreignCash = await other.tx((tx) => systemAccountId(tx, other.ctx, 'cash'))
    const attempt = (lines: Parameters<typeof postJournal>[2]['lines']) =>
      shop.tx((tx) =>
        postJournal(tx, shop.ctx, { entry_date: '2026-10-20', source_type: 'manual', lines }),
      )
    await expect(
      attempt([
        { account: { id: foreignCash }, debit_paise: 100 },
        { account: { subtype: 'capital' }, credit_paise: 100 },
      ]),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE', details: { account_id: foreignCash } })

    const inactiveId = newId()
    await t.deps.db.systemDb
      .insertInto('accounts')
      .values({
        id: inactiveId,
        tenant_id: shop.tenant.id,
        code: '1290',
        name: 'Old bank',
        type: 'asset',
        is_active: false,
      })
      .execute()
    await expect(
      attempt([
        { account: { id: inactiveId }, debit_paise: 100 },
        { account: { subtype: 'capital' }, credit_paise: 100 },
      ]),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE' })

    const s = await insertTestSupplier(t.deps, shop.tenant.id)
    await expect(
      attempt([
        {
          account: { subtype: 'receivable' },
          debit_paise: 100,
          party: { type: 'supplier', id: s.id },
        },
        { account: { subtype: 'sales' }, credit_paise: 100 },
      ]),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE' })
    await expect(
      attempt([
        {
          account: { subtype: 'receivable' },
          debit_paise: 100,
          party: { type: 'customer', id: newId() },
        },
        { account: { subtype: 'sales' }, credit_paise: 100 },
      ]),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // All-zero entries are not written.
    expect(
      await attempt([{ account: { subtype: 'cash' }, debit_paise: 0, credit_paise: 0 }]),
    ).toEqual({ entry_id: null })
  })

  it('keeps per-line store dimensions (stock transfer between stores)', async () => {
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
    const lines = await shop.tx(async (tx) => {
      const { entry_id } = await postJournal(tx, shop.ctx, {
        entry_date: '2026-10-24',
        store_id: shop.store.id,
        source_type: 'stock_transfer',
        source_id: newId(),
        lines: [
          { account: { subtype: 'inventory' }, debit_paise: 4_200, store_id: store2 },
          { account: { subtype: 'inventory' }, credit_paise: 4_200 },
        ],
      })
      return tx
        .selectFrom('journal_lines')
        .select(['store_id', 'debit_paise', 'credit_paise'])
        .where('entry_id', '=', entry_id!)
        .orderBy('debit_paise')
        .execute()
    })
    expect(lines).toEqual([
      { store_id: shop.store.id, debit_paise: 0, credit_paise: 4_200 },
      { store_id: store2, debit_paise: 4_200, credit_paise: 0 },
    ])
  })

  it('re-creates a missing system account from the default chart', async () => {
    const fresh = await createTestTenant(t)
    await t.deps.db.systemDb
      .deleteFrom('accounts')
      .where('tenant_id', '=', fresh.tenant.id)
      .where('subtype', '=', 'bank_charges')
      .execute()
    const id = await fresh.tx((tx) => systemAccountId(tx, fresh.ctx, 'bank_charges'))
    const row = await t.deps.db.systemDb
      .selectFrom('accounts')
      .select(['code', 'is_system'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ code: '5360', is_system: true })
  })
})
