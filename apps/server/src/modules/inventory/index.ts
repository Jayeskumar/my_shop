/**
 * inventory module — stock levels, movements, batches, adjustments, transfers, alerts.
 * Owned by the inventory module (ARCHITECTURE.md §3.1).
 *
 * Endpoints: docs/API.md "inventory". Request/response contracts: packages/shared/src/api/inventory.ts.
 * Add `routes` (registered under /api/v1), `publicRoutes` (/public/v1), `webhooks` (/webhooks)
 * and `cliCommands` here; background jobs go in ./jobs.ts. See modules/module.ts.
 */
import { defineModule } from '../module'

export const inventoryModule = defineModule({ name: 'inventory' })
