/**
 * Invoice posting service (ARCHITECTURE.md §10 "Sales invoice completed / cancelled"):
 *
 *  - commitInvoice: price (pricing.ts, mode commit/sync) → plan limit (invoices_per_month) and
 *    usage → number (register series for POS; acceptOfflineNumber for offline bills) → stock
 *    'sale' (COGS captured into the lines) → journal (Dr receivable, Cr sales / output GST /
 *    round off; Dr COGS, Cr inventory) → one recordPayment per tender (cash change in the
 *    payment notes; UPI intents consumed exactly once by core) → the rest is the due (credit,
 *    validated) → loyalty earn / redeem → audit of overrides → open shift attached.
 *  - held bills / drafts: priced and stored without number, stock or journal; completing one
 *    re-prices it at current prices (manual prices kept and re-checked, FEFO re-picked).
 *  - cancel: payments cancelled (refund list), stock 'sale_cancel' at the original costs,
 *    journal reversed, loyalty reversed, audited.
 *  - dues collection and estimates (numbered EST…, no stock / journal; convert → invoice).
 */
import { type SalesChannel, addDays, newId } from '@kadai/shared'
import { effectiveCreditDays, invoiceDueDate } from '@kadai/shared/api/parties'
import { PROVIDER_CAPABILITIES, paymentClientRef } from '@kadai/shared/api/payments'
import {
  AdHocItemSchema,
  type CartLine,
  ESTIMATE_VALIDITY_DAYS,
  type EstimateConvertSchema,
  type EstimateCreateSchema,
  type HeldBill,
  type InvoiceCancelResult,
  type InvoiceCreateParsed,
  type InvoiceSaveResult,
  type SalesIssue,
  type Tender,
  allocateTenders,
  cashTenderNotes,
  generateShareToken,
  parseCashTenderNotes,
  seriesDocTypeFor,
} from '@kadai/shared/api/sales'
import type { z } from 'zod'
import { jsonb } from '../../db/json'
import { type Tx, afterCommit } from '../../db/tenant'
import { audit } from '../../core/audit'
import { assertWithinLimit, incrementUsage } from '../../core/entitlements'
import { AppError, conflict, invalidField, notFound, unprocessable } from '../../core/errors'
import { assertStoreAccess } from '../../core/http'
import { postStock } from '../../core/inventory'
import { postJournal, reverseJournal } from '../../core/ledger'
import { earnPoints, redeemPoints, reversePoints, reversiblePoints } from '../../core/loyalty'
import type { KadaiMetrics } from '../../core/metrics'
import { acceptOfflineNumber, nextNumber } from '../../core/numbering'
import { cancelPayment, recordPayment } from '../../core/payments'
import {
  type JsonRecord,
  type SalesCtx,
  assertNoBlocking,
  intOf,
  isRecord,
  recordOf,
  salesEnv,
  tenantToday,
} from './common'
import {
  type InvoiceRow,
  type StoredLine,
  loadInvoiceDetail,
  loadInvoiceRow,
  loadStoredLines,
} from './detail'
import { type PricedSale, type PricingMode, type SaleInput, priceSale } from './pricing'

export interface SalesRuntime {
  publicBaseUrl: string
  metrics?: Pick<KadaiMetrics, 'invoicesCreated'> | undefined
}

type AdHocItem = z.output<typeof AdHocItemSchema>

export interface CommitInput extends SaleInput {
  channel: SalesChannel
  client_ref?: string | null | undefined
  salesperson_id?: string | null | undefined
  notes?: string | null | undefined
  tenders: readonly Tender[]
}

export interface CommitOptions {
  /** Held bill / draft row being completed (locked by the caller). */
  existing?: InvoiceRow
  /** Offline bill (POST /pos/sync). */
  sync?: { offline_number: string | null; offline_created_at: Date }
  trustedKeys?: ReadonlySet<string>
  /** Merged into sales_invoices.meta. */
  extraMeta?: JsonRecord
}

export interface CommitResult {
  invoice_id: string
  number: string
  renumbered: boolean
  offline_number: string | null
  tenders: InvoiceSaveResult['tenders']
  change_paise: number
  warnings: SalesIssue[]
}

const warningsOf = (issues: readonly SalesIssue[]): SalesIssue[] =>
  issues.filter((i) => i.severity === 'warning')

async function assertSalesperson(tx: Tx, ctx: SalesCtx, userId: string | null | undefined) {
  if (!userId) return
  const m = await tx
    .selectFrom('memberships')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('user_id', '=', userId)
    .executeTakeFirst()
  if (!m) throw invalidField('salesperson_id', 'The salesperson is not a member of this business')
}

/** sales_invoices columns of a priced document (totals, party snapshot, place of supply). */
function pricedHeader(p: PricedSale) {
  const t = p.totals
  return {
    store_id: p.store.id,
    register_id: p.register?.id ?? null,
    doc_type: p.doc_type,
    customer_id: p.customer?.id ?? null,
    customer_name: p.snapshot.name,
    customer_phone: p.snapshot.phone,
    customer_gstin: p.snapshot.gstin,
    customer_address: p.snapshot.address ? jsonb(p.snapshot.address) : null,
    customer_state_code: p.snapshot.state_code,
    place_of_supply: p.place_of_supply,
    is_interstate: p.is_interstate,
    price_includes_tax: p.price_includes_tax,
    gross_paise: t.gross_paise,
    item_discount_paise: t.item_discount_paise,
    bill_discount_paise: t.bill_discount_paise,
    taxable_paise: t.taxable_paise,
    cgst_paise: t.cgst_paise,
    sgst_paise: t.sgst_paise,
    igst_paise: t.igst_paise,
    cess_paise: t.cess_paise,
    round_off_paise: t.round_off_paise,
    total_paise: t.total_paise,
    item_count: p.lines.length,
    rx: p.rx ? jsonb(p.rx) : null,
  }
}

/** Line rows of a priced document (costs filled in by the caller for completed bills). */
function lineRows(
  tenantId: string,
  invoiceId: string,
  p: PricedSale,
  costs: ReadonlyArray<{ unit_cost_paise: number; cost_paise: number; meta?: JsonRecord }>,
) {
  return p.lines.map((l, i) => {
    const c = costs[i] ?? { unit_cost_paise: 0, cost_paise: 0 }
    return {
      id: newId(),
      tenant_id: tenantId,
      invoice_id: invoiceId,
      line_no: l.line_no,
      product_id: l.product_id,
      batch_id: l.batch_id,
      name: l.name,
      name_ta: l.name_ta,
      hsn_code: l.hsn_code,
      unit: l.unit,
      pack_size: l.pack_size,
      qty_milli: l.qty_milli,
      free_qty_milli: 0,
      mrp_paise: l.mrp_paise,
      unit_price_paise: l.unit_price_paise,
      discount_bp: l.discount_bp,
      discount_paise: l.discount_paise,
      gross_paise: l.gross_paise,
      taxable_paise: l.taxable_paise,
      gst_rate_bp: l.gst_rate_bp,
      cgst_paise: l.cgst_paise,
      sgst_paise: l.sgst_paise,
      igst_paise: l.igst_paise,
      cess_rate_bp: l.cess_rate_bp,
      cess_paise: l.cess_paise,
      total_paise: l.total_paise,
      unit_cost_paise: c.unit_cost_paise,
      cost_paise: c.cost_paise,
      promotion_id: l.promotion_id,
      serial_numbers: l.serial_numbers,
      meta: jsonb({ ...l.meta, ...(c.meta ?? {}) }),
    }
  })
}

