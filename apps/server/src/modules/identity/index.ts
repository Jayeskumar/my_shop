/**
 * identity module — users, roles, stores, registers, devices, settings, number series, audit log, files.
 * Owned by the identity module (ARCHITECTURE.md §3.1).
 *
 * Endpoints: docs/API.md "identity". Request/response contracts: packages/shared/src/api/identity.ts.
 * Add `routes` (registered under /api/v1), `publicRoutes` (/public/v1), `webhooks` (/webhooks)
 * and `cliCommands` here; background jobs go in ./jobs.ts. See modules/module.ts.
 */
import { defineModule } from '../module'

export const identityModule = defineModule({ name: 'identity' })
