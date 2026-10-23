/**
 * Payment link for a due reminder. The payments module owns links (POST /payments/links); its
 * service is not importable from here, so — as agreed in the payments contract — a reminder
 * creates the link intent itself, exactly like the payments module does for a static UPI ID:
 *
 *   payment_intents row: kind 'link', purpose 'customer_due', ref customer, provider 'upi_vpa'
 *   (the store's default active UPI ID account, else the all-stores one), status 'pending',
 *   a 12-character reference_code (UPI `tr`), the NPCI upi://pay URI and
 *   short_url = PUBLIC_BASE_URL/pay/<reference_code> — the public pay page of the payments
 *   module (GET /public/v1/pay/:referenceCode), which applies the money FIFO once confirmed.
 *
 * Without an active UPI ID account there is no link (the reminder then shows the shop's UPI ID
 * or phone instead).
 */
import {
  UPI_NOTE_MAX_LENGTH,
  buildUpiUri,
  generateReferenceCode,
  isValidVpa,
  newId,
} from '@kadai/shared'
import type { PaymentIntent } from '@kadai/shared/api/payments'
import type { Config } from '../../config'
import type { RequestContext } from '../../core/context'
import { jsonb } from '../../db/json'
import type { Tx } from '../../db/tenant'
import { iso } from './common'

/** Hours a reminder's pay link stays open (payments: PaymentLinkCreateSchema default). */
export const DUE_LINK_EXPIRES_IN_HOURS = 72

export interface DueLink {
  intent: PaymentIntent
  url: string
  kind: 'provider' | 'pay_page'
}

interface VpaAccount {
  id: string
  display_name: string
  vpa: string
  payee_name: string | null
  merchant_code: string | null
}

/** The UPI ID account used for a store's links: store default, then all-stores default. */
export async function vpaAccountFor(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId'>,
  storeId: string,
): Promise<VpaAccount | null> {
  const rows = await tx
    .selectFrom('payment_provider_accounts')
    .select(['id', 'display_name', 'vpa', 'payee_name', 'merchant_code', 'store_id', 'is_default'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('provider', '=', 'upi_vpa')
    .where('is_active', '=', true)
    .where((eb) => eb.or([eb('store_id', '=', storeId), eb('store_id', 'is', null)]))
    .orderBy(({ eb }) => eb('store_id', 'is not', null), 'desc')
    .orderBy('is_default', 'desc')
    .orderBy('created_at')
    .execute()
  const row = rows.find((r) => r.vpa && isValidVpa(r.vpa))
  return row?.vpa
    ? {
        id: row.id,
        display_name: row.display_name,
        vpa: row.vpa,
        payee_name: row.payee_name,
        merchant_code:
          row.merchant_code && /^\d{4}$/.test(row.merchant_code) ? row.merchant_code : null,
      }
    : null
}

/** Creates the link intent (see the module comment); null when the store has no UPI ID. */
export async function createDueLinkIntent(
  tx: Tx,
  ctx: Pick<RequestContext, 'tenantId' | 'userId'>,
  config: Pick<Config, 'publicBaseUrl'>,
  input: {
    customer: { id: string; name: string }
    store_id: string
    amount_paise: number
    shop_name: string
    now?: Date
  },
): Promise<DueLink | null> {
  const account = await vpaAccountFor(tx, ctx, input.store_id)
  if (!account) return null
  const now = input.now ?? new Date()
  const expiresAt = new Date(now.getTime() + DUE_LINK_EXPIRES_IN_HOURS * 3_600_000)
  const note = `${input.shop_name} dues`.slice(0, UPI_NOTE_MAX_LENGTH)
  for (let attempt = 0; attempt < 5; attempt++) {
    const referenceCode = generateReferenceCode()
    const url = `${config.publicBaseUrl}/pay/${referenceCode}`
    const upiUri = buildUpiUri({
      vpa: account.vpa,
      payee_name: account.payee_name?.trim() || input.shop_name,
      amount_paise: input.amount_paise,
      note,
      reference: referenceCode,
      mcc: account.merchant_code,
    })
    const row = await tx
      .insertInto('payment_intents')
      .values({
        id: newId(),
        tenant_id: ctx.tenantId,
        store_id: input.store_id,
        provider_account_id: account.id,
        provider: 'upi_vpa',
        kind: 'link',
        purpose: 'customer_due',
        ref_type: 'customer',
        ref_id: input.customer.id,
        customer_id: input.customer.id,
        reference_code: referenceCode,
        amount_paise: input.amount_paise,
        status: 'pending',
        upi_uri: upiUri,
        short_url: url,
        expires_at: expiresAt,
        metadata: jsonb({ source: 'due_reminder', note }),
        created_by: ctx.userId,
      })
      .onConflict((oc) => oc.columns(['tenant_id', 'reference_code']).doNothing())
      .returningAll()
      .executeTakeFirst()
    if (!row) continue
    const intent: PaymentIntent = {
      id: row.id,
      store_id: row.store_id,
      register_id: row.register_id,
      provider_account_id: row.provider_account_id,
      provider: 'upi_vpa',
      provider_display_name: account.display_name,
      kind: 'link',
      purpose: 'customer_due',
      ref_type: 'customer',
      ref_id: row.ref_id,
      customer_id: row.customer_id,
      customer_name: input.customer.name,
      reference_code: row.reference_code,
      amount_paise: Number(row.amount_paise),
      currency: 'INR',
      status: 'pending',
      upi_uri: row.upi_uri,
      image_url: null,
      short_url: row.short_url,
      provider_ref: row.provider_ref,
      provider_payment_id: row.provider_payment_id,
      payer_vpa: row.payer_vpa,
      payer_name: row.payer_name,
      utr: row.utr,
      paid_amount_paise: row.paid_amount_paise === null ? null : Number(row.paid_amount_paise),
      fee_paise: row.fee_paise === null ? null : Number(row.fee_paise),
      amount_mismatch: false,
      confirmation: null,
      confirmed_by: null,
      confirmed_by_name: null,
      payment_id: null,
      payment_number: null,
      expires_at: iso(expiresAt),
      expires_in_seconds: Math.max(0, Math.round((expiresAt.getTime() - now.getTime()) / 1000)),
      paid_at: null,
      failure_reason: null,
      poll_count: row.poll_count,
      last_polled_at: null,
      created_by: row.created_by,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    }
    return { intent, url, kind: 'pay_page' }
  }
  throw new Error('could not allocate a unique payment reference code')
}
