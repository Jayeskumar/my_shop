import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  AuditLogListQuerySchema,
  AuditLogSchema,
  BusinessProfileSchema,
  BusinessProfileUpdateSchema,
  DeviceCreateResultSchema,
  DeviceCreateSchema,
  DeviceListQuerySchema,
  FILE_UPLOAD_RULES,
  FileSchema,
  FileUploadQuerySchema,
  ImportJobSchema,
  ImportRequestBaseSchema,
  MemberCreateResultSchema,
  MemberCreateSchema,
  MemberListQuerySchema,
  MemberSchema,
  MemberUpdateSchema,
  NumberSeriesCreateSchema,
  NumberSeriesSchema,
  NumberSeriesUpdateSchema,
  RegisterCreateSchema,
  RegisterSchema,
  RegisterUpdateSchema,
  ResetPinSchema,
  RoleCreateSchema,
  RoleSchema,
  RoleUpdateSchema,
  SettingsPatchSchema,
  SettingsResponseSchema,
  StoreCreateSchema,
  StoreSchema,
  StoreUpdateSchema,
  documentPath,
  fileUploadIssue,
  formatSeriesNumber,
  identityRoutes,
  parseCsv,
  parseCsvTable,
  permissionCatalog,
  seriesFormatIssues,
  seriesMaxLength,
  toCsv,
  toCsvRow,
  zNullableGstin,
  zNullablePhone,
  zNullableText,
  zQueryIds,
  zTags,
} from '../../src/api/identity'
import { dataOf, routePermissions } from '../../src/api/common'
import { makeGstin } from '../../src/gst'
import { newId } from '../../src/ids'
import { PERMISSION_CODES } from '../../src/permissions'
import { DEFAULT_SETTINGS } from '../../src/settings'

const ok = (schema: z.ZodType, v: unknown) => schema.safeParse(v).success
const messages = (schema: z.ZodType, v: unknown) => {
  const r = schema.safeParse(v)
  return r.success ? [] : r.error.issues.map((i) => i.message)
}
const now = '2026-10-20T10:15:00.000Z'
const TN_GSTIN = makeGstin('33', 'ABCPE1234F')
const KA_GSTIN = makeGstin('29', 'ABCPE1234F')

describe('shared helpers', () => {
  it('zQueryIds accepts repeated keys and comma lists', () => {
    const a = newId()
    const b = newId()
    expect(zQueryIds.parse(a)).toEqual([a])
    expect(zQueryIds.parse(`${a}, ${b}`)).toEqual([a, b])
    expect(zQueryIds.parse([a, b])).toEqual([a, b])
    expect(ok(zQueryIds, 'nope')).toBe(false)
  })
  it('nullable fields keep undefined (PATCH) and clear with null / empty', () => {
    expect(zNullableText(10).parse(undefined)).toBeUndefined()
    expect(zNullableText(10).parse('')).toBeNull()
    expect(zNullableText(10).parse(null)).toBeNull()
    expect(zNullableText(10).parse('  x ')).toBe('x')
    expect(zNullablePhone.parse(undefined)).toBeUndefined()
    expect(zNullablePhone.parse('')).toBeNull()
    expect(zNullablePhone.parse('098765 43210')).toBe('+919876543210')
    expect(messages(zNullablePhone, '12345')).toEqual(['phone'])
    expect(zNullableGstin.parse(undefined)).toBeUndefined()
    expect(zNullableGstin.parse(TN_GSTIN.toLowerCase())).toBe(TN_GSTIN)
    expect(messages(zNullableGstin, '33ABCDE1234F1Z0')).toEqual(['gstin'])
  })
  it('zTags lower-cases and de-duplicates', () => {
    expect(zTags.parse(['VIP', 'vip', ' Street 3 '])).toEqual(['vip', 'street 3'])
  })
})

