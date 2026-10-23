/**
 * POST /labels (feature barcode_labels): the print model for barcode / price labels. Prices
 * follow the billing precedence (store price > batch price > product price; MRP batch > store >
 * product); products without a barcode get an internal EAN-13 when `generate_missing_barcodes`
 * (needs catalog.write).
 */
import { newId } from '@kadai/shared'
import {
  LABEL_TEMPLATES,
  type LabelPrintModel,
  type LabelRequestSchema,
  barcodeFormatFor,
  variantLabel,
} from '@kadai/shared/api/catalog'
import type { z } from 'zod'
import { audit } from '../../core/audit'
import { getEntitlements } from '../../core/entitlements'
import { AppError } from '../../core/errors'
import { assertStoreAccess } from '../../core/http'
import type { Tx } from '../../db/tenant'
import { primaryBarcodes } from './product-read'
import { assertCanWriteCatalog } from './product-write'
import { generateInternalBarcodes } from './sequences'
import { type Ctx, issue, stringRecord, tenantInfo, touchProducts } from './shared'

export async function printLabels(
  tx: Tx,
  ctx: Ctx,
  body: z.output<typeof LabelRequestSchema>,
): Promise<LabelPrintModel> {
  if (body.generate_missing_barcodes) assertCanWriteCatalog(ctx)
  const tenant = await tenantInfo(tx, ctx)
  let storeId: string | null = null
  if (body.store_id) {
    assertStoreAccess(ctx, body.store_id)
    const store = await tx
      .selectFrom('stores')
      .select('id')
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', body.store_id)
      .executeTakeFirst()
    if (!store) throw issue('store_id', 'reference_not_found')
    storeId = store.id
  }

  const productIds = [...new Set(body.items.map((i) => i.product_id))]
  const products = await tx
    .selectFrom('products')
    .select([
      'id',
      'parent_id',
      'kind',
      'sku',
      'name',
      'name_ta',
      'unit',
      'pack_size',
      'sale_price_paise',
      'mrp_paise',
      'variant_attributes',
    ])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', 'in', productIds)
    .execute()
  const byId = new Map(products.map((p) => [p.id, p]))
  body.items.forEach((item, i) => {
    const p = byId.get(item.product_id)
    if (!p) throw issue(`items.${String(i)}.product_id`, 'reference_not_found')
    if (p.kind === 'variant_parent')
      throw new AppError('UNPROCESSABLE', 'Print labels for the variants, not the parent', {
        reason: 'product_kind',
        path: `items.${String(i)}.product_id`,
      })
  })

  const batchIds = [
    ...new Set(body.items.map((i) => i.batch_id).filter((b): b is string => b !== null)),
  ]
  const batches = batchIds.length
    ? await tx
        .selectFrom('batches')
        .select([
          'id',
          'product_id',
          'batch_no',
          'expiry_date',
          'mfg_date',
          'mrp_paise',
          'sale_price_paise',
        ])
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', 'in', batchIds)
        .execute()
    : []
  const batchById = new Map(batches.map((b) => [b.id, b]))
  body.items.forEach((item, i) => {
    if (item.batch_id === null) return
    const b = batchById.get(item.batch_id)
    if (!b || b.product_id !== item.product_id)
      throw issue(`items.${String(i)}.batch_id`, 'reference_not_found')
  })

  const storePrices = new Map<string, { sale_price_paise: number; mrp_paise: number | null }>()
  if (storeId && (await getEntitlements(ctx)).features.has('store_pricing')) {
    const rows = await tx
      .selectFrom('store_product_prices')
      .select(['product_id', 'sale_price_paise', 'mrp_paise'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('store_id', '=', storeId)
      .where('product_id', 'in', productIds)
      .execute()
    for (const r of rows) storePrices.set(r.product_id, r)
  }

  const parentIds = [
    ...new Set(products.map((p) => p.parent_id).filter((x): x is string => x !== null)),
  ]
  const parents = parentIds.length
    ? await tx
        .selectFrom('products')
        .select(['id', 'variant_axes'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', 'in', parentIds)
        .execute()
    : []
  const axesOf = new Map(parents.map((p) => [p.id, p.variant_axes]))

  const codes = await primaryBarcodes(tx, ctx, productIds)
  const generated = new Set<string>()
  if (body.generate_missing_barcodes) {
    const missing = productIds.filter((id) => !codes.has(id))
    if (missing.length) {
      const fresh = await generateInternalBarcodes(tx, ctx, missing.length)
      await tx
        .insertInto('product_barcodes')
        .values(
          missing.map((pid, i) => ({
            id: newId(),
            tenant_id: ctx.tenantId,
            product_id: pid,
            barcode: fresh[i]!,
            qty_milli: 1000,
          })),
        )
        .execute()
      missing.forEach((pid, i) => {
        codes.set(pid, fresh[i]!)
        generated.add(pid)
      })
      await touchProducts(tx, ctx, missing)
      await audit(tx, ctx, {
        action: 'product.barcode_generate',
        entity_type: 'product',
        summary: `Generated ${String(missing.length)} barcodes for labels`,
        changes: { products: missing.map((pid) => ({ product_id: pid, barcode: codes.get(pid) })) },
      })
    }
  }

  let total = 0
  const labels = body.items.map((item) => {
    const p = byId.get(item.product_id)!
    const batch = item.batch_id ? batchById.get(item.batch_id) : undefined
    const sp = storePrices.get(p.id)
    const attrs = stringRecord(p.variant_attributes)
    const order = (p.parent_id ? axesOf.get(p.parent_id) : undefined) ?? Object.keys(attrs)
    const code = codes.get(p.id) ?? null
    total += item.copies
    return {
      product_id: p.id,
      batch_id: batch?.id ?? null,
      sku: p.sku,
      name: p.name,
      name_ta: p.name_ta,
      price_paise: sp?.sale_price_paise ?? batch?.sale_price_paise ?? p.sale_price_paise,
      mrp_paise: batch?.mrp_paise ?? sp?.mrp_paise ?? p.mrp_paise,
      barcode: code,
      barcode_format: code ? barcodeFormatFor(code) : null,
      barcode_generated: generated.has(p.id),
      batch_no: batch?.batch_no ?? null,
      expiry_date: batch?.expiry_date ?? null,
      mfg_date: batch?.mfg_date ?? null,
      size: attrs.size ?? null,
      color: attrs.color ?? attrs.colour ?? null,
      variant_label: Object.keys(attrs).length ? variantLabel(attrs, order) : null,
      unit: p.unit,
      pack_size: p.pack_size,
      copies: item.copies,
    }
  })
  return {
    template: LABEL_TEMPLATES[body.template],
    shop: { name: tenant.name, name_ta: tenant.name_ta },
    labels,
    total_copies: total,
  }
}
