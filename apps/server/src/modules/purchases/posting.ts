/**
 * Posting and cancelling purchase bills (ARCHITECTURE.md §10).
 *
 * POST /purchase-bills/:id/post (bill row locked):
 *  1. checks: draft, supplier invoice number, batch numbers + expiry of batch-tracked products
 *     (expired → 422 EXPIRED_BATCH unless allow_past_expiry), purchase order still receivable,
 *     duplicate supplier invoice (FY of the invoice date, and of the GRN);
 *  2. totals recomputed (purchaseBillTotals), GRN number ('purchase_bill' series of the store);
 *  3. batches resolved by (product, batch_no) or created; their landed cost is updated, and
 *     with update_prices their MRP / selling price;
 *  4. stock: 'purchase' +(qty + free) per line at the landed cost per pack (core postStock);
 *  5. products: purchase_price_paise = landed cost; MRP / selling price when given and
 *     update_prices — every change audited ('product.price_update');
 *  6. journal: Dr inventory (taxable + other charges + tax when not ITC-eligible), Dr input
 *     CGST / SGST / IGST / cess when ITC-eligible, Cr payable (supplier) — the total, or total −
 *     tax for reverse charge with the tax credited to the output tax accounts — and round-off;
 *  7. purchase order lines: received quantity += charged quantity, order status recomputed.
 *
 * POST /purchase-bills/:id/cancel: refused while live payments (409 bill_has_payments) or debit
 * notes (409 bill_has_debit_notes) refer to the bill; stock leaves with 'purchase_cancel'
 * (422 INSUFFICIENT_STOCK when it was consumed and negative stock is not allowed), the journal is
 * reversed, PO receipts are taken back, and the cancellation is audited.
 */
import { type SystemAccountSubtype, fyOf, newId } from '@kadai/shared'
import type {
  PriceUpdate,
  PurchaseBillPostResult,
  PurchaseBillPostSchema,
} from '@kadai/shared/api/purchases'
import type { z } from 'zod'
import { audit } from '../../core/audit'
import { AppError, assertNotStale } from '../../core/errors'
import { postStock } from '../../core/inventory'
import { type JournalLineInput, postJournal, reverseJournal } from '../../core/ledger'
import { nextNumber } from '../../core/numbering'
import type { Tx } from '../../db/tenant'
import {
  type BillLineRow,
  type BillRow,
  assertBatchFields,
  assertBillDraft,
  assertUniqueSupplierInvoice,
  billDetail,
  computeBill,
  loadBill,
  loadBillLines,
  loadOrderLink,
  sourceFromRow,
  storedRoundOffOverride,
  supplierPayable,
} from './bills'
import {
  type Ctx,
  type ProductInfo,
  assertPurchasable,
  businessToday,
  loadProducts,
  loadStore,
  loadSupplier,
  loadTenant,
  reasonError,
} from './common'
import { applyOrderReceipts } from './orders'

type BillPost = z.output<typeof PurchaseBillPostSchema>

interface ResolvedBatch {
  id: string
  created: boolean
}

