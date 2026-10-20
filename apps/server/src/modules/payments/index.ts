/**
 * payments module — providers, UPI intents, webhooks, receipts/vouchers, reconciliation.
 * Owned by the payments module (ARCHITECTURE.md §3.1).
 *
 * Endpoints: docs/API.md "payments". Request/response contracts: packages/shared/src/api/payments.ts.
 * Add `routes` (registered under /api/v1), `publicRoutes` (/public/v1), `webhooks` (/webhooks)
 * and `cliCommands` here; background jobs go in ./jobs.ts. See modules/module.ts.
 */
import { defineModule } from '../module'

export const paymentsModule = defineModule({ name: 'payments' })
