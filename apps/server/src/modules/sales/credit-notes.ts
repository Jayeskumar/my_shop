/**
 * Returns / credit notes (ARCHITECTURE.md §10 "Credit note (return)"):
 *
 *  - amounts are pro-rata from the ORIGINAL invoice line (prorateReturnLine: taxable / tax heads
 *    scaled by quantity, the final return of a line takes the exact remainder, so live notes
 *    always sum to the line), rounded per settings.invoice.round_off — the note that completes the
 *    return of a whole invoice takes the round-off that makes Σ notes = the invoice total;
 *  - stock 'sale_return' for restocked lines at the original unit cost (damaged / expired goods
 *    are not restocked by default);
 *  - journal: Dr sales_returns (taxable) + output taxes, Cr receivable (customer) total, round
 *    off; Dr inventory, Cr COGS (restocked cost);
 *  - settlement: cash / upi / bank_transfer → recordPayment(out) refund (≤ what was paid and not
 *    refunded yet); adjust_due → reduces the invoice due (the excess over the due becomes the
 *    customer's store credit); store_credit → recordPayment(out, store_credit);
 *  - invoice lines' returned_qty_milli, invoice returned_paise / payment_status, proportional
 *    loyalty reversal; audited. Cancelling a note reverses all of it.
 * Free-form returns (no invoice) need sales.return + sales.cancel and product lines with prices.
 */
import {
  type CreditNoteReason,
  type CreditNoteSettlement,
  CreditNoteReasonSchema,
  CreditNoteSettlementSchema,
  CreditNoteStatusSchema,
  computeDocument,
  newId,
  roundToRupee,
  sumSafe,
} from '@kadai/shared'
import { paymentClientRef } from '@kadai/shared/api/payments'
import {
  type CreditNoteDetail,
  type ReturnableResponse,
  SALES_BACKDATE_PERMISSION,
  creditNoteSettlementOptions,
  defaultRestock,
  prorateReturnLine,
  returnableQtyMilli,
  salesDocumentModeFor,
} from '@kadai/shared/api/sales'
import type { TaxAmounts } from '@kadai/shared'
import { sql } from 'kysely'
import { jsonb } from '../../db/json'
import type { Tx } from '../../db/tenant'
import { audit } from '../../core/audit'
import { conflict, forbidden, invalidField, notFound, unprocessable } from '../../core/errors'
import { assertStoreAccess } from '../../core/http'
import { postStock } from '../../core/inventory'
import { postJournal, reverseJournal } from '../../core/ledger'
import { adjustPoints, earnPoints, reversePoints, reversiblePoints } from '../../core/loyalty'
import { nextNumber } from '../../core/numbering'
import { cancelPayment, recordPayment, storeCreditBalance } from '../../core/payments'
import {
  type SalesCtx,
  can,
  loadCustomer,
  loadRegister,
  loadStore,
  openShiftOf,
  recordOf,
  salesEnv,
} from './common'
import {
  type InvoiceRow,
  invoicePayments,
  loadInvoiceRow,
  loadStoredLines,
  taxBreakupOf,
} from './detail'
import { loadProducts } from './pricing'

export interface CreditNoteInput {
  client_ref: string
  invoice_id?: string | undefined
  invoice_client_ref?: string | undefined
  store_id?: string | undefined
  register_id?: string | undefined
  customer_id?: string | undefined
  note_date?: string | undefined
  lines: Array<{
    invoice_line_id?: string | undefined
    invoice_line_no?: number | undefined
    product_id?: string | undefined
    batch_id?: string | undefined
    unit_price_paise?: number | undefined
    qty_milli: number
    restock?: boolean | undefined
  }>
  reason: CreditNoteReason
  settlement: CreditNoteSettlement
  refund_reference?: string | undefined
  provider_account_id?: string | undefined
  notes?: string | undefined
}

interface NoteLine {
  invoice_line_id: string | null
  product_id: string | null
  batch_id: string | null
  name: string
  name_ta: string | null
  hsn_code: string | null
  unit: string
  pack_size: number
  qty_milli: number
  unit_price_paise: number
  gst_rate_bp: number
  cess_rate_bp: number
  amounts: TaxAmounts & { total_paise: number }
  unit_cost_paise: number
  restock: boolean
  track_inventory: boolean
  batch_tracked: boolean
}

const ZERO: TaxAmounts = {
  taxable_paise: 0,
  cgst_paise: 0,
  sgst_paise: 0,
  igst_paise: 0,
  cess_paise: 0,
}

