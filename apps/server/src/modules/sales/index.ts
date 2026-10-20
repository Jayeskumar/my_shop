/**
 * sales module — POS, invoices, held bills, estimates, credit notes, offline sync, public invoice.
 * Owned by the sales module (ARCHITECTURE.md §3.1).
 *
 * Endpoints: docs/API.md "sales". Request/response contracts: packages/shared/src/api/sales.ts.
 * Add `routes` (registered under /api/v1), `publicRoutes` (/public/v1), `webhooks` (/webhooks)
 * and `cliCommands` here; background jobs go in ./jobs.ts. See modules/module.ts.
 */
import { defineModule } from '../module'

export const salesModule = defineModule({ name: 'sales' })
