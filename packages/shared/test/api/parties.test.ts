import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  BankDetailsInputSchema,
  CUSTOMER_IMPORT_COLUMNS,
  CustomerCreateSchema,
  CustomerImportSchema,
  CustomerListQuerySchema,
  CustomerLookupQuerySchema,
  CustomerSchema,
  CustomerSummarySchema,
  CustomerUpdateSchema,
  DoctorCreateSchema,
  DoctorSchema,
  LoyaltyAdjustResultSchema,
  LoyaltyAdjustSchema,
  PartyLedgerQuerySchema,
  PartyLedgerSchema,
  SupplierCreateSchema,
  SupplierSchema,
  SupplierUpdateSchema,
  buildLedgerStatement,
  creditCheck,
  customerImportTemplateCsv,
  effectiveCreditDays,
  invoiceDueDate,
  isInvoiceOverdue,
  loyaltyPointsForAmount,
  loyaltyRedeemIssue,
  loyaltyValuePaise,
  maxRedeemablePoints,
  monthlySeries,
  partiesRoutes,
  partyBalanceEffect,
} from '../../src/api/parties'
import { parseCsv } from '../../src/api/identity'
import { makeGstin } from '../../src/gst'
import { newId } from '../../src/ids'
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/settings'

const ok = (schema: z.ZodType, v: unknown) => schema.safeParse(v).success
const messages = (schema: z.ZodType, v: unknown) => {
  const r = schema.safeParse(v)
  return r.success ? [] : r.error.issues.map((i) => i.message)
}
const now = '2026-10-20T10:15:00.000Z'
const KA_GSTIN = makeGstin('29', 'AAAPZ1234C')

describe('customers', () => {
  it('create normalises phone, derives state from the GSTIN and the price tier', () => {
    const c = CustomerCreateSchema.parse({
      name: 'Lakshmi Traders',
      phone: '98765-43210',
      gstin: KA_GSTIN.toLowerCase(),
      customer_type: 'wholesale',
      opening_balance_paise: 125_000,
      tags: ['Wholesale', 'wholesale'],
    })
    expect(c).toMatchObject({
      phone: '+919876543210',
      gstin: KA_GSTIN,
      state_code: '29',
      price_tier: 'wholesale',
      credit_limit_paise: null,
      whatsapp_opt_in: true,
      tags: ['wholesale'],
      address: {},
    })
    const walkIn = CustomerCreateSchema.parse({ name: 'Walk-in Ravi' })
    expect(walkIn).toMatchObject({ price_tier: 'retail', opening_balance_paise: 0 })
    expect(walkIn.phone).toBeUndefined()
  })
  it('create rejects bad phone / GSTIN / state mismatch', () => {
    expect(messages(CustomerCreateSchema, { name: 'x', phone: '12345' })).toEqual(['phone'])
    expect(messages(CustomerCreateSchema, { name: 'x', gstin: '29AAAAA0000A1Z0' })).toEqual([
      'gstin',
    ])
    expect(
      messages(CustomerCreateSchema, { name: 'x', gstin: KA_GSTIN, state_code: '33' }),
    ).toEqual(['gstin_state'])
    expect(messages(CustomerCreateSchema, { name: 'x', alt_phone: 'call me' })).toEqual([
      'alt_phone',
    ])
  })
  it('update keeps omitted fields untouched and derives the state from a new GSTIN', () => {
    expect(CustomerUpdateSchema.parse({ credit_days: 15 })).toEqual({ credit_days: 15 })
    expect(CustomerUpdateSchema.parse({ gstin: KA_GSTIN })).toEqual({
      gstin: KA_GSTIN,
      state_code: '29',
    })
    expect(CustomerUpdateSchema.parse({ phone: '' })).toEqual({ phone: null })
    expect(messages(CustomerUpdateSchema, { if_updated_at: now })).toEqual(['empty_patch'])
  })
  it('list & lookup queries', () => {
    expect(
      CustomerListQuerySchema.parse({ has_due: '1', sort: '-balance_paise', tag: 'VIP' }),
    ).toMatchObject({
      has_due: true,
      tag: 'vip',
      sort: { field: 'balance_paise', direction: 'desc' },
    })
    expect(CustomerLookupQuerySchema.parse({ phone: '09876543210' }).phone).toBe('+919876543210')
    expect(ok(CustomerLookupQuerySchema, { phone: '1234' })).toBe(false)
  })
  it('customer response', () => {
    const c = CustomerSchema.parse({
      id: newId(),
      code: null,
      name: 'Murugan',
      name_ta: 'முருகன்',
      phone: '+919876543210',
      alt_phone: null,
      email: null,
      gstin: null,
      state_code: '33',
      address: { city: 'Madurai' },
      customer_type: 'retail',
      price_tier: 'retail',
      credit_limit_paise: 500_000,
      credit_days: null,
      opening_balance_paise: 125_000,
      balance_paise: -2_000,
      overdue_paise: 0,
      loyalty_points: 120,
      date_of_birth: '1980-06-15',
      anniversary: null,
      notes: null,
      tags: ['regular'],
      whatsapp_opt_in: true,
      is_active: true,
      last_invoice_at: new Date(now),
      created_by: null,
      created_at: now,
      updated_at: now,
    })
    expect(c.last_invoice_at).toBe(now)
  })
})