/** Amounts credited so far by LIVE credit notes, per invoice line. */
async function creditedByLine(
  tx: Tx,
  ctx: SalesCtx,
  invoiceId: string,
): Promise<Map<string, TaxAmounts>> {
  const rows = await tx
    .selectFrom('credit_note_lines as l')
    .innerJoin('credit_notes as c', (j) =>
      j.onRef('c.tenant_id', '=', 'l.tenant_id').onRef('c.id', '=', 'l.credit_note_id'),
    )
    .select([
      'l.invoice_line_id',
      sql<number>`sum(l.taxable_paise)::bigint`.as('taxable_paise'),
      sql<number>`sum(l.cgst_paise)::bigint`.as('cgst_paise'),
      sql<number>`sum(l.sgst_paise)::bigint`.as('sgst_paise'),
      sql<number>`sum(l.igst_paise)::bigint`.as('igst_paise'),
      sql<number>`sum(l.cess_paise)::bigint`.as('cess_paise'),
    ])
    .where('l.tenant_id', '=', ctx.tenantId)
    .where('c.invoice_id', '=', invoiceId)
    .where('c.status', '=', 'completed')
    .where('l.invoice_line_id', 'is not', null)
    .groupBy('l.invoice_line_id')
    .execute()
  return new Map(
    rows.map((r) => [
      r.invoice_line_id!,
      {
        taxable_paise: Number(r.taxable_paise),
        cgst_paise: Number(r.cgst_paise),
        sgst_paise: Number(r.sgst_paise),
        igst_paise: Number(r.igst_paise),
        cess_paise: Number(r.cess_paise),
      },
    ]),
  )
}

/** Money given back so far for an invoice (refunds + store credit of live notes). */
async function refundedFor(tx: Tx, ctx: SalesCtx, invoiceId: string): Promise<number> {
  const row = await tx
    .selectFrom('payment_allocations as a')
    .innerJoin('payments as p', (j) =>
      j.onRef('p.tenant_id', '=', 'a.tenant_id').onRef('p.id', '=', 'a.payment_id'),
    )
    .innerJoin('credit_notes as c', (j) =>
      j.onRef('c.tenant_id', '=', 'a.tenant_id').onRef('c.id', '=', 'a.target_id'),
    )
    .select(sql<number>`coalesce(sum(a.amount_paise), 0)::bigint`.as('total'))
    .where('a.tenant_id', '=', ctx.tenantId)
    .where('a.target_type', '=', 'credit_note')
    .where('c.invoice_id', '=', invoiceId)
    .where('c.status', '=', 'completed')
    .where('p.status', '=', 'completed')
    .where('p.direction', '=', 'out')
    .executeTakeFirstOrThrow()
  return Number(row.total)
}

function paymentStatusOf(paid: number, due: number): 'unpaid' | 'partial' | 'paid' {
  if (due <= 0) return 'paid'
  return paid > 0 ? 'partial' : 'unpaid'
}

// ---------------------------------------------------------------------------------------------
// Returnable
// ---------------------------------------------------------------------------------------------