describe('CSV helpers', () => {
  it('round-trips quoting, commas, quotes, newlines and Tamil', () => {
    const rows = [
      ['sku', 'name', 'note'],
      ['A-1', 'அரிசி, பொன்னி', 'He said "ok"\nnext line'],
      ['B-2', '', 12.5],
    ]
    const text = toCsv(rows)
    expect(text.startsWith('﻿')).toBe(true)
    expect(parseCsv(text)).toEqual([
      ['sku', 'name', 'note'],
      ['A-1', 'அரிசி, பொன்னி', 'He said "ok"\nnext line'],
      ['B-2', '', '12.5'],
    ])
  })
  it('guards spreadsheet formulas but not negative numbers', () => {
    expect(toCsvRow(['=SUM(A1)', '-12.50', '@x', -5])).toBe("'=SUM(A1),-12.50,'@x,-5")
  })
  it('detects tab / semicolon delimiters and normalises headers', () => {
    expect(parseCsv('a\tb\n1\t2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(parseCsv('a;b\r\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    const table = parseCsvTable('SKU, GST Rate ,Name\nX1,18,Rice\n\nX2,5\n')
    expect(table.headers).toEqual(['sku', 'gst_rate', 'name'])
    expect(table.rows).toEqual([
      { line: 2, values: { sku: 'X1', gst_rate: '18', name: 'Rice' } },
      { line: 3, values: { sku: 'X2', gst_rate: '5', name: '' } },
    ])
  })
})

describe('document links', () => {
  it('maps entity types to web routes', () => {
    const id = newId()
    expect(documentPath('sales_invoice', id)).toBe(`/sales/invoices/${id}`)
    expect(documentPath('stock_transfer', id)).toBe(`/inventory/transfers/${id}`)
    expect(documentPath('settings', id)).toBeNull()
    expect(documentPath(null, id)).toBeNull()
  })
})

const member = {
  id: newId(),
  membership_id: newId(),
  full_name: 'Selvi',
  phone: '+919876543210',
  email: null,
  preferred_locale: 'ta',
  role_id: newId(),
  role_code: 'cashier',
  role_name: 'Cashier',
  role_name_ta: 'காசாளர்',
  is_owner: false,
  store_ids: null,
  status: 'invited',
  user_status: 'active',
  has_pin: true,
  pin_locked_until: null,
  last_login_at: new Date(now),
  invited_by: newId(),
  invited_by_name: 'Owner',
  is_self: false,
  created_at: now,
  updated_at: now,
}

describe('users', () => {
  it('member response and list query', () => {
    expect(MemberSchema.parse(member).last_login_at).toBe(now)
    expect(MemberListQuerySchema.parse({ q: 'sel', sort: '-last_login_at' })).toMatchObject({
      limit: 50,
      sort: { field: 'last_login_at', direction: 'desc' },
    })
    expect(MemberListQuerySchema.parse({}).sort).toEqual({ field: 'full_name', direction: 'asc' })
  })
  it('invite defaults to a temporary password; password mode needs a password', () => {
    const base = { phone: '98765 43210', full_name: 'Selvi', role_id: newId() }
    expect(MemberCreateSchema.parse(base)).toMatchObject({
      phone: '+919876543210',
      first_login: 'temporary_password',
      store_ids: null,
    })
    expect(messages(MemberCreateSchema, { ...base, first_login: 'password' })).toEqual([
      'password_required',
    ])
    expect(messages(MemberCreateSchema, { ...base, password: 'Secret#2026' })).toEqual([
      'password_not_allowed',
    ])
    expect(
      ok(MemberCreateSchema, {
        ...base,
        first_login: 'password',
        password: 'Secret#2026',
        pin: '1234',
      }),
    ).toBe(true)
    expect(messages(MemberCreateSchema, { ...base, store_ids: [] })).toEqual(['store_ids_empty'])
    expect(
      MemberCreateResultSchema.parse({
        member,
        existing_user: false,
        temporary_password: 'Kd-7h2k-93',
        otp_sent: false,
      }).temporary_password,
    ).toBe('Kd-7h2k-93')
  })
  it('update needs a change; reset PIN allows null', () => {
    expect(messages(MemberUpdateSchema, {})).toEqual(['empty_patch'])
    expect(messages(MemberUpdateSchema, { if_updated_at: now })).toEqual(['empty_patch'])
    expect(MemberUpdateSchema.parse({ store_ids: [newId()], email: '' })).toMatchObject({
      email: null,
    })
    expect(ResetPinSchema.parse({ pin: null })).toEqual({ pin: null })
    expect(ok(ResetPinSchema, { pin: '12' })).toBe(false)
  })
})

describe('roles & permissions', () => {
  it('role create / update validation', () => {
    expect(
      RoleCreateSchema.parse({
        name: 'Billing + stock',
        permissions: ['pos.use', 'inventory.read'],
      }).name_ta,
    ).toBeUndefined()
    expect(messages(RoleCreateSchema, { name: 'x', permissions: ['pos.use', 'pos.use'] })).toEqual([
      'duplicate_permission',
    ])
    expect(ok(RoleCreateSchema, { name: 'x', permissions: ['pos.fly'] })).toBe(false)
    expect(messages(RoleCreateSchema, { name: 'x', permissions: ['pos.use'], code: '9x' })).toEqual(
      ['role_code'],
    )
    expect(ok(RoleUpdateSchema, { name_ta: 'காசாளர்' })).toBe(true)
  })
  it('role response', () => {
    expect(
      RoleSchema.parse({
        id: newId(),
        code: 'owner',
        name: 'Owner',
        name_ta: 'உரிமையாளர்',
        description: null,
        permissions: ['*'],
        effective_permissions: [...PERMISSION_CODES],
        is_system: true,
        editable: false,
        member_count: 1,
        created_at: now,
        updated_at: now,
      }).effective_permissions,
    ).toHaveLength(PERMISSION_CODES.length)
  })
  it('permission catalogue covers every permission once, grouped', () => {
    const cat = permissionCatalog()
    const codes = cat.groups.flatMap((g) => g.permissions.map((p) => p.code))
    expect(new Set(codes).size).toBe(PERMISSION_CODES.length)
    const catalog = cat.groups.find((g) => g.code === 'catalog')!
    expect(catalog.permissions.find((p) => p.code === 'catalog.write')?.implies).toEqual([
      'catalog.read',
    ])
    expect(identityRoutes.listPermissions.response.parse({ data: cat }).data.groups.length).toBe(
      cat.groups.length,
    )
  })
})

describe('stores, registers, devices', () => {
  const store = {
    id: newId(),
    code: 'S1',
    name: 'Main',
    name_ta: 'முதன்மை',
    gstin: TN_GSTIN,
    state_code: '33',
    address: { line1: '1 Car Street', city: 'Madurai', pincode: '625001' },
    phone: null,
    email: null,
    drug_license_numbers: null,
    fssai_number: null,
    is_active: true,
    register_count: 2,
    created_at: now,
    updated_at: now,
  }
  it('store schemas', () => {
    expect(StoreSchema.parse(store).code).toBe('S1')
    expect(
      StoreCreateSchema.parse({ code: 's2', name: 'Branch', state_code: '33', gstin: TN_GSTIN }),
    ).toMatchObject({ code: 'S2', address: {} })
    expect(
      messages(StoreCreateSchema, { code: 'S2', name: 'B', state_code: '33', gstin: KA_GSTIN }),
    ).toEqual(['gstin_state'])
    expect(messages(StoreCreateSchema, { code: 'TOOLONG', name: 'B', state_code: '33' })).toEqual([
      'store_code',
    ])
    expect(
      messages(StoreCreateSchema, { code: 'S3', name: 'B', state_code: '33', fssai_number: '123' }),
    ).toEqual(['fssai'])
    expect(ok(StoreUpdateSchema, { is_active: false, if_updated_at: now })).toBe(true)
    expect(messages(StoreUpdateSchema, { if_updated_at: now })).toEqual(['empty_patch'])
  })
  it('register schemas fill settings defaults', () => {
    const reg = RegisterSchema.parse({
      id: newId(),
      store_id: store.id,
      store_code: 'S1',
      store_name: 'Main',
      code: 'A',
      name: 'Counter 1',
      is_active: true,
      settings: {},
      last_seen_at: null,
      device_count: 1,
      created_at: now,
      updated_at: now,
    })
    expect(reg.settings).toMatchObject({ print_format: null, auto_print: true })
    expect(
      RegisterCreateSchema.parse({ store_id: store.id, code: 'b', name: 'Counter 2' }).code,
    ).toBe('B')
    expect(ok(RegisterCreateSchema, { store_id: store.id, code: 'ABC', name: 'x' })).toBe(false)
    expect(RegisterUpdateSchema.parse({ settings: { cash_drawer: true } })).toEqual({
      settings: { cash_drawer: true },
    })
    expect(RegisterUpdateSchema.parse({ settings: { scale: { enabled: true } } })).toEqual({
      settings: { scale: { enabled: true } },
    })
    expect(ok(RegisterUpdateSchema, { settings: { bogus: true } })).toBe(false)
  })
  it('device create returns the secret once', () => {
    expect(
      DeviceCreateSchema.parse({ name: 'Counter PC', store_id: store.id }).register_id,
    ).toBeNull()
    expect(DeviceListQuerySchema.parse({}).status).toBe('active')
    const res = DeviceCreateResultSchema.parse({
      device: {
        id: newId(),
        name: 'Counter PC',
        store_id: store.id,
        store_code: 'S1',
        store_name: 'Main',
        register_id: null,
        register_code: null,
        register_name: null,
        user_agent: 'Mozilla/5.0',
        status: 'active',
        approved_by: newId(),
        approved_by_name: 'Owner',
        last_seen_at: null,
        revoked_at: null,
        created_at: now,
        updated_at: now,
      },
      device_secret: 'x'.repeat(43),
    })
    expect(res.device_secret).toHaveLength(43)
    expect(JSON.stringify(res.device)).not.toContain('hash')
  })
})

describe('settings & business profile', () => {
  const tenant = {
    id: newId(),
    name: 'Murugan Stores',
    name_ta: 'முருகன் ஸ்டோர்ஸ்',
    legal_name: null,
    business_type: 'general_store',
    gst_scheme: 'regular',
    gstin: TN_GSTIN,
    pan: null,
    state_code: '33',
    phone: null,
    email: null,
    address: {},
    logo_file_id: null,
    default_locale: 'ta',
    timezone: 'Asia/Kolkata',
    fy_start_month: 4,
    status: 'active',
    plan_code: 'onprem_pro',
  }
  it('settings response fills defaults', () => {
    const res = SettingsResponseSchema.parse({ tenant, settings: { pos: { sound: false } } })
    expect(res.settings.pos.sound).toBe(false)
    expect(res.settings.invoice).toEqual(DEFAULT_SETTINGS.invoice)
  })
  it('settings patch is deep-partial, strict and default-free', () => {
    expect(SettingsPatchSchema.parse({ loyalty: { enabled: true } })).toEqual({
      loyalty: { enabled: true },
    })
    expect(SettingsPatchSchema.parse({ pos: { scale_barcode: { enabled: true } } })).toEqual({
      pos: { scale_barcode: { enabled: true } },
    })
    expect(ok(SettingsPatchSchema, { loyalty: { enabled: true, bogus: 1 } })).toBe(false)
    expect(ok(SettingsPatchSchema, { nope: {} })).toBe(false)
    expect(ok(SettingsPatchSchema, { invoice: { copies: 9 } })).toBe(false)
    expect(messages(SettingsPatchSchema, {})).toEqual(['empty_patch'])
  })
  it('business profile response and update rules', () => {
    expect(
      BusinessProfileSchema.parse({
        ...tenant,
        current_fy: '2026-27',
        gst_scheme_change_requires_confirm: true,
        updated_at: now,
      }).current_fy,
    ).toBe('2026-27')
    expect(BusinessProfileUpdateSchema.parse({ name: 'New' })).toMatchObject({
      name: 'New',
      confirm_gst_scheme_change: false,
    })
    expect(messages(BusinessProfileUpdateSchema, { gstin: KA_GSTIN, state_code: '33' })).toEqual([
      'gstin_state',
    ])
    expect(messages(BusinessProfileUpdateSchema, { gstin: TN_GSTIN, pan: 'AAAPZ1234C' })).toEqual([
      'pan_gstin_mismatch',
    ])
    expect(ok(BusinessProfileUpdateSchema, { gstin: TN_GSTIN, pan: 'abcpe1234f' })).toBe(true)
    expect(messages(BusinessProfileUpdateSchema, { gst_scheme: 'regular', gstin: null })).toEqual([
      'gstin_required',
    ])
    expect(messages(BusinessProfileUpdateSchema, { confirm_gst_scheme_change: true })).toEqual([
      'empty_patch',
    ])
  })
})

describe('number series', () => {
  it('format helpers mirror the GST limit', () => {
    expect(formatSeriesNumber('S1-A/2627/', 42, 5)).toBe('S1-A/2627/00042')
    expect(seriesMaxLength('sales_invoice')).toBe(16)
    expect(seriesMaxLength('estimate')).toBe(32)
    expect(
      seriesFormatIssues({
        doc_type: 'sales_invoice',
        prefix: 'S1/2627/',
        padding: 5,
        next_number: 1,
      }),
    ).toEqual([])
    expect(
      seriesFormatIssues({
        doc_type: 'sales_invoice',
        prefix: 'MAINSTORE/2627/',
        padding: 5,
        next_number: 1,
      }),
    ).toEqual([{ path: 'prefix', code: 'series_too_long' }])
    expect(
      seriesFormatIssues({ doc_type: 'journal', prefix: 'JV S1', padding: 5, next_number: 1 }),
    ).toEqual([{ path: 'prefix', code: 'series_prefix_chars' }])
  })
  it('schemas', () => {
    const storeId = newId()
    expect(
      NumberSeriesSchema.parse({
        id: null,
        key: `${storeId}:-:sales_invoice:2026-27`,
        store_id: storeId,
        store_code: 'S1',
        register_id: null,
        register_code: null,
        doc_type: 'sales_invoice',
        fy: '2026-27',
        prefix: 'S1/2627/',
        padding: 5,
        next_number: 1,
        next: 'S1/2627/00001',
        issued_count: 0,
        max_length: 16,
        is_gst_document: true,
        updated_at: null,
      }).id,
    ).toBeNull()
    expect(
      NumberSeriesCreateSchema.parse({
        store_id: storeId,
        doc_type: 'sales_invoice',
        fy: '2026-27',
        prefix: 's1/2627/',
        next_number: 1501,
      }),
    ).toMatchObject({ prefix: 'S1/2627/', register_id: null, next_number: 1501 })
    expect(NumberSeriesUpdateSchema.parse({ next_number: 10 })).toMatchObject({ force: false })
    expect(messages(NumberSeriesUpdateSchema, { force: true })).toEqual(['empty_patch'])
    expect(messages(NumberSeriesUpdateSchema, { prefix: 'A B' })).toEqual(['series_prefix_chars'])
  })
})

describe('audit log & files', () => {
  it('audit log row and query', () => {
    expect(
      AuditLogSchema.parse({
        id: 12,
        user_id: newId(),
        user_name: 'Owner',
        action: 'product.update',
        entity_type: 'product',
        entity_id: newId(),
        summary: 'Price changed',
        changes: { before: { sale_price_paise: 100 }, after: { sale_price_paise: 120 } },
        ip: '192.168.1.10',
        user_agent: null,
        request_id: 'req-1',
        created_at: new Date(now),
      }).created_at,
    ).toBe(now)
    expect(
      ok(AuditLogListQuerySchema, { action: 'product', from: '2026-10-01', to: '2026-10-31' }),
    ).toBe(true)
    expect(messages(AuditLogListQuerySchema, { from: '2026-10-31', to: '2026-10-01' })).toEqual([
      'date_order',
    ])
    expect(ok(AuditLogListQuerySchema, { action: 'DROP TABLE' })).toBe(false)
  })
  it('upload rules', () => {
    expect(ok(FileUploadQuerySchema, { purpose: 'export' })).toBe(false)
    expect(fileUploadIssue('product_image', { size: 1000, type: 'image/png' })).toBeNull()
    expect(fileUploadIssue('product_image', { size: 3 * 1024 * 1024, type: 'image/png' })).toBe(
      'file_too_large',
    )
    expect(fileUploadIssue('logo', { size: 10, type: 'image/svg+xml' })).toBe('file_type')
    expect(fileUploadIssue('import', { size: 0, type: 'text/csv' })).toBe('file_empty')
    expect(
      fileUploadIssue('prescription', { size: 10, type: 'application/pdf; charset=x' }),
    ).toBeNull()
    expect(FILE_UPLOAD_RULES.import.max_bytes).toBe(10 * 1024 * 1024)
    const id = newId()
    expect(
      dataOf(FileSchema).parse({
        data: {
          id,
          purpose: 'logo',
          filename: 'logo.png',
          content_type: 'image/png',
          size_bytes: 1234,
          checksum_sha256: 'a'.repeat(64),
          created_by: null,
          created_at: now,
          content_path: `/files/${id}/content`,
        },
      }).data.content_path,
    ).toContain(id)
  })
  it('import job', () => {
    expect(ImportRequestBaseSchema.parse({ file_id: newId() })).toMatchObject({
      mode: 'upsert',
      dry_run: true,
    })
    const job = ImportJobSchema.parse({
      id: newId(),
      kind: 'products',
      status: 'completed',
      file_id: newId(),
      filename: 'items.csv',
      store_id: null,
      mode: 'upsert',
      dry_run: true,
      options: { match_by: 'sku' },
      total_rows: 3,
      success_rows: 2,
      error_rows: 1,
      progress_bp: 10_000,
      errors: [{ row: 4, field: 'gst_rate', message: 'Invalid GST rate 13' }],
      errors_truncated: false,
      summary: { created: 1, updated: 1 },
      preview: [{ row: 2, action: 'create', key: 'A1', name: 'Rice' }],
      created_by: null,
      created_at: now,
      updated_at: now,
      finished_at: now,
    })
    expect(job.errors[0]).toEqual({
      row: 4,
      field: 'gst_rate',
      code: 'invalid',
      message: 'Invalid GST rate 13',
    })
    expect(job.summary).toEqual({ created: 1, updated: 1, unchanged: 0, skipped: 0, details: {} })
  })
})

describe('route catalogue', () => {
  it('every route is under /api with a valid shape', () => {
    for (const [name, def] of Object.entries(identityRoutes)) {
      expect(def.path.startsWith('/'), name).toBe(true)
      expect('scope' in def ? def.scope : 'api').toBe('api')
      if (def.method === 'GET') expect('body' in def, name).toBe(false)
    }
    expect(identityRoutes.createDevice.status).toBe(201)
    expect(identityRoutes.listAuditLogs.feature).toBe('audit_log')
    expect(identityRoutes.createRole.feature).toBe('custom_roles')
    expect(identityRoutes.getFileContent.stream).toBe('file')
  })
  it('optional bodies accept an empty request', () => {
    expect(identityRoutes.disableUser.body.safeParse(undefined).success).toBe(true)
    expect(identityRoutes.revokeDevice.body.safeParse(undefined).success).toBe(true)
    expect(identityRoutes.resetUserPassword.body.safeParse(undefined).success).toBe(true)
  })
})

describe('address helpers', () => {
  it('lists the 38 Tamil Nadu districts once', async () => {
    const { TAMIL_NADU_DISTRICTS } = await import('../../src/api/identity')
    expect(TAMIL_NADU_DISTRICTS).toHaveLength(38)
    expect(new Set(TAMIL_NADU_DISTRICTS.map((d) => d.en)).size).toBe(38)
  })
})

describe('user directory', () => {
  it('lists member names only (no contact or security fields)', async () => {
    const {
      UserDirectoryEntrySchema,
      UserDirectoryQuerySchema,
      identityRoutes: r,
    } = await import('../../src/api/identity')
    const entry = UserDirectoryEntrySchema.parse({
      id: '0192e3a0-0000-7000-8000-000000000001',
      full_name: 'Selvi',
      role_code: 'cashier',
      role_name: 'Cashier',
      role_name_ta: 'காசாளர்',
      status: 'active',
      store_ids: null,
      phone: '+919876543210',
      pin_locked_until: null,
    })
    expect(Object.keys(entry).sort()).toEqual(
      ['full_name', 'id', 'role_code', 'role_name', 'role_name_ta', 'status', 'store_ids'].sort(),
    )
    expect(UserDirectoryQuerySchema.parse({ include_disabled: 'true' })).toEqual({
      include_disabled: true,
    })
    expect(routePermissions(r.userDirectory)).toEqual([])
    expect(r.userDirectory.path).toBe('/users/directory')
  })
})
