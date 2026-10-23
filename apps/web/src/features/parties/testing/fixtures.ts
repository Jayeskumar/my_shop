/**
 * Contract-shaped fixtures for the parties screens (Vitest + MSW tests and the dev screenshot
 * harness). Imports only @kadai/shared so it also runs outside Vite; every factory returns data
 * that parses with the response schemas of the contracts (checked in fixtures.test.ts).
 */
import type { ShiftDetail } from '@kadai/shared/api/accounting'
import type { ImportJob } from '@kadai/shared/api/identity'
import type {
  Customer,
  CustomerListItem,
  CustomerSummary,
  Doctor,
  LoyaltyEntry,
  PartyLedger,
  Supplier,
  SupplierListItem,
} from '@kadai/shared/api/parties'
import type { OpenItemsResponse, Payment, PaymentListResponse } from '@kadai/shared/api/payments'
import type {
  PurchaseBillListResponseSchema,
  PurchaseBillListRow,
} from '@kadai/shared/api/purchases'
import type { InvoiceListResponse, SalesInvoiceListRow } from '@kadai/shared/api/sales'
import { makeGstin } from '@kadai/shared/gst'
import type { z } from 'zod'

type PurchaseBillListResponse = z.output<typeof PurchaseBillListResponseSchema>

export const NOW = '2026-10-20T10:00:00.000Z'
export const TODAY = '2026-10-20'
export const STORE_ID = '0192f0a0-0000-7000-8000-000000000301'
const USER_ID = '0192f0a0-0000-7000-8000-000000000001'
/** Counter A of the test store (src/test/fixtures IDS.register). */
export const REGISTER_ID = '0192f0a0-0000-7000-8000-000000000401'

let seq = 0
/** Deterministic UUID v7-shaped ids. */
export function pid(n?: number): string {
  const v = n ?? ++seq + 5000
  return `0192f0a0-0000-7000-8000-${String(v).padStart(12, '0')}`
}

export const page = (total: number, limit = 50, offset = 0) => ({ limit, offset, total })

export function customerListItem(over: Partial<CustomerListItem> = {}): CustomerListItem {
  return {
    id: pid(),
    code: null,
    name: 'Lakshmi',
    name_ta: 'லட்சுமி',
    phone: '+919876543210',
    gstin: null,
    state_code: '33',
    customer_type: 'retail',
    price_tier: 'retail',
    balance_paise: 0,
    credit_limit_paise: null,
    credit_days: null,
    overdue_paise: 0,
    loyalty_points: 0,
    tags: [],
    whatsapp_opt_in: true,
    is_active: true,
    last_invoice_at: '2026-10-19T12:30:00.000Z',
    created_at: '2026-01-05T09:00:00.000Z',
    updated_at: NOW,
    ...over,
  }
}

export function customer(over: Partial<Customer> = {}): Customer {
  return {
    ...customerListItem(),
    alt_phone: null,
    email: null,
    address: {
      line1: '12, East Masi Street',
      line2: undefined,
      city: 'Madurai',
      district: 'Madurai',
      state_code: '33',
      pincode: '625001',
    },
    opening_balance_paise: 0,
    date_of_birth: null,
    anniversary: null,
    notes: null,
    created_by: USER_ID,
    ...over,
  }
}

