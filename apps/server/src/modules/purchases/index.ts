/**
 * purchases module — purchase orders, purchase bills (GRN), debit notes.
 * Owned by the purchases module (ARCHITECTURE.md §3.1).
 *
 * Endpoints: docs/API.md "purchases". Request/response contracts: packages/shared/src/api/purchases.ts.
 * Add `routes` (registered under /api/v1), `publicRoutes` (/public/v1), `webhooks` (/webhooks)
 * and `cliCommands` here; background jobs go in ./jobs.ts. See modules/module.ts.
 */
import { defineModule } from '../module'

export const purchasesModule = defineModule({ name: 'purchases' })