export async function returnable(
  tx: Tx,
  ctx: SalesCtx,
  invoiceId: string,
): Promise<ReturnableResponse> {
  const inv = await loadInvoiceRow(tx, ctx, invoiceId)
  const lines = await loadStoredLines(tx, ctx, invoiceId)
  const credited = await creditedByLine(tx, ctx, invoiceId)
  const refunded = await refundedFor(tx, ctx, invoiceId)
  const showCost = can(ctx, 'reports.read')
  return {
    invoice: {
      id: inv.id,
      number: inv.number,
      doc_type: inv.doc_type as ReturnableResponse['invoice']['doc_type'],
      invoice_date: inv.invoice_date,
      status: inv.status as ReturnableResponse['invoice']['status'],
      store_id: inv.store_id,
      customer_id: inv.customer_id,
      customer_name: inv.customer_name,
      is_interstate: inv.is_interstate,
      total_paise: inv.total_paise,
      paid_paise: inv.paid_paise,
      due_paise: inv.due_paise,
      returned_paise: inv.returned_paise,
      payment_status: inv.payment_status as ReturnableResponse['invoice']['payment_status'],
    },
    lines: lines.map((l) => ({
      invoice_line_id: l.id,
      line_no: l.line_no,
      product_id: l.product_id,
      batch_id: l.batch_id,
      batch_no: l.batch_no ?? null,
      expiry_date: l.expiry_date ?? null,
      name: l.name,
      name_ta: l.name_ta,
      hsn_code: l.hsn_code,
      unit: l.unit,
      pack_size: l.pack_size,
      qty_milli: l.qty_milli + l.free_qty_milli,
      returned_qty_milli: l.returned_qty_milli,
      returnable_qty_milli:
        inv.status === 'completed' && inv.doc_type !== 'estimate' ? returnableQtyMilli(l) : 0,
      unit_price_paise: l.unit_price_paise,
      gross_paise: l.gross_paise,
      discount_paise: l.discount_paise,
      taxable_paise: l.taxable_paise,
      gst_rate_bp: l.gst_rate_bp,
      cgst_paise: l.cgst_paise,
      sgst_paise: l.sgst_paise,
      igst_paise: l.igst_paise,
      cess_rate_bp: l.cess_rate_bp,
      cess_paise: l.cess_paise,
      total_paise: l.total_paise,
      credited: credited.get(l.id) ?? { ...ZERO },
      unit_cost_paise: showCost ? l.unit_cost_paise : 0,
      track_inventory: l.track_inventory ?? false,
    })),
    refundable_paise: Math.max(0, inv.paid_paise - refunded),
  }
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

export async function createCreditNote(
  tx: Tx,
  ctx: SalesCtx,
  input: CreditNoteInput,
  opts: { sync?: { offline_created_at: Date } } = {},
): Promise<{ id: string; replayed: boolean }> {
  const existing = await tx
    .selectFrom('credit_notes')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('client_ref', '=', input.client_ref)
    .executeTakeFirst()
  if (existing) return { id: existing.id, replayed: true }

  const env = await salesEnv(tx, ctx)
  const sync = opts.sync ?? null
  const noteDate = input.note_date ?? env.today
  if (!sync) {
    if (noteDate > env.today) throw invalidField('note_date', 'The date cannot be in the future')
    if (noteDate < env.today && !can(ctx, SALES_BACKDATE_PERMISSION)) {
      throw forbidden('Back-dated returns need manager permission', {
        reason: 'backdate_not_allowed',
        required: [SALES_BACKDATE_PERMISSION],
      })
    }
  }

  // ---- source document ---------------------------------------------------------------------
  let invoice: InvoiceRow | null = null
  if (input.invoice_id || input.invoice_client_ref) {
    let id = input.invoice_id
    if (!id) {
      const byRef = await tx
        .selectFrom('sales_invoices')
        .select('id')
        .where('tenant_id', '=', ctx.tenantId)
        .where('client_ref', '=', input.invoice_client_ref!)
        .executeTakeFirst()
      if (!byRef) throw notFound('sales_invoice', input.invoice_client_ref)
      id = byRef.id
    }
    invoice = await loadInvoiceRow(tx, ctx, id, { forUpdate: true })
    if (invoice.status !== 'completed' || invoice.doc_type === 'estimate') {
      throw conflict('Returns can be accepted only on completed bills', {
        reason: 'invoice_not_returnable',
        status: invoice.status,
        doc_type: invoice.doc_type,
      })
    }
    if (input.store_id && input.store_id !== invoice.store_id) {
      throw invalidField('store_id', 'The bill belongs to another store')
    }
  } else if (!can(ctx, ['sales.cancel'])) {
    throw forbidden('Returns without a bill need manager permission', {
      reason: 'free_form_return',
      required: ['sales.return', 'sales.cancel'],
    })
  }
  const storeId = invoice?.store_id ?? input.store_id!
  const store = await loadStore(tx, ctx, storeId)
  const register = input.register_id
    ? await loadRegister(tx, ctx, input.register_id, store.id, { requireActive: !sync })
    : null
  const shift = register ? await openShiftOf(tx, ctx, register.id) : null
  const customerId = invoice ? invoice.customer_id : (input.customer_id ?? null)
  const customer = customerId
    ? await loadCustomer(tx, ctx, customerId, { requireActive: false })
    : null

  // ---- lines -------------------------------------------------------------------------------
  const lines: NoteLine[] = []
  let fullReturn = false
  if (invoice) {
    const stored = await loadStoredLines(tx, ctx, invoice.id, { forUpdate: true })
    const byId = new Map(stored.map((l) => [l.id, l]))
    const byNo = new Map(stored.map((l) => [l.line_no, l]))
    const credited = await creditedByLine(tx, ctx, invoice.id)
    const returnedNow = new Map<string, number>()
    for (const [i, l] of input.lines.entries()) {
      const src = l.invoice_line_id
        ? byId.get(l.invoice_line_id)
        : byNo.get(l.invoice_line_no ?? -1)
      if (!src) {
        throw invalidField(`lines.${i}.invoice_line_id`, 'The line is not on this bill')
      }
      const left = returnableQtyMilli(src)
      if (l.qty_milli > left) {
        throw unprocessable('More than the returnable quantity', {
          reason: 'return_exceeds_returnable',
          line_index: i,
          invoice_line_id: src.id,
          returnable_qty_milli: left,
          qty_milli: l.qty_milli,
        })
      }
      const amounts = prorateReturnLine(src, {
        qty_milli: l.qty_milli,
        total_qty_milli: src.qty_milli + src.free_qty_milli,
        returned_qty_milli: src.returned_qty_milli,
        credited: credited.get(src.id) ?? ZERO,
      })
      returnedNow.set(src.id, l.qty_milli)
      const tracked = src.product_id !== null && (src.track_inventory ?? false)
      lines.push({
        invoice_line_id: src.id,
        product_id: src.product_id,
        batch_id: src.batch_id,
        name: src.name,
        name_ta: src.name_ta,
        hsn_code: src.hsn_code,
        unit: src.unit,
        pack_size: src.pack_size,
        qty_milli: l.qty_milli,
        unit_price_paise: src.unit_price_paise,
        gst_rate_bp: src.gst_rate_bp,
        cess_rate_bp: src.cess_rate_bp,
        amounts,
        unit_cost_paise: src.unit_cost_paise,
        restock: tracked && (l.restock ?? defaultRestock(input.reason)),
        track_inventory: tracked,
        batch_tracked: src.batch_id !== null,
      })
    }
    fullReturn = stored.every(
      (s) => s.returned_qty_milli + (returnedNow.get(s.id) ?? 0) >= s.qty_milli + s.free_qty_milli,
    )
  } else {
    const products = await loadProducts(
      tx,
      ctx,
      input.lines.map((l) => l.product_id!),
    )
    const scheme = salesDocumentModeFor(env.tenant.gst_scheme)
    const doc = computeDocument({
      lines: input.lines.map((l, i) => {
        const p = products.get(l.product_id!)
        if (!p) throw invalidField(`lines.${i}.product_id`, 'Unknown product')
        return {
          key: String(i),
          unit_price_paise: l.unit_price_paise!,
          qty_milli: l.qty_milli,
          pack_size: p.pack_size,
          price_includes_tax: p.price_includes_tax,
          gst_rate_bp: p.gst_rate_bp,
          cess_rate_bp: p.cess_rate_bp,
        }
      }),
      is_interstate: false,
      tax_mode: scheme.tax_mode,
      round_off: 'none',
    })
    for (const [i, l] of input.lines.entries()) {
      const p = products.get(l.product_id!)!
      const r = doc.lines[i]!
      const batchTracked = p.track_inventory && p.track_batches
      if (batchTracked && !l.batch_id) {
        throw invalidField(`lines.${i}.batch_id`, 'Select the batch of the returned item')
      }
      if (l.batch_id) {
        const b = await tx
          .selectFrom('batches')
          .select(['product_id'])
          .where('tenant_id', '=', ctx.tenantId)
          .where('id', '=', l.batch_id)
          .executeTakeFirst()
        if (!b || b.product_id !== p.id || !batchTracked) {
          throw invalidField(`lines.${i}.batch_id`, 'The batch does not belong to the product')
        }
      }
      const level = p.track_inventory
        ? await tx
            .selectFrom('stock_levels')
            .select('avg_cost_paise')
            .where('tenant_id', '=', ctx.tenantId)
            .where('store_id', '=', store.id)
            .where('product_id', '=', p.id)
            .where((eb) =>
              l.batch_id ? eb('batch_id', '=', l.batch_id) : eb('batch_id', 'is', null),
            )
            .executeTakeFirst()
        : undefined
      lines.push({
        invoice_line_id: null,
        product_id: p.id,
        batch_id: batchTracked ? (l.batch_id ?? null) : null,
        name: p.name,
        name_ta: p.name_ta,
        hsn_code: p.hsn_code,
        unit: p.unit,
        pack_size: p.pack_size,
        qty_milli: l.qty_milli,
        unit_price_paise: l.unit_price_paise!,
        gst_rate_bp: r.gst_rate_bp,
        cess_rate_bp: r.cess_rate_bp,
        amounts: {
          taxable_paise: r.taxable_paise,
          cgst_paise: r.cgst_paise,
          sgst_paise: r.sgst_paise,
          igst_paise: r.igst_paise,
          cess_paise: r.cess_paise,
          total_paise: r.total_paise,
        },
        unit_cost_paise: level?.avg_cost_paise || p.purchase_price_paise,
        restock: p.track_inventory && (l.restock ?? defaultRestock(input.reason)),
        track_inventory: p.track_inventory,
        batch_tracked: batchTracked,
      })
    }
  }

  // ---- totals ------------------------------------------------------------------------------
  const sum = (k: keyof TaxAmounts): number => sumSafe(lines.map((l) => l.amounts[k]))
  const taxable = sum('taxable_paise')
  const cgst = sum('cgst_paise')
  const sgst = sum('sgst_paise')
  const igst = sum('igst_paise')
  const cess = sum('cess_paise')
  const beforeRound = taxable + cgst + sgst + igst + cess
  let roundOff =
    env.settings.invoice.round_off === 'nearest_rupee'
      ? roundToRupee(beforeRound).round_off_paise
      : 0
  if (invoice && fullReturn) {
    const prior = await tx
      .selectFrom('credit_notes')
      .select(sql<number>`coalesce(sum(total_paise), 0)::bigint`.as('total'))
      .where('tenant_id', '=', ctx.tenantId)
      .where('invoice_id', '=', invoice.id)
      .where('status', '=', 'completed')
      .executeTakeFirstOrThrow()
    const exact = invoice.total_paise - Number(prior.total) - beforeRound
    if (exact >= -99 && exact <= 99) roundOff = exact
  }
  const total = Math.max(0, beforeRound + roundOff)
  if (total !== beforeRound + roundOff) roundOff = total - beforeRound

  // ---- settlement checks -------------------------------------------------------------------
  const refundable = invoice
    ? Math.max(0, invoice.paid_paise - (await refundedFor(tx, ctx, invoice.id)))
    : null
  const allowed = creditNoteSettlementOptions({
    has_invoice: invoice !== null,
    has_customer: customer !== null,
    invoice_due_paise: invoice?.due_paise ?? 0,
    refundable_paise: refundable,
    total_paise: total,
  })
  if (!allowed.includes(input.settlement)) {
    throw unprocessable('This settlement is not possible for this return', {
      reason: 'settlement_not_allowed',
      settlement: input.settlement,
      allowed,
      refundable_paise: refundable,
      due_paise: invoice?.due_paise ?? null,
    })
  }

  // ---- number & rows -----------------------------------------------------------------------
  const n = await nextNumber(tx, ctx, { docType: 'credit_note', storeId: store.id, date: noteDate })
  const id = newId()
  const restockAny = lines.some((l) => l.restock)
  await tx
    .insertInto('credit_notes')
    .values({
      id,
      tenant_id: ctx.tenantId,
      store_id: store.id,
      register_id: register?.id ?? null,
      shift_id: shift?.id ?? null,
      number: n.number,
      fy: n.fy,
      note_date: noteDate,
      invoice_id: invoice?.id ?? null,
      customer_id: customer?.id ?? null,
      customer_name: invoice?.customer_name ?? customer?.name ?? null,
      customer_phone: invoice?.customer_phone ?? customer?.phone ?? null,
      customer_gstin: invoice?.customer_gstin ?? customer?.gstin ?? null,
      customer_state_code: invoice?.customer_state_code ?? customer?.state_code ?? null,
      place_of_supply: invoice?.place_of_supply ?? store.state_code,
      is_interstate: invoice?.is_interstate ?? false,
      reason: input.reason,
      status: 'completed',
      taxable_paise: taxable,
      cgst_paise: cgst,
      sgst_paise: sgst,
      igst_paise: igst,
      cess_paise: cess,
      round_off_paise: roundOff,
      total_paise: total,
      settlement: input.settlement,
      settled_paise: 0,
      restock: restockAny,
      notes: input.notes ?? null,
      client_ref: input.client_ref,
      offline_created_at: sync?.offline_created_at ?? null,
      created_by: ctx.userId,
      meta: jsonb({
        ...(input.refund_reference ? { refund_reference: input.refund_reference } : {}),
      }),
    })
    .execute()

  // Stock back for restocked lines at the original cost.
  const lineIds = lines.map(() => newId())
  const stockIdx: number[] = []
  const movements = lines.flatMap((l, i) => {
    if (!l.restock || !l.product_id) return []
    stockIdx.push(i)
    return [
      {
        store_id: store.id,
        product_id: l.product_id,
        batch_id: l.batch_tracked ? l.batch_id : null,
        qty_milli: l.qty_milli,
        movement_type: 'sale_return' as const,
        unit_cost_paise: l.unit_cost_paise,
        ref_type: 'credit_note',
        ref_id: id,
        ref_line_id: lineIds[i]!,
        reason: input.reason,
      },
    ]
  })
  const posted = movements.length ? await postStock(tx, ctx, movements) : []
  const costs = lines.map(() => 0)
  for (const [k, i] of stockIdx.entries()) costs[i] = posted[k]!.cost_paise
  const cost = sumSafe(costs)

  await tx
    .insertInto('credit_note_lines')
    .values(
      lines.map((l, i) => ({
        id: lineIds[i]!,
        tenant_id: ctx.tenantId,
        credit_note_id: id,
        line_no: i + 1,
        invoice_line_id: l.invoice_line_id,
        product_id: l.product_id,
        batch_id: l.batch_id,
        name: l.name,
        name_ta: l.name_ta,
        hsn_code: l.hsn_code,
        unit: l.unit,
        pack_size: l.pack_size,
        qty_milli: l.qty_milli,
        unit_price_paise: l.unit_price_paise,
        taxable_paise: l.amounts.taxable_paise,
        gst_rate_bp: l.gst_rate_bp,
        cgst_paise: l.amounts.cgst_paise,
        sgst_paise: l.amounts.sgst_paise,
        igst_paise: l.amounts.igst_paise,
        cess_rate_bp: l.cess_rate_bp,
        cess_paise: l.amounts.cess_paise,
        total_paise: l.amounts.total_paise,
        unit_cost_paise: l.unit_cost_paise,
        cost_paise: costs[i]!,
        restock: l.restock,
      })),
    )
    .execute()
  if (cost > 0) {
    await tx
      .updateTable('credit_notes')
      .set({ cost_paise: cost })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', id)
      .execute()
  }

  // ---- journal -----------------------------------------------------------------------------
  const party = customer ? { type: 'customer' as const, id: customer.id } : null
  await postJournal(tx, ctx, {
    entry_date: noteDate,
    store_id: store.id,
    source_type: 'credit_note',
    source_id: id,
    narration: `Return ${n.number}${invoice?.number ? ` of ${invoice.number}` : ''}`,
    lines: [
      { account: { subtype: 'sales_returns' }, debit_paise: taxable },
      { account: { subtype: 'output_cgst' }, debit_paise: cgst },
      { account: { subtype: 'output_sgst' }, debit_paise: sgst },
      { account: { subtype: 'output_igst' }, debit_paise: igst },
      { account: { subtype: 'output_cess' }, debit_paise: cess },
      roundOff >= 0
        ? { account: { subtype: 'round_off' }, debit_paise: roundOff }
        : { account: { subtype: 'round_off' }, credit_paise: -roundOff },
      { account: { subtype: 'receivable' }, credit_paise: total, party },
      { account: { subtype: 'inventory' }, debit_paise: cost },
      { account: { subtype: 'cogs' }, credit_paise: cost },
    ],
  })

  // ---- settlement --------------------------------------------------------------------------
  let adjusted = 0
  const clientRef = paymentClientRef.creditNoteSettlement(id)
  const paymentBase = {
    direction: 'out' as const,
    store_id: store.id,
    register_id: register?.id ?? null,
    shift_id: shift?.id ?? null,
    payment_date: noteDate,
    party,
    ...(sync ? { paid_at: sync.offline_created_at } : {}),
  }
  if (total > 0) {
    switch (input.settlement) {
      case 'cash':
      case 'upi':
      case 'bank_transfer': {
        let accountId: string | null = null
        if (input.provider_account_id) {
          const acct = await tx
            .selectFrom('payment_provider_accounts')
            .select(['store_id', 'is_active', 'settlement_account_id'])
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', input.provider_account_id)
            .executeTakeFirst()
          if (!acct || !acct.is_active || (acct.store_id !== null && acct.store_id !== store.id)) {
            throw invalidField('provider_account_id', 'Unknown UPI account for this store')
          }
          accountId = acct.settlement_account_id
        }
        await recordPayment(tx, ctx, {
          ...paymentBase,
          method: input.settlement,
          amount_paise: total,
          reference: input.refund_reference ?? null,
          account_id: accountId,
          allocations: [{ target_type: 'credit_note', target_id: id, amount_paise: total }],
          notes: `Refund for ${n.number}`,
          client_ref: clientRef,
        })
        break
      }
      case 'store_credit':
        await recordPayment(tx, ctx, {
          ...paymentBase,
          method: 'store_credit',
          amount_paise: total,
          allocations: [{ target_type: 'credit_note', target_id: id, amount_paise: total }],
          notes: `Store credit for ${n.number}`,
          client_ref: clientRef,
        })
        break
      case 'adjust_due': {
        const inv = invoice!
        adjusted = Math.min(total, inv.due_paise)
        const due = inv.due_paise - adjusted
        await tx
          .updateTable('sales_invoices')
          .set({ due_paise: due, payment_status: paymentStatusOf(inv.paid_paise, due) })
          .where('tenant_id', '=', ctx.tenantId)
          .where('id', '=', inv.id)
          .execute()
        await tx
          .updateTable('credit_notes')
          .set({ settled_paise: adjusted, meta: jsonb({ adjusted_paise: adjusted }) })
          .where('tenant_id', '=', ctx.tenantId)
          .where('id', '=', id)
          .execute()
        const excess = total - adjusted
        if (excess > 0) {
          await recordPayment(tx, ctx, {
            ...paymentBase,
            method: 'store_credit',
            amount_paise: excess,
            allocations: [{ target_type: 'credit_note', target_id: id, amount_paise: excess }],
            notes: `Store credit (excess over the due) for ${n.number}`,
            client_ref: clientRef,
          })
        }
        break
      }
    }
  }

  // ---- invoice & loyalty -------------------------------------------------------------------
  let reversed = 0
  let restored = 0
  if (invoice) {
    for (const l of lines) {
      await tx
        .updateTable('sales_invoice_lines')
        .set((eb) => ({ returned_qty_milli: eb('returned_qty_milli', '+', l.qty_milli) }))
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', l.invoice_line_id!)
        .execute()
    }
    const fresh = await tx
      .selectFrom('sales_invoices')
      .select(['paid_paise', 'due_paise', 'returned_paise', 'total_paise'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', invoice.id)
      .executeTakeFirstOrThrow()
    const returnedPaise = fresh.returned_paise + total
    await tx
      .updateTable('sales_invoices')
      .set({
        returned_paise: returnedPaise,
        ...(fullReturn || returnedPaise >= fresh.total_paise ? { payment_status: 'refunded' } : {}),
      })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', invoice.id)
      .execute()

    if (
      invoice.customer_id &&
      (invoice.loyalty_points_earned > 0 || invoice.loyalty_points_redeemed > 0)
    ) {
      const rev = await reversiblePoints(tx, ctx, {
        customer_id: invoice.customer_id,
        ref_type: 'sales_invoice',
        ref_id: invoice.id,
      })
      const share = (points: number): number =>
        invoice!.total_paise > 0 ? Math.floor((points * total) / invoice!.total_paise) : 0
      const earned = fullReturn
        ? rev.earned
        : Math.min(rev.earned, share(invoice.loyalty_points_earned))
      const redeemed = fullReturn
        ? rev.redeemed
        : Math.min(rev.redeemed, share(invoice.loyalty_points_redeemed))
      if (earned > 0 || redeemed > 0) {
        const r = await reversePoints(tx, ctx, {
          customer_id: invoice.customer_id,
          ref_type: 'sales_invoice',
          ref_id: invoice.id,
          earned_points: earned,
          redeemed_points: redeemed,
          notes: `Return ${n.number}`,
        })
        reversed = r.removed_points
        restored = r.restored_points
        await tx
          .updateTable('credit_notes')
          .set({ loyalty_points_reversed: reversed, loyalty_points_restored: restored })
          .where('tenant_id', '=', ctx.tenantId)
          .where('id', '=', id)
          .execute()
      }
    }
  }

  await audit(tx, ctx, {
    action: 'credit_note.create',
    entity_type: 'credit_note',
    entity_id: id,
    summary: `Return ${n.number}${invoice?.number ? ` of ${invoice.number}` : ' (without bill)'}: ${total} paise, ${input.settlement}`,
    changes: {
      invoice_id: invoice?.id ?? null,
      reason: input.reason,
      settlement: input.settlement,
      total_paise: total,
      restocked_lines: lines.filter((l) => l.restock).length,
      loyalty_points_reversed: reversed,
      loyalty_points_restored: restored,
      offline: sync !== null,
    },
  })
  if (invoice) {
    await audit(tx, ctx, {
      action: 'sales_invoice.return',
      entity_type: 'sales_invoice',
      entity_id: invoice.id,
      summary: `Return ${n.number}: ${total} paise (${input.settlement})`,
      changes: { credit_note_id: id },
    })
  }
  return { id, replayed: false }
}

// ---------------------------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------------------------

export async function cancelCreditNote(
  tx: Tx,
  ctx: SalesCtx,
  id: string,
  reason: string,
): Promise<void> {
  const note = await tx
    .selectFrom('credit_notes')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!note) throw notFound('credit_note', id)
  assertStoreAccess(ctx, note.store_id)
  if (note.status === 'cancelled') {
    throw conflict('The credit note is already cancelled', { reason: 'already_cancelled' })
  }
  const env = await salesEnv(tx, ctx)
  const invoice = note.invoice_id
    ? await loadInvoiceRow(tx, ctx, note.invoice_id, { forUpdate: true })
    : null

  // Settlement payments (refunds / store credit) are cancelled with the note.
  const payments = await tx
    .selectFrom('payment_allocations as a')
    .innerJoin('payments as p', (j) =>
      j.onRef('p.tenant_id', '=', 'a.tenant_id').onRef('p.id', '=', 'a.payment_id'),
    )
    .select(['p.id', 'p.method', 'p.amount_paise', 'p.party_id'])
    .where('a.tenant_id', '=', ctx.tenantId)
    .where('a.target_type', '=', 'credit_note')
    .where('a.target_id', '=', id)
    .where('p.status', '=', 'completed')
    .execute()
  for (const p of payments) {
    if (p.method === 'store_credit' && p.party_id) {
      const balance = await storeCreditBalance(tx, ctx, p.party_id)
      if (balance < p.amount_paise) {
        throw conflict('The store credit of this return was already used', {
          reason: 'store_credit_used',
          available_paise: balance,
          amount_paise: p.amount_paise,
        })
      }
    }
    await cancelPayment(tx, ctx, {
      payment_id: p.id,
      reason: `Credit note ${note.number} cancelled: ${reason}`.slice(0, 500),
      date: env.today,
    })
  }

  // Stock that was put back goes out again.
  const lines = await tx
    .selectFrom('credit_note_lines')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('credit_note_id', '=', id)
    .orderBy('line_no')
    .execute()
  const movements = lines.flatMap((l) =>
    l.restock && l.product_id
      ? [
          {
            store_id: note.store_id,
            product_id: l.product_id,
            batch_id: l.batch_id,
            qty_milli: -l.qty_milli,
            movement_type: 'sale' as const,
            ref_type: 'credit_note',
            ref_id: id,
            ref_line_id: l.id,
            reason: `credit note cancelled: ${reason}`.slice(0, 200),
          },
        ]
      : [],
  )
  if (movements.length) await postStock(tx, ctx, movements, { allowNegative: true })

  await reverseJournal(tx, ctx, {
    source_type: 'credit_note',
    source_id: id,
    entry_date: env.today,
    narration: `Cancelled ${note.number}: ${reason}`.slice(0, 500),
  })

  if (invoice) {
    for (const l of lines) {
      if (!l.invoice_line_id) continue
      await tx
        .updateTable('sales_invoice_lines')
        .set((eb) => ({ returned_qty_milli: eb('returned_qty_milli', '-', l.qty_milli) }))
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', l.invoice_line_id)
        .execute()
    }
    const adjusted = Number(recordOf(note.meta)['adjusted_paise'] ?? 0) || 0
    const due = invoice.due_paise + (note.settlement === 'adjust_due' ? adjusted : 0)
    const returnedPaise = Math.max(0, invoice.returned_paise - note.total_paise)
    await tx
      .updateTable('sales_invoices')
      .set({
        returned_paise: returnedPaise,
        due_paise: due,
        payment_status:
          returnedPaise >= invoice.total_paise && invoice.total_paise > 0
            ? 'refunded'
            : paymentStatusOf(invoice.paid_paise, due),
      })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', invoice.id)
      .execute()

    // Loyalty: points taken back are earned again, points given back are taken again.
    if (
      invoice.customer_id &&
      (note.loyalty_points_reversed > 0 || note.loyalty_points_restored > 0)
    ) {
      if (note.loyalty_points_reversed > 0) {
        await earnPoints(tx, ctx, {
          customer_id: invoice.customer_id,
          points: note.loyalty_points_reversed,
          ref_type: 'credit_note',
          ref_id: id,
          notes: `Return ${note.number} cancelled`,
        })
      }
      if (note.loyalty_points_restored > 0) {
        const c = await loadCustomer(tx, ctx, invoice.customer_id, { requireActive: false })
        const take = Math.min(note.loyalty_points_restored, c.loyalty_points)
        if (take > 0) {
          await adjustPoints(tx, ctx, {
            customer_id: invoice.customer_id,
            points: -take,
            notes: `Return ${note.number} cancelled: redeemed points taken again`,
          })
        }
      }
    }
  }

  await tx
    .updateTable('credit_notes')
    .set({
      status: 'cancelled',
      cancelled_at: new Date(),
      cancelled_by: ctx.userId,
      cancel_reason: reason,
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
  await audit(tx, ctx, {
    action: 'credit_note.cancel',
    entity_type: 'credit_note',
    entity_id: id,
    summary: `Credit note ${note.number} cancelled: ${reason}`,
    changes: { reason, total_paise: note.total_paise, settlement: note.settlement },
  })
}

// ---------------------------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------------------------

export async function loadCreditNoteDetail(
  tx: Tx,
  ctx: SalesCtx,
  id: string,
): Promise<CreditNoteDetail> {
  const t = ctx.tenantId
  const note = await tx
    .selectFrom('credit_notes as c')
    .leftJoin('sales_invoices as i', (j) =>
      j.onRef('i.tenant_id', '=', 'c.tenant_id').onRef('i.id', '=', 'c.invoice_id'),
    )
    .leftJoin('users as u', 'u.id', 'c.created_by')
    .leftJoin('users as x', 'x.id', 'c.cancelled_by')
    .selectAll('c')
    .select([
      'i.number as invoice_number',
      'i.invoice_date as invoice_date',
      'i.total_paise as invoice_total_paise',
      'u.full_name as created_by_name',
      'x.full_name as cancelled_by_name',
    ])
    .where('c.tenant_id', '=', t)
    .where('c.id', '=', id)
    .executeTakeFirst()
  if (!note) throw notFound('credit_note', id)
  assertStoreAccess(ctx, note.store_id)
  const lines = await tx
    .selectFrom('credit_note_lines as l')
    .leftJoin('batches as b', (j) =>
      j.onRef('b.tenant_id', '=', 'l.tenant_id').onRef('b.id', '=', 'l.batch_id'),
    )
    .leftJoin('sales_invoice_lines as il', (j) =>
      j.onRef('il.tenant_id', '=', 'l.tenant_id').onRef('il.id', '=', 'l.invoice_line_id'),
    )
    .selectAll('l')
    .select(['b.batch_no', 'b.expiry_date', 'il.name_ta as invoice_name_ta'])
    .where('l.tenant_id', '=', t)
    .where('l.credit_note_id', '=', id)
    .orderBy('l.line_no')
    .execute()
  const journal = await tx
    .selectFrom('journal_entries')
    .select('id')
    .where('tenant_id', '=', t)
    .where('source_type', '=', 'credit_note')
    .where('source_id', '=', id)
    .where('reverses_entry_id', 'is', null)
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst()
  const payments = await invoicePayments(tx, ctx, { type: 'credit_note', id })
  const showCost = can(ctx, 'reports.read')
  return {
    id: note.id,
    number: note.number,
    fy: note.fy,
    note_date: note.note_date,
    store_id: note.store_id,
    register_id: note.register_id,
    invoice_id: note.invoice_id,
    invoice_number: note.invoice_number ?? null,
    customer_id: note.customer_id,
    customer_name: note.customer_name,
    customer_phone: note.customer_phone,
    reason: CreditNoteReasonSchema.parse(note.reason),
    status: CreditNoteStatusSchema.parse(note.status),
    settlement: CreditNoteSettlementSchema.parse(note.settlement),
    total_paise: note.total_paise,
    settled_paise: note.settled_paise,
    item_count: lines.length,
    created_by_name: note.created_by_name ?? null,
    client_ref: note.client_ref,
    created_at: note.created_at.toISOString(),
    customer_gstin: note.customer_gstin,
    customer_state_code: note.customer_state_code,
    place_of_supply: note.place_of_supply,
    is_interstate: note.is_interstate,
    taxable_paise: note.taxable_paise,
    cgst_paise: note.cgst_paise,
    sgst_paise: note.sgst_paise,
    igst_paise: note.igst_paise,
    cess_paise: note.cess_paise,
    tax_paise: note.cgst_paise + note.sgst_paise + note.igst_paise + note.cess_paise,
    round_off_paise: note.round_off_paise,
    cost_paise: showCost ? note.cost_paise : 0,
    restock: note.restock,
    notes: note.notes,
    lines: lines.map((l) => ({
      id: l.id,
      line_no: l.line_no,
      invoice_line_id: l.invoice_line_id,
      product_id: l.product_id,
      batch_id: l.batch_id,
      batch_no: l.batch_no ?? null,
      expiry_date: l.expiry_date ?? null,
      name: l.name,
      name_ta: l.name_ta ?? l.invoice_name_ta ?? null,
      hsn_code: l.hsn_code,
      unit: l.unit,
      pack_size: l.pack_size,
      qty_milli: l.qty_milli,
      unit_price_paise: l.unit_price_paise,
      taxable_paise: l.taxable_paise,
      gst_rate_bp: l.gst_rate_bp,
      cgst_paise: l.cgst_paise,
      sgst_paise: l.sgst_paise,
      igst_paise: l.igst_paise,
      cess_rate_bp: l.cess_rate_bp,
      cess_paise: l.cess_paise,
      total_paise: l.total_paise,
      unit_cost_paise: showCost ? l.unit_cost_paise : 0,
      cost_paise: showCost ? l.cost_paise : 0,
      restock: l.restock,
    })),
    tax_breakup: taxBreakupOf(lines),
    invoice:
      note.invoice_id && note.invoice_date && note.invoice_total_paise !== null
        ? {
            id: note.invoice_id,
            number: note.invoice_number ?? null,
            invoice_date: note.invoice_date,
            total_paise: note.invoice_total_paise,
          }
        : null,
    payments,
    journal_entry_id: journal?.id ?? null,
    loyalty_points_reversed: note.loyalty_points_reversed,
    loyalty_points_restored: note.loyalty_points_restored,
    cancelled_at: note.cancelled_at ? note.cancelled_at.toISOString() : null,
    cancelled_by: note.cancelled_by,
    cancelled_by_name: note.cancelled_by_name ?? null,
    cancel_reason: note.cancel_reason,
    updated_at: note.updated_at.toISOString(),
  }
}