/** A small, realistic customer book for list screens. */
export function customerBook(): CustomerListItem[] {
  return [
    customerListItem({
      id: pid(101),
      name: 'Murugan K',
      name_ta: 'முருகன்',
      phone: '+919843012345',
      balance_paise: 245_000,
      overdue_paise: 120_000,
      credit_limit_paise: 500_000,
      loyalty_points: 340,
      tags: ['regular', 'street-3'],
      last_invoice_at: '2026-10-20T08:15:00.000Z',
    }),
    customerListItem({
      id: pid(102),
      name: 'Selvi R',
      name_ta: 'செல்வி',
      phone: '+919790011223',
      balance_paise: -30_000,
      tags: ['monthly'],
      last_invoice_at: '2026-10-12T17:40:00.000Z',
    }),
    customerListItem({
      id: pid(103),
      name: 'Anand Traders',
      name_ta: 'ஆனந்த் டிரேடர்ஸ்',
      phone: '+919944556677',
      gstin: makeGstin('33', 'AABCA1234F'),
      customer_type: 'wholesale',
      price_tier: 'wholesale',
      balance_paise: 1_875_050,
      credit_limit_paise: 2_000_000,
      credit_days: 15,
      overdue_paise: 0,
      tags: ['wholesale'],
      last_invoice_at: '2026-10-18T11:05:00.000Z',
    }),
    customerListItem({
      id: pid(104),
      name: 'Fathima Begum',
      name_ta: 'ஃபாத்திமா பேகம்',
      phone: '+919500123456',
      balance_paise: 0,
      loyalty_points: 120,
      last_invoice_at: '2026-09-02T10:00:00.000Z',
    }),
    customerListItem({
      id: pid(105),
      name: 'Ravi Chandran',
      name_ta: 'ரவிச்சந்திரன்',
      phone: null,
      balance_paise: 52_500,
      overdue_paise: 52_500,
      tags: ['nearby'],
      last_invoice_at: null,
      whatsapp_opt_in: false,
    }),
  ]
}

export function customerSummary(over: Partial<CustomerSummary> = {}): CustomerSummary {
  const periods = [
    '2025-11',
    '2025-12',
    '2026-01',
    '2026-02',
    '2026-03',
    '2026-04',
    '2026-05',
    '2026-06',
    '2026-07',
    '2026-08',
    '2026-09',
    '2026-10',
  ]
  const sales = [120, 180, 90, 210, 160, 240, 200, 150, 260, 220, 300, 180]
  return {
    customer_id: pid(101),
    lifetime_sales_paise: 4_825_000,
    invoice_count: 96,
    returns_paise: 35_000,
    average_bill_paise: 50_260,
    first_invoice_at: '2025-11-03T09:10:00.000Z',
    last_invoice_at: '2026-10-20T08:15:00.000Z',
    monthly: periods.map((period, i) => ({
      period,
      sales_paise: (sales[i] ?? 0) * 1_000,
      invoice_count: Math.round((sales[i] ?? 0) / 25),
    })),
    top_items: [
      {
        product_id: pid(901),
        name: 'Ponni Rice 5 kg',
        name_ta: 'பொன்னி அரிசி 5 கிலோ',
        unit: 'PCS',
        qty_milli: 24_000,
        amount_paise: 960_000,
        invoice_count: 22,
      },
      {
        product_id: pid(902),
        name: 'Toor Dal',
        name_ta: 'துவரம் பருப்பு',
        unit: 'KG',
        qty_milli: 18_500,
        amount_paise: 296_000,
        invoice_count: 18,
      },
      {
        product_id: pid(903),
        name: 'Groundnut Oil 1 L',
        name_ta: 'கடலை எண்ணெய் 1 லி',
        unit: 'PCS',
        qty_milli: 15_000,
        amount_paise: 285_000,
        invoice_count: 15,
      },
    ],
    balance_paise: 245_000,
    overdue_paise: 120_000,
    overdue_invoice_count: 2,
    oldest_due_date: '2026-09-04',
    credit_limit_paise: 500_000,
    credit_available_paise: 255_000,
    credit_days: 30,
    loyalty_points: 340,
    loyalty_value_paise: 34_000,
    open_payment_links: [
      {
        id: pid(950),
        amount_paise: 120_000,
        status: 'pending',
        short_url: 'https://kadai.example/pay/KD7Q2M9X4B1Z',
        reference_code: 'KD7Q2M9X4B1Z',
        created_at: '2026-10-15T10:00:00.000Z',
        expires_at: '2026-10-22T10:00:00.000Z',
      },
    ],
    ...over,
  }
}