/** Resolves (locking) or creates the batch of a line and applies its cost / price updates. */
async function resolveBatch(
  tx: Tx,
  ctx: Ctx,
  line: BillLineRow,
  product: ProductInfo,
  landedCost: number,
  bill: BillRow,
  updatePrices: boolean,
  priceUpdates: PriceUpdate[],
): Promise<ResolvedBatch> {
  const batchNo = line.batch_no!.trim()
  const existing = await tx
    .selectFrom('batches')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('product_id', '=', product.id)
    .where('batch_no', '=', batchNo)
    .forUpdate()
    .executeTakeFirst()
  if (!existing) {
    // The MRP printed on the new batch is a fact of the batch; its own selling price is a price
    // update and follows `update_prices` like the product's.
    const batchId = newId()
    await tx
      .insertInto('batches')
      .values({
        id: batchId,
        tenant_id: ctx.tenantId,
        product_id: product.id,
        batch_no: batchNo,
        mfg_date: line.mfg_date,
        expiry_date: line.expiry_date,
        mrp_paise: line.mrp_paise ?? product.mrp_paise,
        purchase_price_paise: landedCost,
        sale_price_paise: updatePrices ? line.sale_price_paise : null,
        supplier_id: bill.supplier_id,
      })
      .execute()
    return { id: batchId, created: true }
  }
  if (existing.expiry_date && line.expiry_date && existing.expiry_date !== line.expiry_date) {
    throw reasonError(
      'UNPROCESSABLE',
      'batch_expiry_mismatch',
      `Batch ${batchNo} of ${product.name} already exists with expiry ${existing.expiry_date}`,
      {
        line_no: line.line_no,
        product_id: product.id,
        batch_id: existing.id,
        batch_no: batchNo,
        existing_expiry_date: existing.expiry_date,
        expiry_date: line.expiry_date,
      },
    )
  }
  const set: {
    purchase_price_paise: number
    is_active: boolean
    updated_at: Date
    mrp_paise?: number
    sale_price_paise?: number
    expiry_date?: string
    mfg_date?: string
    supplier_id?: string
  } = { purchase_price_paise: landedCost, is_active: true, updated_at: new Date() }
  if (!existing.expiry_date && line.expiry_date) set.expiry_date = line.expiry_date
  if (!existing.mfg_date && line.mfg_date) set.mfg_date = line.mfg_date
  if (!existing.supplier_id) set.supplier_id = bill.supplier_id
  if (updatePrices && line.mrp_paise != null && line.mrp_paise !== existing.mrp_paise) {
    set.mrp_paise = line.mrp_paise
    priceUpdates.push({
      product_id: product.id,
      product_name: product.name,
      batch_id: existing.id,
      field: 'mrp_paise',
      old_paise: existing.mrp_paise,
      new_paise: line.mrp_paise,
    })
  }
  if (
    updatePrices &&
    line.sale_price_paise != null &&
    line.sale_price_paise !== existing.sale_price_paise
  ) {
    set.sale_price_paise = line.sale_price_paise
    priceUpdates.push({
      product_id: product.id,
      product_name: product.name,
      batch_id: existing.id,
      field: 'sale_price_paise',
      old_paise: existing.sale_price_paise,
      new_paise: line.sale_price_paise,
    })
  }
  await tx
    .updateTable('batches')
    .set(set)
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', existing.id)
    .execute()
  return { id: existing.id, created: false }
}

/** Journal lines of a posted bill (see the module comment). */
export function billJournalLines(
  bill: { supplier_id: string; reverse_charge: boolean; itc_eligible: boolean },
  totals: {
    taxable_paise: number
    other_charges_paise: number
    cgst_paise: number
    sgst_paise: number
    igst_paise: number
    cess_paise: number
    tax_paise: number
    round_off_paise: number
    total_paise: number
  },
): JournalLineInput[] {
  const taxHeads: Array<[number, SystemAccountSubtype, SystemAccountSubtype]> = [
    [totals.cgst_paise, 'input_cgst', 'output_cgst'],
    [totals.sgst_paise, 'input_sgst', 'output_sgst'],
    [totals.igst_paise, 'input_igst', 'output_igst'],
    [totals.cess_paise, 'input_cess', 'output_cess'],
  ]
  const lines: JournalLineInput[] = [
    {
      account: { subtype: 'inventory' },
      debit_paise:
        totals.taxable_paise +
        totals.other_charges_paise +
        (bill.itc_eligible ? 0 : totals.tax_paise),
    },
  ]
  if (bill.itc_eligible) {
    for (const [amount, input] of taxHeads)
      lines.push({ account: { subtype: input }, debit_paise: amount })
  }
  lines.push({
    account: { subtype: 'payable' },
    credit_paise: supplierPayable(totals, bill.reverse_charge),
    party: { type: 'supplier', id: bill.supplier_id },
  })
  if (bill.reverse_charge) {
    for (const [amount, , output] of taxHeads) {
      lines.push({ account: { subtype: output }, credit_paise: amount, memo: 'Reverse charge' })
    }
  }
  if (totals.round_off_paise > 0) {
    lines.push({ account: { subtype: 'round_off' }, debit_paise: totals.round_off_paise })
  } else if (totals.round_off_paise < 0) {
    lines.push({ account: { subtype: 'round_off' }, credit_paise: -totals.round_off_paise })
  }
  return lines
}

