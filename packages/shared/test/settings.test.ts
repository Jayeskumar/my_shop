import { describe, expect, it } from 'vitest'
import { BusinessTypeSchema } from '../src/enums'
import {
  DEFAULT_SETTINGS,
  RegisterSettingsSchema,
  TenantSettingsPatchSchema,
  TenantSettingsSchema,
  deepMerge,
  initialSettingsFor,
  mergeSettings,
  readSettings,
  resolveSettings,
  settingsPresetFor,
} from '../src/settings'

describe('TenantSettingsSchema defaults', () => {
  it('fills every field from an empty object', () => {
    expect(TenantSettingsSchema.parse({})).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS.invoice).toEqual({
      round_off: 'nearest_rupee',
      default_price_includes_tax: true,
      print_format: 'thermal_80',
      bilingual: true,
      show_hsn: true,
      show_mrp_savings: true,
      upi_qr_on_invoice: true,
      footer_text: 'Thank you! Visit again.',
      footer_text_ta: 'நன்றி! மீண்டும் வருக.',
      terms: '',
      copies: 1,
    })
    expect(DEFAULT_SETTINGS.inventory).toEqual({
      allow_negative_stock: true,
      fefo: true,
      expiry_warning_days: 90,
      block_expired_sale: true,
      low_stock_alerts: true,
    })
    expect(DEFAULT_SETTINGS.pos).toMatchObject({
      allow_price_edit: false,
      max_discount_bp_without_override: 1000,
      require_customer_for_credit: true,
      default_payment_method: 'cash',
      sound: true,
      quick_keys: [],
    })
    expect(DEFAULT_SETTINGS.pos.scale_barcode.enabled).toBe(false)
    expect(DEFAULT_SETTINGS.pos.scale_barcode.prefixes).toHaveLength(9)
    expect(DEFAULT_SETTINGS.pharmacy).toEqual({
      require_rx_for_schedules: ['H', 'H1', 'X'],
      h1_register: true,
    })
    expect(DEFAULT_SETTINGS.loyalty).toEqual({
      enabled: false,
      points_per_100_rupees: 1,
      point_value_paise: 100,
      min_redeem_points: 100,
      expiry_days: null,
    })
    expect(DEFAULT_SETTINGS.credit).toEqual({ default_credit_days: 30, block_over_limit: true })
    expect(DEFAULT_SETTINGS.notifications).toEqual({
      whatsapp_invoice: true,
      sms_invoice: false,
      due_reminder_days: [7, 15, 30],
      daily_summary_to_owner: true,
      low_stock_digest: true,
    })
    expect(DEFAULT_SETTINGS.payments).toEqual({
      intent_expiry_seconds: 600,
      upi_auto_complete: true,
    })
  })
})

