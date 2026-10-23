/**
 * reports module — dashboard, sales/stock/party reports, GST returns, H1 register.
 * Owned by the reports module (ARCHITECTURE.md §3.1).
 *
 * Endpoints: docs/API.md "reports & GST". Request/response contracts and the route catalogue:
 * packages/shared/src/api/reports.ts (`reportsRoutes`) — registered here with registerRoutes, so
 * method, path, schemas, the permission (reports.read / reports.gst) and the plan feature
 * (reports_basic / advanced_reports / batches_expiry / shifts / gst_reports) come from the
 * contract. Every report is read-only and SQL-aggregated inside the request's tenant transaction;
 * `?format=csv` downloads are audited as data exports (report.export / gst.gstr1_export).
 */
import type { FastifyReply } from 'fastify'
import type { z } from 'zod'
import type { RouteResponse } from '@kadai/shared/api/common'
import { reportsRoutes } from '@kadai/shared/api/reports'
import {
  type KadaiPlugin,
  type RouteHandlerFor,
  type RouteImpls,
  registerRoutes,
} from '../../core/http'
import type { Tx } from '../../db/tenant'
import { defineModule } from '../module'
import {
  type Ctx,
  type ReportEnv,
  type ReportOutcome,
  type StoreScope,
  reportEnv,
  resolveScope,
  sendFile,
  sendOutcome,
} from './common'
import { dashboard } from './dashboard'
import { gstr1Export, gstr1Report, gstr3bReport } from './gst'
import { customerOutstanding, supplierOutstanding } from './parties'
import { h1Register, scheduleSales } from './pharmacy'
import { hsnSummary, purchaseRegister, salesRegister } from './registers'
import {
  brandSales,
  cancellations,
  categorySales,
  discounts,
  itemSales,
  profit,
  salesSummary,
  shiftsReport,
} from './sales'
import { deadStock, expiry, stockAgeing, stockSummary } from './stock'

type ReportsRoutes = typeof reportsRoutes
type QueryOf<K extends keyof ReportsRoutes> = z.output<ReportsRoutes[K]['query']>
type BodyOf<K extends keyof ReportsRoutes> = ReportsRoutes[K] extends { response: z.ZodType }
  ? z.output<ReportsRoutes[K]['response']>
  : never

/**
 * A tabular report route: report environment + store scope (`store_id`), then the builder; the
 * envelope is returned, or the CSV is sent once the transaction (with its audit row) committed.
 */
function tabular<K extends keyof ReportsRoutes>(
  build: (
    tx: Tx,
    ctx: Ctx,
    env: ReportEnv,
    scope: StoreScope,
    q: QueryOf<K>,
  ) => Promise<ReportOutcome<BodyOf<K>>>,
): RouteHandlerFor<ReportsRoutes[K]> {
  return async (req, reply: FastifyReply) => {
    const q = req.query as QueryOf<K>
    const storeId = (q as { store_id?: string }).store_id
    const outcome = await req.tx(async (tx) => {
      const env = await reportEnv(tx, req.ctx)
      const scope = await resolveScope(tx, req.ctx, storeId)
      return build(tx, req.ctx, env, scope, q)
    })
    // The builder's body type is the route's response type (BodyOf<K>); TS cannot see through K.
    return sendOutcome(reply, outcome) as RouteResponse<ReportsRoutes[K]> | FastifyReply
  }
}

const impls: RouteImpls<ReportsRoutes> = {
  dashboard: async (req) => {
    const data = await req.tx(async (tx) => {
      const env = await reportEnv(tx, req.ctx)
      const scope = await resolveScope(tx, req.ctx, req.query.store_id)
      return dashboard(tx, req.ctx, env, scope, req.query)
    })
    return { data }
  },
  salesSummary: tabular<'salesSummary'>(salesSummary),
  itemSales: tabular<'itemSales'>(itemSales),
  categorySales: tabular<'categorySales'>(categorySales),
  brandSales: tabular<'brandSales'>(brandSales),
  profit: tabular<'profit'>(profit),
  discounts: tabular<'discounts'>(discounts),
  cancellations: tabular<'cancellations'>(cancellations),
  shifts: tabular<'shifts'>(shiftsReport),
  stockSummary: tabular<'stockSummary'>(stockSummary),
  stockAgeing: tabular<'stockAgeing'>(stockAgeing),
  expiry: tabular<'expiry'>(expiry),
  deadStock: tabular<'deadStock'>(deadStock),
  customerOutstanding: tabular<'customerOutstanding'>(customerOutstanding),
  supplierOutstanding: tabular<'supplierOutstanding'>(supplierOutstanding),
  gstr1: async (req) => {
    const data = await req.tx(async (tx) =>
      gstr1Report(tx, req.ctx, await reportEnv(tx, req.ctx), req.query),
    )
    return { data }
  },
  gstr1Export: async (req, reply) => {
    const file = await req.tx(async (tx) =>
      gstr1Export(tx, req.ctx, await reportEnv(tx, req.ctx), req.query),
    )
    return sendFile(reply, file.filename, file.body, file.contentType)
  },
  gstr3b: async (req) => {
    const data = await req.tx(async (tx) =>
      gstr3bReport(tx, req.ctx, await reportEnv(tx, req.ctx), req.query),
    )
    return { data }
  },
  hsnSummary: tabular<'hsnSummary'>(hsnSummary),
  salesRegister: tabular<'salesRegister'>(salesRegister),
  purchaseRegister: tabular<'purchaseRegister'>(purchaseRegister),
  h1Register: tabular<'h1Register'>(h1Register),
  scheduleSales: tabular<'scheduleSales'>(scheduleSales),
}

/** Implementations by route key (the tests assert that none is missing). */
export const reportsImpls = impls

const routes: KadaiPlugin = async (app) => {
  registerRoutes(app, reportsRoutes, impls)
}

export const reportsModule = defineModule({ name: 'reports', routes })