// ---------------------------------------------------------------------------------------------
// Completed invoices
// ---------------------------------------------------------------------------------------------

export async function commitInvoice(
  tx: Tx,
  ctx: SalesCtx,
  rt: SalesRuntime,
  input: CommitInput,
  opts: CommitOptions = {},
): Promise<CommitResult> {
  const sync = opts.sync ?? null
  const mode: PricingMode = sync ? 'sync' : 'commit'
  const priced = await priceSale(tx, ctx, input, {
    mode,
    ...(sync ? { now: sync.offline_created_at } : {}),
    ...(opts.trustedKeys ? { trustedKeys: opts.trustedKeys } : {}),
  })
  assertNoBlocking(priced.issues)
  await assertSalesperson(tx, ctx, input.salesperson_id)
  const { env } = priced
  const store = priced.store
  const register = priced.register

  // ---- plan limit & usage ------------------------------------------------------------------
  if (!sync) await assertWithinLimit(tx, ctx, 'invoices_per_month')
  await incrementUsage(tx, ctx, 'invoices', { enforce: !sync })

  // ---- number ------------------------------------------------------------------------------
  const docType = seriesDocTypeFor(priced.doc_type)
  const invoiceDate = priced.invoice_date
  let numbered: { number: string; fy: string; renumbered: boolean; offline: string | null }
  if (sync?.offline_number && register) {
    const n = await acceptOfflineNumber(tx, ctx, {
      docType,
      storeId: store.id,
      registerId: register.id,
      date: invoiceDate,
      number: sync.offline_number,
    })
    numbered = { number: n.number, fy: n.fy, renumbered: n.renumbered, offline: n.offline_number }
  } else {
    const n = await nextNumber(tx, ctx, {
      docType,
      storeId: store.id,
      registerId: register?.id ?? null,
      date: invoiceDate,
    })
    numbered = {
      number: n.number,
      fy: n.fy,
      renumbered: false,
      offline: sync?.offline_number ?? null,
    }
  }

  const invoiceId = opts.existing?.id ?? newId()

  // ---- stock -------------------------------------------------------------------------------
  const stockIdx: number[] = []
  const movements = priced.lines.flatMap((l, i) => {
    if (!l.product_id || !l.track_inventory) return []
    stockIdx.push(i)
    return [
      {
        store_id: store.id,
        product_id: l.product_id,
        batch_id: l.batch_tracked ? l.batch_id : null,
        qty_milli: -l.qty_milli,
        movement_type: 'sale' as const,
        ref_type: 'sales_invoice',
        ref_id: invoiceId,
        reason: sync ? 'offline sale' : null,
      },
    ]
  })
  const posted = movements.length
    ? await postStock(tx, ctx, movements, sync ? { allowNegative: true } : {})
    : []
  const costs = priced.lines.map(() => ({
    unit_cost_paise: 0,
    cost_paise: 0,
    meta: undefined as JsonRecord | undefined,
  }))
  const negativeLines: number[] = []
  for (const [k, i] of stockIdx.entries()) {
    const m = posted[k]!
    costs[i] = {
      unit_cost_paise: m.unit_cost_paise,
      cost_paise: m.cost_paise,
      meta: sync && m.balance_after_milli < 0 ? { offline_negative_stock: true } : undefined,
    }
    if (m.balance_after_milli < 0) negativeLines.push(priced.lines[i]!.line_no)
  }
  const cost = costs.reduce((s, c) => s + c.cost_paise, 0)

  // ---- header + lines ----------------------------------------------------------------------
  const total = priced.totals.total_paise
  const due = priced.due_paise
  const now = new Date()
  const meta: JsonRecord = {
    ...recordOf(opts.existing?.meta),
    ...priced.meta,
    ...(opts.extraMeta ?? {}),
    ...(priced.overrides.credit_limit ? { credit_limit_override: true } : {}),
    ...(sync && negativeLines.length ? { offline_negative_stock: true } : {}),
    ...(numbered.renumbered ? { offline_number: numbered.offline } : {}),
  }
  const header = {
    ...pricedHeader(priced),
    shift_id: priced.shift?.id ?? null,
    number: numbered.number,
    fy: numbered.fy,
    invoice_date: invoiceDate,
    invoice_at: sync ? sync.offline_created_at : now,
    due_date:
      due > 0
        ? invoiceDueDate(
            invoiceDate,
            effectiveCreditDays(priced.customer?.credit_days, env.settings),
          )
        : null,
    status: 'completed',
    channel: input.channel,
    cost_paise: cost,
    paid_paise: 0,
    returned_paise: 0,
    due_paise: total,
    payment_status: total > 0 ? 'unpaid' : 'paid',
    salesperson_id: input.salesperson_id ?? null,
    notes: input.notes ?? null,
    share_token: opts.existing?.share_token ?? generateShareToken(),
    offline_created_at: sync ? sync.offline_created_at : null,
    completed_at: now,
    created_by: ctx.userId,
    meta: jsonb(meta),
  }
  if (opts.existing) {
    await tx
      .deleteFrom('sales_invoice_lines')
      .where('tenant_id', '=', ctx.tenantId)
      .where('invoice_id', '=', invoiceId)
      .execute()
    await tx
      .updateTable('sales_invoices')
      .set(header)
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', invoiceId)
      .execute()
  } else {
    await tx
      .insertInto('sales_invoices')
      .values({
        id: invoiceId,
        tenant_id: ctx.tenantId,
        client_ref: input.client_ref ?? null,
        ...header,
      })
      .execute()
  }
  const rows = lineRows(ctx.tenantId, invoiceId, priced, costs)
  if (rows.length) await tx.insertInto('sales_invoice_lines').values(rows).execute()

  // ---- journal -----------------------------------------------------------------------------
  const t = priced.totals
  const party = priced.customer ? { type: 'customer' as const, id: priced.customer.id } : null
  await postJournal(tx, ctx, {
    entry_date: invoiceDate,
    store_id: store.id,
    source_type: 'sales_invoice',
    source_id: invoiceId,
    narration: `Sale ${numbered.number}`,
    lines: [
      { account: { subtype: 'receivable' }, debit_paise: total, party },
      { account: { subtype: 'sales' }, credit_paise: t.taxable_paise },
      { account: { subtype: 'output_cgst' }, credit_paise: t.cgst_paise },
      { account: { subtype: 'output_sgst' }, credit_paise: t.sgst_paise },
      { account: { subtype: 'output_igst' }, credit_paise: t.igst_paise },
      { account: { subtype: 'output_cess' }, credit_paise: t.cess_paise },
      t.round_off_paise >= 0
        ? { account: { subtype: 'round_off' }, credit_paise: t.round_off_paise }
        : { account: { subtype: 'round_off' }, debit_paise: -t.round_off_paise },
      { account: { subtype: 'cogs' }, debit_paise: cost },
      { account: { subtype: 'inventory' }, credit_paise: cost },
    ],
  })

  // ---- tenders -----------------------------------------------------------------------------
  const tenderResults: InvoiceSaveResult['tenders'] = []
  const allocLines = priced.tenders?.lines ?? []
  for (const line of allocLines) {
    const tender = input.tenders[line.index]!
    let paymentId: string | null = null
    if (line.applied_paise > 0) {
      const accountId = tender.provider_account_id
        ? await settlementAccountOf(tx, ctx, tender.provider_account_id, store.id)
        : null
      const payment = await recordPayment(tx, ctx, {
        direction: 'in',
        store_id: store.id,
        register_id: register?.id ?? null,
        shift_id: priced.shift?.id ?? null,
        method: tender.method,
        amount_paise: line.applied_paise,
        payment_date: invoiceDate,
        party,
        reference: tender.reference ?? null,
        payment_intent_id: tender.payment_intent_id ?? null,
        account_id: accountId,
        allocations: [
          { target_type: 'sales_invoice', target_id: invoiceId, amount_paise: line.applied_paise },
        ],
        notes:
          line.method === 'cash' && line.change_paise > 0
            ? cashTenderNotes(line.amount_paise, line.change_paise)
            : null,
        client_ref: paymentClientRef.salesTender(invoiceId, line.index),
        ...(sync ? { paid_at: sync.offline_created_at } : {}),
      })
      paymentId = payment.id
    }
    tenderResults.push({ ...line, payment_id: paymentId })
  }

  // ---- loyalty -----------------------------------------------------------------------------
  if (priced.customer && env.features.has('loyalty') && env.settings.loyalty.enabled) {
    let redeemed = 0
    if (t.loyalty_points_redeemed > 0) {
      await redeemPoints(tx, ctx, {
        customer_id: priced.customer.id,
        points: t.loyalty_points_redeemed,
        bill_total_paise: total + t.loyalty_redeem_paise,
        ref_type: 'sales_invoice',
        ref_id: invoiceId,
      })
      redeemed = t.loyalty_points_redeemed
    }
    const earned = await earnPoints(tx, ctx, {
      customer_id: priced.customer.id,
      amount_paise: total,
      ref_type: 'sales_invoice',
      ref_id: invoiceId,
    })
    if (earned.points > 0 || redeemed > 0) {
      await tx
        .updateTable('sales_invoices')
        .set({
          loyalty_points_earned: earned.points,
          loyalty_points_redeemed: redeemed,
          loyalty_redeem_paise: redeemed > 0 ? t.loyalty_redeem_paise : 0,
        })
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', invoiceId)
        .execute()
    }
  }

  // ---- audit -------------------------------------------------------------------------------
  await auditCommit(tx, ctx, { priced, invoiceId, number: numbered, sync, negativeLines })

  if (rt.metrics) {
    const metrics = rt.metrics
    afterCommit(tx, () => {
      metrics.invoicesCreated.inc({ channel: input.channel })
    })
  }

  return {
    invoice_id: invoiceId,
    number: numbered.number,
    renumbered: numbered.renumbered,
    offline_number: numbered.offline,
    tenders: tenderResults,
    change_paise: priced.tenders?.change_paise ?? 0,
    warnings: warningsOf(priced.issues),
  }
}

