/**
 * Shop-generated identifiers from per-tenant counters (catalog_sequences, migration 0100):
 * internal EAN-13 barcodes ('20' + 10-digit sequence + check digit, GS1 restricted circulation)
 * and automatic SKUs (settings.catalog.sku_prefix + 5+ digits). The counter row is locked by the
 * upsert until the transaction ends, so concurrent generators never hand out the same value;
 * values already used by hand-entered codes are skipped.
 */
import { sql } from 'kysely'
import { generateInternalBarcode } from '@kadai/shared'
import { formatAutoSku } from '@kadai/shared/api/catalog'
import type { Tx } from '../../db/tenant'
import type { Ctx } from './shared'

type SequenceName = 'internal_barcode' | 'auto_sku'

const MAX_ROUNDS = 50

/** Reserves `count` consecutive values of a counter; returns them in order. */
export async function nextSequenceValues(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  name: SequenceName,
  count: number,
): Promise<number[]> {
  if (!Number.isSafeInteger(count) || count < 1) throw new RangeError('count must be positive')
  const row = await tx
    .insertInto('catalog_sequences')
    .values({ tenant_id: ctx.tenantId, name, last_value: count })
    .onConflict((oc) =>
      oc.columns(['tenant_id', 'name']).doUpdateSet((eb) => ({
        last_value: eb('catalog_sequences.last_value', '+', count),
        updated_at: sql<Date>`now()`,
      })),
    )
    .returning('last_value')
    .executeTakeFirstOrThrow()
  const end = Number(row.last_value)
  return Array.from({ length: count }, (_, i) => end - count + 1 + i)
}

/** `count` new internal barcodes not used by any product of the tenant. */
export async function generateInternalBarcodes(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  count: number,
): Promise<string[]> {
  const out: string[] = []
  for (let round = 0; out.length < count; round += 1) {
    if (round >= MAX_ROUNDS) throw new Error('could not allocate free internal barcodes')
    const codes = (await nextSequenceValues(tx, ctx, 'internal_barcode', count - out.length)).map(
      generateInternalBarcode,
    )
    const taken = await tx
      .selectFrom('product_barcodes')
      .select('barcode')
      .where('tenant_id', '=', ctx.tenantId)
      .where('barcode', 'in', codes)
      .execute()
    const used = new Set(taken.map((t) => t.barcode))
    out.push(...codes.filter((c) => !used.has(c)))
  }
  return out
}

/** `count` new automatic SKUs (prefix + sequence) not used by any product (case-insensitive). */
export async function generateAutoSkus(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  prefix: string,
  count: number,
): Promise<string[]> {
  const out: string[] = []
  for (let round = 0; out.length < count; round += 1) {
    if (round >= MAX_ROUNDS) throw new Error('could not allocate free automatic SKUs')
    const skus = (await nextSequenceValues(tx, ctx, 'auto_sku', count - out.length)).map((n) =>
      formatAutoSku(prefix, n),
    )
    const taken = await tx
      .selectFrom('products')
      .select(sql<string>`lower(sku)`.as('k'))
      .where('tenant_id', '=', ctx.tenantId)
      .where(sql<boolean>`lower(sku) = any(${skus.map((s) => s.toLowerCase())}::text[])`)
      .execute()
    const used = new Set(taken.map((t) => t.k))
    out.push(...skus.filter((s) => !used.has(s.toLowerCase())))
  }
  return out
}