describe('resolveSettings / mergeSettings / readSettings', () => {
  it('resolveSettings deep-merges a partial over the defaults', () => {
    const s = resolveSettings({
      invoice: { print_format: 'a4' },
      pos: { scale_barcode: { enabled: true } },
    })
    expect(s.invoice.print_format).toBe('a4')
    expect(s.invoice.bilingual).toBe(true)
    expect(s.pos.scale_barcode).toMatchObject({ enabled: true, item_code_length: 5 })
    expect(resolveSettings()).toEqual(DEFAULT_SETTINGS)
    expect(resolveSettings(null)).toEqual(DEFAULT_SETTINGS)
  })
  it('resolveSettings rejects invalid values', () => {
    expect(() => resolveSettings({ invoice: { copies: 0 } })).toThrow()
    expect(() => resolveSettings({ pos: { scale_barcode: { item_code_length: 7 } } })).toThrow()
    expect(() => resolveSettings({ pharmacy: { require_rx_for_schedules: ['Z'] } })).toThrow()
  })
  it('mergeSettings keeps unrelated fields and replaces arrays', () => {
    const current = resolveSettings({
      invoice: { footer_text: 'Custom', copies: 2 },
      notifications: { due_reminder_days: [3, 10] },
    })
    const next = mergeSettings(current, {
      invoice: { copies: 3 },
      notifications: { due_reminder_days: [30] },
    })
    expect(next.invoice).toMatchObject({ footer_text: 'Custom', copies: 3 })
    expect(next.notifications.due_reminder_days).toEqual([30])
    expect(() => mergeSettings(current, { payments: { intent_expiry_seconds: 5 } })).toThrow()
  })
  it('the PATCH schema never injects defaults', () => {
    expect(TenantSettingsPatchSchema.parse({ invoice: { copies: 2 } })).toEqual({
      invoice: { copies: 2 },
    })
    expect(TenantSettingsPatchSchema.parse({ pos: { scale_barcode: { enabled: true } } })).toEqual({
      pos: { scale_barcode: { enabled: true } },
    })
    expect(TenantSettingsPatchSchema.parse({})).toEqual({})
    expect(TenantSettingsPatchSchema.safeParse({ invoice: { copies: 'two' } }).success).toBe(false)
    expect(TenantSettingsPatchSchema.safeParse({ invoice: { print_format: 'a5' } }).success).toBe(
      false,
    )
    const current = resolveSettings({ invoice: { footer_text: 'Custom' } })
    expect(
      mergeSettings(current, TenantSettingsPatchSchema.parse({ invoice: { copies: 2 } })).invoice
        .footer_text,
    ).toBe('Custom')
  })
  it('readSettings is lenient field by field and never throws', () => {
    const s = readSettings({
      invoice: { copies: 99, bilingual: false, junk: 1 },
      pos: { scale_barcode: { prefixes: ['2x'] }, sound: false },
      unknown_section: {},
    })
    expect(s.invoice.copies).toBe(1)
    expect(s.invoice.bilingual).toBe(false)
    expect(s.pos.scale_barcode).toEqual(DEFAULT_SETTINGS.pos.scale_barcode)
    expect(s.pos.sound).toBe(false)
    expect(Object.keys(s)).toEqual(Object.keys(DEFAULT_SETTINGS))
    for (const junk of [null, undefined, 'x', 42, [], { invoice: 'nope' }])
      expect(readSettings(junk)).toEqual(DEFAULT_SETTINGS)
  })
  it('deepMerge semantics', () => {
    expect(
      deepMerge({ a: { b: 1, c: 2 }, d: [1] }, { a: { b: 3 }, d: [2, 3], e: undefined }),
    ).toEqual({ a: { b: 3, c: 2 }, d: [2, 3] })
    expect(deepMerge({ a: 1 }, undefined)).toEqual({ a: 1 })
  })
})

describe('vertical presets', () => {
  it.each(BusinessTypeSchema.options)('%s preset produces valid settings', (type) => {
    expect(() => initialSettingsFor(type)).not.toThrow()
    expect(TenantSettingsSchema.safeParse(initialSettingsFor(type)).success).toBe(true)
  })
  it('applies vertical behaviour', () => {
    const pharmacy = initialSettingsFor('pharmacy')
    expect(pharmacy.inventory).toMatchObject({
      allow_negative_stock: false,
      block_expired_sale: true,
      fefo: true,
    })
    expect(pharmacy.catalog).toMatchObject({ default_track_batches: true, default_unit: 'TAB' })
    expect(initialSettingsFor('supermarket').pos.scale_barcode.enabled).toBe(true)
    expect(initialSettingsFor('apparel').catalog.variant_axes).toEqual(['size', 'color'])
    expect(initialSettingsFor('electronics').invoice.print_format).toBe('a4')
    expect(settingsPresetFor('other')).toEqual({})
  })
  it('RegisterSettingsSchema defaults', () => {
    expect(RegisterSettingsSchema.parse({})).toEqual({
      print_format: null,
      auto_print: true,
      customer_display: false,
      cash_drawer: false,
      printer_name: null,
      silent_print: false,
      scale: {
        enabled: false,
        baud_rate: 9600,
        data_bits: 8,
        stop_bits: 1,
        parity: 'none',
        flow_control: 'none',
        protocol: 'continuous',
        request_command: null,
        weight_pattern: null,
        weight_unit: 'kg',
        stable_only: true,
      },
    })
  })
  it('RegisterSettingsSchema scale settings', () => {
    const s = RegisterSettingsSchema.parse({
      scale: { enabled: true, baud_rate: 2400, weight_pattern: 'GS,\\s*([0-9.]+)kg' },
    })
    expect(s.scale).toMatchObject({ enabled: true, baud_rate: 2400, protocol: 'continuous' })
    expect(RegisterSettingsSchema.safeParse({ scale: { baud_rate: 1234 } }).success).toBe(false)
    expect(RegisterSettingsSchema.safeParse({ scale: { weight_pattern: '([0-9' } }).success).toBe(
      false,
    )
    expect(DEFAULT_SETTINGS.pos.require_open_shift).toBe(false)
  })
})
