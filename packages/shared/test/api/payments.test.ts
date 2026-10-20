import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  OpenItemsQuerySchema,
  OpenItemsResponseSchema,
  PROVIDER_CAPABILITIES,
  PaymentCancelSchema,
  PaymentCreateSchema,
  PaymentDetailSchema,
  PaymentIntentApplySchema,
  PaymentIntentCancelSchema,
  PaymentIntentConfirmSchema,
  PaymentIntentCreateSchema,
  PaymentIntentGetQuerySchema,
  PaymentIntentListQuerySchema,
  PaymentIntentListResponseSchema,
  PaymentIntentMockPaySchema,
  PaymentIntentSchema,
  PaymentLinkCreateSchema,
  PaymentLinkResultSchema,
  PaymentListQuerySchema,
  PaymentListResponseSchema,
  PaymentProviderAccountSchema,
  PaymentProviderCreateSchema,
  PaymentProviderUpdateSchema,
  ProviderTestResultSchema,
  PublicPayPageSchema,
  ReferenceCodeParamsSchema,
  UpiQrPayloadSchema,
  UpiQrQuerySchema,
  WebhookAckSchema,
  allocateFifo,
  intentPollDelaySeconds,
  isDynamicProvider,
  isPaymentCancellable,
  isTerminalIntentStatus,
  maskKeyId,
  paymentClientRef,
  paymentOriginOf,
  paymentWebhookPath,
  paymentsRoutes,
  upiReferenceFromNumber,
  zQueryList,
} from '../../src/api/payments'
import { routeUrl } from '../../src/api/common'
import { PaymentProviderCodeSchema } from '../../src/enums'
import { newId } from '../../src/ids'
import { generateReferenceCode } from '../../src/upi'

const id = () => newId()
const NOW = '2026-10-20T10:15:00+05:30'
const STORE = id()

const capabilities = PROVIDER_CAPABILITIES.razorpay

const intent = {
  id: id(),
  store_id: STORE,
  register_id: id(),
  provider_account_id: id(),
  provider: 'razorpay',
  provider_display_name: 'Razorpay',
  kind: 'qr',
  purpose: 'pos_sale',
  ref_type: 'pos_cart',
  ref_id: id(),
  customer_id: null,
  customer_name: null,
  reference_code: generateReferenceCode(),
  amount_paise: 38_000,
  currency: 'INR',
  status: 'paid',
  upi_uri: null,
  image_url: 'https://rzp.io/qr/abc.png',
  short_url: null,
  provider_ref: 'qr_ABC123',
  provider_payment_id: 'pay_XYZ',
  payer_vpa: 'selvi@okicici',
  payer_name: 'SELVI',
  utr: '429876543210',
  paid_amount_paise: 38_000,
  fee_paise: 0,
  amount_mismatch: false,
  confirmation: 'webhook',
  confirmed_by: null,
  confirmed_by_name: null,
  payment_id: null,
  payment_number: null,
  expires_at: NOW,
  expires_in_seconds: 0,
  paid_at: new Date(NOW),
  failure_reason: null,
  poll_count: 3,
  last_polled_at: NOW,
  created_by: id(),
  created_at: NOW,
  updated_at: NOW,
}

const payment = {
  id: id(),
  store_id: STORE,
  register_id: null,
  shift_id: null,
  number: 'RCS1/2627/00012',
  fy: '2026-27',
  direction: 'in',
  party_type: 'customer',
  party_id: id(),
  party_name: 'Murugan',
  method: 'upi',
  amount_paise: 50_000,
  allocated_paise: 30_000,
  unallocated_paise: 20_000,
  status: 'completed',
  payment_date: '2026-10-20',
  paid_at: NOW,
  reference: '429876543210',
  payment_intent_id: null,
  account_id: id(),
  account_name: 'Bank account',
  notes: null,
  client_ref: null,
  origin: 'manual',
  created_by: id(),
  created_by_name: 'Kavitha',
  created_at: NOW,
  cancelled_at: null,
  cancel_reason: null,
}