export function customerLedger(over: Partial<PartyLedger> = {}): PartyLedger {
  const rows = [
    {
      date: '2026-04-01',
      source_type: 'opening' as const,
      document_number: null,
      description: 'Old notebook balance',
      debit_paise: 50_000,
      credit_paise: 0,
    },
    {
      date: '2026-09-04',
      source_type: 'sales_invoice' as const,
      document_number: 'S1-A/2627/00412',
      description: null,
      debit_paise: 82_000,
      credit_paise: 0,
    },
    {
      date: '2026-09-18',
      source_type: 'sales_invoice' as const,
      document_number: 'S1-A/2627/00577',
      description: null,
      debit_paise: 38_000,
      credit_paise: 0,
    },
    {
      date: '2026-09-30',
      source_type: 'payment' as const,
      document_number: 'RC/2627/00088',
      description: 'UPI 6281…',
      debit_paise: 0,
      credit_paise: 50_000,
    },
    {
      date: '2026-10-08',
      source_type: 'credit_note' as const,
      document_number: 'CN/2627/00009',
      description: 'Damaged packet returned',
      debit_paise: 0,
      credit_paise: 5_000,
    },
    {
      date: '2026-10-20',
      source_type: 'sales_invoice' as const,
      document_number: 'S1-A/2627/00981',
      description: null,
      debit_paise: 130_000,
      credit_paise: 0,
    },
  ]
  let balance = 0
  const built = rows.map((r, i) => {
    balance += r.debit_paise - r.credit_paise
    return { entry_id: pid(700 + i), source_id: pid(800 + i), ...r, balance_paise: balance }
  })
  return {
    party: {
      type: 'customer',
      id: pid(101),
      name: 'Murugan K',
      name_ta: 'முருகன்',
      phone: '+919843012345',
    },
    from: null,
    to: TODAY,
    opening_balance_paise: 0,
    total_debit_paise: rows.reduce((s, r) => s + r.debit_paise, 0),
    total_credit_paise: rows.reduce((s, r) => s + r.credit_paise, 0),
    closing_balance_paise: balance,
    rows: built,
    truncated: false,
    ...over,
  }
}

export function loyaltyEntries(): LoyaltyEntry[] {
  return [
    {
      id: pid(601),
      customer_id: pid(101),
      points: 13,
      kind: 'earn',
      ref_type: 'sales_invoice',
      ref_id: pid(805),
      ref_number: 'S1-A/2627/00981',
      notes: null,
      created_by: USER_ID,
      created_by_name: 'Murugan K',
      created_at: '2026-10-20T08:15:00.000Z',
      balance_after: 340,
    },
    {
      id: pid(602),
      customer_id: pid(101),
      points: -100,
      kind: 'redeem',
      ref_type: 'sales_invoice',
      ref_id: pid(802),
      ref_number: 'S1-A/2627/00577',
      notes: null,
      created_by: USER_ID,
      created_by_name: 'Murugan K',
      created_at: '2026-09-18T18:00:00.000Z',
      balance_after: 327,
    },
    {
      id: pid(603),
      customer_id: pid(101),
      points: 50,
      kind: 'adjust',
      ref_type: null,
      ref_id: null,
      ref_number: null,
      notes: 'Deepavali gift',
      created_by: USER_ID,
      created_by_name: 'Murugan K',
      created_at: '2026-09-10T11:00:00.000Z',
      balance_after: 427,
    },
  ]
}

