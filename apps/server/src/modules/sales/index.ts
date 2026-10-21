/**
 * sales module — POS, invoices, held bills, estimates, credit notes, offline sync, public invoice.
 * Owned by the sales module (ARCHITECTURE.md §3.1).
 *
 * Endpoints: docs/API.md "sales & POS". Every route is registered FROM the catalogue
 * `salesRoutes` (@kadai/shared/api/sales): method, path, schemas, permission any-of, feature and
 * idempotency come from the contract. Financial creates (`idempotent` routes) run through
 * idempotentTx (Idempotency-Key header or body client_ref); invoices and credit notes are also
 * unique by client_ref, so a POS retry always gets the same document back.
 *
 * Services: pricing.ts (cart pricing), invoices.ts (posting, held bills, cancel, dues,
 * estimates), credit-notes.ts (returns), print.ts (print models, share, public invoice),
 * bootstrap.ts / sync.ts (offline POS), lists.ts (lists + CSV), detail.ts (read models).
 * Costs (unit_cost_paise / cost_paise) are shown only with reports.read.
 */
import { hasPermission } from '@kadai/shared'
import { salesRoutes } from '@kadai/shared/api/sales'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { audit } from '../../core/audit'
import { systemContext } from '../../core/context'
import { forbidden, notFound } from '../../core/errors'
import { RATE_LIMITS, type RouteImpls, routePlugins } from '../../core/http'
import { withTenant } from '../../db/tenant'
import { defineModule } from '../module'
import { posBootstrap } from './bootstrap'
import { tenantToday } from './common'
import {
  cancelCreditNote,
  createCreditNote,
  loadCreditNoteDetail,
  returnable,
} from './credit-notes'
import { loadInvoiceDetail } from './detail'
import {
  type SalesRuntime,
  cancelInvoice,
  collectPayment,
  completeDraft,
  convertEstimate,
  createEstimate,
  createInvoice,
  deleteDraft,
  listHeld,
  saveResult,
  updateDraft,
} from './invoices'
import { creditNotesCsv, invoicesCsv, listCreditNotes, listInvoices } from './lists'
import { priceSale } from './pricing'
import { creditNotePrintModel, invoicePrintModel, publicInvoice, shareInvoice } from './print'
import { posSync } from './sync'

function runtimeOf(req: FastifyRequest): SalesRuntime {
  return { publicBaseUrl: req.server.kadai.config.publicBaseUrl, metrics: req.server.kadai.metrics }
}

/** ?format=csv exports need an export-capable role and are audited. */
function assertCanExport(req: FastifyRequest): void {
  if (!hasPermission(req.ctx.permissions, ['data.export', 'reports.read'])) {
    throw forbidden('Exporting needs permission', { required: ['data.export', 'reports.read'] })
  }
}

function sendCsv(reply: FastifyReply, filename: string, csv: string): FastifyReply {
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${filename}"`)
    .send(csv)
}

type Impls = RouteImpls<typeof salesRoutes>