describe('helpers', () => {
  it('zQueryList accepts one or repeated values', () => {
    const s = zQueryList(z.enum(['a', 'b']))
    expect(s.parse('a')).toEqual(['a'])
    expect(s.parse(['a', 'b'])).toEqual(['a', 'b'])
    expect(s.safeParse('c').success).toBe(false)
    expect(s.safeParse([]).success).toBe(false)
  })

  it('allocateFifo', () => {
    const items = [
      { target_type: 'opening_balance' as const, target_id: 'p', due_paise: 1_000 },
      { target_type: 'sales_invoice' as const, target_id: 'i1', due_paise: 5_000 },
      { target_type: 'sales_invoice' as const, target_id: 'i2', due_paise: 0 },
      { target_type: 'sales_invoice' as const, target_id: 'i3', due_paise: 4_000 },
    ]
    expect(allocateFifo(items, 7_500)).toEqual({
      allocations: [
        { target_type: 'opening_balance', target_id: 'p', amount_paise: 1_000 },
        { target_type: 'sales_invoice', target_id: 'i1', amount_paise: 5_000 },
        { target_type: 'sales_invoice', target_id: 'i3', amount_paise: 1_500 },
      ],
      unallocated_paise: 0,
    })
    expect(allocateFifo(items, 12_000).unallocated_paise).toBe(2_000)
    expect(allocateFifo(items, 0).allocations).toEqual([])
    expect(() => allocateFifo(items, -1)).toThrow(RangeError)
  })

  it('payment origins from client_ref', () => {
    const inv = id()
    expect(paymentClientRef.salesTender(inv, 1)).toBe(`tender:${inv}:1`)
    expect(paymentOriginOf(paymentClientRef.salesTender(inv, 0))).toBe('sales_tender')
    expect(paymentOriginOf(paymentClientRef.creditNoteSettlement(inv))).toBe(
      'credit_note_settlement',
    )
    expect(paymentOriginOf(paymentClientRef.debitNoteSettlement(inv))).toBe('debit_note_settlement')
    expect(paymentOriginOf(null)).toBe('manual')
    expect(paymentOriginOf(id())).toBe('manual')
    expect(isPaymentCancellable({ status: 'completed', origin: 'manual' })).toBe(true)
    expect(isPaymentCancellable({ status: 'completed', origin: 'sales_tender' })).toBe(false)
    expect(isPaymentCancellable({ status: 'cancelled', origin: 'manual' })).toBe(false)
  })

  it('provider helpers', () => {
    expect(maskKeyId('rzp_live_AbCdEfGh1234')).toBe('rzp_live_••••1234')
    expect(maskKeyId('plainkey987')).toBe('••••y987')
    expect(paymentWebhookPath('razorpay', 'acc')).toBe('/webhooks/payments/razorpay/acc')
    expect(isDynamicProvider('razorpay')).toBe(true)
    expect(isDynamicProvider('upi_vpa')).toBe(false)
    for (const code of PaymentProviderCodeSchema.options)
      expect(PROVIDER_CAPABILITIES[code]).toBeDefined()
    expect(PROVIDER_CAPABILITIES.upi_vpa.manual_confirm).toBe(true)
    expect([0, 1, 2, 3, 10].map(intentPollDelaySeconds)).toEqual([3, 5, 10, 30, 30])
    expect(isTerminalIntentStatus('pending')).toBe(false)
    expect(isTerminalIntentStatus('expired')).toBe(true)
    expect(upiReferenceFromNumber('S1-A/2627/00042')).toBe('S1A262700042')
    expect(upiReferenceFromNumber('///')).toBeNull()
  })
})

