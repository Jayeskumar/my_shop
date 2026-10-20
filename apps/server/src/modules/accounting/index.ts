/**
 * accounting module — accounts, journals, expenses, shifts, books, financial statements.
 * Owned by the accounting module (ARCHITECTURE.md §3.1).
 *
 * Endpoints: docs/API.md "accounting". Request/response contracts: packages/shared/src/api/accounting.ts.
 * Add `routes` (registered under /api/v1), `publicRoutes` (/public/v1), `webhooks` (/webhooks)
 * and `cliCommands` here; background jobs go in ./jobs.ts. See modules/module.ts.
 */
import { defineModule } from '../module'

export const accountingModule = defineModule({ name: 'accounting' })
