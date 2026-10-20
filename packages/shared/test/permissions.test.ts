import { describe, expect, it } from 'vitest'
import {
  PERMISSIONS,
  PERMISSION_CODES,
  PERMISSION_GROUPS,
  PERMISSION_IMPLIES,
  PermissionSchema,
  ROLE_PRESETS,
  SYSTEM_ROLE_CODES,
  expandPermissions,
  hasAllPermissions,
  hasPermission,
  isPermission,
  type Permission,
} from '../src/permissions'

const EXPECTED: Permission[] = [
  'pos.use',
  'sales.create',
  'sales.read',
  'sales.cancel',
  'sales.return',
  'sales.discount_override',
  'sales.price_override',
  'sales.credit',
  'catalog.read',
  'catalog.write',
  'inventory.read',
  'inventory.adjust',
  'inventory.transfer',
  'customers.read',
  'customers.write',
  'suppliers.read',
  'suppliers.write',
  'purchases.read',
  'purchases.write',
  'payments.read',
  'payments.collect',
  'payments.pay',
  'payments.configure',
  'accounting.read',
  'accounting.write',
  'expenses.write',
  'shifts.operate',
  'shifts.manage',
  'reports.read',
  'reports.gst',
  'notifications.send',
  'settings.manage',
  'users.manage',
  'audit.read',
  'billing.manage',
  'data.export',
]
const CASHIER: Permission[] = [
  'pos.use',
  'sales.create',
  'sales.read',
  'sales.credit',
  'sales.return',
  'catalog.read',
  'inventory.read',
  'customers.read',
  'customers.write',
  'payments.collect',
  'shifts.operate',
]

describe('permission catalogue', () => {
  it('has exactly the contract codes', () => {
    expect(PERMISSION_CODES).toEqual(EXPECTED)
    expect(PermissionSchema.options).toEqual(EXPECTED)
  })
  it('every code has a known group and bilingual labels', () => {
    for (const code of PERMISSION_CODES) {
      const def = PERMISSIONS[code]
      expect(Object.keys(PERMISSION_GROUPS)).toContain(def.group)
      expect(def.label_en.length).toBeGreaterThan(3)
      expect(def.label_ta).toMatch(/[஀-௿]/)
    }
    for (const g of Object.values(PERMISSION_GROUPS)) expect(g.label_ta).toMatch(/[஀-௿]/)
  })
  it('implications only reference real codes', () => {
    for (const [from, to] of Object.entries(PERMISSION_IMPLIES)) {
      expect(isPermission(from)).toBe(true)
      for (const t of to ?? []) expect(isPermission(t)).toBe(true)
    }
  })
})

describe('role presets', () => {
  it('defines all system roles with Tamil names', () => {
    expect(Object.keys(ROLE_PRESETS)).toEqual([...SYSTEM_ROLE_CODES])
    for (const role of Object.values(ROLE_PRESETS)) {
      expect(role.name_ta).toMatch(/[஀-௿]/)
      expect(role.description.length).toBeGreaterThan(5)
      expect(new Set(role.permissions).size).toBe(role.permissions.length)
    }
  })
  it('owner has everything, manager everything but billing', () => {
    expect([...ROLE_PRESETS.owner.permissions]).toEqual(EXPECTED)
    expect([...ROLE_PRESETS.manager.permissions]).toEqual(
      EXPECTED.filter((p) => p !== 'billing.manage'),
    )
  })
  it('cashier, accountant, inventory clerk and pharmacist match the contract', () => {
    expect([...ROLE_PRESETS.cashier.permissions].sort()).toEqual([...CASHIER].sort())
    expect([...ROLE_PRESETS.accountant.permissions].sort()).toEqual(
      [
        'sales.read',
        'purchases.read',
        'payments.read',
        'accounting.read',
        'accounting.write',
        'expenses.write',
        'reports.read',
        'reports.gst',
        'customers.read',
        'suppliers.read',
        'data.export',
      ].sort(),
    )
    expect([...ROLE_PRESETS.inventory_clerk.permissions].sort()).toEqual(
      [
        'catalog.read',
        'catalog.write',
        'inventory.read',
        'inventory.adjust',
        'inventory.transfer',
        'purchases.read',
        'purchases.write',
        'suppliers.read',
        'suppliers.write',
      ].sort(),
    )
    expect([...ROLE_PRESETS.pharmacist.permissions].sort()).toEqual(
      [...CASHIER, 'sales.discount_override', 'inventory.adjust', 'reports.read'].sort(),
    )
  })
})

describe('expandPermissions / hasPermission', () => {
  it('expands wildcards, groups and implications; ignores unknown codes', () => {
    expect(expandPermissions(['*']).size).toBe(EXPECTED.length)
    expect([...expandPermissions(['sales.*'])].sort()).toEqual(
      EXPECTED.filter((p) => p.startsWith('sales.')).sort(),
    )
    expect([...expandPermissions(['catalog.write'])].sort()).toEqual([
      'catalog.read',
      'catalog.write',
    ])
    expect([...expandPermissions(['shifts.manage', 'reports.gst'])].sort()).toEqual([
      'reports.gst',
      'reports.read',
      'shifts.manage',
      'shifts.operate',
    ])
    expect([...expandPermissions(['legacy.code', ' pos.use '])]).toEqual(['pos.use'])
    expect(expandPermissions([]).size).toBe(0)
  })
  it('hasPermission is any-of; hasAllPermissions is all-of', () => {
    const perms = expandPermissions(ROLE_PRESETS.cashier.permissions)
    expect(hasPermission(perms, 'pos.use')).toBe(true)
    expect(hasPermission(perms, 'sales.cancel')).toBe(false)
    expect(hasPermission(perms, ['sales.cancel', 'sales.return'])).toBe(true)
    expect(hasPermission(['reports.read'], 'reports.read')).toBe(true)
    expect(hasAllPermissions(perms, ['pos.use', 'sales.create'])).toBe(true)
    expect(hasAllPermissions(perms, ['pos.use', 'settings.manage'])).toBe(false)
  })
})