describe('provider requests', () => {
  it('upi_vpa', () => {
    const p = PaymentProviderCreateSchema.parse({
      provider: 'upi_vpa',
      display_name: 'Shop UPI',
      vpa: ' Murugan.Stores@OKAXIS ',
      payee_name: 'Murugan Stores',
      merchant_code: '5411',
      is_default: true,
    })
    expect(p).toMatchObject({ vpa: 'murugan.stores@okaxis', merchant_code: '5411' })
    expect(
      PaymentProviderCreateSchema.safeParse({
        provider: 'upi_vpa',
        display_name: 'x',
        vpa: 'nope',
        payee_name: 'x',
      }).success,
    ).toBe(false)
    expect(
      PaymentProviderCreateSchema.safeParse({
        provider: 'upi_vpa',
        display_name: 'x',
        vpa: 'a@b1',
        payee_name: 'x',
        merchant_code: '54',
      }).success,
    ).toBe(false)
  })
  it('razorpay', () => {
    const ok = PaymentProviderCreateSchema.parse({
      provider: 'razorpay',
      display_name: 'Razorpay',
      credentials: { key_id: 'rzp_live_AbCdEfGh1234', key_secret: 'secretsecret' },
      webhook_secret: 'whsec-123456',
    })
    expect(ok).toMatchObject({ mode: 'live' })
    expect(
      PaymentProviderCreateSchema.safeParse({
        provider: 'razorpay',
        display_name: 'Razorpay',
        mode: 'test',
        credentials: { key_id: 'rzp_live_AbCdEfGh1234', key_secret: 'secretsecret' },
      }).success,
    ).toBe(false)
    expect(
      PaymentProviderCreateSchema.safeParse({ provider: 'cashfree', display_name: 'x' }).success,
    ).toBe(false)
  })
  it('update', () => {
    expect(PaymentProviderUpdateSchema.parse({ webhook_secret: null }).webhook_secret).toBeNull()
    expect(PaymentProviderUpdateSchema.safeParse({}).success).toBe(false)
    expect(PaymentProviderUpdateSchema.safeParse({ if_updated_at: NOW }).success).toBe(false)
  })
})

describe('intent requests', () => {
  it('create', () => {
    expect(
      PaymentIntentCreateSchema.parse({
        amount_paise: 38_000,
        purpose: 'pos_sale',
        store_id: STORE,
        ref_type: 'pos_cart',
        ref_id: id(),
      }).purpose,
    ).toBe('pos_sale')
    const bad = (o: Record<string, unknown>) =>
      PaymentIntentCreateSchema.safeParse({ amount_paise: 100, store_id: STORE, ...o }).success
    expect(bad({ purpose: 'pos_sale', ref_type: 'pos_cart' })).toBe(false)
    expect(bad({ purpose: 'invoice_due' })).toBe(false)
    expect(bad({ purpose: 'customer_due' })).toBe(false)
    expect(bad({ purpose: 'customer_due', customer_id: id() })).toBe(true)
    expect(bad({ purpose: 'pos_sale', amount_paise: 0 })).toBe(false)
  })
  it('get / confirm / cancel / mock / apply / list', () => {
    expect(PaymentIntentGetQuerySchema.parse({ wait: '25', since_status: 'pending' })).toEqual({
      wait: 25,
      since_status: 'pending',
    })
    expect(PaymentIntentGetQuerySchema.safeParse({ wait: '26' }).success).toBe(false)
    expect(PaymentIntentConfirmSchema.parse(undefined)).toEqual({})
    expect(PaymentIntentConfirmSchema.parse({ utr: '429876543210' }).utr).toBe('429876543210')
    expect(PaymentIntentConfirmSchema.safeParse({ utr: '12-34' }).success).toBe(false)
    expect(PaymentIntentCancelSchema.parse(undefined)).toEqual({})
    expect(PaymentIntentMockPaySchema.parse({})).toEqual({ outcome: 'paid' })
    expect(
      PaymentIntentApplySchema.parse({ target_type: 'customer', target_id: id() }).target_type,
    ).toBe('customer')
    expect(
      PaymentIntentListQuerySchema.parse({
        status: 'paid',
        unapplied: 'true',
        provider: ['razorpay', 'upi_vpa'],
      }),
    ).toMatchObject({
      status: ['paid'],
      unapplied: true,
      provider: ['razorpay', 'upi_vpa'],
      limit: 50,
    })
  })
  it('links, QR, references', () => {
    const l = PaymentLinkCreateSchema.parse({
      customer_id: id(),
      store_id: STORE,
      send_via: 'whatsapp',
    })
    expect(l).toMatchObject({ expires_in_hours: 72, phone: null, send_via: 'whatsapp' })
    expect(
      PaymentLinkCreateSchema.safeParse({ customer_id: id(), store_id: STORE, send_via: 'email' })
        .success,
    ).toBe(false)
    expect(UpiQrQuerySchema.parse({ amount_paise: '100' }).amount_paise).toBe(100)
    expect(
      ReferenceCodeParamsSchema.safeParse({ reference_code: generateReferenceCode() }).success,
    ).toBe(true)
    expect(ReferenceCodeParamsSchema.safeParse({ reference_code: 'kd123' }).success).toBe(false)
  })
})