function invoiceRow(over: Partial<SalesInvoiceListRow>): SalesInvoiceListRow {
  return {
    id: pid(),
    doc_type: 'tax_invoice',
    number: 'S1-A/2627/00981',
    fy: '2026-27',
    invoice_date: TODAY,
    invoice_at: NOW,
    status: 'completed',
    channel: 'pos',
    store_id: STORE_ID,
    store_code: 'S1',
    register_id: null,
    register_code: 'A',
    customer_id: pid(101),
    customer_name: 'Murugan K',
    customer_phone: '+919843012345',
    item_count: 6,
    total_paise: 130_000,
    paid_paise: 0,
    returned_paise: 0,
    due_paise: 130_000,
    payment_status: 'unpaid',
    due_date: '2026-11-19',
    created_by: USER_ID,
    created_by_name: 'Murugan K',
    offline: false,
    client_ref: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  }
}

export function invoiceList(): InvoiceListResponse {
  const rows = [
    invoiceRow({ id: pid(805) }),
    invoiceRow({
      id: pid(802),
      number: 'S1-A/2627/00577',
      invoice_date: '2026-09-18',
      total_paise: 38_000,
      paid_paise: 0,
      due_paise: 38_000,
      due_date: '2026-10-18',
    }),
    invoiceRow({
      id: pid(801),
      number: 'S1-A/2627/00412',
      invoice_date: '2026-09-04',
      total_paise: 82_000,
      paid_paise: 50_000,
      due_paise: 32_000,
      payment_status: 'partial',
      due_date: '2026-10-04',
    }),
    invoiceRow({
      id: pid(810),
      number: 'S1-A/2627/00350',
      invoice_date: '2026-08-28',
      total_paise: 45_500,
      paid_paise: 45_500,
      due_paise: 0,
      payment_status: 'paid',
      due_date: null,
    }),
  ]
  return {
    data: rows,
    page: page(rows.length, 20),
    summary: {
      count: 4,
      total_paise: 295_500,
      paid_paise: 95_500,
      due_paise: 200_000,
      returned_paise: 5_000,
      taxable_paise: 281_400,
      tax_paise: 14_100,
    },
  }
}

function paymentRow(over: Partial<Payment>): Payment {
  return {
    id: pid(),
    store_id: STORE_ID,
    register_id: null,
    shift_id: null,
    number: 'RC/2627/00088',
    fy: '2026-27',
    direction: 'in',
    party_type: 'customer',
    party_id: pid(101),
    party_name: 'Murugan K',
    method: 'upi',
    amount_paise: 50_000,
    allocated_paise: 50_000,
    unallocated_paise: 0,
    status: 'completed',
    payment_date: '2026-09-30',
    paid_at: '2026-09-30T12:00:00.000Z',
    reference: '628194773311',
    payment_intent_id: null,
    account_id: pid(990),
    account_name: 'Bank — UPI',
    notes: null,
    client_ref: null,
    origin: 'manual',
    created_by: USER_ID,
    created_by_name: 'Murugan K',
    created_at: '2026-09-30T12:00:00.000Z',
    cancelled_at: null,
    cancel_reason: null,
    ...over,
  }
}

export function paymentList(partyType: 'customer' | 'supplier' = 'customer'): PaymentListResponse {
  const rows =
    partyType === 'customer'
      ? [
          paymentRow({ id: pid(840) }),
          paymentRow({
            id: pid(841),
            number: 'RC/2627/00041',
            method: 'cash',
            amount_paise: 30_000,
            allocated_paise: 20_000,
            unallocated_paise: 10_000,
            payment_date: '2026-08-30',
            reference: null,
          }),
        ]
      : [
          paymentRow({
            id: pid(842),
            number: 'PV/2627/00015',
            direction: 'out',
            party_type: 'supplier',
            party_id: pid(201),
            party_name: 'Sri Lakshmi Traders',
            method: 'bank_transfer',
            amount_paise: 1_500_000,
            allocated_paise: 1_500_000,
            reference: 'NEFT 88123',
            payment_date: '2026-10-02',
          }),
        ]
  const total = rows.reduce((s, r) => s + r.amount_paise, 0)
  return {
    data: rows,
    page: page(rows.length, 20),
    summary: {
      count: rows.length,
      in_paise: partyType === 'customer' ? total : 0,
      out_paise: partyType === 'customer' ? 0 : total,
      net_paise: partyType === 'customer' ? total : -total,
      by_method: [],
    },
  }
}

