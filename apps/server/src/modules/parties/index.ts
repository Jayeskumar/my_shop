/**
 * parties module — customers, suppliers, doctors, loyalty.
 * Owned by the parties module (ARCHITECTURE.md §3.1).
 *
 * Endpoints: docs/API.md "parties". Request/response contracts: packages/shared/src/api/parties.ts.
 * Add `routes` (registered under /api/v1), `publicRoutes` (/public/v1), `webhooks` (/webhooks)
 * and `cliCommands` here; background jobs go in ./jobs.ts. See modules/module.ts.
 */
import { defineModule } from '../module'

export const partiesModule = defineModule({ name: 'parties' })
