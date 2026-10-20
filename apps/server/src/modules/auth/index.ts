/**
 * auth (foundation) module — login, OTP, sessions, PIN login, /me, on-prem setup.
 * Foundation-owned (ARCHITECTURE.md §3.1): implemented in the Domain phase on top of core/tokens.ts, core/otp.ts, core/passwords.ts and core/rbac.ts.
 *
 * Endpoints: docs/API.md "auth". Request/response contracts: packages/shared/src/api/auth.ts.
 * Add `routes` (registered under /api/v1), `publicRoutes` (/public/v1), `webhooks` (/webhooks)
 * and `cliCommands` here; background jobs go in ./jobs.ts. See modules/module.ts.
 */
import { defineModule } from '../module'

export const authModule = defineModule({ name: 'auth' })