export function openItems(partyType: 'customer' | 'supplier' = 'customer'): OpenItemsResponse {
  if (partyType === 'supplier') {
    return {
      party: {
        type: 'supplier',
        id: pid(201),
        name: 'Sri Lakshmi Traders',
        balance_paise: 2_350_000,
        store_credit_paise: null,
      },
      direction: 'out',
      items: [
        {
          target_type: 'purchase_bill',
          target_id: pid(860),
          number: 'SLT/1182',
          date: '2026-09-10',
          due_date: '2026-10-10',
          total_paise: 1_250_000,
          due_paise: 1_250_000,
          days_overdue: 10,
          store_id: STORE_ID,
        },
        {
          target_type: 'purchase_bill',
          target_id: pid(861),
          number: 'SLT/1240',
          date: '2026-10-05',
          due_date: '2026-11-04',
          total_paise: 1_100_000,
          due_paise: 1_100_000,
          days_overdue: null,
          store_id: STORE_ID,
        },
      ],
      total_due_paise: 2_350_000,
    }
  }
  return {
    party: {
      type: 'customer',
      id: pid(101),
      name: 'Murugan K',
      balance_paise: 245_000,
      store_credit_paise: 0,
    },
    direction: 'in',
    items: [
      {
        target_type: 'opening_balance',
        target_id: pid(101),
        number: null,
        date: '2026-04-01',
        due_date: null,
        total_paise: 50_000,
        due_paise: 45_000,
        days_overdue: null,
        store_id: null,
      },
      {
        target_type: 'sales_invoice',
        target_id: pid(801),
        number: 'S1-A/2627/00412',
        date: '2026-09-04',
        due_date: '2026-10-04',
        total_paise: 82_000,
        due_paise: 32_000,
        days_overdue: 16,
        store_id: STORE_ID,
      },
      {
        target_type: 'sales_invoice',
        target_id: pid(802),
        number: 'S1-A/2627/00577',
        date: '2026-09-18',
        due_date: '2026-10-18',
        total_paise: 38_000,
        due_paise: 38_000,
        days_overdue: 2,
        store_id: STORE_ID,
      },
      {
        target_type: 'sales_invoice',
        target_id: pid(805),
        number: 'S1-A/2627/00981',
        date: TODAY,
        due_date: '2026-11-19',
        total_paise: 130_000,
        due_paise: 130_000,
        days_overdue: null,
        store_id: STORE_ID,
      },
    ],
    total_due_paise: 245_000,
  }
}

export function supplierListItem(over: Partial<SupplierListItem> = {}): SupplierListItem {
  return {
    id: pid(),
    code: null,
    name: 'Sri Lakshmi Traders',
    contact_person: 'Ganesan',
    phone: '+919842233445',
    gstin: makeGstin('33', 'AAFFS1234K'),
    state_code: '33',
    drug_license_no: null,
    payment_terms_days: 30,
    balance_paise: 0,
    overdue_paise: 0,
    upi_vpa: null,
    is_active: true,
    last_bill_date: '2026-10-05',
    created_at: '2026-02-01T09:00:00.000Z',
    updated_at: NOW,
    ...over,
  }
}

export function supplierBook(): SupplierListItem[] {
  return [
    supplierListItem({
      id: pid(201),
      balance_paise: 2_350_000,
      overdue_paise: 1_250_000,
      upi_vpa: 'srilakshmi@okaxis',
    }),
    supplierListItem({
      id: pid(202),
      name: 'Madurai Oil Mills',
      contact_person: 'Pandian',
      phone: '+919787654321',
      gstin: makeGstin('33', 'AAGCM5678L'),
      balance_paise: 480_000,
      payment_terms_days: 15,
      last_bill_date: '2026-10-14',
    }),
    supplierListItem({
      id: pid(203),
      name: 'Kumar Agencies',
      contact_person: null,
      phone: '+919600112233',
      gstin: null,
      balance_paise: -25_000,
      payment_terms_days: null,
      last_bill_date: '2026-07-21',
    }),
  ]
}

