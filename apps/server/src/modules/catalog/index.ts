/**
 * catalog module — categories, brands, tax slab rules, products, variants, barcodes, promotions, store prices, labels.
 * Owned by the catalog module (ARCHITECTURE.md §3.1).
 *
 * Endpoints: docs/API.md "catalog". Request/response contracts: packages/shared/src/api/catalog.ts.
 * Add `routes` (registered under /api/v1), `publicRoutes` (/public/v1), `webhooks` (/webhooks)
 * and `cliCommands` here; background jobs go in ./jobs.ts. See modules/module.ts.
 */
import { defineModule } from '../module'

export const catalogModule = defineModule({ name: 'catalog' })
