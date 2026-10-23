/**
 * Contract-shaped fixtures for the payments screens (Vitest + MSW tests and the screenshot
 * harness). Imports only @kadai/shared so it also runs outside Vite; every factory returns data
 * that parses with the response schemas of the contracts (checked in fixtures.test.ts).
 */
import type { AccountBalance, ChartOfAccounts, ShiftDetail } from '@kadai/shared/api/accounting'
import type { CustomerListItem, SupplierListItem } from '@kadai/shared/api/parties'
import {
  type OpenItemsResponse,
  type Payment,
  type PaymentDetail,
  type PaymentIntent,
  type PaymentIntentListResponse,
  type PaymentListResponse,
  type PaymentProviderAccount,
  PROVIDER_CAPABILITIES,
  type ProviderTestResult,
  type PublicPayPage,
  RAZORPAY_WEBHOOK_EVENTS,
  type UpiQrPayload,
} from '@kadai/shared/api/payments'
import type { InvoiceListResponse, SalesInvoiceListRow } from '@kadai/shared/api/sales'
import { makeGstin } from '@kadai/shared/gst'
import { buildUpiUri } from '@kadai/shared/upi'

export const NOW = '2026-10-20T10:00:00.000Z'
export const TODAY = '2026-10-20'
/** Main store / Counter A / owner of src/test/fixtures (IDS). */
export const STORE_ID = '0192f0a0-0000-7000-8000-000000000301'
export const REGISTER_ID = '0192f0a0-0000-7000-8000-000000000401'
const USER_ID = '0192f0a0-0000-7000-8000-000000000001'

/** Deterministic UUID v7-shaped ids. */
export function pid(n: number): string {
  return `0192f0a0-0000-7000-8000-${String(n).padStart(12, '0')}`
}

export const ID = {
  vpaAccount: pid(9001),
  rzpAccount: pid(9002),
  oldAccount: pid(9003),
  bankAccount: pid(9101),
  cashAccount: pid(9102),
  customer: pid(9201),
  customer2: pid(9202),
  supplier: pid(9301),
  invoice1: pid(9401),
  invoice2: pid(9402),
  invoice3: pid(9403),
  bill1: pid(9451),
  bill2: pid(9452),
  intentPending: pid(9501),
  intentUnapplied: pid(9502),
  intentPaid: pid(9503),
  intentExpired: pid(9504),
  intentRzp: pid(9505),
  intentLink: pid(9506),
  payment1: pid(9601),
  payment2: pid(9602),
  payment3: pid(9603),
  payment4: pid(9604),
  alloc1: pid(9701),
  alloc2: pid(9702),
} as const

export const page = (total: number, limit = 50, offset = 0) => ({ limit, offset, total })

// ---- providers -------------------------------------------------------------------------------

export function vpaAccount(over: Partial<PaymentProviderAccount> = {}): PaymentProviderAccount {
  return {
    id: ID.vpaAccount,
    store_id: null,
    store_name: null,
    provider: 'upi_vpa',
    display_name: 'Shop UPI ID',
    mode: 'live',
    vpa: 'murugan.stores@okaxis',
    payee_name: 'Sri Murugan Stores',
    merchant_code: '5411',
    key_id_masked: null,
    has_credentials: false,
    has_webhook_secret: false,
    webhook_url: null,
    webhook_events: [],
    settlement_account_id: ID.bankAccount,
    settlement_account_name: 'Indian Bank current a/c',
    is_default: true,
    is_active: true,
    last_verified_at: '2026-10-18T05:30:00.000Z',
    capabilities: PROVIDER_CAPABILITIES.upi_vpa,
    created_at: '2026-06-01T05:30:00.000Z',
    updated_at: '2026-10-18T05:30:00.000Z',
    ...over,
  }
}