async function settlementAccountOf(
  tx: Tx,
  ctx: SalesCtx,
  providerAccountId: string,
  storeId: string,
): Promise<string | null> {
  const acct = await tx
    .selectFrom('payment_provider_accounts')
    .select(['id', 'store_id', 'is_active', 'settlement_account_id'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', providerAccountId)
    .executeTakeFirst()
  if (!acct || !acct.is_active || (acct.store_id !== null && acct.store_id !== storeId)) {
    throw invalidField('tenders.provider_account_id', 'Unknown UPI account for this store')
  }
  return acct.settlement_account_id
}

async function auditCommit(
  tx: Tx,
  ctx: SalesCtx,
  a: {
    priced: PricedSale
    invoiceId: string
    number: { number: string; renumbered: boolean; offline: string | null }
    sync: CommitOptions['sync'] | null
    negativeLines: number[]
  },
): Promise<void> {
  const { priced, invoiceId } = a
  const o = priced.overrides
  if (
    o.price_keys.length ||
    o.discount_keys.length ||
    o.bill_discount ||
    o.credit_limit ||
    o.backdated
  ) {
    const priceLines = priced.lines
      .filter((l) => o.price_keys.includes(l.source_key))
      .map((l) => ({
        line_no: l.line_no,
        name: l.name,
        resolved_price_paise: l.resolved_price_paise,
        unit_price_paise: l.unit_price_paise,
      }))
    const discountLines = priced.lines
      .filter((l) => o.discount_keys.includes(l.source_key))
      .map((l) => ({
        line_no: l.line_no,
        name: l.name,
        discount_bp: l.manual_discount_bp,
        discount_paise: l.manual_discount_paise,
      }))
    const parts = [
      priceLines.length ? `price changed on ${priceLines.length} line(s)` : null,
      discountLines.length ? `discount above limit on ${discountLines.length} line(s)` : null,
      o.bill_discount ? 'bill discount above limit' : null,
      o.credit_limit ? 'credit limit overridden' : null,
      o.backdated ? `dated ${priced.invoice_date}` : null,
    ].filter(Boolean)
    await audit(tx, ctx, {
      action: 'sales_invoice.override',
      entity_type: 'sales_invoice',
      entity_id: invoiceId,
      summary: `${a.number.number}: ${parts.join('; ')}`,
      changes: {
        price_lines: priceLines,
        discount_lines: discountLines,
        bill_discount_paise: o.bill_discount ? priced.totals.manual_bill_discount_paise : null,
        credit: o.credit_limit ? priced.quote.credit : null,
        invoice_date: o.backdated ? priced.invoice_date : null,
      },
    })
  }
  if (!a.sync) return
  if (a.number.renumbered) {
    await audit(tx, ctx, {
      action: 'sales_invoice.renumbered',
      entity_type: 'sales_invoice',
      entity_id: invoiceId,
      summary: `Offline bill ${a.number.offline ?? ''} saved as ${a.number.number}`,
      changes: { offline_number: a.number.offline, number: a.number.number },
    })
  }
  const exceptions = priced.issues.filter(
    (i) =>
      i.severity === 'warning' &&
      !['near_expiry', 'low_stock', 'fefo_split', 'price_above_mrp', 'price_below_cost'].includes(
        i.code,
      ),
  )
  if (exceptions.length || a.negativeLines.length) {
    await audit(tx, ctx, {
      action: 'sales_invoice.offline_exceptions',
      entity_type: 'sales_invoice',
      entity_id: invoiceId,
      summary: `Offline bill ${a.number.number}: ${[
        ...new Set(exceptions.map((i) => i.code)),
        ...(a.negativeLines.length ? ['negative_stock'] : []),
      ].join(', ')}`,
      changes: { issues: exceptions, negative_stock_lines: a.negativeLines },
    })
  }
}

// ---------------------------------------------------------------------------------------------
// Held bills / drafts
// ---------------------------------------------------------------------------------------------

export interface DraftInput extends SaleInput {
  status: 'held' | 'draft'
  channel: SalesChannel
  client_ref?: string | null | undefined
  salesperson_id?: string | null | undefined
  notes?: string | null | undefined
}

/** Stores a held bill / draft (no number, stock or journal). Returns the invoice id. */
export async function saveDraft(
  tx: Tx,
  ctx: SalesCtx,
  input: DraftInput,
  opts: { existing?: InvoiceRow; extraMeta?: JsonRecord; trustedKeys?: ReadonlySet<string> } = {},
): Promise<{ id: string; warnings: SalesIssue[] }> {
  const priced = await priceSale(tx, ctx, input, {
    mode: 'draft',
    ...(opts.trustedKeys ? { trustedKeys: opts.trustedKeys } : {}),
  })
  assertNoBlocking(priced.issues)
  await assertSalesperson(tx, ctx, input.salesperson_id)
  const id = opts.existing?.id ?? newId()
  const header = {
    ...pricedHeader(priced),
    invoice_date: priced.invoice_date,
    status: input.status,
    channel: input.channel,
    due_paise: 0,
    paid_paise: 0,
    payment_status: 'unpaid',
    salesperson_id: input.salesperson_id ?? null,
    notes: input.notes ?? null,
    meta: jsonb({ ...recordOf(opts.existing?.meta), ...priced.meta, ...(opts.extraMeta ?? {}) }),
  }
  if (opts.existing) {
    await tx
      .deleteFrom('sales_invoice_lines')
      .where('tenant_id', '=', ctx.tenantId)
      .where('invoice_id', '=', id)
      .execute()
    await tx
      .updateTable('sales_invoices')
      .set(header)
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', id)
      .execute()
  } else {
    await tx
      .insertInto('sales_invoices')
      .values({
        id,
        tenant_id: ctx.tenantId,
        client_ref: input.client_ref ?? null,
        created_by: ctx.userId,
        ...header,
      })
      .execute()
  }
  const rows = lineRows(ctx.tenantId, id, priced, [])
  if (rows.length) await tx.insertInto('sales_invoice_lines').values(rows).execute()
  return { id, warnings: warningsOf(priced.issues) }
}

/**
 * Cart lines of a stored document, for re-pricing: FEFO-picked parts of one cart line are merged
 * back (the batches are re-picked), explicit batches are kept, manual prices are kept (they are
 * re-checked against the current user's permissions) and ad-hoc items keep their entry.
 */
export function cartFromStoredLines(
  lines: readonly StoredLine[],
  opts: { keepPrices?: boolean } = {},
): CartLine[] {
  const out: CartLine[] = []
  const merged = new Map<string, CartLine>()
  for (const l of [...lines].sort((a, b) => a.line_no - b.line_no)) {
    const meta = recordOf(l.meta)
    const key = typeof meta['source_key'] === 'string' ? meta['source_key'] : `line-${l.line_no}`
    const auto = meta['batch_auto'] === true
    const manualFlat = intOf(meta['manual_discount_paise'])
    const prev = merged.get(key)
    if (prev && auto) {
      prev.qty_milli += l.qty_milli
      if (manualFlat) prev.discount_paise = (prev.discount_paise ?? 0) + manualFlat
      if (l.serial_numbers.length) {
        prev.serial_numbers = [...(prev.serial_numbers ?? []), ...l.serial_numbers]
      }
      continue
    }
    const source = meta['price_source']
    const keepPrice =
      l.product_id === null ||
      source === 'manual' ||
      source === 'ad_hoc' ||
      opts.keepPrices === true
    const line: CartLine = {
      key,
      qty_milli: l.qty_milli,
      ...(l.product_id ? { product_id: l.product_id } : { item: adHocItemOf(l, meta) }),
      ...(keepPrice ? { unit_price_paise: l.unit_price_paise } : {}),
      ...(l.discount_bp ? { discount_bp: l.discount_bp } : {}),
      ...(manualFlat ? { discount_paise: manualFlat } : {}),
      ...(l.batch_id && !auto ? { batch_id: l.batch_id } : {}),
      ...(l.serial_numbers.length ? { serial_numbers: [...l.serial_numbers] } : {}),
      ...(typeof meta['scanned_code'] === 'string' ? { scanned_code: meta['scanned_code'] } : {}),
      ...(typeof meta['note'] === 'string' ? { note: meta['note'] } : {}),
    }
    out.push(line)
    if (auto) merged.set(key, line)
  }
  return out
}

function adHocItemOf(l: StoredLine, meta: JsonRecord): AdHocItem {
  const stored = AdHocItemSchema.safeParse(meta['item'])
  if (stored.success) return stored.data
  const rebuilt = AdHocItemSchema.safeParse({
    name: l.name,
    ...(l.name_ta ? { name_ta: l.name_ta } : {}),
    ...(l.hsn_code ? { hsn_code: l.hsn_code } : {}),
    gst_rate_bp: l.gst_rate_bp,
    cess_rate_bp: l.cess_rate_bp,
    unit: l.unit,
  })
  if (rebuilt.success) return rebuilt.data
  throw unprocessable('A stored item line cannot be re-priced', {
    reason: 'line_invalid',
    line_no: l.line_no,
  })
}

/** Cart input of a stored held bill / draft / estimate. */
export async function storedCart(
  tx: Tx,
  ctx: SalesCtx,
  row: InvoiceRow,
  opts: { keepPrices?: boolean } = {},
): Promise<SaleInput & { lines: CartLine[] }> {
  const lines = await loadStoredLines(tx, ctx, row.id)
  const meta = recordOf(row.meta)
  const rx = row.rx && isRecord(row.rx) ? (row.rx as SaleInput['rx']) : null
  return {
    store_id: row.store_id,
    register_id: row.register_id,
    customer_id: row.customer_id,
    customer: row.customer_name
      ? {
          name: row.customer_name,
          phone: row.customer_phone,
          gstin: row.customer_gstin,
          ...(isRecord(row.customer_address)
            ? { address: row.customer_address as NonNullable<SaleInput['customer']>['address'] }
            : {}),
          ...(row.customer_state_code ? { state_code: row.customer_state_code } : {}),
        }
      : null,
    place_of_supply: row.place_of_supply,
    lines: cartFromStoredLines(lines, opts),
    bill_discount_bp: intOf(meta['bill_discount_bp']),
    bill_discount_paise: intOf(meta['bill_discount_paise']),
    loyalty_redeem_points: intOf(meta['loyalty_redeem_points']),
    rx,
  }
}

function assertOpen(row: InvoiceRow): void {
  if (row.status !== 'held' && row.status !== 'draft') {
    throw conflict(`The bill is ${row.status}; only held bills and drafts can be changed`, {
      reason: 'not_open',
      status: row.status,
    })
  }
}

export interface DraftChanges {
  customer_id?: string | null | undefined
  customer?: SaleInput['customer'] | undefined
  place_of_supply?: string | undefined
  lines?: CartLine[] | undefined
  bill_discount_bp?: number | undefined
  bill_discount_paise?: number | undefined
  loyalty_redeem_points?: number | undefined
  rx?: SaleInput['rx'] | undefined
  salesperson_id?: string | null | undefined
  notes?: string | null | undefined
  status?: 'held' | 'draft' | undefined
  if_updated_at?: string | undefined
}

/** Applies PATCH-style changes to a stored cart. */
function applyChanges(
  cart: SaleInput & { lines: CartLine[] },
  row: InvoiceRow,
  c: DraftChanges,
): SaleInput & { lines: CartLine[]; salesperson_id: string | null; notes: string | null } {
  const customerChanged = c.customer_id !== undefined && c.customer_id !== row.customer_id
  return {
    ...cart,
    customer_id: c.customer_id !== undefined ? c.customer_id : cart.customer_id,
    // A new customer replaces the old snapshot unless a snapshot is sent too.
    customer: c.customer !== undefined ? c.customer : customerChanged ? null : cart.customer,
    place_of_supply: c.place_of_supply ?? cart.place_of_supply,
    lines: c.lines ?? cart.lines,
    bill_discount_bp: c.bill_discount_bp ?? cart.bill_discount_bp,
    bill_discount_paise: c.bill_discount_paise ?? cart.bill_discount_paise,
    loyalty_redeem_points: c.loyalty_redeem_points ?? cart.loyalty_redeem_points,
    rx: c.rx !== undefined ? c.rx : cart.rx,
    salesperson_id: c.salesperson_id !== undefined ? c.salesperson_id : row.salesperson_id,
    notes: c.notes !== undefined ? c.notes : row.notes,
  }
}

function assertFresh(row: InvoiceRow, ifUpdatedAt: string | undefined): void {
  if (ifUpdatedAt && new Date(ifUpdatedAt).getTime() !== row.updated_at.getTime()) {
    throw new AppError('STALE_WRITE', 'The bill was changed by someone else', {
      entity: 'sales_invoice',
      id: row.id,
      updated_at: row.updated_at.toISOString(),
    })
  }
}

export async function updateDraft(
  tx: Tx,
  ctx: SalesCtx,
  id: string,
  changes: DraftChanges,
): Promise<void> {
  const row = await loadInvoiceRow(tx, ctx, id, { forUpdate: true })
  assertOpen(row)
  assertFresh(row, changes.if_updated_at)
  const cart = applyChanges(await storedCart(tx, ctx, row), row, changes)
  await saveDraft(
    tx,
    ctx,
    {
      ...cart,
      status: changes.status ?? (row.status === 'draft' ? 'draft' : 'held'),
      channel: row.channel as SalesChannel,
      invoice_date: row.invoice_date,
    },
    { existing: row },
  )
}

export async function deleteDraft(tx: Tx, ctx: SalesCtx, id: string): Promise<void> {
  const row = await loadInvoiceRow(tx, ctx, id, { forUpdate: true })
  assertOpen(row)
  await tx
    .deleteFrom('sales_invoices')
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
}

export interface CompleteInput {
  tenders: readonly Tender[]
  register_id?: string | undefined
  credit_limit_override: boolean
  changes?: DraftChanges | undefined
}

/** Held bill / draft → completed (re-priced at current prices). */
export async function completeDraft(
  tx: Tx,
  ctx: SalesCtx,
  rt: SalesRuntime,
  id: string,
  body: CompleteInput,
): Promise<CommitResult> {
  const row = await loadInvoiceRow(tx, ctx, id, { forUpdate: true })
  assertOpen(row)
  if (body.changes) assertFresh(row, body.changes.if_updated_at)
  const cart = applyChanges(await storedCart(tx, ctx, row), row, body.changes ?? {})
  const today = await tenantToday(tx, ctx)
  // POS bills complete today; back-office drafts keep their (permission-checked) date.
  const invoiceDate = row.channel === 'pos' ? today : row.invoice_date
  return commitInvoice(
    tx,
    ctx,
    rt,
    {
      ...cart,
      register_id: body.register_id ?? row.register_id,
      channel: row.channel as SalesChannel,
      tenders: body.tenders,
      credit_limit_override: body.credit_limit_override,
      invoice_date: invoiceDate,
      client_ref: row.client_ref,
    },
    { existing: row },
  )
}

// ---------------------------------------------------------------------------------------------
// Create (POST /sales/invoices)
// ---------------------------------------------------------------------------------------------

/** Rebuilds the save result of an existing invoice (client_ref replay without a stored response). */
export async function replayResult(
  tx: Tx,
  ctx: SalesCtx,
  rt: SalesRuntime,
  id: string,
): Promise<InvoiceSaveResult> {
  const invoice = await loadInvoiceDetail(tx, ctx, id, rt.publicBaseUrl)
  const tenders: InvoiceSaveResult['tenders'] = []
  const payments = await tx
    .selectFrom('payments')
    .select(['id', 'method', 'amount_paise', 'notes', 'client_ref'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('client_ref', 'like', `tender:${id}:%`)
    .execute()
  for (const p of payments) {
    const index = Number(p.client_ref?.split(':')[2] ?? '0')
    const cash = parseCashTenderNotes(p.notes)
    tenders.push({
      index,
      method: invoice.payments.find((x) => x.payment_id === p.id)?.method ?? 'cash',
      amount_paise: cash ? cash.tendered_paise : p.amount_paise,
      applied_paise: p.amount_paise,
      change_paise: cash?.change_paise ?? 0,
      payment_id: p.id,
    })
  }
  tenders.sort((a, b) => a.index - b.index)
  return {
    invoice,
    tenders,
    change_paise: tenders.reduce((s, t) => s + t.change_paise, 0),
    warnings: [],
  }
}

export async function createInvoice(
  tx: Tx,
  ctx: SalesCtx,
  rt: SalesRuntime,
  body: InvoiceCreateParsed,
): Promise<InvoiceSaveResult> {
  if (body.client_ref) {
    const existing = await tx
      .selectFrom('sales_invoices')
      .select('id')
      .where('tenant_id', '=', ctx.tenantId)
      .where('client_ref', '=', body.client_ref)
      .executeTakeFirst()
    if (existing) return replayResult(tx, ctx, rt, existing.id)
  }
  const input: SaleInput & { channel: SalesChannel } = {
    store_id: body.store_id,
    register_id: body.register_id ?? (body.channel === 'pos' ? ctx.registerId : null),
    customer_id: body.customer_id ?? null,
    customer: body.customer ?? null,
    place_of_supply: body.place_of_supply ?? null,
    lines: body.lines,
    bill_discount_bp: body.bill_discount_bp,
    bill_discount_paise: body.bill_discount_paise,
    loyalty_redeem_points: body.loyalty_redeem_points,
    rx: body.rx ?? null,
    invoice_date: body.invoice_date ?? null,
    channel: body.channel,
    credit_limit_override: body.credit_limit_override,
  }
  if (body.status === 'held' || body.status === 'draft') {
    const saved = await saveDraft(tx, ctx, {
      ...input,
      status: body.status,
      client_ref: body.client_ref ?? null,
      salesperson_id: body.salesperson_id ?? null,
      notes: body.notes ?? null,
    })
    return {
      invoice: await loadInvoiceDetail(tx, ctx, saved.id, rt.publicBaseUrl),
      tenders: [],
      change_paise: 0,
      warnings: saved.warnings,
    }
  }
  const result = await commitInvoice(tx, ctx, rt, {
    ...input,
    tenders: body.tenders,
    client_ref: body.client_ref ?? null,
    salesperson_id: body.salesperson_id ?? null,
    notes: body.notes ?? null,
  })
  return saveResult(tx, ctx, rt, result)
}

export async function saveResult(
  tx: Tx,
  ctx: SalesCtx,
  rt: SalesRuntime,
  r: CommitResult,
): Promise<InvoiceSaveResult> {
  return {
    invoice: await loadInvoiceDetail(tx, ctx, r.invoice_id, rt.publicBaseUrl),
    tenders: r.tenders,
    change_paise: r.change_paise,
    warnings: r.warnings,
  }
}

// ---------------------------------------------------------------------------------------------
// Held bills list
// ---------------------------------------------------------------------------------------------

export async function listHeld(
  tx: Tx,
  ctx: SalesCtx,
  q: {
    store_id: string
    register_id?: string | undefined
    status?: Array<'held' | 'draft'> | undefined
  },
): Promise<HeldBill[]> {
  assertStoreAccess(ctx, q.store_id)
  let query = tx
    .selectFrom('sales_invoices as i')
    .leftJoin('registers as r', (j) =>
      j.onRef('r.tenant_id', '=', 'i.tenant_id').onRef('r.id', '=', 'i.register_id'),
    )
    .leftJoin('users as u', 'u.id', 'i.created_by')
    .select([
      'i.id',
      'i.status',
      'i.store_id',
      'i.register_id',
      'r.code as register_code',
      'i.customer_id',
      'i.customer_name',
      'i.item_count',
      'i.total_paise',
      'i.notes',
      'u.full_name as created_by_name',
      'i.created_at',
      'i.updated_at',
    ])
    .where('i.tenant_id', '=', ctx.tenantId)
    .where('i.store_id', '=', q.store_id)
    .where('i.status', 'in', q.status?.length ? q.status : ['held', 'draft'])
  if (q.register_id) query = query.where('i.register_id', '=', q.register_id)
  const rows = await query.orderBy('i.updated_at', 'desc').limit(200).execute()
  return rows.map((r) => ({
    id: r.id,
    status: r.status === 'draft' ? 'draft' : 'held',
    store_id: r.store_id,
    register_id: r.register_id,
    register_code: r.register_code ?? null,
    customer_id: r.customer_id,
    customer_name: r.customer_name,
    item_count: r.item_count,
    total_paise: r.total_paise,
    notes: r.notes,
    created_by_name: r.created_by_name ?? null,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  }))
}

// ---------------------------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------------------------

export async function cancelInvoice(
  tx: Tx,
  ctx: SalesCtx,
  rt: SalesRuntime,
  id: string,
  reason: string,
): Promise<InvoiceCancelResult> {
  const row = await loadInvoiceRow(tx, ctx, id, { forUpdate: true })
  if (row.status === 'cancelled') {
    throw conflict('The bill is already cancelled', { reason: 'already_cancelled' })
  }
  if (row.status !== 'completed') {
    throw conflict(`A ${row.status} bill cannot be cancelled`, {
      reason: 'not_completed',
      status: row.status,
    })
  }
  const today = await tenantToday(tx, ctx)
  const now = new Date()

  if (row.doc_type === 'estimate') {
    await tx
      .updateTable('sales_invoices')
      .set({
        status: 'cancelled',
        cancelled_at: now,
        cancelled_by: ctx.userId,
        cancel_reason: reason,
      })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', id)
      .execute()
    await audit(tx, ctx, {
      action: 'sales_invoice.cancel',
      entity_type: 'sales_invoice',
      entity_id: id,
      summary: `Estimate ${row.number ?? ''} cancelled: ${reason}`,
      changes: { reason },
    })
    return { invoice: await loadInvoiceDetail(tx, ctx, id, rt.publicBaseUrl), refunds: [] }
  }

  const liveNotes = await tx
    .selectFrom('credit_notes')
    .select(['id', 'number'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('invoice_id', '=', id)
    .where('status', '=', 'completed')
    .execute()
  if (liveNotes.length) {
    throw conflict('The bill has returns (credit notes); cancel them first', {
      reason: 'has_credit_notes',
      credit_note_ids: liveNotes.map((n) => n.id),
    })
  }

  // ---- payments ----------------------------------------------------------------------------
  const allocated = await tx
    .selectFrom('payment_allocations as a')
    .innerJoin('payments as p', (j) =>
      j.onRef('p.tenant_id', '=', 'a.tenant_id').onRef('p.id', '=', 'a.payment_id'),
    )
    .leftJoin('payment_intents as pi', (j) =>
      j.onRef('pi.tenant_id', '=', 'p.tenant_id').onRef('pi.id', '=', 'p.payment_intent_id'),
    )
    .select([
      'p.id',
      'p.method',
      'p.amount_paise',
      'p.reference',
      'p.payment_intent_id',
      'pi.provider',
      'pi.utr',
    ])
    .where('a.tenant_id', '=', ctx.tenantId)
    .where('a.target_type', '=', 'sales_invoice')
    .where('a.target_id', '=', id)
    .where('p.status', '=', 'completed')
    .orderBy('p.paid_at')
    .execute()
  const paymentIds = [...new Set(allocated.map((p) => p.id))]
  if (paymentIds.length) {
    const foreign = await tx
      .selectFrom('payment_allocations')
      .select(['payment_id'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('payment_id', 'in', paymentIds)
      .where((eb) => eb.or([eb('target_type', '<>', 'sales_invoice'), eb('target_id', '<>', id)]))
      .execute()
    if (foreign.length) {
      throw conflict('A receipt of this bill also settles other documents; cancel it first', {
        reason: 'shared_receipt',
        payment_ids: [...new Set(foreign.map((f) => f.payment_id))],
      })
    }
  }
  const refunds: InvoiceCancelResult['refunds'] = []
  const seen = new Set<string>()
  for (const p of allocated) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    await cancelPayment(tx, ctx, {
      payment_id: p.id,
      reason: `Bill ${row.number ?? ''} cancelled: ${reason}`.slice(0, 500),
      date: today,
    })
    const provider = p.provider ?? null
    const pspRefund =
      p.method === 'upi' &&
      !(provider && provider in PROVIDER_CAPABILITIES
        ? PROVIDER_CAPABILITIES[provider as keyof typeof PROVIDER_CAPABILITIES].refunds
        : false)
    refunds.push({
      payment_id: p.id,
      method: p.method as InvoiceCancelResult['refunds'][number]['method'],
      amount_paise: p.amount_paise,
      psp_refund_required: pspRefund,
      provider,
      utr: p.utr ?? p.reference ?? null,
    })
  }

  // ---- stock back at the original costs ------------------------------------------------------
  const lines = await loadStoredLines(tx, ctx, id)
  const movements = lines.flatMap((l) =>
    l.product_id && l.track_inventory
      ? [
          {
            store_id: row.store_id,
            product_id: l.product_id,
            batch_id: l.batch_id,
            qty_milli: l.qty_milli + l.free_qty_milli,
            movement_type: 'sale_cancel' as const,
            unit_cost_paise: l.unit_cost_paise,
            ref_type: 'sales_invoice',
            ref_id: id,
            ref_line_id: l.id,
            reason: reason.slice(0, 200),
          },
        ]
      : [],
  )
  if (movements.length) await postStock(tx, ctx, movements, { allowNegative: true })

  // ---- journal, loyalty, status ----------------------------------------------------------------
  await reverseJournal(tx, ctx, {
    source_type: 'sales_invoice',
    source_id: id,
    entry_date: today,
    narration: `Cancelled ${row.number ?? ''}: ${reason}`.slice(0, 500),
  })
  if (row.customer_id && (row.loyalty_points_earned > 0 || row.loyalty_points_redeemed > 0)) {
    const rev = await reversiblePoints(tx, ctx, {
      customer_id: row.customer_id,
      ref_type: 'sales_invoice',
      ref_id: id,
    })
    if (rev.earned > 0 || rev.redeemed > 0) {
      await reversePoints(tx, ctx, {
        customer_id: row.customer_id,
        ref_type: 'sales_invoice',
        ref_id: id,
        notes: `Bill ${row.number ?? ''} cancelled`,
      })
    }
  }
  await tx
    .updateTable('sales_invoices')
    .set({
      status: 'cancelled',
      cancelled_at: now,
      cancelled_by: ctx.userId,
      cancel_reason: reason,
      due_paise: 0,
      payment_status: refunds.length ? 'refunded' : 'unpaid',
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
  await audit(tx, ctx, {
    action: 'sales_invoice.cancel',
    entity_type: 'sales_invoice',
    entity_id: id,
    summary: `Bill ${row.number ?? ''} of ${row.total_paise} paise cancelled: ${reason}`,
    changes: {
      reason,
      total_paise: row.total_paise,
      refunds: refunds.map((r) => ({
        payment_id: r.payment_id,
        method: r.method,
        amount_paise: r.amount_paise,
      })),
    },
  })
  return { invoice: await loadInvoiceDetail(tx, ctx, id, rt.publicBaseUrl), refunds }
}

// ---------------------------------------------------------------------------------------------
// Dues collection
// ---------------------------------------------------------------------------------------------

export async function collectPayment(
  tx: Tx,
  ctx: SalesCtx,
  rt: SalesRuntime,
  id: string,
  body: {
    tenders: readonly Tender[]
    payment_date?: string | undefined
    register_id?: string | undefined
    notes?: string | undefined
    client_ref?: string | undefined
  },
): Promise<{
  invoice: Awaited<ReturnType<typeof loadInvoiceDetail>>
  tenders: InvoiceSaveResult['tenders']
  change_paise: number
}> {
  const row = await loadInvoiceRow(tx, ctx, id, { forUpdate: true })
  if (row.status !== 'completed' || row.doc_type === 'estimate') {
    throw conflict('Payments can be collected only on completed bills', {
      reason: 'not_completed',
      status: row.status,
    })
  }
  if (row.due_paise <= 0) throw conflict('Nothing is due on this bill', { reason: 'nothing_due' })
  const env = await salesEnv(tx, ctx)
  const paymentDate = body.payment_date ?? env.today
  if (paymentDate > env.today) {
    throw invalidField('payment_date', 'The payment date cannot be in the future')
  }
  const alloc = allocateTenders(row.due_paise, body.tenders)
  if (alloc.issue) {
    throw unprocessable(
      alloc.issue.code === 'tender_exceeds_due'
        ? 'A payment is more than the amount due'
        : 'The cash tender is not needed',
      { reason: alloc.issue.code, index: alloc.issue.index, due_paise: row.due_paise },
    )
  }
  let registerId: string | null = body.register_id ?? null
  if (registerId) {
    const reg = await tx
      .selectFrom('registers')
      .select(['store_id'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', registerId)
      .executeTakeFirst()
    if (!reg) throw notFound('register', registerId)
    if (reg.store_id !== row.store_id) {
      throw invalidField('register_id', 'The register belongs to another store')
    }
  } else {
    registerId = null
  }
  const shift = registerId
    ? await tx
        .selectFrom('register_shifts')
        .select('id')
        .where('tenant_id', '=', ctx.tenantId)
        .where('register_id', '=', registerId)
        .where('status', '=', 'open')
        .executeTakeFirst()
    : undefined
  const party = row.customer_id ? { type: 'customer' as const, id: row.customer_id } : null
  const results: InvoiceSaveResult['tenders'] = []
  const ref = body.client_ref ?? newId()
  for (const line of alloc.lines) {
    const tender = body.tenders[line.index]!
    const accountId = tender.provider_account_id
      ? await settlementAccountOf(tx, ctx, tender.provider_account_id, row.store_id)
      : null
    const notes = [
      body.notes ?? null,
      line.method === 'cash' && line.change_paise > 0
        ? cashTenderNotes(line.amount_paise, line.change_paise)
        : null,
    ]
      .filter(Boolean)
      .join(' ')
    const payment = await recordPayment(tx, ctx, {
      direction: 'in',
      store_id: row.store_id,
      register_id: registerId,
      shift_id: shift?.id ?? null,
      method: tender.method,
      amount_paise: line.applied_paise,
      payment_date: paymentDate,
      party,
      reference: tender.reference ?? null,
      payment_intent_id: tender.payment_intent_id ?? null,
      account_id: accountId,
      allocations: [
        { target_type: 'sales_invoice', target_id: id, amount_paise: line.applied_paise },
      ],
      notes: notes || null,
      client_ref: `collect:${id}:${ref}:${line.index}`.slice(0, 200),
      number: true,
    })
    results.push({ ...line, payment_id: payment.id })
  }
  return {
    invoice: await loadInvoiceDetail(tx, ctx, id, rt.publicBaseUrl),
    tenders: results,
    change_paise: alloc.change_paise,
  }
}

// ---------------------------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------------------------

export async function createEstimate(
  tx: Tx,
  ctx: SalesCtx,
  rt: SalesRuntime,
  body: z.output<typeof EstimateCreateSchema>,
): Promise<Awaited<ReturnType<typeof loadInvoiceDetail>>> {
  if (body.client_ref) {
    const existing = await tx
      .selectFrom('sales_invoices')
      .select('id')
      .where('tenant_id', '=', ctx.tenantId)
      .where('client_ref', '=', body.client_ref)
      .executeTakeFirst()
    if (existing) return loadInvoiceDetail(tx, ctx, existing.id, rt.publicBaseUrl)
  }
  const priced = await priceSale(
    tx,
    ctx,
    {
      store_id: body.store_id,
      register_id: body.register_id ?? null,
      customer_id: body.customer_id ?? null,
      customer: body.customer ?? null,
      place_of_supply: body.place_of_supply ?? null,
      lines: body.lines,
      bill_discount_bp: body.bill_discount_bp,
      bill_discount_paise: body.bill_discount_paise,
      rx: body.rx ?? null,
    },
    { mode: 'estimate' },
  )
  assertNoBlocking(priced.issues)
  await assertSalesperson(tx, ctx, body.salesperson_id)
  const today = priced.env.today
  const validUntil = body.valid_until ?? addDays(today, ESTIMATE_VALIDITY_DAYS)
  if (validUntil < today) {
    throw invalidField('valid_until', 'estimate_valid_until_past')
  }
  const n = await nextNumber(tx, ctx, {
    docType: 'estimate',
    storeId: priced.store.id,
    date: today,
  })
  const id = newId()
  await tx
    .insertInto('sales_invoices')
    .values({
      id,
      tenant_id: ctx.tenantId,
      ...pricedHeader(priced),
      number: n.number,
      fy: n.fy,
      invoice_date: today,
      due_date: validUntil,
      status: 'completed',
      channel: priced.register ? 'pos' : 'backoffice',
      due_paise: 0,
      paid_paise: 0,
      payment_status: 'unpaid',
      salesperson_id: body.salesperson_id ?? null,
      notes: body.notes ?? null,
      client_ref: body.client_ref ?? null,
      share_token: generateShareToken(),
      completed_at: new Date(),
      created_by: ctx.userId,
      meta: jsonb(priced.meta),
    })
    .execute()
  const rows = lineRows(ctx.tenantId, id, priced, [])
  if (rows.length) await tx.insertInto('sales_invoice_lines').values(rows).execute()
  return loadInvoiceDetail(tx, ctx, id, rt.publicBaseUrl)
}

export async function convertEstimate(
  tx: Tx,
  ctx: SalesCtx,
  rt: SalesRuntime,
  id: string,
  body: z.output<typeof EstimateConvertSchema>,
): Promise<InvoiceSaveResult> {
  const est = await loadInvoiceRow(tx, ctx, id, { forUpdate: true })
  if (est.doc_type !== 'estimate') {
    throw conflict('Only estimates can be converted', { reason: 'not_an_estimate' })
  }
  if (est.status !== 'completed') {
    throw conflict(`The estimate is ${est.status}`, {
      reason: est.status === 'converted' ? 'already_converted' : 'not_open',
      status: est.status,
      converted_to_id: est.converted_to_id,
    })
  }
  const cart = await storedCart(tx, ctx, est, { keepPrices: body.keep_prices })
  const trusted = body.keep_prices ? new Set(cart.lines.map((l) => l.key ?? '')) : undefined
  const base: SaleInput & { channel: SalesChannel } = {
    ...cart,
    register_id: body.register_id ?? (body.channel === 'pos' ? est.register_id : null),
    invoice_date: body.invoice_date ?? null,
    channel: body.channel,
    credit_limit_override: body.credit_limit_override,
    rx: null,
  }
  const meta = { source_estimate_id: est.id, source_estimate_number: est.number }
  let result: InvoiceSaveResult
  let newInvoiceId: string
  if (body.status === 'draft') {
    const saved = await saveDraft(
      tx,
      ctx,
      {
        ...base,
        status: 'draft',
        client_ref: body.client_ref ?? null,
        salesperson_id: est.salesperson_id,
        notes: est.notes,
      },
      { extraMeta: meta, ...(trusted ? { trustedKeys: trusted } : {}) },
    )
    newInvoiceId = saved.id
    result = {
      invoice: await loadInvoiceDetail(tx, ctx, saved.id, rt.publicBaseUrl),
      tenders: [],
      change_paise: 0,
      warnings: saved.warnings,
    }
  } else {
    const r = await commitInvoice(
      tx,
      ctx,
      rt,
      {
        ...base,
        tenders: body.tenders,
        client_ref: body.client_ref ?? null,
        salesperson_id: est.salesperson_id,
        notes: est.notes,
      },
      { extraMeta: meta, ...(trusted ? { trustedKeys: trusted } : {}) },
    )
    newInvoiceId = r.invoice_id
    result = await saveResult(tx, ctx, rt, r)
  }
  await tx
    .updateTable('sales_invoices')
    .set({ status: 'converted', converted_to_id: newInvoiceId })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
  await audit(tx, ctx, {
    action: 'sales_invoice.estimate_convert',
    entity_type: 'sales_invoice',
    entity_id: id,
    summary: `Estimate ${est.number ?? ''} converted to ${result.invoice.number ?? 'a draft'}`,
    changes: { invoice_id: newInvoiceId, status: body.status, keep_prices: body.keep_prices },
  })
  // The detail of the new invoice shows source_estimate only after the estimate row is updated.
  result.invoice = await loadInvoiceDetail(tx, ctx, newInvoiceId, rt.publicBaseUrl)
  return result
}