export function supplier(over: Partial<Supplier> = {}): Supplier {
  return {
    ...supplierBook()[0]!,
    email: 'accounts@srilakshmi.example',
    pan: 'AAFFS1234K',
    address: {
      line1: '45, North Veli Street',
      line2: undefined,
      city: 'Madurai',
      district: 'Madurai',
      state_code: '33',
      pincode: '625001',
    },
    opening_balance_paise: 0,
    bank_details: {
      account_name: 'Sri Lakshmi Traders',
      account_no_last4: '4321',
      ifsc: 'IOBA0001234',
      bank_name: 'Indian Overseas Bank, Madurai',
    },
    notes: null,
    created_by: USER_ID,
    ...over,
  }
}

export function supplierLedger(): PartyLedger {
  const rows = [
    {
      date: '2026-09-10',
      source_type: 'purchase_bill' as const,
      document_number: 'SLT/1182',
      description: null,
      debit_paise: 0,
      credit_paise: 1_250_000,
    },
    {
      date: '2026-10-02',
      source_type: 'payment' as const,
      document_number: 'PV/2627/00015',
      description: 'NEFT 88123',
      debit_paise: 1_500_000,
      credit_paise: 0,
    },
    {
      date: '2026-10-05',
      source_type: 'purchase_bill' as const,
      document_number: 'SLT/1240',
      description: null,
      debit_paise: 0,
      credit_paise: 1_100_000,
    },
  ]
  let balance = 1_500_000
  const built = rows.map((r, i) => {
    balance += r.credit_paise - r.debit_paise
    return { entry_id: pid(720 + i), source_id: pid(820 + i), ...r, balance_paise: balance }
  })
  return {
    party: {
      type: 'supplier',
      id: pid(201),
      name: 'Sri Lakshmi Traders',
      name_ta: null,
      phone: '+919842233445',
    },
    from: '2026-09-01',
    to: TODAY,
    opening_balance_paise: 1_500_000,
    total_debit_paise: 1_500_000,
    total_credit_paise: 2_350_000,
    closing_balance_paise: balance,
    rows: built,
    truncated: false,
  }
}

function billRow(over: Partial<PurchaseBillListRow>): PurchaseBillListRow {
  return {
    id: pid(),
    number: 'GRN/2627/00031',
    fy: '2026-27',
    status: 'posted',
    store_id: STORE_ID,
    supplier_id: pid(201),
    supplier_name: 'Sri Lakshmi Traders',
    supplier_invoice_no: 'SLT/1240',
    supplier_invoice_date: '2026-10-05',
    received_date: '2026-10-05',
    due_date: '2026-11-04',
    purchase_order_id: null,
    purchase_order_number: null,
    line_count: 12,
    taxable_paise: 1_047_620,
    tax_paise: 52_380,
    total_paise: 1_100_000,
    paid_paise: 0,
    returned_paise: 0,
    due_paise: 1_100_000,
    payment_status: 'unpaid',
    overdue: false,
    days_overdue: null,
    posted_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  }
}

export function billList(): PurchaseBillListResponse {
  const rows = [
    billRow({ id: pid(861) }),
    billRow({
      id: pid(860),
      number: 'GRN/2627/00019',
      supplier_invoice_no: 'SLT/1182',
      supplier_invoice_date: '2026-09-10',
      received_date: '2026-09-10',
      due_date: '2026-10-10',
      total_paise: 1_250_000,
      due_paise: 1_250_000,
      overdue: true,
      days_overdue: 10,
    }),
  ]
  return {
    data: rows,
    page: page(rows.length, 20),
    summary: {
      count: 2,
      total_paise: 2_350_000,
      paid_paise: 0,
      due_paise: 2_350_000,
      overdue_paise: 1_250_000,
    },
  }
}

