/**
 * onprem module — the shop side of Kadai Server (mode onprem; ARCHITECTURE.md §21): licence
 * status / activation / offline licence files, vendor check-ins and banners, renewals, updates
 * through the host updater, local and cloud backups, Kadai Connect opt-in, LAN / disk info and
 * the support bundle.
 *
 * Endpoints: docs/API.md "on-prem system". Contracts: packages/shared/src/api/onprem.ts
 * (`onpremRoutes`, every route mode 'onprem'). Background jobs go in ./jobs.ts.
 */
import { defineModule } from '../module'

export const onpremModule = defineModule({ name: 'onprem' })