describe('payment requests', () => {
  const party = { party_type: 'customer', party_id: id() }
  it('create', () => {
    const p = PaymentCreateSchema.parse({
      direction: 'in',
      store_id: STORE,
      ...party,
      method: 'cash',
      amount_paise: 50_000,
      auto_allocate: 'fifo',
    })
    expect(p.auto_allocate).toBe('fifo')
    const bad = (o: Record<string, unknown>) =>
      PaymentCreateSchema.safeParse({
        direction: 'in',
        store_id: STORE,
        ...party,
        method: 'cash',
        amount_paise: 50_000,
        ...o,
      }).success
    expect(
      bad({
        allocations: [{ target_type: 'sales_invoice', target_id: id(), amount_paise: 60_000 }],
      }),
    ).toBe(false)
    expect(
      bad({ allocations: [{ target_type: 'purchase_bill', target_id: id(), amount_paise: 100 }] }),
    ).toBe(false)
    expect(
      bad({
        allocations: [{ target_type: 'sales_invoice', target_id: id(), amount_paise: 100 }],
        auto_allocate: 'fifo',
      }),
    ).toBe(false)
    expect(bad({ method: 'store_credit', party_type: 'supplier' })).toBe(false)
    expect(
      bad({
        direction: 'out',
        party_type: 'supplier',
        allocations: [{ target_type: 'purchase_bill', target_id: id(), amount_paise: 50_000 }],
      }),
    ).toBe(true)
    expect(bad({ party_id: undefined })).toBe(false)
  })
  it('cancel, list, open items', () => {
    expect(PaymentCancelSchema.safeParse({ reason: '' }).success).toBe(false)
    expect(
      PaymentListQuerySchema.parse({
        method: 'upi',
        direction: 'in',
        format: 'csv',
        sort: '-payment_date',
      }),
    ).toMatchObject({
      method: ['upi'],
      format: 'csv',
      sort: { field: 'payment_date', direction: 'desc' },
    })
    expect(
      OpenItemsQuerySchema.parse({ party_type: 'supplier', party_id: id() }).direction,
    ).toBeUndefined()
  })
})