describe('credit & dues', () => {
  it('effective credit days, due date and overdue', () => {
    expect(effectiveCreditDays(null, DEFAULT_SETTINGS)).toBe(30)
    expect(effectiveCreditDays(7, DEFAULT_SETTINGS)).toBe(7)
    expect(invoiceDueDate('2026-10-01', 30)).toBe('2026-10-31')
    expect(isInvoiceOverdue('2026-10-01', 30, '2026-10-31')).toBe(false)
    expect(isInvoiceOverdue('2026-10-01', 30, '2026-11-01')).toBe(true)
  })
  it('credit check', () => {
    expect(
      creditCheck({ balance_paise: 1000, credit_limit_paise: null, additional_paise: 1e9 }).allowed,
    ).toBe(true)
    expect(
      creditCheck({ balance_paise: 40_000, credit_limit_paise: 50_000, additional_paise: 10_000 }),
    ).toEqual({
      allowed: true,
      available_paise: 10_000,
      exceeded_by_paise: 0,
    })
    expect(
      creditCheck({ balance_paise: 40_000, credit_limit_paise: 50_000, additional_paise: 12_500 }),
    ).toEqual({
      allowed: false,
      available_paise: 10_000,
      exceeded_by_paise: 2_500,
    })
    expect(
      creditCheck({ balance_paise: 60_000, credit_limit_paise: 50_000, additional_paise: 100 })
        .exceeded_by_paise,
    ).toBe(100)
  })
})

