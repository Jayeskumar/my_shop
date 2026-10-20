import { newId } from '@kadai/shared'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestTenant, closeTestDb, insertTestTenant, testDb } from '../test/helpers'
import { afterCommit, afterRollback, withSystemTx, withTenant } from './tenant'

describe('row-level security coverage', () => {
  afterAll(() => closeTestDb())

  it('every public table with tenant_id (except the exempt list) has RLS and a tenant_isolation policy', async () => {
    const { systemDb } = testDb()
    const rows = await sql<{ table_name: string; rls: boolean; has_policy: boolean }>`
      SELECT c.relname AS table_name,
             c.relrowsecurity AS rls,
             EXISTS (SELECT 1 FROM pg_policies p
                      WHERE p.schemaname = 'public' AND p.tablename = c.relname AND p.policyname = 'tenant_isolation') AS has_policy
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
       WHERE c.relkind IN ('r', 'p')
         AND c.relname <> ALL (kadai_rls_exempt_tables())
       ORDER BY 1`.execute(systemDb)
    expect(rows.rows.length).toBeGreaterThan(40)
    const missing = rows.rows.filter((r) => !r.rls || !r.has_policy).map((r) => r.table_name)
    expect(missing).toEqual([])
  })

  it('tenants and users have their own policies', async () => {
    const { systemDb } = testDb()
    const res = await sql<{ tablename: string; policyname: string }>`
      SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('tenants', 'users') ORDER BY 1, 2`.execute(systemDb)
    expect(res.rows).toEqual([
      { tablename: 'tenants', policyname: 'tenant_self' },
      { tablename: 'users', policyname: 'users_self_update' },
      { tablename: 'users', policyname: 'users_visible' },
    ])
  })

  it('the runtime role cannot read secrets or system-only tables', async () => {
    const { appDb } = testDb()
    await expect(sql`SELECT password_hash FROM users LIMIT 1`.execute(appDb)).rejects.toMatchObject({ code: '42501' })
    for (const table of ['auth_sessions', 'otp_codes', 'system_settings', 'schema_migrations', 'payment_webhook_events']) {
      await expect(sql`SELECT 1 FROM ${sql.table(table)} LIMIT 1`.execute(appDb), table).rejects.toMatchObject({ code: '42501' })
    }
  })
})

describe('tenant isolation through withTenant', () => {
  let a: TestTenant
  let b: TestTenant

  beforeAll(async () => {
    const { systemDb } = testDb()
    a = await insertTestTenant(systemDb)
    b = await insertTestTenant(systemDb)
  })
  afterAll(() => closeTestDb())

  const ctxOf = (t: TestTenant) => ({ tenantId: t.tenant.id, userId: t.owner.user_id })

  it('sees only its own rows', async () => {
    const { appDb } = testDb()
    const storesA = await withTenant(appDb, ctxOf(a), (tx) => tx.selectFrom('stores').select(['id', 'tenant_id']).execute())
    expect(storesA.map((s) => s.id)).toEqual([a.store.id])
    // Even an explicit filter on the other tenant returns nothing.
    const leak = await withTenant(appDb, ctxOf(a), (tx) => tx.selectFrom('stores').select('id').where('tenant_id', '=', b.tenant.id).execute())
    expect(leak).toEqual([])
    const tenants = await withTenant(appDb, ctxOf(a), (tx) => tx.selectFrom('tenants').select('id').execute())
    expect(tenants.map((t) => t.id)).toEqual([a.tenant.id])
  })

  it('returns zero rows without tenant context', async () => {
    const { appDb } = testDb()
    const rows = await withSystemTx(appDb, (tx) => tx.selectFrom('stores').select('id').execute())
    expect(rows).toEqual([])
  })

  it('rejects writes into another tenant (WITH CHECK)', async () => {
    const { appDb } = testDb()
    await expect(
      withTenant(appDb, ctxOf(a), (tx) => tx.insertInto('brands').values({ id: newId(), tenant_id: b.tenant.id, name: 'Intruder' }).execute()),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('cannot reference another tenant’s rows through composite foreign keys', async () => {
    const { appDb } = testDb()
    await expect(
      withTenant(appDb, ctxOf(a), (tx) =>
        tx.insertInto('registers').values({ id: newId(), tenant_id: a.tenant.id, store_id: b.store.id, code: 'Z', name: 'Bad' }).execute(),
      ),
    ).rejects.toMatchObject({ code: '23503' })
  })

  it('does not leak context to the next transaction on the same pool', async () => {
    const { appDb } = testDb()
    await withTenant(appDb, ctxOf(a), async (tx) => tx.selectFrom('stores').select('id').execute())
    const after = await sql<{ t: string | null }>`SELECT current_setting('app.tenant_id', true) AS t`.execute(appDb)
    expect(after.rows[0]?.t ?? '').toBe('')
  })

  it('applies a per-transaction statement timeout', async () => {
    const { appDb } = testDb()
    await expect(withTenant(appDb, ctxOf(a), (tx) => sql`SELECT pg_sleep(1)`.execute(tx), { statementTimeoutMs: 100 })).rejects.toMatchObject({
      code: '57014',
    })
  })

  it('runs afterCommit hooks only on commit and afterRollback hooks only on rollback', async () => {
    const { appDb } = testDb()
    const calls: string[] = []
    await withTenant(appDb, ctxOf(a), async (tx) => {
      afterCommit(tx, () => void calls.push('commit'))
      afterRollback(tx, () => void calls.push('rollback'))
    })
    await expect(
      withTenant(appDb, ctxOf(a), async (tx) => {
        afterCommit(tx, () => void calls.push('commit2'))
        afterRollback(tx, () => void calls.push('rollback2'))
        throw new Error('fail')
      }),
    ).rejects.toThrow('fail')
    expect(calls).toEqual(['commit', 'rollback2'])
  })

  it('rejects malformed tenant ids before touching the database', async () => {
    const { appDb } = testDb()
    expect(() => withTenant(appDb, { tenantId: 'nope', userId: null }, async () => 1)).toThrow(TypeError)
  })
})
