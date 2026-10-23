/**
 * CSV export (GET /products/export, streamed) with exactly the import columns of the tenant's
 * vertical, so an exported file can be edited and imported back (upsert by SKU / barcode).
 * Rows are read in keyset batches, each in its own short tenant transaction; the export is
 * audited (data exports, ARCHITECTURE.md §7.7). Also the import template (GET
 * /products/import/template).
 */
import { Readable } from 'node:stream'
import { type RawBuilder, sql } from 'kysely'
import {
  type BusinessType,
  milliToDecimalString,
  paiseToRupeesString,
  todayIn,
} from '@kadai/shared'
import {
  type ProductExportQuerySchema,
  type ProductImportColumnDef,
  productImportColumns,
  productImportTemplateCsv,
} from '@kadai/shared/api/catalog'
import { type CsvValue, toCsvRow } from '@kadai/shared/api/identity'
import type { FastifyReply } from 'fastify'
import type { z } from 'zod'
import { audit } from '../../core/audit'
import type { RequestContext } from '../../core/context'
import type { KadaiDeps } from '../../core/runtime'
import { withTenant } from '../../db/tenant'
import { loadCategoryPaths } from './categories'
import { lowStockCondition, productFilter } from './product-read'
import { andAll, issue, jsonObject, resolveStoreId, stringRecord, tenantInfo } from './shared'

const BATCH = 500

interface ExportRow {
  id: string
  kind: string
  sku: string | null
  name: string
  name_ta: string | null
  category_id: string | null
  brand_name: string | null
  unit: string
  pack_size: number
  hsn_code: string | null
  gst_rate_bp: number
  mrp_paise: number | null
  sale_price_paise: number
  purchase_price_paise: number
  wholesale_price_paise: number | null
  price_includes_tax: boolean
  track_batches: boolean
  reorder_level_milli: number | null
  aliases: string[]
  scale_plu: string | null
  attributes: unknown
  variant_attributes: unknown
  parent_sku: string | null
  barcodes: string[] | null
}

/** Basis points → percent text: 500 → '5', 25 → '0.25', 1800 → '18'. */
export function percentText(bp: number): string {
  const whole = Math.trunc(bp / 100)
  const frac = bp % 100
  return frac === 0
    ? String(whole)
    : `${String(whole)}.${String(frac).padStart(2, '0').replace(/0$/, '')}`
}

function yesNo(b: boolean): string {
  return b ? 'yes' : 'no'
}

function cellFor(col: ProductImportColumnDef, r: ExportRow, categoryPath: string | null): CsvValue {
  const attrs = jsonObject(r.attributes)
  const variant = stringRecord(r.variant_attributes)
  switch (col.key) {
    case 'sku':
      return r.sku
    case 'barcode':
      return (r.barcodes ?? []).join('|')
    case 'name':
      return r.name
    case 'name_ta':
      return r.name_ta
    case 'category_path':
      return categoryPath
    case 'brand':
      return r.brand_name
    case 'unit':
      return r.unit
    case 'pack_size':
      return r.pack_size
    case 'hsn_code':
      return r.hsn_code
    case 'gst_rate':
      return percentText(r.gst_rate_bp)
    case 'mrp':
      return r.mrp_paise === null ? null : paiseToRupeesString(r.mrp_paise)
    case 'sale_price':
      return paiseToRupeesString(r.sale_price_paise)
    case 'purchase_price':
      return paiseToRupeesString(r.purchase_price_paise)
    case 'wholesale_price':
      return r.wholesale_price_paise === null ? null : paiseToRupeesString(r.wholesale_price_paise)
    case 'price_includes_tax':
      return yesNo(r.price_includes_tax)
    case 'track_batches':
      return yesNo(r.track_batches)
    case 'reorder_level':
      return r.reorder_level_milli === null ? null : milliToDecimalString(r.reorder_level_milli)
    case 'aliases':
      return r.aliases.join('|')
    case 'scale_plu':
      return r.scale_plu
    case 'parent_sku':
      return r.parent_sku
    default:
      break
  }
  if (col.target === 'variant') return variant[col.key] ?? null
  const v = attrs[col.key]
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return yesNo(v)
  if (typeof v === 'number' || typeof v === 'string') return v
  return JSON.stringify(v)
}