describe('ledger statements', () => {
  it('sign conventions', () => {
    expect(partyBalanceEffect('customer', 1000, 0)).toBe(1000)
    expect(partyBalanceEffect('customer', 0, 400)).toBe(-400)
    expect(partyBalanceEffect('supplier', 0, 1000)).toBe(1000)
    expect(partyBalanceEffect('supplier', 300, 0)).toBe(-300)
  })
  it('running balance from an opening window and totals', () => {
    const all = [
      { date: '2026-09-01', debit_paise: 10_000, credit_paise: 0 },
      { date: '2026-09-15', debit_paise: 0, credit_paise: 4_000 },
      { date: '2026-10-02', debit_paise: 5_000, credit_paise: 0 },
      { date: '2026-10-10', debit_paise: 0, credit_paise: 11_000 },
    ]
    const full = buildLedgerStatement('customer', 0, all)
    expect(full.rows.map((r) => r.balance_paise)).toEqual([10_000, 6_000, 11_000, 0])
    // Window from 2026-10-01: opening = balance of everything before.
    const before = all.filter((e) => e.date < '2026-10-01')
    const opening = buildLedgerStatement('customer', 0, before).closing_balance_paise
    const window = buildLedgerStatement(
      'customer',
      opening,
      all.filter((e) => e.date >= '2026-10-01'),
    )
    expect(opening).toBe(6_000)
    expect(window.rows.map((r) => r.balance_paise)).toEqual([11_000, 0])
    expect(window).toMatchObject({
      total_debit_paise: 5_000,
      total_credit_paise: 11_000,
      closing_balance_paise: 0,
    })
    expect(window.closing_balance_paise).toBe(full.closing_balance_paise)
    const supplier = buildLedgerStatement('supplier', 2_000, [
      { debit_paise: 0, credit_paise: 8_000 },
    ])
    expect(supplier.closing_balance_paise).toBe(10_000)
  })
  it('statement response and query', () => {
    expect(PartyLedgerQuerySchema.parse({ from: '2026-10-01' })).toMatchObject({ format: 'json' })
    expect(messages(PartyLedgerQuerySchema, { from: '2026-10-02', to: '2026-10-01' })).toEqual([
      'date_order',
    ])
    const id = newId()
    expect(
      PartyLedgerSchema.parse({
        party: { type: 'customer', id, name: 'Murugan', name_ta: null, phone: '+919876543210' },
        from: '2026-10-01',
        to: '2026-10-31',
        opening_balance_paise: 6_000,
        total_debit_paise: 5_000,
        total_credit_paise: 11_000,
        closing_balance_paise: 0,
        rows: [
          {
            entry_id: newId(),
            date: '2026-10-02',
            source_type: 'sales_invoice',
            source_id: newId(),
            document_number: 'S1-A/2627/00042',
            description: null,
            debit_paise: 5_000,
            credit_paise: 0,
            balance_paise: 11_000,
          },
        ],
        truncated: false,
      }).rows[0]!.document_number,
    ).toBe('S1-A/2627/00042')
  })
})

describe('summary', () => {
  it('zero-filled monthly series', () => {
    const series = monthlySeries(
      [{ period: '2026-09', sales_paise: 500, invoice_count: 2 }],
      '2026-10',
      3,
    )
    expect(series).toEqual([
      { period: '2026-08', sales_paise: 0, invoice_count: 0 },
      { period: '2026-09', sales_paise: 500, invoice_count: 2 },
      { period: '2026-10', sales_paise: 0, invoice_count: 0 },
    ])
    expect(monthlySeries([], '2026-02', 12)[0]!.period).toBe('2025-03')
  })
  it('summary response', () => {
    expect(
      CustomerSummarySchema.parse({
        customer_id: newId(),
        lifetime_sales_paise: 1_000_000,
        invoice_count: 40,
        returns_paise: 5_000,
        average_bill_paise: 25_000,
        first_invoice_at: now,
        last_invoice_at: now,
        monthly: monthlySeries([], '2026-10'),
        top_items: [
          {
            product_id: newId(),
            name: 'Ponni Rice',
            name_ta: null,
            unit: 'KG',
            qty_milli: 25_000,
            amount_paise: 170_000,
            invoice_count: 5,
          },
        ],
        balance_paise: 12_000,
        overdue_paise: 2_000,
        overdue_invoice_count: 1,
        oldest_due_date: '2026-08-01',
        credit_limit_paise: null,
        credit_available_paise: null,
        credit_days: 30,
        loyalty_points: 120,
        loyalty_value_paise: 12_000,
        open_payment_links: [
          {
            id: newId(),
            amount_paise: 12_000,
            status: 'pending',
            short_url: 'https://rzp.io/i/x',
            reference_code: 'KD1234567890',
            created_at: now,
            expires_at: null,
          },
        ],
      }).monthly,
    ).toHaveLength(12)
  })
})