const impls: Impls = {
  // ---- POS ------------------------------------------------------------------------------
  posBootstrap: {
    tx: async (tx, req) => ({ data: await posBootstrap(tx, req.ctx, req.query) }),
  },
  posQuote: {
    tx: async (tx, req) => {
      const b = req.body
      const priced = await priceSale(
        tx,
        req.ctx,
        {
          store_id: b.store_id,
          register_id: b.register_id ?? req.ctx.registerId,
          customer_id: b.customer_id ?? null,
          customer: b.customer ?? null,
          place_of_supply: b.place_of_supply ?? null,
          lines: b.lines,
          bill_discount_bp: b.bill_discount_bp,
          bill_discount_paise: b.bill_discount_paise,
          loyalty_redeem_points: b.loyalty_redeem_points,
          rx: b.rx ?? null,
          tenders: b.tenders,
          credit_limit_override: b.credit_limit_override,
          invoice_date: b.invoice_date ?? null,
        },
        { mode: 'quote' },
      )
      return { data: priced.quote }
    },
  },
  posSync: async (req) => ({
    data: await posSync((fn) => req.tx(fn), req.ctx, runtimeOf(req), req.body, req.log),
  }),
  listHeld: { tx: async (tx, req) => ({ data: await listHeld(tx, req.ctx, req.query) }) },

  // ---- invoices -------------------------------------------------------------------------
  createInvoice: {
    tx: async (tx, req) => ({ data: await createInvoice(tx, req.ctx, runtimeOf(req), req.body) }),
  },
  listInvoices: async (req, reply) => {
    if (req.query.format === 'csv') {
      assertCanExport(req)
      const csv = await req.tx(async (tx) => {
        const out = await invoicesCsv(tx, req.ctx, req.query)
        await audit(tx, req.ctx, {
          action: 'sales_invoice.export',
          entity_type: 'sales_invoice',
          summary: 'Bills exported (CSV)',
          changes: { query: req.query },
        })
        return { out, today: await tenantToday(tx, req.ctx) }
      })
      return sendCsv(reply, `bills-${csv.today}.csv`, csv.out)
    }
    return req.tx((tx) => listInvoices(tx, req.ctx, req.query))
  },
  getInvoice: {
    tx: async (tx, req) => ({
      data: await loadInvoiceDetail(tx, req.ctx, req.params.id, runtimeOf(req).publicBaseUrl),
    }),
  },
  updateInvoice: {
    tx: async (tx, req) => {
      await updateDraft(tx, req.ctx, req.params.id, req.body)
      return {
        data: await loadInvoiceDetail(tx, req.ctx, req.params.id, runtimeOf(req).publicBaseUrl),
      }
    },
  },
  deleteInvoice: {
    tx: async (tx, req) => {
      await deleteDraft(tx, req.ctx, req.params.id)
    },
  },
  completeInvoice: {
    tx: async (tx, req) => {
      const rt = runtimeOf(req)
      const r = await completeDraft(tx, req.ctx, rt, req.params.id, req.body)
      return { data: await saveResult(tx, req.ctx, rt, r) }
    },
  },
  cancelInvoice: {
    tx: async (tx, req) => ({
      data: await cancelInvoice(tx, req.ctx, runtimeOf(req), req.params.id, req.body.reason),
    }),
  },
  collectPayment: {
    tx: async (tx, req) => ({
      data: await collectPayment(tx, req.ctx, runtimeOf(req), req.params.id, req.body),
    }),
  },
  printInvoice: {
    tx: async (tx, req) => ({
      data: await invoicePrintModel(tx, req.ctx, req.params.id, {
        format: req.query.format,
        locale: req.query.locale,
        publicBaseUrl: runtimeOf(req).publicBaseUrl,
      }),
    }),
  },
  shareInvoice: {
    tx: async (tx, req) => ({
      data: await shareInvoice(tx, req.ctx, req.params.id, req.body, runtimeOf(req).publicBaseUrl),
    }),
  },
  returnable: { tx: async (tx, req) => ({ data: await returnable(tx, req.ctx, req.params.id) }) },

  // ---- estimates ------------------------------------------------------------------------
  createEstimate: {
    tx: async (tx, req) => ({ data: await createEstimate(tx, req.ctx, runtimeOf(req), req.body) }),
  },
  convertEstimate: {
    tx: async (tx, req) => ({
      data: await convertEstimate(tx, req.ctx, runtimeOf(req), req.params.id, req.body),
    }),
  },

  // ---- credit notes ---------------------------------------------------------------------
  listCreditNotes: async (req, reply) => {
    if (req.query.format === 'csv') {
      assertCanExport(req)
      const csv = await req.tx(async (tx) => {
        const out = await creditNotesCsv(tx, req.ctx, req.query)
        await audit(tx, req.ctx, {
          action: 'credit_note.export',
          entity_type: 'credit_note',
          summary: 'Credit notes exported (CSV)',
          changes: { query: req.query },
        })
        return { out, today: await tenantToday(tx, req.ctx) }
      })
      return sendCsv(reply, `credit-notes-${csv.today}.csv`, csv.out)
    }
    return req.tx((tx) => listCreditNotes(tx, req.ctx, req.query))
  },
  createCreditNote: {
    tx: async (tx, req) => {
      const r = await createCreditNote(tx, req.ctx, req.body)
      return { data: await loadCreditNoteDetail(tx, req.ctx, r.id) }
    },
  },
  getCreditNote: {
    tx: async (tx, req) => ({ data: await loadCreditNoteDetail(tx, req.ctx, req.params.id) }),
  },
  cancelCreditNote: {
    tx: async (tx, req) => {
      await cancelCreditNote(tx, req.ctx, req.params.id, req.body.reason)
      return { data: await loadCreditNoteDetail(tx, req.ctx, req.params.id) }
    },
  },
  printCreditNote: {
    tx: async (tx, req) => ({
      data: await creditNotePrintModel(tx, req.ctx, req.params.id, {
        format: req.query.format,
        locale: req.query.locale,
        publicBaseUrl: runtimeOf(req).publicBaseUrl,
      }),
    }),
  },

  // ---- public -----------------------------------------------------------------------------
  publicInvoice: {
    config: { rateLimit: RATE_LIMITS.public },
    handler: async (req) => {
      const deps = req.server.kadai
      // System pool: the share token is the only key a public visitor has; it identifies the
      // tenant before any tenant context exists (like webhook routing, ARCHITECTURE.md §6.1).
      const hit = await deps.db.systemDb
        .selectFrom('sales_invoices as i')
        .innerJoin('tenants as t', 't.id', 'i.tenant_id')
        .select([
          'i.id',
          'i.tenant_id',
          'i.status',
          't.default_locale',
          't.status as tenant_status',
        ])
        .where('i.share_token', '=', req.params.shareToken)
        .executeTakeFirst()
      if (
        !hit ||
        hit.tenant_status !== 'active' ||
        (hit.status !== 'completed' && hit.status !== 'cancelled' && hit.status !== 'converted')
      ) {
        throw notFound('invoice')
      }
      const ctx = systemContext(hit.tenant_id, {
        requestId: req.id,
        locale: hit.default_locale === 'en' ? 'en' : 'ta',
      })
      return {
        data: await withTenant(deps.db.appDb, ctx, (tx) =>
          publicInvoice(tx, ctx, hit.id, deps.config.publicBaseUrl),
        ),
      }
    },
  },
}

export const salesImpls = impls

export const salesModule = defineModule({ name: 'sales', ...routePlugins(salesRoutes, impls) })
