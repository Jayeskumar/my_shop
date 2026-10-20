/**
 * notifications module — outbox, templates, SMS/WhatsApp/email providers, delivery webhooks.
 * Owned by the notifications module (ARCHITECTURE.md §3.1).
 *
 * Endpoints: docs/API.md "notifications". Request/response contracts: packages/shared/src/api/notifications.ts.
 * Add `routes` (registered under /api/v1), `publicRoutes` (/public/v1), `webhooks` (/webhooks)
 * and `cliCommands` here; background jobs go in ./jobs.ts. See modules/module.ts.
 */
import { defineModule } from '../module'

export const notificationsModule = defineModule({ name: 'notifications' })
