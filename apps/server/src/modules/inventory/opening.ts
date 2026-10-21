/**
 * POST /stock/opening — opening stock of a store as a posted adjustment of kind 'opening':
 * 'opening' movements at the given cost per pack (batches created / reused by batch_no for
 * batch-tracked products) and the journal Dr inventory / Cr opening_balance. Products that
 * already have movements in the store are refused (409 has_movements {product_ids}) unless
 * `force`; every opening is audited (with the forced products). Idempotent via Idempotency-Key.
 */
import { sql } from 'kysely'
import { newId } from '@kadai/shared'
import type { OpeningStockResult, OpeningStockSchema } from '@kadai/shared/api/inventory'
import type { z } from 'zod'
import { audit } from '../../core/audit'
import { notFound } from '../../core/errors'
import { assertStoreAccess } from '../../core/http'
import { postStock } from '../../core/inventory'
import { postJournal } from '../../core/ledger'
import { nextNumber } from '../../core/numbering'
import type { Tx } from '../../db/tenant'
import { ADJUSTMENT_REF, adjustmentDetail, adjustmentJournalLines } from './adjustments'
import {
  type BatchInfo,
  type Ctx,
  assertNotFuture,
  businessToday,
  loadBatches,
  loadProducts,
  loadStore,
  reasonError,
} from './common'

type OpeningStock = z.output<typeof OpeningStockSchema>
type OpeningBatch = NonNullable<OpeningStock['lines'][number]['batch']>

/** Finds a product's batch by number (case-insensitive) or creates it; fills missing details. */
async function resolveBatch(
  tx: Tx,
  ctx: Ctx,
  productId: string,
  input: OpeningBatch,
  unitCost: number,
): Promise<{ id: string; batch_no: string; created: boolean }> {
  const find = () =>
    tx
      .selectFrom('batches')
      .select([
        'id',
        'batch_no',
        'expiry_date',
        'mfg_date',
        'mrp_paise',
        'sale_price_paise',
        'purchase_price_paise',
      ])
      .where('tenant_id', '=', ctx.tenantId)
      .where('product_id', '=', productId)
      .where(sql<boolean>`lower(batch_no) = ${input.batch_no.toLowerCase()}`)
      .orderBy('created_at')
      .forUpdate()
      .executeTakeFirst()
  const existing = await find()
  if (existing) {
    const fill = {
      ...(existing.expiry_date === null && input.expiry_date
        ? { expiry_date: input.expiry_date }
        : {}),
      ...(existing.mfg_date === null && input.mfg_date ? { mfg_date: input.mfg_date } : {}),
      ...(existing.mrp_paise === null && input.mrp_paise !== null
        ? { mrp_paise: input.mrp_paise }
        : {}),
      ...(existing.sale_price_paise === null && input.sale_price_paise !== null
        ? { sale_price_paise: input.sale_price_paise }
        : {}),
      ...(existing.purchase_price_paise === null ? { purchase_price_paise: unitCost } : {}),
    }
    if (Object.keys(fill).length) {
      await tx
        .updateTable('batches')
        .set({ ...fill, updated_at: sql<Date>`now()` })
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', existing.id)
        .execute()
    }
    return { id: existing.id, batch_no: existing.batch_no, created: false }
  }
  const id = newId()
  const inserted = await tx
    .insertInto('batches')
    .values({
      id,
      tenant_id: ctx.tenantId,
      product_id: productId,
      batch_no: input.batch_no,
      expiry_date: input.expiry_date,
      mfg_date: input.mfg_date,
      mrp_paise: input.mrp_paise,
      sale_price_paise: input.sale_price_paise,
      purchase_price_paise: unitCost,
    })
    .onConflict((oc) => oc.doNothing())
    .returning('id')
    .executeTakeFirst()
  if (inserted) return { id, batch_no: input.batch_no, created: true }
  // Created concurrently with the same number: reuse it.
  const again = await find()
  if (!again) throw notFound('batch')
  return { id: again.id, batch_no: again.batch_no, created: false }
}

