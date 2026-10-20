/**
 * platform module — plans, subscriptions, SaaS billing, platform admin, license, backups, API keys, system info.
 * Owned by the platform module (ARCHITECTURE.md §3.1).
 *
 * Endpoints: docs/API.md "platform". Request/response contracts: packages/shared/src/api/platform.ts.
 * Add `routes` (registered under /api/v1), `publicRoutes` (/public/v1), `webhooks` (/webhooks)
 * and `cliCommands` here; background jobs go in ./jobs.ts. See modules/module.ts.
 */
import { defineModule } from '../module'

export const platformModule = defineModule({ name: 'platform' })
