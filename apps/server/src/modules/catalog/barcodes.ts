/**
 * Product barcodes: add (unique per tenant; `qty_milli` for case barcodes), generate an internal
 * EAN-13, delete. Every change bumps products.updated_at so POS delta sync re-sends the product.
 */
import { newId } from '@kadai/shared'
import type { BarcodeAddSchema, ProductBarcode } from '@kadai/shared/api/catalog'
import type { z } from 'zod'
import { audit } from '../../core/audit'
import { notFound } from '../../core/errors'
import type { Tx } from '../../db/tenant'
import { loadProductRow, toBarcode } from './product-read'
import { assertBarcodesFree, barcodeQtyOk, variantParentBarcodeError } from './product-write'
import { generateInternalBarcodes } from './sequences'
import { type Ctx, issue, touchProducts } from './shared'

export async function addBarcode(
  tx: Tx,
  ctx: Ctx,
  productId: string,
  body: z.output<typeof BarcodeAddSchema>,
): Promise<ProductBarcode> {
  const product = await loadProductRow(tx, ctx, productId, { forUpdate: true })
  if (product.kind === 'variant_parent') throw variantParentBarcodeError('barcode')
  if (!barcodeQtyOk(product, body.qty_milli)) throw issue('qty_milli', 'barcode_qty_whole')
  let code: string
  if (body.generate) {
    code = (await generateInternalBarcodes(tx, ctx, 1))[0]!
  } else {
    code = body.barcode!
    await assertBarcodesFree(tx, ctx, [code], 'barcode')
  }
  const row = await tx
    .insertInto('product_barcodes')
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      product_id: productId,
      barcode: code,
      qty_milli: body.qty_milli,
    })
    .returning(['id', 'product_id', 'barcode', 'qty_milli', 'created_at'])
    .executeTakeFirstOrThrow()
  await touchProducts(tx, ctx, [productId])
  await audit(tx, ctx, {
    action: 'product.barcode_add',
    entity_type: 'product',
    entity_id: productId,
    summary: `${product.name}: ${code}`,
    changes: { barcode: code, qty_milli: body.qty_milli, generated: body.generate },
  })
  return toBarcode(row)
}

export async function deleteBarcode(
  tx: Tx,
  ctx: Ctx,
  productId: string,
  barcodeId: string,
): Promise<void> {
  const product = await loadProductRow(tx, ctx, productId, { forUpdate: true })
  const row = await tx
    .deleteFrom('product_barcodes')
    .where('tenant_id', '=', ctx.tenantId)
    .where('product_id', '=', productId)
    .where('id', '=', barcodeId)
    .returning(['barcode'])
    .executeTakeFirst()
  if (!row) throw notFound('barcode', barcodeId)
  await touchProducts(tx, ctx, [productId])
  await audit(tx, ctx, {
    action: 'product.barcode_delete',
    entity_type: 'product',
    entity_id: productId,
    summary: `${product.name}: ${row.barcode}`,
    changes: { barcode: row.barcode },
  })
}