async function* exportLines(
  deps: Pick<KadaiDeps, 'db'>,
  ctx: RequestContext,
  businessType: BusinessType,
  conds: RawBuilder<unknown>[],
): AsyncGenerator<string> {
  const columns = productImportColumns(businessType)
  yield `\uFEFF${toCsvRow(columns.map((c) => c.key))}\r\n`
  const paths = await withTenant(deps.db.appDb, ctx, (tx) => loadCategoryPaths(tx, ctx))
  let after: string | null = null
  for (;;) {
    const cursor: string | null = after
    const rows: ExportRow[] = await withTenant(
      deps.db.appDb,
      ctx,
      async (tx): Promise<ExportRow[]> => {
        const res = await sql<ExportRow>`
        SELECT p.id, p.kind, p.sku, p.name, p.name_ta, p.category_id, b.name::text AS brand_name,
               p.unit, p.pack_size, p.hsn_code, p.gst_rate_bp, p.mrp_paise, p.sale_price_paise,
               p.purchase_price_paise, p.wholesale_price_paise, p.price_includes_tax,
               p.track_batches, p.reorder_level_milli, p.aliases, p.scale_plu, p.attributes,
               p.variant_attributes, parent.sku AS parent_sku,
               (SELECT array_agg(pb.barcode ORDER BY pb.created_at, pb.id) FROM product_barcodes pb
                 WHERE pb.tenant_id = p.tenant_id AND pb.product_id = p.id) AS barcodes
          FROM products p
          LEFT JOIN brands b ON b.tenant_id = p.tenant_id AND b.id = p.brand_id
          LEFT JOIN products parent ON parent.tenant_id = p.tenant_id AND parent.id = p.parent_id
         WHERE ${andAll(conds)} ${cursor ? sql`AND p.id > ${cursor}::uuid` : sql``}
         ORDER BY p.id
         LIMIT ${BATCH}`.execute(tx)
        return res.rows
      },
    )
    for (const r of rows) {
      const path = r.category_id ? (paths.byId.get(r.category_id)?.path ?? null) : null
      yield `${toCsvRow(columns.map((c) => cellFor(c, r, path)))}\r\n`
    }
    if (rows.length < BATCH) return
    after = rows[rows.length - 1]!.id
  }
}

export async function streamProductExport(
  deps: Pick<KadaiDeps, 'db'>,
  ctx: RequestContext,
  reply: FastifyReply,
  q: z.output<typeof ProductExportQuerySchema>,
): Promise<FastifyReply> {
  const { conds, tenant } = await withTenant(deps.db.appDb, ctx, async (tx) => {
    const t = await tenantInfo(tx, ctx)
    const { conds: c } = await productFilter(tx, ctx, q)
    if (q.low_stock !== undefined) {
      // Same rule as the list: low stock needs a store (?store_id or the device's store).
      const storeId = await resolveStoreId(tx, ctx, q.store_id)
      if (!storeId) throw issue('store_id', 'store_required')
      c.push(lowStockCondition(storeId, q.low_stock))
    }
    await audit(tx, ctx, {
      action: 'product.export',
      entity_type: 'product',
      summary: 'Products exported as CSV',
      changes: { filters: q },
    })
    return { conds: c, tenant: t }
  })
  const filename = `products-${todayIn(tenant.timezone)}.csv`
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${filename}"`)
    .send(Readable.from(exportLines(deps, ctx, tenant.business_type, conds)))
}

export function sendImportTemplate(reply: FastifyReply, businessType: BusinessType): FastifyReply {
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header(
      'content-disposition',
      `attachment; filename="kadai-products-template-${businessType}.csv"`,
    )
    .send(productImportTemplateCsv(businessType))
}
