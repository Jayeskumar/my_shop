/**
 * POST /pos/sync — offline bills and returns uploaded by a register (ARCHITECTURE.md §12).
 *
 * Invoices first, then credit notes, each in array (= creation) order and each in its OWN
 * transaction, so one failure does not block the rest. Per item:
 *  - a client_ref already uploaded → `duplicate` (the same document is returned);
 *  - the offline number is kept when it is the series' next number (acceptOfflineNumber), else
 *    the bill is renumbered (`renumbered`, audited for review);
 *  - stock may go negative (lines flagged in meta, audited); monthly usage is counted without
 *    enforcement (the bill was already given to the customer); policy problems (overrides, credit
 *    limit, rx…) are reported as warnings and audited, while what cannot be posted at all fails.
 */
import type { FastifyBaseLogger } from 'fastify'
import { ZodError } from 'zod'
import {
  type PosSyncRequestSchema,
  type PosSyncResult,
  type SyncItemResult,
  salesDocumentModeFor,
} from '@kadai/shared/api/sales'
import type { z } from 'zod'
import type { Tx } from '../../db/tenant'
import { audit } from '../../core/audit'
import { AppError, isAppError } from '../../core/errors'
import { peekSeries } from '../../core/numbering'
import { type SalesCtx, loadRegister, salesEnv } from './common'
import { createCreditNote } from './credit-notes'
import { type SalesRuntime, commitInvoice } from './invoices'

type SyncBody = z.output<typeof PosSyncRequestSchema>
type RunTx = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>

