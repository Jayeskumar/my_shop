/**
 * POST /webhooks/platform/razorpay — verifies the Razorpay platform webhook signature,
 * deduplicates events in payment_webhook_events (provider 'razorpay_platform'), and fulfils
 * cloud_plan orders or transitions Razorpay subscriptions.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { newId } from '@kadai/shared'
import {
  PLATFORM_WEBHOOK_PROVIDER,
  RAZORPAY_SUBSCRIPTION_EVENT_STATUS,
  type PlatformRazorpayEvent,
  type platformRoutes,
} from '@kadai/shared/api/platform'
import { AppError } from '../../core/errors'
import type { RouteImpls } from '../../core/http'
import { jsonb } from '../../db/json'
import { withSystemTx } from '../../db/tenant'
import {
  fulfilPlanOrder,
  loadCheckoutByOrder,
  loadCheckoutByRef,
  lockOrder,
  orderTerms,
} from './fulfilment'
import type { PlatformRuntime } from './runtime'
import { loadLiveSubscription, setTenantPlan } from './subscriptions'

type Routes = typeof platformRoutes

function verifySignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(signature, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export function webhookHandlers(
  rt: PlatformRuntime,
): Pick<RouteImpls<Routes>, 'razorpayWebhook'> {
  const { deps } = rt
  return {
    razorpayWebhook: {
      handler: async (req) => {
        const secret = rt.settings.razorpay.webhookSecret
        const sig = req.headers['x-razorpay-signature'] as string | undefined
        const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}), 'utf8')
        if (secret && !verifySignature(rawBody, sig, secret)) {
          throw new AppError('UNAUTHENTICATED', 'Invalid Razorpay webhook signature')
        }

        const payload = (req.body ?? {}) as Record<string, unknown>
        const event = typeof payload.event === 'string' ? payload.event : 'unknown'
        const eventId =
          (req.headers['x-razorpay-event-id'] as string | undefined) ??
          (typeof payload.id === 'string' ? payload.id : newId())

        const now = rt.now()
        // systemDb: payment_webhook_events and vendor_orders are system-level tables.
        await withSystemTx(deps.db.systemDb, async (tx) => {
          const inserted = await tx
            .insertInto('payment_webhook_events')
            .values({
              id: newId(),
              provider: PLATFORM_WEBHOOK_PROVIDER,
              event_id: eventId,
              event_type: event,
              payload: jsonb(payload),
              signature_valid: true,
              processed_at: now,
            })
            .onConflict((oc) => oc.columns(['provider', 'event_id']).doNothing())
            .returning('id')
            .executeTakeFirst()
          if (!inserted) return

          const inner = (payload.payload ?? {}) as Record<
            string,
            Record<string, Record<string, unknown>>
          >
          if (event === 'payment_link.paid') {
            const plink = inner.payment_link?.entity
            const payment = inner.payment?.entity
            const refId = typeof plink?.reference_id === 'string' ? plink.reference_id : null
            const plinkId = typeof plink?.id === 'string' ? plink.id : null
            const paymentId = typeof payment?.id === 'string' ? payment.id : plinkId
            const checkout = plinkId ? await loadCheckoutByRef(tx, plinkId) : null
            const orderId = checkout?.order_id ?? refId
            if (orderId) {
              const order = await lockOrder(tx, orderId)
              if (order && order.kind === 'cloud_plan' && order.status !== 'fulfilled') {
                const chk = checkout ?? (await loadCheckoutByOrder(tx, order.id))
                const terms = orderTerms(order, chk)
                if (terms) {
                  await fulfilPlanOrder(
                    tx,
                    { entitlements: deps.entitlements },
                    {
                      order,
                      terms,
                      payment: {
                        provider: 'razorpay',
                        reference: paymentId ?? null,
                        paid_at: now,
                      },
                      now,
                      request_id: req.id,
                    },
                  )
                }
              }
            }
          } else if (
            event.startsWith('subscription.') &&
            event in RAZORPAY_SUBSCRIPTION_EVENT_STATUS
          ) {
            const subEntity = inner.subscription?.entity
            const subId = typeof subEntity?.id === 'string' ? subEntity.id : null
            if (!subId) return
            const nextStatus =
              RAZORPAY_SUBSCRIPTION_EVENT_STATUS[
                event as Extract<PlatformRazorpayEvent, `subscription.${string}`>
              ]
            const existing = await tx
              .selectFrom('subscriptions')
              .select(['id', 'tenant_id', 'plan_code'])
              .where('provider_subscription_id', '=', subId)
              .forUpdate()
              .executeTakeFirst()
            if (existing) {
              await tx
                .updateTable('subscriptions')
                .set({
                  status: nextStatus,
                  ...(nextStatus === 'past_due' ? { past_due_since: now } : {}),
                  ...(nextStatus === 'cancelled' || nextStatus === 'expired'
                    ? { ended_at: now }
                    : {}),
                  updated_at: now,
                })
                .where('id', '=', existing.id)
                .execute()
              if (nextStatus === 'cancelled' || nextStatus === 'expired') {
                const live = await loadLiveSubscription(tx, existing.tenant_id)
                if (!live) {
                  await setTenantPlan(tx, deps.entitlements, existing.tenant_id, 'free')
                }
              }
              await deps.entitlements.invalidate(existing.tenant_id)
            }
          }
        })

        return { data: { ok: true as const } }
      },
    },
  }
}
