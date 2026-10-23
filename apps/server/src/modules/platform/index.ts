/**
 * platform module — cloud plans, subscriptions and SaaS billing, announcements, API keys and system
 * info (on-prem licence/backups: modules/onprem; vendor console: modules/licensing).
 * Owned by the platform module (ARCHITECTURE.md §3.1).
 *
 * Endpoints: docs/API.md "platform". Request/response contracts: packages/shared/src/api/platform.ts.
 */
import type { FastifyInstance } from 'fastify'
import { platformRoutes } from '@kadai/shared/api/platform'
import { registerRoutes } from '../../core/http'
import { WORKER_HEARTBEAT_KEY } from '../../plugins/health'
import { defineModule } from '../module'
import { announcementHandlers } from './announcements'
import { apiKeyHandlers } from './api-keys'
import { billingImpls } from './billing'
import { createRazorpayClient } from './razorpay'
import type { PlatformRuntime } from './runtime'
import { resolvePlatformSettings } from './settings'
import { systemInfoHandlers } from './system-info'
import { webhookHandlers } from './webhook'

function createRuntime(app: FastifyInstance): PlatformRuntime {
  const settings = resolvePlatformSettings(app.kadai.config)
  return {
    deps: app.kadai,
    settings,
    razorpay: createRazorpayClient(settings.razorpay),
    now: () => new Date(),
    heartbeatKey: WORKER_HEARTBEAT_KEY,
  }
}

export const platformModule = defineModule({
  name: 'platform',
  routes: async (app) => {
    const rt = createRuntime(app)
    registerRoutes(app, platformRoutes, {
      ...billingImpls(rt),
      ...announcementHandlers(rt),
      ...systemInfoHandlers(rt),
      ...apiKeyHandlers(rt),
    })
  },
  webhooks: async (app) => {
    const rt = createRuntime(app)
    registerRoutes(app, platformRoutes, webhookHandlers(rt))
  },
})
