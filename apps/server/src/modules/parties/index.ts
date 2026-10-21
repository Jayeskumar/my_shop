/**
 * parties module — customers & khata, suppliers, doctors, loyalty.
 * Owned by the parties module (ARCHITECTURE.md §3.1).
 *
 * Endpoints: docs/API.md "parties". Every route is registered from the shared catalogue
 * (`partiesRoutes` in @kadai/shared/api/parties): method, path, schemas, permission and feature
 * guards and the idempotency-key check come from the contract. `{ tx }` implementations run in
 * ONE tenant transaction (RLS), replayed through idempotentTx for idempotent creates.
 * Background jobs are in ./jobs.ts.
 */
import { customerImportTemplateCsv, partiesRoutes } from '@kadai/shared/api/parties'
import type { FastifyReply } from 'fastify'
import { audit } from '../../core/audit'
import type { RequestContext } from '../../core/context'
import { notFound } from '../../core/errors'
import { type RouteImpls, type RouteRequestFor, routePlugins } from '../../core/http'
import type { Tx } from '../../db/tenant'
import { defineModule } from '../module'
import { fileSlug, sendCsv } from './common'
import { importCustomers } from './customer-import'
import {
  createCustomer,
  deleteCustomer,
  getCustomer,
  listCustomers,
  lookupCustomerByPhone,
  updateCustomer,
} from './customers'
import { createDoctor, deleteDoctor, getDoctor, listDoctors, updateDoctor } from './doctors'
import { adjustLoyalty, listLoyalty } from './loyalty'
import { type StatementParty, partyStatement, statementCsv } from './statements'
import { customerSummary } from './summary'
import {
  createSupplier,
  deleteSupplier,
  getSupplier,
  listSuppliers,
  updateSupplier,
} from './suppliers'

type Routes = typeof partiesRoutes

async function statementPartyOf(
  tx: Tx,
  ctx: RequestContext,
  type: StatementParty['type'],
  id: string,
): Promise<StatementParty> {
  if (type === 'customer') {
    const row = await tx
      .selectFrom('customers')
      .select(['id', 'name', 'name_ta', 'phone'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row) throw notFound('customer', id)
    return { type, ...row }
  }
  const row = await tx
    .selectFrom('suppliers')
    .select(['id', 'name', 'phone'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .executeTakeFirst()
  if (!row) throw notFound('supplier', id)
  return { type, ...row, name_ta: null }
}

/** Statement route: JSON, or a CSV download (`?format=csv`, audited as a data export). */
// customerLedger and supplierLedger share the params / query schemas.
function statementRoute(type: StatementParty['type']) {
  return async (req: RouteRequestFor<Routes['customerLedger']>, reply: FastifyReply) => {
    const statement = await req.tx(async (tx) => {
      const party = await statementPartyOf(tx, req.ctx, type, req.params.id)
      const st = await partyStatement(tx, req.ctx, party, req.query)
      if (req.query.format === 'csv') {
        await audit(tx, req.ctx, {
          action: `${type}.ledger_export`,
          entity_type: type,
          entity_id: party.id,
          summary: `Ledger of ${party.name} exported (${st.from ?? 'start'} to ${st.to})`,
        })
      }
      return st
    })
    if (req.query.format === 'csv') {
      const name = fileSlug(statement.party.name, statement.party.id.slice(-8))
      return sendCsv(
        reply,
        `${type === 'customer' ? 'khata' : 'supplier-ledger'}-${name}-${statement.to}.csv`,
        statementCsv(statement, req.ctx.locale),
      )
    }
    return { data: statement }
  }
}

export const partiesImpls: RouteImpls<Routes> = {
  // ---- customers ---------------------------------------------------------------------------
  listCustomers: { tx: (tx, req) => listCustomers(tx, req.ctx, req.query) },
  createCustomer: {
    tx: async (tx, req) => ({ data: await createCustomer(tx, req.ctx, req.body) }),
  },
  lookupCustomer: {
    tx: async (tx, req) => ({ data: await lookupCustomerByPhone(tx, req.ctx, req.query.phone) }),
  },
  customerImportTemplate: async (_req, reply) =>
    sendCsv(reply, 'customer-import-template.csv', customerImportTemplateCsv()),
  importCustomers: {
    tx: async (tx, req) => ({
      data: await importCustomers(tx, req.ctx, req.server.kadai.files, req.body),
    }),
  },
  getCustomer: { tx: async (tx, req) => ({ data: await getCustomer(tx, req.ctx, req.params.id) }) },
  updateCustomer: {
    tx: async (tx, req) => ({
      data: await updateCustomer(tx, req.ctx, req.params.id, req.body),
    }),
  },
  deleteCustomer: {
    tx: async (tx, req) => ({ data: await deleteCustomer(tx, req.ctx, req.params.id) }),
  },
  customerLedger: statementRoute('customer'),
  customerSummary: {
    tx: async (tx, req) => ({ data: await customerSummary(tx, req.ctx, req.params.id) }),
  },
  customerLoyalty: { tx: (tx, req) => listLoyalty(tx, req.ctx, req.params.id, req.query) },
  adjustLoyalty: {
    tx: async (tx, req) => ({ data: await adjustLoyalty(tx, req.ctx, req.params.id, req.body) }),
  },

  // ---- suppliers ---------------------------------------------------------------------------
  listSuppliers: { tx: (tx, req) => listSuppliers(tx, req.ctx, req.query) },
  createSupplier: {
    tx: async (tx, req) => ({ data: await createSupplier(tx, req.ctx, req.body) }),
  },
  getSupplier: { tx: async (tx, req) => ({ data: await getSupplier(tx, req.ctx, req.params.id) }) },
  updateSupplier: {
    tx: async (tx, req) => ({
      data: await updateSupplier(tx, req.ctx, req.params.id, req.body),
    }),
  },
  deleteSupplier: {
    tx: async (tx, req) => ({ data: await deleteSupplier(tx, req.ctx, req.params.id) }),
  },
  supplierLedger: statementRoute('supplier'),

  // ---- doctors -----------------------------------------------------------------------------
  listDoctors: { tx: (tx, req) => listDoctors(tx, req.ctx, req.query) },
  createDoctor: { tx: async (tx, req) => ({ data: await createDoctor(tx, req.ctx, req.body) }) },
  getDoctor: { tx: async (tx, req) => ({ data: await getDoctor(tx, req.ctx, req.params.id) }) },
  updateDoctor: {
    tx: async (tx, req) => ({ data: await updateDoctor(tx, req.ctx, req.params.id, req.body) }),
  },
  deleteDoctor: {
    tx: async (tx, req) => ({ data: await deleteDoctor(tx, req.ctx, req.params.id) }),
  },
}

export const partiesModule = defineModule({
  name: 'parties',
  ...routePlugins(partiesRoutes, partiesImpls),
})