export async function postOpeningStock(
  tx: Tx,
  ctx: Ctx,
  body: OpeningStock,
): Promise<OpeningStockResult> {
  assertStoreAccess(ctx, body.store_id)
  await loadStore(tx, ctx, body.store_id, { requireActive: true, path: 'store_id' })
  const { today } = await businessToday(tx, ctx)
  const date = body.date ?? today
  assertNotFuture(date, today, ['date'])

  const products = await loadProducts(
    tx,
    ctx,
    body.lines.map((l) => l.product_id),
  )
  const given = await loadBatches(
    tx,
    ctx,
    body.lines.flatMap((l) => (l.batch_id ? [l.batch_id] : [])),
  )
  body.lines.forEach((l, i) => {
    const path = `lines.${String(i)}`
    const p = products.get(l.product_id)
    if (!p) throw notFound('product', l.product_id)
    if (!p.track_inventory || p.kind === 'variant_parent' || p.kind === 'service') {
      throw reasonError('UNPROCESSABLE', 'not_stock_item', `${p.name} does not hold stock`, {
        product_id: p.id,
        path: `${path}.product_id`,
      })
    }
    const hasBatch = Boolean(l.batch_id ?? l.batch)
    if (p.track_batches && !hasBatch) {
      throw reasonError(
        'UNPROCESSABLE',
        'batch_required',
        `${p.name} is batch-tracked: give a batch`,
        {
          product_id: p.id,
          path: `${path}.batch`,
        },
      )
    }
    if (!p.track_batches && hasBatch) {
      throw reasonError('UNPROCESSABLE', 'batch_not_allowed', `${p.name} does not track batches`, {
        product_id: p.id,
        path: `${path}.batch`,
      })
    }
    if (l.batch_id) {
      const b: BatchInfo | undefined = given.get(l.batch_id)
      if (!b) throw notFound('batch', l.batch_id)
      if (b.product_id !== p.id) {
        throw reasonError(
          'UNPROCESSABLE',
          'batch_product_mismatch',
          `Batch ${b.batch_no} belongs to another product`,
          {
            batch_id: b.id,
            product_id: p.id,
            path: `${path}.batch_id`,
          },
        )
      }
    }
  })

  const productIds = [...products.keys()].sort()
  // Two openings of the same product in the same store must not both pass the "no movements
  // yet" check: serialise them per (store, product) for the rest of the transaction (sorted, so
  // concurrent openings never deadlock).
  for (const productId of productIds) {
    const lockKey = `inventory.opening:${ctx.tenantId}:${body.store_id}:${productId}`
    await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(tx)
  }
  const moved = await tx
    .selectFrom('stock_movements')
    .select('product_id')
    .distinct()
    .where('tenant_id', '=', ctx.tenantId)
    .where('store_id', '=', body.store_id)
    .where('product_id', 'in', productIds)
    .execute()
  const movedIds = moved.map((m) => m.product_id).sort()
  if (movedIds.length && !body.force) {
    throw reasonError(
      'CONFLICT',
      'has_movements',
      'Some products already have stock movements in this store; use force to add opening stock anyway',
      { product_ids: movedIds },
    )
  }

  // Batches named by number are created (or reused) first, in line order.
  const batchesCreated: OpeningStockResult['batches_created'] = []
  const batchIds: (string | null)[] = []
  for (const l of body.lines) {
    if (l.batch_id) batchIds.push(l.batch_id)
    else if (l.batch) {
      const b = await resolveBatch(tx, ctx, l.product_id, l.batch, l.unit_cost_paise)
      if (b.created)
        batchesCreated.push({ product_id: l.product_id, batch_id: b.id, batch_no: b.batch_no })
      batchIds.push(b.id)
    } else batchIds.push(null)
  }
  const seen = new Set<string>()
  body.lines.forEach((l, i) => {
    // Two lines naming the same batch differently (id + number) are one stock row.
    const key = `${l.product_id}:${batchIds[i] ?? '-'}`
    if (seen.has(key)) {
      throw reasonError(
        'UNPROCESSABLE',
        'batch_product_mismatch',
        'Two lines refer to the same batch',
        {
          path: `lines.${String(i)}`,
        },
      )
    }
    seen.add(key)
  })

  const num = await nextNumber(tx, ctx, {
    docType: 'stock_adjustment',
    storeId: body.store_id,
    date,
  })
  const id = newId()
  await tx
    .insertInto('stock_adjustments')
    .values({
      id,
      tenant_id: ctx.tenantId,
      store_id: body.store_id,
      number: num.number,
      fy: num.fy,
      adjustment_date: date,
      kind: 'opening',
      status: 'posted',
      notes: body.notes ?? null,
      posted_at: sql<Date>`now()`,
      posted_by: ctx.userId,
      created_by: ctx.userId,
    })
    .execute()
  const lineRows = body.lines.map((l, i) => ({
    id: newId(),
    tenant_id: ctx.tenantId,
    adjustment_id: id,
    line_no: i + 1,
    product_id: l.product_id,
    batch_id: batchIds[i] ?? null,
    qty_delta_milli: l.qty_milli,
    unit_cost_paise: l.unit_cost_paise,
    unit_cost_given: true,
  }))
  await tx.insertInto('stock_adjustment_lines').values(lineRows).execute()

  const posted = await postStock(
    tx,
    ctx,
    lineRows.map((l) => ({
      store_id: body.store_id,
      product_id: l.product_id,
      batch_id: l.batch_id,
      qty_milli: l.qty_delta_milli,
      movement_type: 'opening' as const,
      unit_cost_paise: l.unit_cost_paise,
      ref_type: ADJUSTMENT_REF,
      ref_id: id,
      ref_line_id: l.id,
      reason: body.notes ?? null,
    })),
  )
  const value = posted.reduce((acc, r) => acc + r.value_paise, 0)
  const journal = await postJournal(tx, ctx, {
    entry_date: date,
    store_id: body.store_id,
    source_type: 'stock_adjustment',
    source_id: id,
    narration: `Opening stock ${num.number}`,
    lines: adjustmentJournalLines('opening', value, 0),
  })
  await tx
    .updateTable('stock_adjustments')
    .set({ total_value_paise: value })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
  await audit(tx, ctx, {
    action: body.force && movedIds.length ? 'stock.opening_forced' : 'stock.opening',
    entity_type: ADJUSTMENT_REF,
    entity_id: id,
    summary: `Opening stock ${num.number}: ${String(body.lines.length)} lines, value ${String(value)} paise${
      movedIds.length ? `, forced for ${String(movedIds.length)} products with movements` : ''
    }`,
    changes: {
      force: body.force,
      lines: body.lines.length,
      value_paise: value,
      ...(movedIds.length ? { forced_product_ids: movedIds } : {}),
    },
  })
  return {
    adjustment: await adjustmentDetail(tx, ctx, id),
    total_value_paise: value,
    journal_entry_id: journal.entry_id,
    batches_created: batchesCreated,
  }
}
