/**
 * reports module — dashboard, sales/stock/party reports, GST returns, H1 register.
 * Owned by the reports module (ARCHITECTURE.md §3.1).
 *
 * Endpoints: docs/API.md "reports". Request/response contracts: packages/shared/src/api/reports.ts.
 * Add `routes` (registered under /api/v1), `publicRoutes` (/public/v1), `webhooks` (/webhooks)
 * and `cliCommands` here; background jobs go in ./jobs.ts. See modules/module.ts.
 */
import { defineModule } from '../module'

export const reportsModule = defineModule({ name: 'reports' })
