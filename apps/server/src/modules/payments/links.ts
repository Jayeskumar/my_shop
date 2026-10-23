/**
 * Dues collection links, the public pay page and the static (standee) UPI QR —
 * docs/API.md "payments & UPI", ARCHITECTURE.md §11.3.
 *
 *  - POST /payments/links: a link intent (kind 'link', purpose customer_due) for the customer's
 *    due (or an amount). A dynamic provider with links (Razorpay; mock in development) creates a
 *    hosted payment link; otherwise the Kadai pay page PUBLIC_BASE_URL/pay/<reference_code> with a
 *    UPI deep link to the shop's UPI ID (tr = reference_code). `send_via` (plan feature
 *    notifications; WhatsApp only to customers who did not opt out) queues the
 *    `payment_link` notification in the same transaction; the response always carries a
 *    ready-made message and a wa.me link for manual sharing. When the link is paid, the receipt
 *    is recorded FIFO against the customer's oldest dues (markIntentPaid).
 *  - GET /public/v1/pay/:referenceCode: the pay page model — no internal ids.
 *  - GET /payments/upi-qr: a `upi://pay` payload of the shop UPI ID without amount (customer
 *    enters it) or with one.
 */
import { type PaymentProviderCode, buildUpiUri, formatINR } from '@kadai/shared'
import { renderNotification, requiresWhatsAppOptIn, waMeUrl } from '@kadai/shared/api/notifications'
import {
  PAYMENT_LINK_TEMPLATE,
  PROVIDER_CAPABILITIES,
  type PaymentLinkCreateSchema,
  type PaymentLinkResult,
  type PublicPayPage,
  type UpiQrPayload,
  type UpiQrQuerySchema,
  isDynamicProvider,
} from '@kadai/shared/api/payments'
import { sql } from 'kysely'
import type { z } from 'zod'
import { canAccessStore, systemContext } from '../../core/context'
import { assertFeature } from '../../core/entitlements'
import { invalidField, notFound } from '../../core/errors'
import { assertStoreAccess } from '../../core/http'
import { enqueueNotification } from '../../core/notify'
import type { KadaiDeps } from '../../core/runtime'
import { type Tx, withTenant } from '../../db/tenant'
import { type Ctx, loadShop, reasonError, recordOf, stringOf } from './common'
import {
  type IntentDeps,
  type IntentRow,
  intentQuery,
  openIntent,
  resolveProviderAccount,
  toIntent,
} from './intents'

type LinkBody = z.output<typeof PaymentLinkCreateSchema>
type UpiQrQuery = z.output<typeof UpiQrQuerySchema>

