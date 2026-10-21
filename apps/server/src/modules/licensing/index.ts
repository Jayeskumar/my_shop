/**
 * licensing module — the vendor control plane (cloud deployment with KADAI_VENDOR_CONSOLE=true;
 * ARCHITECTURE.md §21, docs/PRODUCT.md): on-prem licences, activations, AMC renewals, offers and
 * coupons, vendor orders and invoices, partners and commissions, releases, announcements, cloud
 * tenant admin, Kadai Connect, cloud backups and the messaging relay. Tables of migration 0010
 * (system pool only).
 *
 * Endpoints: docs/API.md "licensing & vendor console". Contracts: packages/shared/src/api/licensing.ts
 * — `licensingRoutes` (console, `routes` under /api/v1, tenant-less user tokens: register with
 * `route(app, def, handler, { config: { auth: 'user' }, preHandler: [staff guard] })`) and
 * `licensingPublicRoutes` (`publicRoutes` under /public/v1). Background jobs go in ./jobs.ts.
 */
import { defineModule } from '../module'

export const licensingModule = defineModule({ name: 'licensing' })