export async function postBill(
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: BillPost,
): Promise<PurchaseBillPostResult> {
  const bill = await loadBill(tx, ctx, id, { forUpdate: true })
  assertNotStale(bill.updated_at, body.if_updated_at, 'purchase_bill', bill.id)
  assertBillDraft(bill, 'posted')
  const invoiceNo = bill.supplier_invoice_no.trim()
  if (!invoiceNo) {
    throw reasonError(
      'UNPROCESSABLE',
      'supplier_invoice_no_required',
      "Enter the supplier's invoice number before posting",
      { bill_id: bill.id },
    )
  }
  const store = await loadStore(tx, ctx, bill.store_id, { requireActive: true })
  const supplier = await loadSupplier(tx, ctx, bill.supplier_id, { requireActive: true })
  const cal = await businessToday(tx, ctx)
  const rows = await loadBillLines(tx, ctx, bill.id)
  const products = await loadProducts(
    tx,
    ctx,
    rows.map((r) => r.product_id),
    { lock: true },
  )
  for (const r of rows) assertPurchasable(products.get(r.product_id)!, r.line_no)
  const sources = rows.map(sourceFromRow)
  assertBatchFields(sources, products)
  if (!body.allow_past_expiry) {
    for (const r of rows) {
      if (products.get(r.product_id)!.track_batches && r.expiry_date && r.expiry_date < cal.today) {
        throw new AppError(
          'EXPIRED_BATCH',
          `Batch ${r.batch_no ?? ''} of ${products.get(r.product_id)!.name} expired on ${r.expiry_date}`,
          {
            reason: 'expired_batch',
            line_no: r.line_no,
            product_id: r.product_id,
            batch_no: r.batch_no,
            expiry_date: r.expiry_date,
          },
        )
      }
    }
  }
  if (bill.purchase_order_id) {
    await loadOrderLink(tx, ctx, bill.purchase_order_id, {
      supplier_id: bill.supplier_id,
      store_id: bill.store_id,
    })
  }
  const grnFy = fyOf(bill.received_date, cal.fyStartMonth)
  await assertUniqueSupplierInvoice(tx, ctx, {
    supplier_id: bill.supplier_id,
    supplier_invoice_no: invoiceNo,
    supplier_invoice_date: bill.supplier_invoice_date,
    exclude_bill_id: bill.id,
    grn_fy: grnFy,
  })

  const itc = bill.itc_eligible && (await loadTenant(tx, ctx)).gst_scheme === 'regular'
  const totals = computeBill(
    {
      is_interstate: bill.is_interstate,
      itc_eligible: itc,
      other_charges_paise: bill.other_charges_paise,
      round_off_override: storedRoundOffOverride(bill, sources),
    },
    sources,
  )
  const numbered = await nextNumber(tx, ctx, {
    docType: 'purchase_bill',
    storeId: store.id,
    date: bill.received_date,
  })

  // ---- batches ----------------------------------------------------------------------------
  const priceUpdates: PriceUpdate[] = []
  const batchIds = new Map<string, string>()
  let batchesCreated = 0
  const lineBatch: Array<string | null> = []
  for (const [i, r] of rows.entries()) {
    const p = products.get(r.product_id)!
    if (!p.track_batches) {
      lineBatch.push(null)
      continue
    }
    const key = `${p.id}|${r.batch_no!.trim()}`
    let batchId = batchIds.get(key)
    if (!batchId) {
      const resolved = await resolveBatch(
        tx,
        ctx,
        r,
        p,
        totals.lines[i]!.landed_unit_cost_paise,
        bill,
        body.update_prices,
        priceUpdates,
      )
      batchId = resolved.id
      if (resolved.created) batchesCreated += 1
      batchIds.set(key, batchId)
    } else {
      await tx
        .updateTable('batches')
        .set({
          purchase_price_paise: totals.lines[i]!.landed_unit_cost_paise,
          updated_at: new Date(),
        })
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', batchId)
        .execute()
    }
    lineBatch.push(batchId)
  }

  // ---- stock ------------------------------------------------------------------------------
  const posted = await postStock(
    tx,
    ctx,
    rows.map((r, i) => ({
      store_id: store.id,
      product_id: r.product_id,
      batch_id: lineBatch[i] ?? null,
      qty_milli: r.qty_milli + r.free_qty_milli,
      movement_type: 'purchase' as const,
      unit_cost_paise: totals.lines[i]!.landed_unit_cost_paise,
      ref_type: 'purchase_bill',
      ref_id: bill.id,
      ref_line_id: r.id,
      reason: `GRN ${numbered.number}`,
    })),
  )

  // ---- product prices ---------------------------------------------------------------------
  const latest = new Map<string, { landed: number; mrp: number | null; sale: number | null }>()
  rows.forEach((r, i) => {
    const prev = latest.get(r.product_id)
    latest.set(r.product_id, {
      landed: totals.lines[i]!.landed_unit_cost_paise,
      mrp: r.mrp_paise ?? prev?.mrp ?? null,
      sale: r.sale_price_paise ?? prev?.sale ?? null,
    })
  })
  for (const [productId, next] of [...latest.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const p = products.get(productId)!
    const before: Record<string, number | null> = {}
    const after: Record<string, number | null> = {}
    const set: { purchase_price_paise?: number; mrp_paise?: number; sale_price_paise?: number } = {}
    const change = (
      field: 'purchase_price_paise' | 'mrp_paise' | 'sale_price_paise',
      oldValue: number | null,
      newValue: number,
    ): void => {
      if (oldValue === newValue) return
      set[field] = newValue
      before[field] = oldValue
      after[field] = newValue
      priceUpdates.push({
        product_id: p.id,
        product_name: p.name,
        batch_id: null,
        field,
        old_paise: oldValue,
        new_paise: newValue,
      })
    }
    change('purchase_price_paise', p.purchase_price_paise, next.landed)
    if (body.update_prices && next.mrp !== null) change('mrp_paise', p.mrp_paise, next.mrp)
    if (body.update_prices && next.sale !== null)
      change('sale_price_paise', p.sale_price_paise, next.sale)
    if (Object.keys(set).length === 0) continue
    await tx
      .updateTable('products')
      .set({ ...set, updated_at: new Date() })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', p.id)
      .execute()
    await audit(tx, ctx, {
      action: 'product.price_update',
      entity_type: 'product',
      entity_id: p.id,
      summary: `${p.name}: prices updated from purchase ${numbered.number}`,
      changes: {
        before,
        after,
        source: { type: 'purchase_bill', id: bill.id, number: numbered.number },
      },
    })
  }

  // ---- journal ----------------------------------------------------------------------------
  await postJournal(tx, ctx, {
    entry_date: bill.received_date,
    store_id: store.id,
    source_type: 'purchase_bill',
    source_id: bill.id,
    narration: `Purchase ${numbered.number} — ${supplier.name}, invoice ${invoiceNo}`,
    lines: billJournalLines(
      { supplier_id: bill.supplier_id, reverse_charge: bill.reverse_charge, itc_eligible: itc },
      totals,
    ),
  })

  // ---- purchase order receipts ------------------------------------------------------------
  if (bill.purchase_order_id) {
    const deltas = new Map<string, number>()
    for (const r of rows) {
      if (r.purchase_order_line_id) {
        deltas.set(
          r.purchase_order_line_id,
          (deltas.get(r.purchase_order_line_id) ?? 0) + r.qty_milli,
        )
      }
    }
    await applyOrderReceipts(tx, ctx, bill.purchase_order_id, deltas)
  }

  // ---- bill -------------------------------------------------------------------------------
  for (const [i, r] of rows.entries()) {
    const t = totals.lines[i]!
    await tx
      .updateTable('purchase_bill_lines')
      .set({
        batch_id: lineBatch[i] ?? null,
        batch_no: r.batch_no?.trim() ?? null,
        gross_paise: t.gross_paise,
        taxable_paise: t.taxable_paise,
        cgst_paise: t.cgst_paise,
        sgst_paise: t.sgst_paise,
        igst_paise: t.igst_paise,
        cess_paise: t.cess_paise,
        total_paise: t.total_paise,
        landed_unit_cost_paise: t.landed_unit_cost_paise,
      })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', r.id)
      .execute()
  }
  const payable = supplierPayable(totals, bill.reverse_charge)
  const now = new Date()
  await tx
    .updateTable('purchase_bills')
    .set({
      status: 'posted',
      number: numbered.number,
      fy: numbered.fy,
      supplier_invoice_no: invoiceNo,
      supplier_gstin: supplier.gstin,
      supplier_state_code: supplier.state_code,
      itc_eligible: itc,
      gross_paise: totals.gross_paise,
      discount_paise: totals.discount_paise,
      taxable_paise: totals.taxable_paise,
      cgst_paise: totals.cgst_paise,
      sgst_paise: totals.sgst_paise,
      igst_paise: totals.igst_paise,
      cess_paise: totals.cess_paise,
      other_charges_paise: totals.other_charges_paise,
      round_off_paise: totals.round_off_paise,
      total_paise: totals.total_paise,
      paid_paise: 0,
      returned_paise: 0,
      due_paise: payable,
      payment_status: payable > 0 ? 'unpaid' : 'paid',
      posted_at: now,
      posted_by: ctx.userId,
      updated_at: now,
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', bill.id)
    .execute()
  await audit(tx, ctx, {
    action: 'purchase_bill.post',
    entity_type: 'purchase_bill',
    entity_id: bill.id,
    summary: `Purchase ${numbered.number} posted: ${supplier.name}, invoice ${invoiceNo}, ${totals.total_paise} paise`,
    changes: {
      number: numbered.number,
      total_paise: totals.total_paise,
      payable_paise: payable,
      lines: rows.length,
      batches_created: batchesCreated,
      price_updates: priceUpdates.length,
    },
  })
  return {
    bill: await billDetail(tx, ctx, bill.id),
    price_updates: priceUpdates,
    batches_created: batchesCreated,
    stock_lines: posted.filter((m) => !m.skipped).length,
  }
}

export async function cancelBill(
  tx: Tx,
  ctx: Ctx,
  id: string,
  reason: string,
): Promise<Awaited<ReturnType<typeof billDetail>>> {
  const bill = await loadBill(tx, ctx, id, { forUpdate: true })
  if (bill.status !== 'posted') {
    throw reasonError(
      'CONFLICT',
      'bill_not_posted',
      bill.status === 'draft'
        ? 'A draft bill is deleted, not cancelled'
        : `Purchase bill ${bill.number ?? ''} is already cancelled`,
      { bill_id: bill.id, status: bill.status },
    )
  }
  const payments = await tx
    .selectFrom('payment_allocations as a')
    .innerJoin('payments as p', (j) =>
      j.onRef('p.tenant_id', '=', 'a.tenant_id').onRef('p.id', '=', 'a.payment_id'),
    )
    .select(['p.id', 'p.number'])
    .where('a.tenant_id', '=', ctx.tenantId)
    .where('a.target_type', '=', 'purchase_bill')
    .where('a.target_id', '=', bill.id)
    .where('p.status', '=', 'completed')
    .execute()
  if (payments.length) {
    throw reasonError(
      'CONFLICT',
      'bill_has_payments',
      `Payments are recorded against purchase ${bill.number ?? ''}; cancel them first`,
      {
        bill_id: bill.id,
        payment_ids: payments.map((p) => p.id),
        payment_numbers: payments.map((p) => p.number),
      },
    )
  }
  const notes = await tx
    .selectFrom('debit_notes')
    .select(['id', 'number'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('bill_id', '=', bill.id)
    .where('status', '=', 'completed')
    .execute()
  if (notes.length) {
    throw reasonError(
      'CONFLICT',
      'bill_has_debit_notes',
      `Debit notes are recorded against purchase ${bill.number ?? ''}; cancel them first`,
      {
        bill_id: bill.id,
        debit_note_ids: notes.map((n) => n.id),
        debit_note_numbers: notes.map((n) => n.number),
      },
    )
  }
  const rows = await loadBillLines(tx, ctx, bill.id)
  const cal = await businessToday(tx, ctx)
  await postStock(
    tx,
    ctx,
    rows.map((r) => ({
      store_id: bill.store_id,
      product_id: r.product_id,
      batch_id: r.batch_id,
      qty_milli: -(r.qty_milli + r.free_qty_milli),
      movement_type: 'purchase_cancel' as const,
      ref_type: 'purchase_bill',
      ref_id: bill.id,
      ref_line_id: r.id,
      reason: `GRN ${bill.number ?? ''} cancelled: ${reason}`.slice(0, 500),
    })),
  )
  await reverseJournal(tx, ctx, {
    source_type: 'purchase_bill',
    source_id: bill.id,
    entry_date: cal.today,
    narration: `Purchase ${bill.number ?? ''} cancelled: ${reason}`.slice(0, 500),
  })
  if (bill.purchase_order_id) {
    const deltas = new Map<string, number>()
    for (const r of rows) {
      if (r.purchase_order_line_id) {
        deltas.set(
          r.purchase_order_line_id,
          (deltas.get(r.purchase_order_line_id) ?? 0) - r.qty_milli,
        )
      }
    }
    await applyOrderReceipts(tx, ctx, bill.purchase_order_id, deltas)
  }
  const now = new Date()
  await tx
    .updateTable('purchase_bills')
    .set({
      status: 'cancelled',
      due_paise: 0,
      cancelled_at: now,
      cancelled_by: ctx.userId,
      cancel_reason: reason,
      updated_at: now,
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', bill.id)
    .execute()
  await audit(tx, ctx, {
    action: 'purchase_bill.cancel',
    entity_type: 'purchase_bill',
    entity_id: bill.id,
    summary: `Purchase ${bill.number ?? ''} cancelled: ${reason}`,
    changes: {
      reason,
      number: bill.number,
      total_paise: bill.total_paise,
      supplier_id: bill.supplier_id,
    },
  })
  return billDetail(tx, ctx, bill.id)
}