describe('loyalty maths', () => {
  const enabled = mergeSettings(DEFAULT_SETTINGS, {
    loyalty: {
      enabled: true,
      points_per_100_rupees: 2,
      point_value_paise: 50,
      min_redeem_points: 20,
    },
  }).loyalty
  it('earning floors to whole points and is off when disabled', () => {
    expect(loyaltyPointsForAmount(123_456, enabled)).toBe(24)
    expect(loyaltyPointsForAmount(4_999, enabled)).toBe(0)
    expect(loyaltyPointsForAmount(-500, enabled)).toBe(0)
    expect(loyaltyPointsForAmount(1_000_000, DEFAULT_SETTINGS.loyalty)).toBe(0)
  })
  it('value and redeemable maximum', () => {
    expect(loyaltyValuePaise(100, enabled)).toBe(5_000)
    expect(
      maxRedeemablePoints({ balance_points: 500, bill_total_paise: 6_025, settings: enabled }),
    ).toBe(120)
    expect(
      maxRedeemablePoints({ balance_points: 15, bill_total_paise: 100_000, settings: enabled }),
    ).toBe(0)
    expect(
      maxRedeemablePoints({
        balance_points: 500,
        bill_total_paise: 100_000,
        settings: DEFAULT_SETTINGS.loyalty,
      }),
    ).toBe(0)
  })
  it('redeem validation keys', () => {
    const base = { balance_points: 100, settings: enabled }
    expect(loyaltyRedeemIssue({ ...base, points: 50, bill_total_paise: 10_000 })).toBeNull()
    expect(loyaltyRedeemIssue({ ...base, points: 10 })).toBe('loyalty_below_minimum')
    expect(loyaltyRedeemIssue({ ...base, points: 150 })).toBe('loyalty_insufficient')
    expect(loyaltyRedeemIssue({ ...base, points: 60, bill_total_paise: 2_000 })).toBe(
      'loyalty_exceeds_bill',
    )
    expect(loyaltyRedeemIssue({ ...base, points: 0 })).toBe('loyalty_points_zero')
    expect(loyaltyRedeemIssue({ ...base, points: 50, settings: DEFAULT_SETTINGS.loyalty })).toBe(
      'loyalty_disabled',
    )
  })
  it('adjust body and result', () => {
    expect(messages(LoyaltyAdjustSchema, { points: 0, notes: 'x' })).toEqual([
      'loyalty_points_zero',
    ])
    expect(ok(LoyaltyAdjustSchema, { points: -20, notes: '' })).toBe(false)
    const customerId = newId()
    expect(
      LoyaltyAdjustResultSchema.parse({
        customer_id: customerId,
        loyalty_points: 80,
        entry: {
          id: newId(),
          customer_id: customerId,
          points: -20,
          kind: 'adjust',
          ref_type: null,
          ref_id: null,
          ref_number: null,
          notes: 'Correction',
          created_by: newId(),
          created_by_name: 'Owner',
          created_at: now,
          balance_after: 80,
        },
      }).entry.kind,
    ).toBe('adjust')
  })
})

