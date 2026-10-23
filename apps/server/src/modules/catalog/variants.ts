/**
 * POST /products/:id/variants — the cartesian product of the axes values becomes child products
 * (kind 'variant', parent_id), the product becomes 'variant_parent' with variant_axes. Names are
 * "<parent> - M / Red" (Tamil name with the Tamil value labels), SKUs "<PARENTSKU>-M-RED";
 * category, brand, tax, prices (with per-combination overrides) and attributes are inherited.
 * Idempotent: combinations that already exist (case-insensitive) are skipped.
 */
import { sql } from 'kysely'
import { newId } from '@kadai/shared'
import {
  type VariantGenerateResult,
  type VariantGenerateSchema,
  variantCombinations,
  variantKey,
  variantName,
  variantPrices,
  variantSku,
} from '@kadai/shared/api/catalog'
import type { z } from 'zod'
import { audit } from '../../core/audit'
import { assertWithinLimit } from '../../core/entitlements'
import { AppError } from '../../core/errors'
import { jsonb } from '../../db/json'
import type { Tx } from '../../db/tenant'
import { getProductDetail, loadProductRow, toVariantRows } from './product-read'
import { catalogEnv, productsHaveMovements } from './product-write'
import { generateAutoSkus, generateInternalBarcodes } from './sequences'
import { type Ctx, conflictReason, issue, resolveStoreId, stringRecord } from './shared'

type Body = z.output<typeof VariantGenerateSchema>

/** SKUs not used by other products: '<sku>', else '<sku>-2' … '<sku>-9', else null. */
async function freeSkus(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  wanted: readonly string[],
): Promise<Array<string | null>> {
  const candidates = wanted.flatMap((s) => [
    s,
    ...Array.from({ length: 8 }, (_, i) => `${s.slice(0, 37)}-${String(i + 2)}`),
  ])
  if (candidates.length === 0) return []
  const rows = await tx
    .selectFrom('products')
    .select(sql<string>`lower(sku)`.as('k'))
    .where('tenant_id', '=', ctx.tenantId)
    .where(sql<boolean>`lower(sku) = any(${candidates.map((c) => c.toLowerCase())}::text[])`)
    .execute()
  const used = new Set(rows.map((r) => r.k))
  return wanted.map((s) => {
    for (const c of [
      s,
      ...Array.from({ length: 8 }, (_, i) => `${s.slice(0, 37)}-${String(i + 2)}`),
    ]) {
      if (!used.has(c.toLowerCase())) {
        used.add(c.toLowerCase())
        return c
      }
    }
    return null
  })
}