export function razorpayAccount(
  over: Partial<PaymentProviderAccount> = {},
): PaymentProviderAccount {
  return {
    id: ID.rzpAccount,
    store_id: STORE_ID,
    store_name: 'Main store',
    provider: 'razorpay',
    display_name: 'Razorpay',
    mode: 'live',
    vpa: null,
    payee_name: 'Sri Murugan Stores',
    merchant_code: '5411',
    key_id_masked: 'rzp_live_••••Ab12',
    has_credentials: true,
    has_webhook_secret: true,
    webhook_url: `https://murugan.kadai.app/webhooks/payments/razorpay/${ID.rzpAccount}`,
    webhook_events: [...RAZORPAY_WEBHOOK_EVENTS],
    settlement_account_id: null,
    settlement_account_name: null,
    is_default: false,
    is_active: true,
    last_verified_at: null,
    capabilities: PROVIDER_CAPABILITIES.razorpay,
    created_at: '2026-07-01T05:30:00.000Z',
    updated_at: '2026-10-10T05:30:00.000Z',
    ...over,
  }
}

export function providerList(): PaymentProviderAccount[] {
  return [
    vpaAccount(),
    razorpayAccount(),
    vpaAccount({
      id: ID.oldAccount,
      display_name: 'Old UPI ID',
      vpa: 'murugan@oldbank',
      is_default: false,
      is_active: false,
      settlement_account_id: null,
      settlement_account_name: null,
    }),
  ]
}

export function vpaTestResult(): ProviderTestResult {
  return {
    ok: true,
    provider: 'upi_vpa',
    checked_at: NOW,
    error_code: null,
    message: null,
    test_upi_uri: buildUpiUri({
      vpa: 'murugan.stores@okaxis',
      payee_name: 'Sri Murugan Stores',
      amount_paise: 100,
      note: 'Kadai test',
    }),
  }
}

export function upiQrPayload(over: Partial<UpiQrPayload> = {}): UpiQrPayload {
  return {
    provider_account_id: ID.vpaAccount,
    vpa: 'murugan.stores@okaxis',
    payee_name: 'Sri Murugan Stores',
    merchant_code: '5411',
    amount_paise: null,
    note: null,
    upi_uri: buildUpiUri({
      vpa: 'murugan.stores@okaxis',
      payee_name: 'Sri Murugan Stores',
      mcc: '5411',
    }),
    shop: { name: 'Sri Murugan Stores', name_ta: 'ஸ்ரீ முருகன் ஸ்டோர்ஸ்' },
    store: { id: STORE_ID, name: 'Main store', name_ta: 'முதன்மைக் கிளை' },
    ...over,
  }
}

// ---- accounting / parties / sales (pickers, apply dialog) ------------------------------------

function account(over: Partial<AccountBalance>): AccountBalance {
  return {
    id: ID.bankAccount,
    code: '1110',
    name: 'Indian Bank current a/c',
    name_ta: 'இந்தியன் வங்கி நடப்புக் கணக்கு',
    type: 'asset',
    subtype: 'bank',
    parent_id: null,
    is_system: false,
    is_active: true,
    store_id: null,
    money_kind: 'bank',
    details: {
      bank_name: 'Indian Bank',
      account_last4: '4821',
      ifsc: 'IDIB000M012',
      branch: 'Madurai Main',
      account_holder: 'Sri Murugan Stores',
    },
    created_at: '2026-04-01T05:30:00.000Z',
    updated_at: '2026-04-01T05:30:00.000Z',
    debit_paise: null,
    credit_paise: null,
    balance_paise: null,
    rollup_balance_paise: null,
    depth: 0,
    has_entries: true,
    ...over,
  }
}

export function chartOfAccounts(): ChartOfAccounts {
  return {
    as_of: TODAY,
    store_id: null,
    accounts: [
      account({}),
      account({
        id: ID.cashAccount,
        code: '1100',
        name: 'Cash',
        name_ta: 'ரொக்கம்',
        subtype: 'cash',
        is_system: true,
        money_kind: 'cash',
      }),
    ],
    totals: [],
  }
}

