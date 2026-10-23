import { describe, expect, it } from 'vitest'
import {
  AuditLogSchema,
  BusinessProfileSchema,
  DeviceSchema,
  MemberSchema,
  NumberSeriesSchema,
  RegisterSchema,
  RoleSchema,
  SettingsResponseSchema,
  StoreSchema,
  permissionCatalog,
} from '@kadai/shared/api/identity'
import { ScaleBarcodeConfigSchema } from '@kadai/shared/scale'
import { DEFAULT_SETTINGS } from '@kadai/shared/settings'
import {
  auditLog,
  businessProfile,
  device,
  member,
  register,
  series,
  settingsResponse,
  store,
  systemRole,
  role,
} from '../testing/fixtures'
import { diffRows, displayValue } from './audit'
import { changedFields, changedTopLevel, digitsOnly } from './forms'
import { gstinStatus } from './gstin'
import { canAssignRole } from './members'
import { impliedBy, roleCodeFromName } from './role-permissions'
import { badPrefixes, layoutLength, sampleScaleBarcode, testScan } from './scale'

describe('settings fixtures follow the identity contract', () => {
  it('parse with the response schemas', () => {
    expect(MemberSchema.safeParse(member()).success).toBe(true)
    expect(RoleSchema.safeParse(role()).success).toBe(true)
    expect(RoleSchema.safeParse(systemRole('manager')).success).toBe(true)
    expect(StoreSchema.safeParse(store()).success).toBe(true)
    expect(RegisterSchema.safeParse(register()).success).toBe(true)
    expect(DeviceSchema.safeParse(device()).success).toBe(true)
    expect(NumberSeriesSchema.safeParse(series()).success).toBe(true)
    expect(AuditLogSchema.safeParse(auditLog()).success).toBe(true)
    expect(BusinessProfileSchema.safeParse(businessProfile()).success).toBe(true)
    expect(SettingsResponseSchema.safeParse(settingsResponse()).success).toBe(true)
  })
})

describe('gstinStatus', () => {
  it('follows typing, then checks state and check character', () => {
    expect(gstinStatus('')).toEqual({ kind: 'empty' })
    expect(gstinStatus('33AAA')).toEqual({ kind: 'typing', length: 5 })
    expect(gstinStatus('00AAAPL1234C1ZL')).toEqual({ kind: 'state', code: '00' })
    expect(gstinStatus('33AAAPL1234C1ZX')).toEqual({ kind: 'checksum' })
    expect(gstinStatus('33aaapl1234c1zl')).toMatchObject({
      kind: 'valid',
      stateCode: '33',
      pan: 'AAAPL1234C',
    })
    expect(gstinStatus('33AAAPL1234C1ZLX')).toEqual({ kind: 'too_long', length: 16 })
  })
})

describe('form diffs', () => {
  it('changedFields keeps only changed leaves and replaces arrays whole', () => {
    const base = { a: { x: 1, y: [1, 2] }, b: true }
    expect(changedFields(base, { a: { x: 1, y: [1, 2] }, b: true })).toBeUndefined()
    expect(changedFields(base, { a: { x: 2, y: [1, 2] }, b: true })).toEqual({ a: { x: 2 } })
    expect(changedFields(base, { a: { x: 1, y: [2] }, b: false })).toEqual({
      a: { y: [2] },
      b: false,
    })
  })

  it('changedTopLevel sends objects such as the address whole', () => {
    const base = { name: 'A', address: { line1: 'x', city: 'Madurai' } }
    expect(changedTopLevel(base, { name: 'A', address: { line1: 'y', city: 'Madurai' } })).toEqual({
      address: { line1: 'y', city: 'Madurai' },
    })
    expect(changedTopLevel(base, { ...base })).toBeUndefined()
    expect(digitsOnly('12a34567', 6)).toBe('123456')
  })
})

describe('roles', () => {
  it('only owners hand out the owner role; others only roles within their own permissions', () => {
    const mine = new Set(['pos.use', 'sales.create', 'sales.read'] as const)
    expect(canAssignRole(systemRole('owner'), mine, false)).toEqual({
      ok: false,
      reason: 'owner_only',
    })
    expect(canAssignRole(role({ effective_permissions: ['pos.use'] }), mine, false)).toEqual({
      ok: true,
    })
    expect(canAssignRole(systemRole('manager'), mine, false)).toEqual({
      ok: false,
      reason: 'role_exceeds_own_permissions',
    })
    expect(canAssignRole(systemRole('owner'), mine, true)).toEqual({ ok: true })
  })

  it('impliedBy follows implications transitively', () => {
    const implied = impliedBy(permissionCatalog(), new Set(['catalog.write']))
    expect(implied.get('catalog.read')).toBe('catalog.write')
    expect(implied.has('catalog.write')).toBe(false)
  })
})

describe('scale barcode helpers', () => {
  const cfg = ScaleBarcodeConfigSchema.parse({ enabled: true })

  it('checks the 13-digit layout', () => {
    expect(badPrefixes(cfg)).toEqual([])
    expect(layoutLength(cfg)).toBe(13)
    expect(badPrefixes({ ...cfg, prefixes: ['2', '21'] })).toEqual(['2'])
  })

  it('reads a sample label and explains failures', () => {
    const sample = sampleScaleBarcode(cfg)!
    expect(sample).toHaveLength(13)
    expect(testScan(sample, cfg)).toEqual({
      ok: true,
      parsed: { prefix: '21', plu: '00123', qty_milli: 1250 },
    })
    expect(testScan('21001230125', cfg)).toEqual({ ok: false, reason: 'length' })
    expect(testScan('abc', cfg)).toEqual({ ok: false, reason: 'digits' })
    expect(testScan(`${sample.slice(0, 12)}${(Number(sample[12]) + 1) % 10}`, cfg)).toEqual({
      ok: false,
      reason: 'check_digit',
    })
    expect(testScan('8901234567890', cfg)).toMatchObject({ ok: false })
    expect(testScan(sample, { ...cfg, enabled: false })).toEqual({ ok: false, reason: 'disabled' })
    const price = { ...cfg, value_type: 'price' as const }
    const priced = sampleScaleBarcode(price)!
    expect(testScan(priced, price)).toMatchObject({ ok: true, parsed: { price_paise: 4550 } })
  })
})

describe('audit diff rows', () => {
  it('flattens {before, after} and falls back to raw JSON for other shapes', () => {
    expect(
      diffRows({
        before: { invoice: { show_hsn: true }, name: 'A' },
        after: { invoice: { show_hsn: false }, name: 'B' },
      }),
    ).toEqual([
      { path: 'invoice.show_hsn', before: true, after: false },
      { path: 'name', before: 'A', after: 'B' },
    ])
    expect(diffRows({ renumbered: true })).toBeNull()
    expect(displayValue(null)).toBe('—')
    expect(displayValue(false)).toBe('No')
    expect(displayValue(DEFAULT_SETTINGS.notifications.due_reminder_days)).toBe('[7,15,30]')
  })
})

describe('role codes', () => {
  it('derives the code the server will use from the role name', () => {
    expect(roleCodeFromName('Senior pharmacist')).toBe('senior_pharmacist')
    expect(roleCodeFromName('  Billing Staff 2 ')).toBe('billing_staff_2')
    expect(roleCodeFromName('2nd shift helper')).toBe('nd_shift_helper')
    expect(roleCodeFromName('மூத்த மருந்தாளர்')).toBe('custom_role')
  })
})
