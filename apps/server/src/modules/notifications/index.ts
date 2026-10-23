/**
 * notifications module — outbox, templates, SMS / WhatsApp / email providers, delivery webhooks,
 * due reminders and the owner's daily summary. Owned by the notifications module
 * (ARCHITECTURE.md §3.1, §15).
 *
 * Endpoints: docs/API.md "notifications". Every route is registered from the shared catalogue
 * (`notificationsRoutes` in @kadai/shared/api/notifications), so method, path, schemas,
 * permission / feature guards and the idempotency-key check come from the contract. `{ tx }`
 * implementations run in ONE tenant transaction (RLS); idempotent ones replay through
 * idempotentTx. Background jobs are in ./jobs.ts; providers in ./providers.
 *
 * The enqueue side of the outbox is core/notify.ts enqueueNotification() (used by every module).
 */
import type { FastifyRequest } from 'fastify'
import {
  ADHOC_SEND_RATE_LIMIT,
  type NotificationsRoutes,
  notificationsRoutes,
  requiresWhatsAppOptIn,
} from '@kadai/shared/api/notifications'
import { audit } from '../../core/audit'
import { unprocessable } from '../../core/errors'
import { type KadaiPlugin, RATE_LIMITS, type RouteImpls, registerRoutes } from '../../core/http'
import { enqueueNotification } from '../../core/notify'
import { defineModule } from '../module'
import { loadShop } from './common'
import { listNotifications, loadNotification, retryNotification } from './outbox'
import { installNotificationProviders } from './providers'
import { channelUsable, remindCustomer } from './reminders'
import { deleteTemplate, listTemplates, upsertTemplate } from './templates'
import { handleDeliveryWebhook, verifyWebhookSubscription } from './webhooks'

/** POST /notifications/send: ADHOC_SEND_RATE_LIMIT per business (all its users together). */
const adhocRateLimit = {
  max: ADHOC_SEND_RATE_LIMIT.max,
  timeWindow: ADHOC_SEND_RATE_LIMIT.window_seconds * 1000,
  keyGenerator: (req: FastifyRequest) =>
    req.hasCtx ? `notify-send:${req.ctx.tenantId}` : `notify-send:ip:${req.ip}`,
}

export const notificationImpls: RouteImpls<NotificationsRoutes> = {
  listNotifications: {
    tx: (tx, req) => listNotifications(tx, req.ctx, req.query),
  },
  getNotification: {
    tx: async (tx, req) => ({ data: await loadNotification(tx, req.ctx, req.params.id) }),
  },
  retryNotification: {
    tx: async (tx, req) => ({ data: await retryNotification(tx, req.ctx, req.params.id) }),
  },
  sendNotification: {
    config: { rateLimit: adhocRateLimit },
    tx: async (tx, req) => {
      const b = req.body
      const deps = req.server.kadai
      const registry = installNotificationProviders(deps.config, deps.logger)
      if (!channelUsable(registry, deps.config, b.channel))
        throw unprocessable(`No ${b.channel} service is set up`, {
          reason: 'channel_not_configured',
        })
      if (requiresWhatsAppOptIn(b.template_code, b.channel)) {
        const optedOut = await tx
          .selectFrom('customers')
          .select('id')
          .where('tenant_id', '=', req.ctx.tenantId)
          .where('phone', '=', b.to)
          .where('whatsapp_opt_in', '=', false)
          .executeTakeFirst()
        if (optedOut)
          throw unprocessable('The customer opted out of WhatsApp messages', {
            reason: 'whatsapp_opt_out',
          })
      }
      const shop = await loadShop(tx, req.ctx)
      const queued = await enqueueNotification(tx, req.ctx, {
        channel: b.channel,
        template_code: b.template_code,
        to: b.to,
        recipient_name: b.recipient_name ?? null,
        locale: b.locale ?? shop.default_locale,
        params: b.params,
        ref_type: b.ref_type ?? null,
        ref_id: b.ref_id ?? null,
        scheduled_at: b.scheduled_at ?? null,
      })
      await audit(tx, req.ctx, {
        action: 'notification.send',
        entity_type: 'notification',
        entity_id: queued.id,
        summary: `${b.template_code} by ${b.channel}`,
        changes: {
          channel: b.channel,
          template_code: b.template_code,
          ref_type: b.ref_type ?? null,
          ref_id: b.ref_id ?? null,
        },
      })
      return { data: await loadNotification(tx, req.ctx, queued.id) }
    },
  },
  listTemplates: {
    tx: async (tx, req) => ({
      data: await listTemplates(tx, req.ctx, req.server.kadai, req.query),
    }),
  },
  upsertTemplate: {
    tx: async (tx, req) => ({
      data: await upsertTemplate(tx, req.ctx, req.server.kadai.config, req.params, req.body),
    }),
  },
  deleteTemplate: {
    tx: async (tx, req) => ({
      data: await deleteTemplate(tx, req.ctx, req.server.kadai.config, req.params),
    }),
  },
  remindCustomer: {
    tx: async (tx, req) => ({
      data: await remindCustomer(tx, req.ctx, req.server.kadai, req.params.id, req.body),
    }),
  },
  webhook: {
    config: { rateLimit: RATE_LIMITS.webhook },
    handler: async (req) => {
      await handleDeliveryWebhook(req.server.kadai, req, req.params.provider)
      return { data: { ok: true as const } }
    },
  },
  webhookVerify: {
    config: { rateLimit: RATE_LIMITS.webhook },
    handler: async (req, reply) =>
      verifyWebhookSubscription(req.server.kadai, req.params.provider, req.query, reply),
  },
}

const routes: KadaiPlugin = async (app) => {
  installNotificationProviders(app.kadai.config, app.kadai.logger)
  registerRoutes(app, notificationsRoutes, notificationImpls)
}

const webhooks: KadaiPlugin = async (app) => {
  registerRoutes(app, notificationsRoutes, notificationImpls)
}

export const notificationsModule = defineModule({ name: 'notifications', routes, webhooks })
