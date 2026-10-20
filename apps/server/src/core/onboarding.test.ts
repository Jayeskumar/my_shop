import {
  BUSINESS_TYPES,
  DEFAULT_CHART,
  ROLE_PRESETS,
  SYSTEM_ROLE_CODES,
  VERTICAL_PRESETS,
  flattenCategoryPresets,
  initialSettingsFor,
  newId,
  readSettings,
} from '@kadai/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp, randomPhone } from '../test/helpers'
import { randomGstin } from '../test/tenants'
import { type CreateTenantInput, createTenant } from './onboarding'
import { verifyPassword } from './passwords'

const PASSWORD = 'Vanakkam-Kadai#42'

function input(overrides: Partial<CreateTenantInput> = {}): CreateTenantInput {
  const suffix = newId().slice(-6)
  return {
    business_name: `Murugan Stores ${suffix}`,
    business_name_ta: 'முருகன் ஸ்டோர்ஸ்',
    business_type: 'general_store',
    state_code: '33',
    locale: 'ta',
    owner: { full_name: 'Murugan', phone: randomPhone(), password: PASSWORD },
    mode: 'cloud',
    ...overrides,
  }
}

describe('core/onboarding', () => {
  let t: TestApp
  const db = () => t.deps.db.systemDb

  beforeAll(async () => {
    t = await buildTestApp()
  })
  afterAll(() => t.close())

  it.each(BUSINESS_TYPES.map((b) => b.code))(
    'creates a ready-to-bill %s tenant (roles, owner, S1/A, chart, presets, settings, trial)',
    async (businessType) => {
      const gstin = randomGstin('33')
      const created = await createTenant(db(), input({ business_type: businessType, gstin }))
      const tid = created.tenant.id
      expect(created.tenant).toMatchObject({
        business_type: businessType,
        gst_scheme: 'regular',
        gstin,
        state_code: '33',
        plan_code: 'free',
      })
      expect(created.user.created).toBe(true)

      const tenant = await db().selectFrom('tenants').selectAll().where('id', '=', tid).executeTakeFirstOrThrow()
      expect(tenant.pan).toBe(gstin.slice(2, 12))
      expect(readSettings(tenant.settings)).toEqual(initialSettingsFor(businessType))

      const roles = await db().selectFrom('roles').select(['code', 'permissions', 'is_system']).where('tenant_id', '=', tid).execute()
      expect(roles.map((r) => r.code).sort()).toEqual([...SYSTEM_ROLE_CODES].sort())
      expect(roles.every((r) => r.is_system)).toBe(true)
      expect(roles.find((r) => r.code === 'owner')?.permissions).toEqual(['*'])
      expect(roles.find((r) => r.code === 'cashier')?.permissions).toEqual([...ROLE_PRESETS.cashier.permissions])

      const membership = await db()
        .selectFrom('memberships')
        .selectAll()
        .where('tenant_id', '=', tid)
        .executeTakeFirstOrThrow()
      expect(membership).toMatchObject({
        id: created.membership.id,
        user_id: created.user.id,
        role_id: created.roles.owner,
        status: 'active',
        store_ids: null,
      })
      const user = await db().selectFrom('users').selectAll().where('id', '=', created.user.id).executeTakeFirstOrThrow()
      expect(await verifyPassword(user.password_hash!, PASSWORD)).toBe(true)
      expect(user.preferred_locale).toBe('ta')

      const stores = await db().selectFrom('stores').selectAll().where('tenant_id', '=', tid).execute()
      expect(stores).toHaveLength(1)
      expect(stores[0]).toMatchObject({ code: 'S1', state_code: '33', gstin })
      const registers = await db().selectFrom('registers').selectAll().where('tenant_id', '=', tid).execute()
      expect(registers.map((r) => [r.code, r.store_id])).toEqual([['A', stores[0]!.id]])

      const accounts = await db().selectFrom('accounts').select(['code', 'subtype', 'type', 'is_system']).where('tenant_id', '=', tid).execute()
      expect(accounts).toHaveLength(DEFAULT_CHART.length)
      expect(accounts.every((a) => a.is_system)).toBe(true)
      const subtypes = accounts.flatMap((a) => (a.subtype ? [a.subtype] : []))
      expect(new Set(subtypes).size).toBe(subtypes.length)
      expect(subtypes).toEqual(expect.arrayContaining(['cash', 'receivable', 'payable', 'bank_charges', 'customer_advance']))

      const preset = VERTICAL_PRESETS[businessType]
      const flat = flattenCategoryPresets(preset.categories)
      const categories = await db()
        .selectFrom('categories as c')
        .leftJoin('categories as p', 'p.id', 'c.parent_id')
        .leftJoin('tax_slab_rules as r', 'r.id', 'c.tax_slab_rule_id')
        .select(['c.name', 'c.name_ta', 'c.hsn_code', 'c.gst_rate_bp', 'p.name as parent_name', 'r.name as rule_name'])
        .where('c.tenant_id', '=', tid)
        .execute()
      expect(categories).toHaveLength(flat.length)
      for (const f of flat) {
        const row = categories.find((c) => c.name === f.name)
        expect(row, f.name).toBeDefined()
        expect(row!.parent_name).toBe(f.parent_name)
        expect(row!.name_ta).toBe(f.name_ta)
        expect(row!.gst_rate_bp).toBe(f.gst_rate_bp ?? null)
        if (f.tax_slab_rule) {
          expect(row!.rule_name).toBe(preset.tax_slab_rules.find((r) => r.key === f.tax_slab_rule)!.name)
        }
      }
      const rules = await db().selectFrom('tax_slab_rules').select(['name', 'slabs']).where('tenant_id', '=', tid).execute()
      expect(rules).toHaveLength(preset.tax_slab_rules.length)
      for (const r of preset.tax_slab_rules) {
        expect(rules.find((x) => x.name === r.name)?.slabs).toEqual(r.slabs)
      }

      const subs = await db().selectFrom('subscriptions').selectAll().where('tenant_id', '=', tid).execute()
      expect(subs).toHaveLength(1)
      expect(subs[0]).toMatchObject({ plan_code: 'growth', status: 'trialing' })
      const days = (subs[0]!.trial_ends_at!.getTime() - subs[0]!.current_period_start.getTime()) / 86_400_000
      expect(days).toBeCloseTo(14, 5)

      const auditRow = await db()
        .selectFrom('audit_logs')
        .select(['action', 'user_id', 'entity_id'])
        .where('tenant_id', '=', tid)
        .executeTakeFirstOrThrow()
      expect(auditRow).toEqual({ action: 'tenant.create', user_id: created.user.id, entity_id: tid })
    },
  )

  it('gives new cloud tenants the Valarchi trial entitlements', async () => {
    const created = await createTenant(db(), input())
    const ent = await t.deps.entitlements.get(created.tenant.id)
    expect(ent.plan_code).toBe('growth')
    expect(ent.features.has('purchases')).toBe(true)
    expect(ent.features.has('multi_store')).toBe(false)
  })

  it('creates no subscription on-prem and applies the scheme defaults', async () => {
    const onprem = await createTenant(db(), input({ mode: 'onprem', business_type: 'pharmacy' }))
    expect(onprem.subscription).toBeNull()
    expect(onprem.tenant.gst_scheme).toBe('unregistered')
    const subs = await db().selectFrom('subscriptions').select('id').where('tenant_id', '=', onprem.tenant.id).execute()
    expect(subs).toHaveLength(0)
    const composition = await createTenant(db(), input({ gst_scheme: 'composition', gstin: randomGstin('33') }))
    expect(composition.tenant.gst_scheme).toBe('composition')
  })

  it('validates GST registration, phone, email and password before writing anything', async () => {
    const name = `Invalid ${newId()}`
    const cases: Array<[Partial<CreateTenantInput>, string]> = [
      [{ gstin: randomGstin('29') }, 'gstin'],
      [{ gstin: '33ABCDE1234F1Z0' }, 'gstin'],
      [{ gst_scheme: 'unregistered', gstin: randomGstin('33') }, 'gst_scheme'],
      [{ gst_scheme: 'regular' }, 'gstin'],
      [{ state_code: '45' }, 'state_code'],
    ]
    for (const [overrides, path] of cases) {
      const err = await createTenant(db(), input({ business_name: name, ...overrides })).catch((e: unknown) => e)
      expect(err, path).toMatchObject({ code: 'VALIDATION_ERROR' })
      expect(JSON.stringify((err as { details: unknown }).details)).toContain(path)
    }
    await expect(
      createTenant(db(), input({ business_name: name, owner: { full_name: 'X', phone: '12345', password: PASSWORD } })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(
      createTenant(db(), input({ business_name: name, owner: { full_name: 'X', phone: randomPhone(), password: 'password123' } })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(
      createTenant(db(), input({ business_name: name, owner: { full_name: 'X', phone: randomPhone() } })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    const none = await db().selectFrom('tenants').select('id').where('name', '=', name).execute()
    expect(none).toHaveLength(0)
  })

  it('links an existing identity by password or verified OTP, and blocks double submits', async () => {
    const phone = randomPhone()
    const first = await createTenant(db(), input({ owner: { full_name: 'Lakshmi', phone, password: PASSWORD } }))
    expect(first.user.created).toBe(true)

    await expect(
      createTenant(db(), input({ owner: { full_name: 'Lakshmi', phone, password: 'Wrong-Password#1' } })),
    ).rejects.toMatchObject({ code: 'DUPLICATE', details: { field: 'phone', reason: 'phone_registered' } })

    const second = await createTenant(
      db(),
      input({ business_name: 'Lakshmi Textiles', business_type: 'apparel', owner: { full_name: 'L', phone, password: PASSWORD } }),
    )
    expect(second.user).toMatchObject({ id: first.user.id, created: false, full_name: 'Lakshmi' })
    expect(second.tenant.id).not.toBe(first.tenant.id)

    await expect(
      createTenant(db(), input({ business_name: 'lakshmi textiles', owner: { full_name: 'L', phone, password: PASSWORD } })),
    ).rejects.toMatchObject({ code: 'DUPLICATE', details: { reason: 'duplicate_signup', tenant_id: second.tenant.id } })

    const third = await createTenant(db(), input({ phone_verified: true, owner: { full_name: 'L', phone } }))
    expect(third.user.id).toBe(first.user.id)
    const memberships = await db().selectFrom('memberships').select('tenant_id').where('user_id', '=', first.user.id).execute()
    expect(memberships).toHaveLength(3)
  })

  it('rejects an email used by another account', async () => {
    const email = `owner.${newId().slice(-8)}@example.in`
    await createTenant(db(), input({ owner: { full_name: 'A', phone: randomPhone(), password: PASSWORD, email } }))
    await expect(
      createTenant(db(), input({ owner: { full_name: 'B', phone: randomPhone(), password: PASSWORD, email: email.toUpperCase() } })),
    ).rejects.toMatchObject({ code: 'DUPLICATE', details: { field: 'email' } })
  })

  it('is atomic: a failure late in onboarding leaves nothing behind', async () => {
    const phone = randomPhone()
    const name = `Atomic ${newId()}`
    await expect(
      createTenant(db(), input({ business_name: name, trial: { plan_code: 'no_such_plan', days: 14 }, owner: { full_name: 'X', phone, password: PASSWORD } })),
    ).rejects.toMatchObject({ code: 'INTERNAL' })
    expect(await db().selectFrom('tenants').select('id').where('name', '=', name).execute()).toHaveLength(0)
    expect(await db().selectFrom('users').select('id').where('phone', '=', phone).execute()).toHaveLength(0)
  })
})