describe('suppliers', () => {
  it('bank details never keep the full account number', () => {
    const parsed = BankDetailsInputSchema.parse({
      account_name: 'Sri Balaji Agencies',
      account_number: '1234 5678 9012',
      ifsc: 'sbin0001234',
    })
    expect(parsed).toEqual({
      account_name: 'Sri Balaji Agencies',
      account_no_last4: '9012',
      ifsc: 'SBIN0001234',
    })
    expect(JSON.stringify(parsed)).not.toContain('123456789012')
    expect(BankDetailsInputSchema.parse({ bank_name: 'SBI' })).toEqual({ bank_name: 'SBI' })
    expect(BankDetailsInputSchema.parse({ account_number: null })).toEqual({
      account_no_last4: null,
    })
    expect(messages(BankDetailsInputSchema, { ifsc: 'SBIN1234' })).toEqual(['ifsc'])
    expect(messages(BankDetailsInputSchema, { account_number: '12ab' })).toEqual([
      'bank_account_number',
    ])
    expect(ok(BankDetailsInputSchema, { account_no: '123456789012' })).toBe(false)
  })
  it('create / update', () => {
    const s = SupplierCreateSchema.parse({
      name: 'Sri Balaji Pharma Distributors',
      gstin: KA_GSTIN,
      pan: 'aaapz1234c',
      upi_vpa: ' Balaji@OKSBI ',
      drug_license_no: 'TN-MDU-20B-1234',
      bank_details: { account_number: '000111222333', ifsc: 'HDFC0000123' },
    })
    expect(s).toMatchObject({
      state_code: '29',
      pan: 'AAAPZ1234C',
      upi_vpa: 'balaji@oksbi',
      bank_details: { account_no_last4: '2333', ifsc: 'HDFC0000123' },
      payment_terms_days: null,
      opening_balance_paise: 0,
    })
    expect(messages(SupplierCreateSchema, { name: 'x', upi_vpa: 'not a vpa' })).toEqual(['vpa'])
    expect(
      messages(SupplierCreateSchema, { name: 'x', gstin: KA_GSTIN, pan: 'AAAPZ9999C' }),
    ).toEqual(['pan_gstin_mismatch'])
    expect(SupplierUpdateSchema.parse({ upi_vpa: '' })).toEqual({ upi_vpa: null })
    expect(SupplierUpdateSchema.parse({ payment_terms_days: 45 })).toEqual({
      payment_terms_days: 45,
    })
  })
  it('supplier response sanitises bank details', () => {
    const s = SupplierSchema.parse({
      id: newId(),
      code: null,
      name: 'Balaji',
      contact_person: null,
      phone: null,
      email: null,
      gstin: null,
      pan: null,
      state_code: '33',
      address: {},
      drug_license_no: null,
      payment_terms_days: 30,
      opening_balance_paise: 0,
      balance_paise: 45_000,
      overdue_paise: 0,
      bank_details: {
        account_no_last4: '2333',
        ifsc: 'HDFC0000123',
        account_number: '000111222333',
      },
      upi_vpa: null,
      notes: null,
      is_active: true,
      last_bill_date: '2026-10-18',
      created_by: null,
      created_at: now,
      updated_at: now,
    })
    expect(s.bank_details).toEqual({
      account_name: null,
      account_no_last4: '2333',
      ifsc: 'HDFC0000123',
      bank_name: null,
    })
  })
})

describe('doctors, import, routes', () => {
  it('doctor schemas', () => {
    expect(
      DoctorCreateSchema.parse({ name: 'Dr. Kavitha', registration_no: 'TNMC 12345' }),
    ).toMatchObject({
      address: {},
      registration_no: 'TNMC 12345',
    })
    expect(
      DoctorSchema.parse({
        id: newId(),
        name: 'Dr. Kavitha',
        registration_no: 'TNMC 12345',
        qualification: 'MBBS',
        phone: null,
        clinic_name: 'Kavitha Clinic',
        address: {},
        is_active: true,
        created_at: now,
        updated_at: now,
      }).clinic_name,
    ).toBe('Kavitha Clinic')
  })
  it('customer import template and body', () => {
    const [header] = parseCsv(customerImportTemplateCsv())
    expect(header).toEqual(CUSTOMER_IMPORT_COLUMNS.map((c) => c.key))
    expect(CUSTOMER_IMPORT_COLUMNS.filter((c) => c.required).map((c) => c.key)).toEqual(['name'])
    expect(CustomerImportSchema.parse({ file_id: newId() })).toMatchObject({
      match_by: 'phone',
      dry_run: true,
    })
  })
  it('route catalogue', () => {
    for (const [name, def] of Object.entries(partiesRoutes)) {
      expect(def.path.startsWith('/'), name).toBe(true)
      if (def.method === 'GET') expect('body' in def, name).toBe(false)
    }
    expect(partiesRoutes.adjustLoyalty.feature).toBe('loyalty')
    expect(partiesRoutes.createCustomer.idempotent).toBe(true)
    expect(partiesRoutes.supplierLedger.permission).toBe('suppliers.read')
  })
})