export function customerListItem(over: Partial<CustomerListItem> = {}): CustomerListItem {
  return {
    id: ID.customer,
    code: null,
    name: 'Lakshmi Ammal',
    name_ta: 'லட்சுமி அம்மாள்',
    phone: '+919843012345',
    gstin: null,
    state_code: '33',
    customer_type: 'retail',
    price_tier: 'retail',
    balance_paise: 2_000_00,
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

export function supplierListItem(over: Partial<SupplierListItem> = {}): SupplierListItem {
  return {
    id: ID.supplier,
    code: null,
    name: 'Sri Lakshmi Traders',
    contact_person: 'Ganesan',
    phone: '+919842233445',
    gstin: makeGstin('33', 'AAFFS1234K'),
    state_code: '33',
    drug_license_no: null,
    payment_terms_days: 30,
    balance_paise: 23_500_00,
    overdue_paise: 0,
    upi_vpa: null,
    is_active: true,
    last_bill_date: '2026-10-05',
    created_at: '2026-02-01T09:00:00.000Z',
    updated_at: NOW,
    ...over,
  }
}

export function openItems(partyType: 'customer' | 'supplier' = 'customer'): OpenItemsResponse {
  if (partyType === 'supplier') {
    return {
      party: {
        type: 'supplier',
        id: ID.supplier,
        name: 'Sri Lakshmi Traders',
        balance_paise: 23_500_00,
        store_credit_paise: null,
      },
      direction: 'out',
      items: [
        {
          target_type: 'purchase_bill',
          target_id: ID.bill1,
          number: 'SLT/1182',
          date: '2026-09-10',
          due_date: '2026-10-10',
          total_paise: 12_500_00,
          due_paise: 12_500_00,
          days_overdue: 10,
          store_id: STORE_ID,
        },
        {
          target_type: 'purchase_bill',
          target_id: ID.bill2,
          number: 'SLT/1240',
          date: '2026-10-05',
          due_date: '2026-11-04',
          total_paise: 11_000_00,
          due_paise: 11_000_00,
          days_overdue: null,
          store_id: STORE_ID,
        },
      ],
      total_due_paise: 23_500_00,
    }
  }
  return {
    party: {
      type: 'customer',
      id: ID.customer,
      name: 'Lakshmi Ammal',
      balance_paise: 2_000_00,
      store_credit_paise: 0,
    },
    direction: 'in',
    items: [
      {
        target_type: 'opening_balance',
        target_id: ID.customer,
        number: null,
        date: '2026-04-01',
        due_date: null,
        total_paise: 500_00,
        due_paise: 450_00,
        days_overdue: null,
        store_id: null,
      },
      {
        target_type: 'sales_invoice',
        target_id: ID.invoice1,
        number: 'S1-A/2627/00412',
        date: '2026-09-04',
        due_date: '2026-10-04',
        total_paise: 820_00,
        due_paise: 320_00,
        days_overdue: 16,
        store_id: STORE_ID,
      },
      {
        target_type: 'sales_invoice',
        target_id: ID.invoice2,
        number: 'S1-A/2627/00577',
        date: '2026-09-18',
        due_date: '2026-10-18',
        total_paise: 1_230_00,
        due_paise: 1_230_00,
        days_overdue: 2,
        store_id: STORE_ID,
      },
    ],
    total_due_paise: 2_000_00,
  }
}

function invoiceRow(over: Partial<SalesInvoiceListRow>): SalesInvoiceListRow {
  return {
    id: ID.invoice1,
    doc_type: 'tax_invoice',
    number: 'S1-A/2627/00412',
    fy: '2026-27',
    invoice_date: '2026-09-04',
    invoice_at: '2026-09-04T06:30:00.000Z',
    status: 'completed',
    channel: 'pos',
    store_id: STORE_ID,
    store_code: 'S1',
    register_id: REGISTER_ID,
    register_code: 'A',
    customer_id: ID.customer,
    customer_name: 'Lakshmi Ammal',
    customer_phone: '+919843012345',
    item_count: 6,
    total_paise: 820_00,
    paid_paise: 500_00,
    returned_paise: 0,
    due_paise: 320_00,
    payment_status: 'partial',
    due_date: '2026-10-04',
    created_by: USER_ID,
    created_by_name: 'Murugan K',
    offline: false,
    client_ref: null,
    created_at: '2026-09-04T06:30:00.000Z',
    updated_at: NOW,
    ...over,
  }
}

export function dueInvoices(): InvoiceListResponse {
  const rows = [
    invoiceRow({}),
    invoiceRow({
      id: ID.invoice2,
      number: 'S1-A/2627/00577',
      invoice_date: '2026-09-18',
      total_paise: 1_230_00,
      paid_paise: 0,
      due_paise: 1_230_00,
      payment_status: 'unpaid',
    }),
    invoiceRow({
      id: ID.invoice3,
      number: 'S1-A/2627/00981',
      invoice_date: TODAY,
      customer_id: null,
      customer_name: null,
      customer_phone: null,
      total_paise: 180_00,
      paid_paise: 0,
      due_paise: 180_00,
      payment_status: 'unpaid',
    }),
  ]
  return {
    data: rows,
    page: page(rows.length),
    summary: {
      count: rows.length,
      total_paise: 2_230_00,
      paid_paise: 500_00,
      due_paise: 1_730_00,
      returned_paise: 0,
      taxable_paise: 2_124_00,
      tax_paise: 106_00,
    },
  }
}

/** The open shift of Counter A (cash received at the counter goes into its drawer). */
export function openShift(over: Partial<ShiftDetail> = {}): ShiftDetail {
  return {
    id: pid(9950),
    store_id: STORE_ID,
    store_name: 'Main store',
    register_id: REGISTER_ID,
    register_code: 'A',
    register_name: 'Counter A',
    status: 'open',
    opened_by: USER_ID,
    opened_by_name: 'Selvi',
    opened_at: NOW,
    opening_cash_paise: 2_000_00,
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
        opening_cash_paise: 2_000_00,
        cash_receipts_paise: 0,
        cash_payments_paise: 0,
        pay_ins_paise: 0,
        pay_outs_paise: 0,
        cash_expenses_paise: 0,
        expected_cash_paise: 2_000_00,
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

// ---- intents ---------------------------------------------------------------------------------

export function intent(over: Partial<PaymentIntent> = {}): PaymentIntent {
  const amount = over.amount_paise ?? 250_00
  return {
    id: ID.intentPending,
    store_id: STORE_ID,
    register_id: REGISTER_ID,
    provider_account_id: ID.vpaAccount,
    provider: 'upi_vpa',
    provider_display_name: 'Shop UPI ID',
    kind: 'qr',
    purpose: 'pos_sale',
    ref_type: 'pos_cart',
    ref_id: pid(9901),
    customer_id: null,
    customer_name: null,
    reference_code: 'KD7Q2M9XA4BC',
    amount_paise: amount,
    currency: 'INR',
    status: 'pending',
    upi_uri: buildUpiUri({
      vpa: 'murugan.stores@okaxis',
      payee_name: 'Sri Murugan Stores',
      amount_paise: amount,
      reference: 'KD7Q2M9XA4BC',
    }),
    image_url: null,
    short_url: null,
    provider_ref: null,
    provider_payment_id: null,
    payer_vpa: null,
    payer_name: null,
    utr: null,
    paid_amount_paise: null,
    fee_paise: null,
    amount_mismatch: false,
    confirmation: null,
    confirmed_by: null,
    confirmed_by_name: null,
    payment_id: null,
    payment_number: null,
    expires_at: '2026-10-20T10:05:00.000Z',
    expires_in_seconds: 300,
    paid_at: null,
    failure_reason: null,
    poll_count: 0,
    last_polled_at: null,
    created_by: USER_ID,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  }
}

/** The same intent after the money arrived. */
export function paidIntent(base: PaymentIntent, over: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    ...base,
    status: 'paid',
    payer_vpa: 'lakshmi@okhdfcbank',
    payer_name: 'LAKSHMI A',
    utr: '628194773311',
    paid_amount_paise: base.amount_paise,
    confirmation: base.provider === 'upi_vpa' ? 'manual' : 'webhook',
    paid_at: '2026-10-20T10:01:10.000Z',
    expires_in_seconds: null,
    updated_at: '2026-10-20T10:01:10.000Z',
    ...over,
  }
}

export function todaysIntents(): PaymentIntent[] {
  const unapplied = paidIntent(
    intent({
      id: ID.intentUnapplied,
      provider: 'razorpay',
      provider_account_id: ID.rzpAccount,
      provider_display_name: 'Razorpay',
      reference_code: 'KD3H8P2LQ7ZD',
      amount_paise: 560_00,
      upi_uri: null,
      image_url: 'https://rzp.io/qr/abc.png',
      provider_ref: 'qr_N8sK2',
    }),
    { confirmation: 'webhook', fee_paise: 0, payment_id: null },
  )
  return [
    intent(),
    unapplied,
    paidIntent(
      intent({
        id: ID.intentPaid,
        reference_code: 'KD9Z1R4TW6YE',
        amount_paise: 1_250_00,
        purpose: 'customer_due',
        ref_type: 'customer',
        ref_id: ID.customer,
        customer_id: ID.customer,
        customer_name: 'Lakshmi Ammal',
      }),
      {
        payment_id: ID.payment1,
        payment_number: 'RC/2627/00042',
        confirmed_by: USER_ID,
        confirmed_by_name: 'Murugan K',
      },
    ),
    intent({
      id: ID.intentExpired,
      reference_code: 'KD5N6V8BC2XF',
      amount_paise: 99_00,
      status: 'expired',
      expires_in_seconds: 0,
    }),
    intent({
      id: ID.intentLink,
      kind: 'link',
      purpose: 'customer_due',
      ref_type: 'customer',
      ref_id: ID.customer2,
      customer_id: ID.customer2,
      customer_name: 'Ravi Kumar',
      reference_code: 'KD2W4E6R8T0Y',
      amount_paise: 1_430_00,
      short_url: 'https://murugan.kadai.app/pay/KD2W4E6R8T0Y',
      expires_at: '2026-10-23T10:00:00.000Z',
      expires_in_seconds: 259_200,
    }),
  ]
}

export function intentList(
  rows: readonly PaymentIntent[] = todaysIntents(),
  over: Partial<PaymentIntentListResponse['summary']> = {},
): PaymentIntentListResponse {
  const all = todaysIntents()
  const byStatus = new Map<string, { count: number; amount: number }>()
  for (const i of all) {
    const s = byStatus.get(i.status) ?? { count: 0, amount: 0 }
    s.count++
    s.amount += i.paid_amount_paise ?? i.amount_paise
    byStatus.set(i.status, s)
  }
  return {
    data: [...rows],
    page: page(rows.length),
    summary: {
      by_status: [...byStatus.entries()].map(([status, s]) => ({
        status: status as PaymentIntent['status'],
        count: s.count,
        amount_paise: s.amount,
      })),
      paid_total_paise: 1_810_00,
      unapplied_count: 1,
      unapplied_total_paise: 560_00,
      by_provider: [
        {
          provider_account_id: ID.vpaAccount,
          provider: 'upi_vpa',
          display_name: 'Shop UPI ID',
          paid_count: 1,
          paid_total_paise: 1_250_00,
        },
        {
          provider_account_id: ID.rzpAccount,
          provider: 'razorpay',
          display_name: 'Razorpay',
          paid_count: 1,
          paid_total_paise: 560_00,
        },
      ],
      ...over,
    },
  }
}

// ---- receipts & vouchers ---------------------------------------------------------------------

export function payment(over: Partial<Payment> = {}): Payment {
  return {
    id: ID.payment1,
    store_id: STORE_ID,
    register_id: null,
    shift_id: null,
    number: 'RC/2627/00042',
    fy: '2026-27',
    direction: 'in',
    party_type: 'customer',
    party_id: ID.customer,
    party_name: 'Lakshmi Ammal',
    method: 'upi',
    amount_paise: 1_250_00,
    allocated_paise: 1_250_00,
    unallocated_paise: 0,
    status: 'completed',
    payment_date: TODAY,
    paid_at: '2026-10-20T10:01:10.000Z',
    reference: '628194773311',
    payment_intent_id: ID.intentPaid,
    account_id: ID.bankAccount,
    account_name: 'Indian Bank current a/c',
    notes: null,
    client_ref: pid(9801),
    origin: 'manual',
    created_by: USER_ID,
    created_by_name: 'Murugan K',
    created_at: '2026-10-20T10:01:10.000Z',
    cancelled_at: null,
    cancel_reason: null,
    ...over,
  }
}

export function paymentRows(): Payment[] {
  return [
    payment(),
    payment({
      id: ID.payment2,
      number: null,
      party_type: null,
      party_id: null,
      party_name: null,
      method: 'cash',
      amount_paise: 180_00,
      allocated_paise: 180_00,
      register_id: REGISTER_ID,
      reference: null,
      payment_intent_id: null,
      account_id: ID.cashAccount,
      account_name: 'Cash',
      client_ref: `tender:${ID.invoice3}:0`,
      origin: 'sales_tender',
      paid_at: '2026-10-20T08:15:00.000Z',
    }),
    payment({
      id: ID.payment3,
      number: 'PV/2627/00015',
      direction: 'out',
      party_type: 'supplier',
      party_id: ID.supplier,
      party_name: 'Sri Lakshmi Traders',
      method: 'bank_transfer',
      amount_paise: 12_500_00,
      allocated_paise: 12_500_00,
      reference: 'NEFT 88123',
      payment_intent_id: null,
      payment_date: '2026-10-19',
      paid_at: '2026-10-19T11:00:00.000Z',
    }),
    payment({
      id: ID.payment4,
      number: 'RC/2627/00041',
      method: 'cash',
      amount_paise: 300_00,
      allocated_paise: 200_00,
      unallocated_paise: 100_00,
      reference: null,
      payment_intent_id: null,
      account_id: ID.cashAccount,
      account_name: 'Cash',
      status: 'cancelled',
      cancelled_at: '2026-10-19T12:00:00.000Z',
      cancel_reason: 'Entered twice',
      payment_date: '2026-10-19',
      paid_at: '2026-10-19T09:00:00.000Z',
    }),
  ]
}

export function paymentList(
  rows: readonly Payment[] = paymentRows(),
  total = rows.length,
): PaymentListResponse {
  return {
    data: [...rows],
    page: page(total),
    summary: {
      count: 3,
      in_paise: 1_430_00,
      out_paise: 12_500_00,
      net_paise: 1_430_00 - 12_500_00,
      by_method: [
        { method: 'upi', direction: 'in', count: 1, amount_paise: 1_250_00 },
        { method: 'cash', direction: 'in', count: 1, amount_paise: 180_00 },
        { method: 'bank_transfer', direction: 'out', count: 1, amount_paise: 12_500_00 },
      ],
    },
  }
}

export function paymentDetail(over: Partial<PaymentDetail> = {}): PaymentDetail {
  return {
    ...payment(),
    allocations: [
      {
        id: ID.alloc1,
        target_type: 'sales_invoice',
        target_id: ID.invoice1,
        amount_paise: 320_00,
        document_number: 'S1-A/2627/00412',
        document_date: '2026-09-04',
        document_total_paise: 820_00,
        document_due_paise: 0,
      },
      {
        id: ID.alloc2,
        target_type: 'sales_invoice',
        target_id: ID.invoice2,
        amount_paise: 930_00,
        document_number: 'S1-A/2627/00577',
        document_date: '2026-09-18',
        document_total_paise: 1_230_00,
        document_due_paise: 300_00,
      },
    ],
    intent: {
      id: ID.intentPaid,
      reference_code: 'KD9Z1R4TW6YE',
      provider: 'upi_vpa',
      payer_vpa: 'lakshmi@okhdfcbank',
      utr: '628194773311',
      paid_at: '2026-10-20T10:01:10.000Z',
    },
    journal_entry_id: pid(9990),
    cancelled_by_name: null,
    updated_at: '2026-10-20T10:01:10.000Z',
    ...over,
  }
}

// ---- public pay page -------------------------------------------------------------------------

export const PAY_CODE = 'KD2W4E6R8T0Y'

export function publicPayPage(over: Partial<PublicPayPage> = {}): PublicPayPage {
  return {
    reference_code: PAY_CODE,
    status: 'pending',
    purpose: 'customer_due',
    amount_paise: 1_430_00,
    currency: 'INR',
    shop: {
      name: 'Sri Murugan Stores',
      name_ta: 'ஸ்ரீ முருகன் ஸ்டோர்ஸ்',
      city: 'Madurai',
      phone: '+919876543210',
      logo_url: null,
    },
    payee: { name: 'Sri Murugan Stores', vpa: 'murugan.stores@okaxis' },
    customer_first_name: 'Ravi',
    upi_uri: buildUpiUri({
      vpa: 'murugan.stores@okaxis',
      payee_name: 'Sri Murugan Stores',
      amount_paise: 1_430_00,
      reference: PAY_CODE,
    }),
    short_url: null,
    expires_at: '2026-10-23T10:00:00.000Z',
    paid_at: null,
    ...over,
  }
}