export async function generateVariants(
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: Body,
): Promise<VariantGenerateResult> {
  const env = await catalogEnv(tx, ctx)
  const parent = await loadProductRow(tx, ctx, id, { forUpdate: true })
  if (parent.kind !== 'standard' && parent.kind !== 'variant_parent') {
    throw new AppError(
      'UNPROCESSABLE',
      'Only a standard product or a variant parent has variants',
      {
        reason: 'product_kind',
        kind: parent.kind,
      },
    )
  }
  if (parent.kind === 'standard' && (await productsHaveMovements(tx, ctx, [id]))) {
    throw conflictReason(
      'This product already has stock movements; create a new product for the variants',
      'product_in_use',
    )
  }
  const existing = await tx
    .selectFrom('products')
    .select(['id', 'variant_attributes'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('parent_id', '=', id)
    .execute()
  const requested = Object.keys(body.axes)
  let order: string[]
  if (existing.length > 0) {
    const stored = parent.variant_axes
    const same = stored.length === requested.length && requested.every((a) => stored.includes(a))
    if (!same) throw issue('axes', 'variant_axes_mismatch')
    order = [...stored]
  } else {
    order = requested
  }
  body.price_overrides.forEach((o, i) => {
    const ok = Object.entries(o.match).every(
      ([axis, value]) =>
        order.includes(axis) &&
        (body.axes[axis] ?? []).some((v) => v.toLowerCase() === value.toLowerCase()),
    )
    if (!ok) throw issue(`price_overrides.${String(i)}.match`, 'variant_override_match')
  })

  const existingKeys = new Map(
    existing.map((e) => [variantKey(stringRecord(e.variant_attributes), order), e.id]),
  )
  const combos = variantCombinations(body.axes, order)
  const skipped: VariantGenerateResult['skipped'] = []
  const fresh: Array<Record<string, string>> = []
  for (const attrs of combos) {
    const hit = existingKeys.get(variantKey(attrs, order))
    if (hit) skipped.push({ variant_attributes: attrs, product_id: hit })
    else fresh.push(attrs)
  }

  const base = {
    sale_price_paise: parent.sale_price_paise,
    mrp_paise: parent.mrp_paise,
    purchase_price_paise: parent.purchase_price_paise,
    wholesale_price_paise: parent.wholesale_price_paise,
  }
  const prices = fresh.map((attrs) => variantPrices(base, attrs, body.price_overrides))
  prices.forEach((p) => {
    if (p.mrp_paise !== null && p.mrp_paise < p.sale_price_paise)
      throw issue('price_overrides', 'mrp_below_sale_price')
  })

  const createdIds: string[] = []
  if (fresh.length > 0) {
    if (parent.is_active) await assertWithinLimit(tx, ctx, 'products', { adding: fresh.length })
    let skus: Array<string | null>
    if (parent.sku)
      skus = await freeSkus(
        tx,
        ctx,
        fresh.map((a) => variantSku(parent.sku!, a, order)),
      )
    else if (env.settings.catalog.auto_sku)
      skus = await generateAutoSkus(tx, ctx, env.settings.catalog.sku_prefix, fresh.length)
    else skus = fresh.map(() => null)
    const rows = await tx
      .insertInto('products')
      .values(
        fresh.map((attrs, i) => ({
          id: newId(),
          tenant_id: ctx.tenantId,
          parent_id: id,
          kind: 'variant',
          sku: skus[i] ?? null,
          name: variantName(parent.name, attrs, order),
          name_ta: parent.name_ta
            ? variantName(parent.name_ta, attrs, order, body.value_labels_ta)
            : null,
          aliases: parent.aliases,
          description: parent.description,
          category_id: parent.category_id,
          brand_id: parent.brand_id,
          unit: parent.unit,
          pack_size: parent.pack_size,
          allow_loose: parent.allow_loose,
          decimal_qty: parent.decimal_qty,
          hsn_code: parent.hsn_code,
          gst_rate_bp: parent.gst_rate_bp,
          cess_rate_bp: parent.cess_rate_bp,
          tax_slab_rule_id: parent.tax_slab_rule_id,
          price_includes_tax: parent.price_includes_tax,
          mrp_paise: prices[i]!.mrp_paise,
          sale_price_paise: prices[i]!.sale_price_paise,
          wholesale_price_paise: prices[i]!.wholesale_price_paise,
          purchase_price_paise: prices[i]!.purchase_price_paise,
          min_sale_price_paise:
            parent.min_sale_price_paise !== null &&
            parent.min_sale_price_paise <= prices[i]!.sale_price_paise
              ? parent.min_sale_price_paise
              : null,
          max_discount_bp: parent.max_discount_bp,
          track_inventory: true,
          track_batches: parent.track_batches,
          is_weighed: parent.is_weighed,
          reorder_level_milli: parent.reorder_level_milli,
          reorder_qty_milli: parent.reorder_qty_milli,
          variant_attributes: jsonb(attrs),
          attributes: jsonb(parent.attributes ?? {}),
          image_file_id: parent.image_file_id,
          is_active: parent.is_active,
          created_by: ctx.userId,
        })),
      )
      .returning('id')
      .execute()
    createdIds.push(...rows.map((r) => r.id))
    if (body.generate_barcodes) {
      const codes = await generateInternalBarcodes(tx, ctx, createdIds.length)
      await tx
        .insertInto('product_barcodes')
        .values(
          createdIds.map((pid, i) => ({
            id: newId(),
            tenant_id: ctx.tenantId,
            product_id: pid,
            barcode: codes[i]!,
            qty_milli: 1000,
          })),
        )
        .execute()
    }
  }

  // The parent is no longer sold itself: its barcodes would scan to an unsellable product. It has
  // no stock movements (checked above), so nothing was ever sold under them.
  let removedBarcodes: string[] = []
  if (parent.kind === 'standard') {
    const removed = await tx
      .deleteFrom('product_barcodes')
      .where('tenant_id', '=', ctx.tenantId)
      .where('product_id', '=', id)
      .returning('barcode')
      .execute()
    removedBarcodes = removed.map((r) => r.barcode)
  }
  const axesChanged = JSON.stringify(parent.variant_axes) !== JSON.stringify(order)
  if (parent.kind !== 'variant_parent' || axesChanged || parent.track_inventory) {
    await tx
      .updateTable('products')
      .set({ kind: 'variant_parent', variant_axes: order, track_inventory: false })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', id)
      .execute()
  }
  if (createdIds.length > 0 || parent.kind !== 'variant_parent') {
    await audit(tx, ctx, {
      action: 'product.variants_generate',
      entity_type: 'product',
      entity_id: id,
      summary: `${parent.name}: ${String(createdIds.length)} variants created, ${String(skipped.length)} existing`,
      changes: {
        axes: body.axes,
        created: createdIds.length,
        skipped: skipped.length,
        ...(removedBarcodes.length ? { removed_parent_barcodes: removedBarcodes } : {}),
      },
    })
  }

  const storeId = await resolveStoreId(tx, ctx, null)
  const createdRows = createdIds.length
    ? await tx
        .selectFrom('products')
        .select([
          'id',
          'kind',
          'sku',
          'name',
          'name_ta',
          'variant_attributes',
          'sale_price_paise',
          'mrp_paise',
          'purchase_price_paise',
          'is_active',
          'track_inventory',
          'created_at',
        ])
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', 'in', createdIds)
        .orderBy('created_at')
        .orderBy('id')
        .execute()
    : []
  return {
    parent: await getProductDetail(tx, ctx, id),
    created: await toVariantRows(tx, ctx, storeId, createdRows),
    skipped,
  }
}