function errorOf(err: unknown, log: FastifyBaseLogger): SyncItemResult['error'] {
  if (isAppError(err)) {
    return { code: err.code, message: err.message, details: err.details ?? null }
  }
  if (err instanceof ZodError) {
    return {
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
      details: {
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    }
  }
  const pg = err as { code?: unknown; constraint?: unknown }
  if (pg && pg.code === '23505') {
    return {
      code: 'DUPLICATE',
      message: 'Already uploaded',
      details: { constraint: typeof pg.constraint === 'string' ? pg.constraint : null },
    }
  }
  log.error({ err }, 'pos sync item failed')
  return { code: 'INTERNAL', message: 'Unexpected error', details: null }
}

interface RetiredHeld {
  id: string
  /** removed: the held bill was deleted; conflict: it was already completed / cancelled. */
  outcome: 'removed' | 'conflict'
  status: string
  number: string | null
}

/**
 * The held bill (or draft) an offline bill was made from: deleted when it is still open in the
 * register's store (drafts may be deleted, ARCHITECTURE.md §5); a held bill that was completed
 * meanwhile elsewhere is reported (possible double billing) instead.
 */
async function retireHeldBill(
  tx: Tx,
  ctx: SalesCtx,
  a: { id: string | null; store_id: string },
): Promise<RetiredHeld | null> {
  if (!a.id) return null
  const row = await tx
    .selectFrom('sales_invoices')
    .select(['id', 'status', 'store_id', 'number'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', a.id)
    .forUpdate()
    .executeTakeFirst()
  if (!row || row.store_id !== a.store_id) return null
  if (row.status !== 'held' && row.status !== 'draft') {
    return { id: row.id, outcome: 'conflict', status: row.status, number: row.number }
  }
  await tx
    .deleteFrom('sales_invoices')
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', row.id)
    .execute()
  return { id: row.id, outcome: 'removed', status: row.status, number: null }
}

async function auditHeldRetired(
  tx: Tx,
  ctx: SalesCtx,
  held: RetiredHeld,
  bill: { id: string; number: string },
): Promise<void> {
  if (held.outcome === 'removed') {
    await audit(tx, ctx, {
      action: 'sales_invoice.held_billed_offline',
      entity_type: 'sales_invoice',
      entity_id: bill.id,
      summary: `Held bill billed offline as ${bill.number}; the held bill was removed`,
      changes: { held_invoice_id: held.id, held_status: held.status },
    })
    return
  }
  await audit(tx, ctx, {
    action: 'sales_invoice.held_conflict',
    entity_type: 'sales_invoice',
    entity_id: bill.id,
    summary: `Offline bill ${bill.number} was made from a held bill that is already ${held.status}${held.number ? ` (${held.number})` : ''}: check for double billing`,
    changes: { held_invoice_id: held.id, held_status: held.status, held_number: held.number },
  })
}

export async function posSync(
  runTx: RunTx,
  ctx: SalesCtx,
  rt: SalesRuntime,
  body: SyncBody,
  log: FastifyBaseLogger,
): Promise<PosSyncResult> {
  // The register (and its store) must be valid for this member before anything is posted.
  const register = await runTx((tx) =>
    loadRegister(tx, ctx, body.register_id, null, { requireActive: false }),
  )
  const results: SyncItemResult[] = []

  for (const inv of body.invoices) {
    const base = {
      kind: 'invoice' as const,
      client_ref: inv.client_ref,
      offline_number: inv.offline_number,
    }
    try {
      if (inv.register_id && inv.register_id !== register.id) {
        throw new AppError('VALIDATION_ERROR', 'The bill belongs to another register', {
          issues: [{ path: 'register_id', message: 'register_mismatch' }],
        })
      }
      if (inv.store_id !== register.store_id) {
        throw new AppError('VALIDATION_ERROR', 'The bill belongs to another store', {
          issues: [{ path: 'store_id', message: 'store_mismatch' }],
        })
      }
      const r = await runTx(async (tx) => {
        const dup = await tx
          .selectFrom('sales_invoices')
          .select(['id', 'number', 'status'])
          .where('tenant_id', '=', ctx.tenantId)
          .where('client_ref', '=', inv.client_ref)
          .forUpdate()
          .executeTakeFirst()
        const dupOpen = dup !== undefined && (dup.status === 'held' || dup.status === 'draft')
        if (dup && !dupOpen) {
          return { status: 'duplicate' as const, id: dup.id, number: dup.number, warnings: [] }
        }
        // A held bill (recalled, or stored under this client_ref) that was billed offline is
        // retired in this transaction, so it cannot be recalled and billed a second time.
        const held = await retireHeldBill(tx, ctx, {
          id: inv.held_invoice_id ?? (dupOpen ? dup.id : null),
          store_id: register.store_id,
        })
        const res = await commitInvoice(
          tx,
          ctx,
          rt,
          {
            store_id: inv.store_id,
            register_id: register.id,
            customer_id: inv.customer_id ?? null,
            customer: inv.customer ?? null,
            place_of_supply: inv.place_of_supply ?? null,
            lines: inv.lines,
            bill_discount_bp: inv.bill_discount_bp,
            bill_discount_paise: inv.bill_discount_paise,
            loyalty_redeem_points: inv.loyalty_redeem_points,
            rx: inv.rx ?? null,
            tenders: inv.tenders,
            credit_limit_override: inv.credit_limit_override,
            invoice_date: inv.invoice_date,
            channel: 'pos',
            client_ref: inv.client_ref,
            salesperson_id: inv.salesperson_id ?? null,
            notes: inv.notes ?? null,
          },
          {
            sync: {
              offline_number: inv.offline_number,
              offline_created_at: new Date(inv.offline_created_at),
            },
          },
        )
        if (held) await auditHeldRetired(tx, ctx, held, { id: res.invoice_id, number: res.number })
        return {
          status: res.renumbered ? ('renumbered' as const) : ('created' as const),
          id: res.invoice_id,
          number: res.number,
          warnings: res.warnings,
        }
      })
      results.push({ ...base, ...r, error: null })
    } catch (err) {
      results.push({
        ...base,
        status: 'failed',
        id: null,
        number: null,
        error: errorOf(err, log),
        warnings: [],
      })
    }
  }

  for (const cn of body.credit_notes) {
    const base = { kind: 'credit_note' as const, client_ref: cn.client_ref, offline_number: null }
    try {
      const r = await runTx(async (tx) => {
        const res = await createCreditNote(
          tx,
          ctx,
          { ...cn, register_id: cn.register_id ?? register.id },
          { sync: { offline_created_at: new Date(cn.offline_created_at) } },
        )
        const row = await tx
          .selectFrom('credit_notes')
          .select('number')
          .where('tenant_id', '=', ctx.tenantId)
          .where('id', '=', res.id)
          .executeTakeFirstOrThrow()
        return {
          status: res.replayed ? ('duplicate' as const) : ('created' as const),
          id: res.id,
          number: row.number,
        }
      })
      results.push({ ...base, ...r, error: null, warnings: [] })
    } catch (err) {
      results.push({
        ...base,
        status: 'failed',
        id: null,
        number: null,
        error: errorOf(err, log),
        warnings: [],
      })
    }
  }

  const series = await runTx(async (tx) => {
    const env = await salesEnv(tx, ctx)
    const docType = salesDocumentModeFor(env.tenant.gst_scheme).series
    const s = await peekSeries(tx, ctx, {
      docType,
      storeId: register.store_id,
      registerId: register.id,
      date: env.today,
    })
    return { doc_type: docType, ...s }
  })

  const count = (s: SyncItemResult['status']) => results.filter((r) => r.status === s).length
  return {
    results,
    created: count('created'),
    duplicates: count('duplicate'),
    renumbered: count('renumbered'),
    failed: count('failed'),
    series,
  }
}