/** Picks the account of a dues link: explicit, else a dynamic link provider, else the UPI ID. */
async function linkAccount(
  tx: Tx,
  ctx: Ctx,
  storeId: string,
  explicit: string | undefined,
): Promise<{ id: string; provider: PaymentProviderCode }> {
  if (explicit) return resolveProviderAccount(tx, ctx, storeId, explicit)
  const rows = await tx
    .selectFrom('payment_provider_accounts')
    .select(['id', 'provider', 'store_id', 'is_default'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('is_active', '=', true)
    .where((eb) => eb.or([eb('store_id', '=', storeId), eb('store_id', 'is', null)]))
    .orderBy(sql`store_id is null`)
    .orderBy('is_default', 'desc')
    .orderBy('created_at')
    .execute()
  const usable = rows.filter(
    (r) => PROVIDER_CAPABILITIES[r.provider as PaymentProviderCode]?.implemented,
  )
  const dynamic = usable.find((r) => {
    const code = r.provider as PaymentProviderCode
    return isDynamicProvider(code) && PROVIDER_CAPABILITIES[code].links
  })
  if (dynamic) {
    // Only when the plan allows dynamic UPI; otherwise fall back to the pay page.
    const allowed = await assertFeature(ctx, 'upi_dynamic').then(
      () => true,
      () => false,
    )
    if (allowed) return { id: dynamic.id, provider: dynamic.provider as PaymentProviderCode }
  }
  const vpa = usable.find((r) => r.provider === 'upi_vpa')
  if (!vpa) {
    throw reasonError(
      'UNPROCESSABLE',
      'Add the shop UPI ID (or a Razorpay account) to send payment links',
      'no_upi_account',
      { store_id: storeId },
    )
  }
  return { id: vpa.id, provider: 'upi_vpa' }
}

function linkParams(shopName: string, customerName: string, amount: number, link: string) {
  return { shop_name: shopName, customer_name: customerName, amount: formatINR(amount), link }
}

function linkResult(
  row: IntentRow,
  shopName: string,
  customer: { name: string },
  phone: string | null,
  locale: Ctx['locale'],
  channel: 'whatsapp' | 'sms',
): PaymentLinkResult {
  const url = row.short_url ?? ''
  const params = linkParams(shopName, customer.name, row.amount_paise, url)
  const rendered = renderNotification({ code: PAYMENT_LINK_TEMPLATE, channel, locale, params })
  const message = rendered?.body ?? `${shopName}: ${params.amount} — ${url}`
  return {
    intent: toIntent(row),
    url,
    link_kind: row.provider === 'upi_vpa' ? 'pay_page' : 'provider',
    notification_id: stringOf(recordOf(row.metadata).notification_id),
    message,
    wa_me_url: phone ? waMeUrl(phone, message) : null,
  }
}

/**
 * Creates (or replays, same idempotency key) a dues link for a customer. Usable by other modules
 * (e.g. due reminders) with their own context.
 */
export async function createPaymentLink(
  deps: IntentDeps,
  ctx: Ctx,
  body: LinkBody,
  idempotencyKey: string | null,
): Promise<{ result: PaymentLinkResult; replayed: boolean }> {
  const prep = await withTenant(deps.db.appDb, ctx, async (tx) => {
    assertStoreAccess(ctx, body.store_id)
    const customer = await tx
      .selectFrom('customers')
      .select(['id', 'name', 'phone', 'balance_paise', 'is_active', 'whatsapp_opt_in'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', body.customer_id)
      .executeTakeFirst()
    if (!customer) throw notFound('customer', body.customer_id)
    if (body.send_via) {
      // Sending by SMS / WhatsApp is a plan feature; sharing the returned wa.me link is not.
      await assertFeature(ctx, 'notifications')
      if (
        requiresWhatsAppOptIn(PAYMENT_LINK_TEMPLATE, body.send_via) &&
        !customer.whatsapp_opt_in
      ) {
        throw reasonError(
          'UNPROCESSABLE',
          'The customer opted out of WhatsApp messages',
          'whatsapp_opt_out',
        )
      }
    }
    // A retry of an earlier link (same key) keeps its amount even after the due changed.
    const earlier = idempotencyKey
      ? await tx
          .selectFrom('payment_intents')
          .select('amount_paise')
          .where('tenant_id', '=', ctx.tenantId)
          .where('idempotency_key', '=', `link:${idempotencyKey}`)
          .executeTakeFirst()
      : undefined
    const amount = body.amount_paise ?? earlier?.amount_paise ?? customer.balance_paise
    if (amount <= 0) {
      throw reasonError('UNPROCESSABLE', 'The customer has nothing due', 'no_due', {
        balance_paise: customer.balance_paise,
      })
    }
    const phone = body.phone ?? customer.phone
    if (body.send_via && !phone) {
      throw reasonError('UNPROCESSABLE', 'The customer has no mobile number', 'phone_required')
    }
    const account = await linkAccount(tx, ctx, body.store_id, body.provider_account_id)
    const shop = await loadShop(tx, ctx)
    return { customer, amount, phone, account, shopName: shop.name }
  })
  const channel = body.send_via ?? 'whatsapp'
  const { row, replayed } = await openIntent(
    deps,
    ctx,
    {
      kind: 'link',
      purpose: 'customer_due',
      store_id: body.store_id,
      ref_type: 'customer',
      ref_id: prep.customer.id,
      customer_id: prep.customer.id,
      provider_account_id: prep.account.id,
      amount_paise: prep.amount,
      note: body.note ?? null,
      idempotency_key: idempotencyKey ? `link:${idempotencyKey}` : null,
      lifetime_seconds: body.expires_in_hours * 3600,
      link_customer: { name: prep.customer.name, phone: prep.phone },
      metadata: { link_phone: prep.phone },
    },
    {
      onPending: async (tx, intent) => {
        if (!body.send_via || !prep.phone || !intent.short_url) return
        const queued = await enqueueNotification(tx, ctx, {
          channel: body.send_via,
          template_code: PAYMENT_LINK_TEMPLATE,
          to: prep.phone,
          recipient_name: prep.customer.name,
          params: linkParams(
            prep.shopName,
            prep.customer.name,
            intent.amount_paise,
            intent.short_url,
          ),
          ref_type: 'payment_intent',
          ref_id: intent.id,
        })
        return { notification_id: queued.id }
      },
    },
  )
  return {
    result: linkResult(row, prep.shopName, prep.customer, prep.phone, ctx.locale, channel),
    replayed,
  }
}

// ---------------------------------------------------------------------------------------------
// Public pay page
// ---------------------------------------------------------------------------------------------

/** GET /public/v1/pay/:referenceCode */
export async function publicPayPage(
  deps: Pick<KadaiDeps, 'db'>,
  referenceCode: string,
): Promise<PublicPayPage> {
  // System pool: the public link carries only the reference code, so the tenant is resolved from
  // it (like the public invoice link). Only (id, tenant_id) of link intents are read here; the
  // page itself is read in that tenant's RLS transaction.
  const hits = await deps.db.systemDb
    .selectFrom('payment_intents')
    .select(['id', 'tenant_id'])
    .where('reference_code', '=', referenceCode)
    .where('kind', '=', 'link')
    .limit(2)
    .execute()
  const hit = hits.length === 1 ? hits[0] : undefined
  if (!hit) throw notFound('payment_link', referenceCode)
  const ctx = systemContext(hit.tenant_id)
  return withTenant(deps.db.appDb, ctx, async (tx) => {
    const row = await intentQuery(tx, ctx).where('i.id', '=', hit.id).executeTakeFirstOrThrow()
    const acct = await tx
      .selectFrom('payment_provider_accounts')
      .select(['provider', 'vpa', 'payee_name'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', row.provider_account_id)
      .executeTakeFirstOrThrow()
    const shop = await loadShop(tx, ctx)
    const intent = toIntent(row)
    const lapsed =
      (intent.status === 'pending' || intent.status === 'created') &&
      row.expires_at !== null &&
      row.expires_at.getTime() <= Date.now()
    const status = lapsed ? 'expired' : intent.status
    const payable = status === 'pending'
    const isVpa = acct.provider === 'upi_vpa'
    return {
      reference_code: row.reference_code,
      status,
      purpose: intent.purpose,
      amount_paise: row.amount_paise,
      currency: 'INR',
      shop: {
        name: shop.name,
        name_ta: shop.name_ta,
        city: shop.city,
        phone: shop.phone,
        logo_url: null,
      },
      payee: { name: acct.payee_name ?? shop.name, vpa: isVpa ? acct.vpa : null },
      customer_first_name: row.customer_name
        ? (row.customer_name.trim().split(/\s+/)[0] ?? null)
        : null,
      upi_uri: payable ? row.upi_uri : null,
      short_url: payable && !isVpa ? row.short_url : null,
      expires_at: intent.expires_at,
      paid_at: intent.paid_at,
    }
  })
}

// ---------------------------------------------------------------------------------------------
// Static / standee QR
// ---------------------------------------------------------------------------------------------

/** GET /payments/upi-qr */
export async function staticUpiQr(tx: Tx, ctx: Ctx, q: UpiQrQuery): Promise<UpiQrPayload> {
  await assertFeature(ctx, 'upi_static')
  let account:
    | {
        id: string
        vpa: string | null
        payee_name: string | null
        merchant_code: string | null
        store_id: string | null
        provider: string
        is_active: boolean
      }
    | undefined
  const base = tx
    .selectFrom('payment_provider_accounts')
    .select(['id', 'vpa', 'payee_name', 'merchant_code', 'store_id', 'provider', 'is_active'])
    .where('tenant_id', '=', ctx.tenantId)
  if (q.provider_account_id) {
    account = await base.where('id', '=', q.provider_account_id).executeTakeFirst()
    if (!account || (account.store_id && !canAccessStore(ctx, account.store_id))) {
      throw notFound('payment_provider_account', q.provider_account_id)
    }
    if (account.provider !== 'upi_vpa' || !account.vpa) {
      throw reasonError('UNPROCESSABLE', 'A static QR needs a UPI ID account', 'not_static_upi')
    }
    if (!account.is_active) {
      throw reasonError(
        'UNPROCESSABLE',
        'The payment provider account is inactive',
        'provider_account_inactive',
      )
    }
    if (q.store_id && account.store_id && account.store_id !== q.store_id) {
      throw reasonError(
        'UNPROCESSABLE',
        'The UPI ID belongs to another store',
        'provider_account_invalid',
      )
    }
  } else {
    if (!q.store_id) throw invalidField('store_id', 'store_id or provider_account_id is required')
    const storeId = q.store_id
    assertStoreAccess(ctx, storeId)
    account = await base
      .where('provider', '=', 'upi_vpa')
      .where('is_active', '=', true)
      .where((eb) => eb.or([eb('store_id', '=', storeId), eb('store_id', 'is', null)]))
      .orderBy(sql`store_id is null`)
      .orderBy('is_default', 'desc')
      .orderBy('created_at')
      .executeTakeFirst()
    if (!account || !account.vpa) {
      throw reasonError('UNPROCESSABLE', 'No UPI ID is set up for this store', 'no_upi_account', {
        store_id: storeId,
      })
    }
  }
  if (q.store_id) assertStoreAccess(ctx, q.store_id)
  const vpa = account.vpa as string
  const shop = await loadShop(tx, ctx)
  const storeId = q.store_id ?? account.store_id
  const store = storeId
    ? await tx
        .selectFrom('stores')
        .select(['id', 'name', 'name_ta'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', storeId)
        .executeTakeFirst()
    : undefined
  if (storeId && !store) throw notFound('store', storeId)
  const payee = account.payee_name ?? shop.name.slice(0, 50)
  return {
    provider_account_id: account.id,
    vpa,
    payee_name: payee,
    merchant_code: account.merchant_code,
    amount_paise: q.amount_paise ?? null,
    note: q.note ?? null,
    upi_uri: buildUpiUri({
      vpa,
      payee_name: payee,
      amount_paise: q.amount_paise ?? null,
      note: q.note ?? null,
      mcc: account.merchant_code,
    }),
    shop: { name: shop.name, name_ta: shop.name_ta },
    store: store ? { id: store.id, name: store.name, name_ta: store.name_ta } : null,
  }
}