export function doctor(over: Partial<Doctor> = {}): Doctor {
  return {
    id: pid(),
    name: 'Dr. S. Kumar',
    registration_no: 'TNMC 45872',
    qualification: 'MBBS, MD',
    phone: '+919443322110',
    clinic_name: 'Kumar Clinic',
    address: {
      line1: '8, Bypass Road',
      line2: undefined,
      city: 'Madurai',
      district: 'Madurai',
      state_code: '33',
      pincode: undefined,
    },
    is_active: true,
    created_at: '2026-03-01T09:00:00.000Z',
    updated_at: NOW,
    ...over,
  }
}

export function importJob(over: Partial<ImportJob> = {}): ImportJob {
  return {
    id: pid(980),
    kind: 'customers',
    status: 'completed',
    file_id: pid(981),
    filename: 'customers.csv',
    store_id: null,
    mode: 'upsert',
    dry_run: true,
    options: { match_by: 'phone' },
    total_rows: 3,
    success_rows: 2,
    error_rows: 1,
    progress_bp: 10_000,
    errors: [{ row: 4, field: 'phone', code: 'phone', message: 'Invalid phone' }],
    errors_truncated: false,
    summary: { created: 1, updated: 1, unchanged: 0, skipped: 1, details: {} },
    preview: [
      { row: 2, action: 'create', key: '+919876500001', name: 'Kannan' },
      { row: 3, action: 'update', key: '+919843012345', name: 'Murugan K' },
      { row: 4, action: 'error', key: '12345', name: 'Bad Phone' },
    ],
    created_by: USER_ID,
    created_at: NOW,
    updated_at: NOW,
    finished_at: NOW,
    ...over,
  }
}

/** GET /shifts/current: an open shift of Counter A (accounting contract ShiftDetail). */
export function openShift(over: Partial<ShiftDetail> = {}): ShiftDetail {
  return {
    id: pid(990),
    store_id: STORE_ID,
    store_name: 'Main store',
    register_id: REGISTER_ID,
    register_code: 'A',
    register_name: 'Counter A',
    status: 'open',
    opened_by: USER_ID,
    opened_by_name: 'Selvi',
    opened_at: NOW,
    opening_cash_paise: 200_000,
    closed_by: null,
    closed_by_name: null,
    closed_at: null,
    expected_cash_paise: null,
    counted_cash_paise: null,
    difference_paise: null,
    difference_status: null,
    bills_count: null,
    sales_total_paise: null,
    notes: null,
    created_at: NOW,
    updated_at: NOW,
    denominations: null,
    summary: {
      version: 1,
      report: 'X',
      generated_at: NOW,
      from: NOW,
      to: NOW,
      bills: {
        count: 0,
        gross_paise: 0,
        discount_paise: 0,
        taxable_paise: 0,
        tax_paise: 0,
        round_off_paise: 0,
        total_paise: 0,
        avg_bill_paise: 0,
        item_lines: 0,
        credit_paise: 0,
      },
      payments_in: [],
      payments_out: [],
      dues_collected_paise: 0,
      returns: { count: 0, total_paise: 0 },
      cancelled_bills: { count: 0, total_paise: 0, items: [] },
      discounts: { item_paise: 0, bill_paise: 0, total_paise: 0 },
      top_items: [],
      expenses: { count: 0, cash_paise: 0 },
      cash: {
        opening_cash_paise: 200_000,
        cash_receipts_paise: 0,
        cash_payments_paise: 0,
        pay_ins_paise: 0,
        pay_outs_paise: 0,
        cash_expenses_paise: 0,
        expected_cash_paise: 200_000,
        counted_cash_paise: null,
        difference_paise: null,
      },
    },
    cash_entries: [],
    can_close: true,
    can_add_cash_entry: true,
    ...over,
  }
}