describe('responses', () => {
  it('provider account (no secrets)', () => {
    const acc = PaymentProviderAccountSchema.parse({
      id: id(),
      store_id: null,
      store_name: null,
      provider: 'razorpay',
      display_name: 'Razorpay',
      mode: 'live',
      vpa: null,
      payee_name: 'Murugan Stores',
      merchant_code: '5411',
      key_id_masked: 'rzp_live_••••1234',
      has_credentials: true,
      has_webhook_secret: true,
      webhook_url: 'https://kadai.example/webhooks/payments/razorpay/abc',
      webhook_events: ['qr_code.credited', 'payment_link.paid', 'payment.failed'],
      settlement_account_id: null,
      settlement_account_name: null,
      is_default: true,
      is_active: true,
      last_verified_at: null,
      capabilities,
      created_at: NOW,
      updated_at: NOW,
      // a stray secret is stripped by the response schema
      key_secret: 'leak',
    })
    expect(JSON.stringify(acc)).not.toContain('leak')
    expect(
      ProviderTestResultSchema.parse({
        ok: true,
        provider: 'upi_vpa',
        checked_at: NOW,
        error_code: null,
        message: null,
        test_upi_uri: 'upi://pay?pa=a@b1&pn=x&am=1.00&cu=INR',
      }).ok,
    ).toBe(true)
  })
  it('intents', () => {
    const i = PaymentIntentSchema.parse(intent)
    expect(i.paid_at).toBe(new Date(NOW).toISOString())
    expect(
      PaymentIntentListResponseSchema.parse({
        data: [intent],
        page: { limit: 50, offset: 0, total: 1 },
        summary: {
          by_status: [{ status: 'paid', count: 1, amount_paise: 38_000 }],
          paid_total_paise: 38_000,
          unapplied_count: 1,
          unapplied_total_paise: 38_000,
          by_provider: [
            {
              provider_account_id: intent.provider_account_id,
              provider: 'razorpay',
              display_name: 'Razorpay',
              paid_count: 1,
              paid_total_paise: 38_000,
            },
          ],
        },
      }).summary.unapplied_count,
    ).toBe(1)
    expect(
      PaymentLinkResultSchema.parse({
        intent: {
          ...intent,
          kind: 'link',
          purpose: 'customer_due',
          status: 'pending',
          short_url: 'https://kadai.example/pay/KD7Q2M9X4LZ0',
        },
        url: 'https://kadai.example/pay/KD7Q2M9X4LZ0',
        link_kind: 'pay_page',
        notification_id: id(),
        message: 'Please pay ₹380.00',
        wa_me_url: null,
      }).link_kind,
    ).toBe('pay_page')
    expect(
      PublicPayPageSchema.parse({
        reference_code: 'KD7Q2M9X4LZ0',
        status: 'pending',
        purpose: 'customer_due',
        amount_paise: 38_000,
        currency: 'INR',
        shop: {
          name: 'Murugan Stores',
          name_ta: null,
          city: 'Madurai',
          phone: null,
          logo_url: null,
        },
        payee: { name: 'Murugan Stores', vpa: 'murugan@okaxis' },
        customer_first_name: 'Selvi',
        upi_uri: 'upi://pay?pa=murugan@okaxis&pn=Murugan&am=380.00&cu=INR&tr=KD7Q2M9X4LZ0',
        short_url: null,
        expires_at: NOW,
        paid_at: null,
      }).upi_uri,
    ).toContain('tr=KD7Q2M9X4LZ0')
    expect(
      UpiQrPayloadSchema.parse({
        provider_account_id: id(),
        vpa: 'murugan@okaxis',
        payee_name: 'Murugan Stores',
        merchant_code: '5411',
        amount_paise: null,
        note: null,
        upi_uri: 'upi://pay?pa=murugan@okaxis&pn=Murugan%20Stores&cu=INR',
        shop: { name: 'Murugan Stores', name_ta: 'முருகன் ஸ்டோர்ஸ்' },
        store: null,
      }).amount_paise,
    ).toBeNull()
    expect(WebhookAckSchema.parse({ ok: true }).ok).toBe(true)
  })
  it('payments', () => {
    const d = PaymentDetailSchema.parse({
      ...payment,
      allocations: [
        {
          id: id(),
          target_type: 'sales_invoice',
          target_id: id(),
          amount_paise: 30_000,
          document_number: 'S1-A/2627/00042',
          document_date: '2026-10-01',
          document_total_paise: 40_000,
          document_due_paise: 10_000,
        },
      ],
      intent: null,
      journal_entry_id: id(),
      cancelled_by_name: null,
      updated_at: NOW,
    })
    expect(d.allocations).toHaveLength(1)
    expect(
      PaymentListResponseSchema.parse({
        data: [payment],
        page: { limit: 50, offset: 0, total: 1 },
        summary: {
          count: 1,
          in_paise: 50_000,
          out_paise: 0,
          net_paise: 50_000,
          by_method: [{ method: 'upi', direction: 'in', count: 1, amount_paise: 50_000 }],
        },
      }).summary.net_paise,
    ).toBe(50_000)
    expect(
      OpenItemsResponseSchema.parse({
        party: {
          type: 'customer',
          id: id(),
          name: 'Murugan',
          balance_paise: 14_000,
          store_credit_paise: 0,
        },
        direction: 'in',
        items: [
          {
            target_type: 'sales_invoice',
            target_id: id(),
            number: 'S1-A/2627/00042',
            date: '2026-10-01',
            due_date: '2026-10-31',
            total_paise: 14_000,
            due_paise: 14_000,
            days_overdue: null,
            store_id: STORE,
          },
        ],
        total_due_paise: 14_000,
      }).items,
    ).toHaveLength(1)
  })
})

describe('payments route catalogue', () => {
  it('paths', () => {
    expect(routeUrl(paymentsRoutes.webhook, { provider: 'razorpay', account_id: 'a' })).toBe(
      '/webhooks/payments/razorpay/a',
    )
    expect(routeUrl(paymentsRoutes.publicPayPage, { reference_code: 'KD7Q2M9X4LZ0' })).toBe(
      '/public/v1/pay/KD7Q2M9X4LZ0',
    )
    expect(routeUrl(paymentsRoutes.streamIntent, { id: 'x' })).toBe(
      '/api/v1/payments/intents/x/stream',
    )
  })
})
