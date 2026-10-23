/**
 * CSV import (dry run, upsert idempotency, create-only, error reporting, categories / brands on
 * the fly, variants via parent_sku, vertical attributes, file-level failures, job-based imports
 * with the catalog.import handler run directly), template and export round trip.
 */
import { makeEan13 } from '@kadai/shared'
import type { ProductDetail, ProductListItem } from '@kadai/shared/api/catalog'
import { type ImportJob, parseCsvTable } from '@kadai/shared/api/identity'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postStock } from '../../../core/inventory'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import { runProductImportJob } from '../imports'
import { jobs } from '../jobs'
import { dataOf, errorOf, req, uniq, uploadCsv } from './helpers'

let t: TestApp

beforeAll(async () => {
  t = await buildTestApp()
})
afterAll(() => t.close())

const ean = (): string =>
  makeEan13(`890${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`)

async function runImport(
  shop: TestShop,
  csv: string,
  opts: Record<string, unknown> = {},
): Promise<ImportJob> {
  const fileId = await uploadCsv(t, shop, csv)
  return dataOf<ImportJob>(
    await req(shop).post('/products/import', { file_id: fileId, ...opts }),
    201,
  )
}

async function findBySku(shop: TestShop, sku: string): Promise<ProductDetail> {
  const list = await req(shop).get(`/products?q=${encodeURIComponent(sku)}`)
  const row = list.json<{ data: ProductListItem[] }>().data.find((p) => p.sku === sku)
  if (!row) throw new Error(`no product ${sku}`)
  return dataOf<ProductDetail>(await req(shop).get(`/products/${row.id}`))
}

const HEAD =
  'sku,barcode,name,name_ta,category_path,brand,unit,pack_size,hsn_code,gst_rate,mrp,sale_price,purchase_price,price_includes_tax,track_batches,reorder_level,aliases,veg'

function groceryCsv(tag: string, codes: [string, string], soapPrice = '42'): string {
  return [
    HEAD,
    `${tag}-RICE,${codes[0]},Ponni Rice 1kg,பொன்னி அரிசி,Grocery ${tag} > Rice,Brand ${tag},KG,1,1006,5,72.00,68.00,60.00,yes,no,10,arisi|ponni,yes`,
    `${tag}-DAL,,Toor Dal 1kg,,Grocery ${tag} > Dal,,KG,1,0713,5,180,165.50,150,yes,no,,,yes`,
    `${tag}-SOAP,${codes[1]},Bath Soap,,Personal ${tag},Soap ${tag},PCS,1,3401,5,45,${soapPrice},35,yes,no,12,,`,
    `${tag}-BAD,,Bad GST,,,,PCS,1,,7,10,10,8,yes,no,,,`,
    `${tag}-NONAME,,,,,,PCS,1,,5,10,10,8,yes,no,,,`,
    `${tag}-RICE,,Duplicate,,,,PCS,1,,5,10,10,,yes,no,,,`,
  ].join('\r\n')
}

describe('product import', () => {
  it('dry run validates every row and writes nothing', async () => {
    const shop = await createTestTenant(t)
    const tag = uniq('D').toUpperCase()
    const job = await runImport(shop, groceryCsv(tag, [ean(), ean()]))
    expect(job).toMatchObject({
      kind: 'products',
      status: 'completed',
      dry_run: true,
      mode: 'upsert',
      total_rows: 6,
      success_rows: 3,
      error_rows: 3,
      progress_bp: 10_000,
      filename: 'products.csv',
    })
    expect(job.summary).toMatchObject({
      created: 3,
      updated: 0,
      details: { categories_created: 4, brands_created: 2 },
    })
    expect(job.errors).toEqual([
      expect.objectContaining({ row: 5, field: 'gst_rate', code: 'gst_rate_invalid' }),
      expect.objectContaining({ row: 6, field: 'name', code: 'required' }),
      expect.objectContaining({ row: 7, field: 'sku', code: 'duplicate_in_file' }),
    ])
    expect(job.preview.map((p) => p.action)).toEqual([
      'create',
      'create',
      'create',
      'error',
      'error',
      'error',
    ])
    const list = await req(shop).get(`/products?q=${tag}`)
    expect(list.json<{ page: { total: number } }>().page.total).toBe(0)
    const fetched = dataOf<ImportJob>(await req(shop).get(`/imports/${job.id}`))
    expect(fetched.id).toBe(job.id)
  })

  it('imports, creates categories and brands, and is idempotent on re-import', async () => {
    const shop = await createTestTenant(t)
    const tag = uniq('I').toUpperCase()
    const codes: [string, string] = [ean(), ean()]
    const csv = groceryCsv(tag, codes)
    const job = await runImport(shop, csv, { dry_run: false })
    expect(job.summary).toMatchObject({
      created: 3,
      details: { categories_created: 4, brands_created: 2, barcodes_added: 2 },
    })
    const rice = await findBySku(shop, `${tag}-RICE`)
    expect(rice).toMatchObject({
      name: 'Ponni Rice 1kg',
      name_ta: 'பொன்னி அரிசி',
      unit: 'KG',
      decimal_qty: true,
      hsn_code: '1006',
      gst_rate_bp: 500,
      mrp_paise: 7200,
      sale_price_paise: 6800,
      purchase_price_paise: 6000,
      reorder_level_milli: 10_000,
      aliases: ['arisi', 'ponni'],
      attributes: { veg: true },
      primary_barcode: codes[0],
    })
    expect(rice.category?.path).toBe(`Grocery ${tag} > Rice`)
    expect(rice.brand?.name).toBe(`Brand ${tag}`)
    expect((await findBySku(shop, `${tag}-DAL`)).sale_price_paise).toBe(16550)

    const again = await runImport(shop, csv, { dry_run: false })
    expect(again.summary).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 3,
      details: { categories_created: 0, brands_created: 0 },
    })
    expect(again.error_rows).toBe(3)
    const count = await req(shop).get(`/products?q=${tag}`)
    expect(count.json<{ page: { total: number } }>().page.total).toBe(3)

    const changed = await runImport(shop, groceryCsv(tag, codes, '40'), { dry_run: false })
    expect(changed.summary).toMatchObject({ updated: 1, unchanged: 2 })
    expect((await findBySku(shop, `${tag}-SOAP`)).sale_price_paise).toBe(4000)
    const audit = await shop.tx((tx) =>
      tx
        .selectFrom('audit_logs')
        .select('changes')
        .where('action', '=', 'product.import')
        .where('entity_id', '=', changed.id)
        .executeTakeFirstOrThrow(),
    )
    expect(JSON.stringify(audit.changes)).toContain('"sale_price_paise":4000')

    const createOnly = await runImport(shop, csv, { dry_run: false, mode: 'create_only' })
    expect(createOnly.summary).toMatchObject({ created: 0, skipped: 3 })
  })

  it('matches by barcode and reports barcodes of other products', async () => {
    const shop = await createTestTenant(t)
    const tag = uniq('B').toUpperCase()
    const [a, b] = [ean(), ean()]
    await runImport(
      shop,
      [
        HEAD,
        `${tag}-A,${a},Alpha,,,,PCS,1,,5,,10,,,,,,`,
        `${tag}-B,${b},Beta,,,,PCS,1,,5,,10,,,,,,`,
      ].join('\n'),
      {
        dry_run: false,
      },
    )
    const job = await runImport(
      shop,
      [
        HEAD,
        `,${a},Alpha renamed,,,,PCS,1,,5,,12,,,,,,`,
        `${tag}-A,${b},Alpha,,,,PCS,1,,5,,10,,,,,,`,
      ].join('\n'),
      { dry_run: false },
    )
    expect(job.summary.updated).toBe(1)
    expect(job.errors).toEqual([
      expect.objectContaining({ row: 3, field: 'barcode', code: 'barcode_taken' }),
    ])
    expect((await findBySku(shop, `${tag}-A`)).name).toBe('Alpha renamed')
    // Matched by barcode, the row would give product B the SKU of product A.
    const byBarcode = await runImport(
      shop,
      [HEAD, `${tag}-A,${b},Beta,,,,PCS,1,,5,,10,,,,,,`].join('\n'),
      {
        match_by: 'barcode',
      },
    )
    expect(byBarcode.errors).toEqual([
      expect.objectContaining({ row: 2, field: 'sku', code: 'sku_taken' }),
    ])
  })

  it('imports variants through parent_sku with size / colour columns (apparel)', async () => {
    const shop = await createTestTenant(t, {
      business_type: 'apparel',
      settings: { catalog: { auto_generate_barcode: false } },
    })
    const tag = uniq('V').toUpperCase()
    const head =
      'sku,barcode,name,name_ta,category_path,brand,unit,pack_size,hsn_code,gst_rate,mrp,sale_price,purchase_price,price_includes_tax,track_batches,reorder_level,aliases,parent_sku,size,color,fabric,gender'
    const csv = [
      head,
      `${tag},,Formal Shirt,,Men ${tag} > Shirts,,PCS,1,6205,5,1299,999,600,yes,no,,,,,,Cotton,men`,
      `${tag}-M-BLUE,,Formal Shirt - M / Blue,,,,,,,,1299,999,600,,,,,${tag},M,Blue,,`,
      `${tag}-L-BLUE,,Formal Shirt - L / Blue,,,,,,,,1299,1099,600,,,,,${tag},L,Blue,,`,
      `${tag}-X,,Same combination,,,,,,,,1299,1099,600,,,,,${tag},L,Blue,,`,
      `${tag}-Y,,No parent,,,,,,,,1299,1099,600,,,,,NOPE-${tag},L,Blue,,`,
      `${tag}-Z,,Bad gender,,,,,,,,1299,1099,600,,,,,,,,,alien`,
    ].join('\n')
    const job = await runImport(shop, csv, { dry_run: false })
    expect(job.summary).toMatchObject({ created: 3, details: { variants_created: 2 } })
    expect(job.errors.map((e) => [e.row, e.code])).toEqual([
      [5, 'duplicate_in_file'],
      [6, 'parent_not_found'],
      [7, 'enum_invalid'],
    ])
    const parent = await findBySku(shop, tag)
    expect(parent).toMatchObject({
      kind: 'variant_parent',
      variant_axes: ['size', 'color'],
      track_inventory: false,
    })
    expect(parent.variants.map((v) => v.variant_attributes)).toEqual([
      { size: 'M', color: 'Blue' },
      { size: 'L', color: 'Blue' },
    ])
    const child = await findBySku(shop, `${tag}-L-BLUE`)
    expect(child).toMatchObject({
      kind: 'variant',
      parent_id: parent.id,
      hsn_code: '6205',
      gst_rate_bp: 500,
      sale_price_paise: 109900,
    })
    expect(child.category?.path).toBe(`Men ${tag} > Shirts`)
    expect(child.attributes).toMatchObject({ fabric: 'Cotton', gender: 'men' })

    // Export → import round trip: nothing changes.
    const exported = await req(shop).get('/products/export?format=csv')
    expect(exported.statusCode).toBe(200)
    expect(exported.headers['content-type']).toContain('text/csv')
    const table = parseCsvTable(exported.body)
    expect(table.headers).toContain('parent_sku')
    const exportedChild = table.rows.find((r) => r.values.sku === `${tag}-M-BLUE`)!
    expect(exportedChild.values).toMatchObject({
      parent_sku: tag,
      size: 'M',
      color: 'Blue',
      gst_rate: '5',
      mrp: '1299.00',
    })
    const round = await runImport(shop, exported.body, { dry_run: false })
    expect(round.summary).toMatchObject({ created: 0, updated: 0, unchanged: 3 })
    expect(round.error_rows).toBe(0)
  })

  it('validates pharmacy attribute columns and forces batch tracking for medicines', async () => {
    const shop = await createTestTenant(t, { business_type: 'pharmacy' })
    const tag = uniq('P').toUpperCase()
    const head =
      'sku,name,unit,pack_size,hsn_code,gst_rate,mrp,sale_price,track_batches,generic_name,schedule,dosage_form'
    const job = await runImport(
      shop,
      [
        head,
        `${tag}-1,Dolo 650,TAB,15,3004,5,30.91,30.91,no,Paracetamol,H,tablet`,
        `${tag}-2,Mystery,TAB,10,3004,5,10,10,no,,Z,tablet`,
        `${tag}-3,Strip,TAB,abc,3004,5,10,10,no,,OTC,`,
      ].join('\n'),
      { dry_run: false },
    )
    expect(job.errors.map((e) => [e.row, e.field, e.code])).toEqual([
      [3, 'schedule', 'enum_invalid'],
      [4, 'pack_size', 'int_invalid'],
    ])
    const med = await findBySku(shop, `${tag}-1`)
    expect(med).toMatchObject({
      pack_size: 15,
      track_batches: true,
      mrp_paise: 3091,
      attributes: { schedule: 'H', generic_name: 'Paracetamol' },
    })
  })

  it('fails whole files that are not CSV or lack required columns', async () => {
    const shop = await createTestTenant(t)
    const xlsx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)])
    const fileId = await uploadCsv(
      t,
      shop,
      xlsx,
      'products.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    const failed = dataOf<ImportJob>(
      await req(shop).post('/products/import', { file_id: fileId }),
      201,
    )
    expect(failed).toMatchObject({
      status: 'failed',
      errors: [expect.objectContaining({ row: 0, code: 'import_format' })],
    })
    const noName = await runImport(shop, 'sku,sale_price\nA,10')
    expect(noName).toMatchObject({
      status: 'failed',
      errors: [expect.objectContaining({ code: 'import_header_missing', field: 'name' })],
    })
    const empty = await runImport(shop, `${HEAD}\n`)
    expect(empty.errors[0]!.code).toBe('file_empty')
  })

  it('large files run as job catalog.import with progress', async () => {
    const shop = await createTestTenant(t)
    const tag = uniq('J').toUpperCase()
    const rows = Array.from(
      { length: 1005 },
      (_, i) => `${tag}-${String(i)},Item ${String(i)},PCS,${String(10 + (i % 5))}`,
    )
    const job = await runImport(shop, ['sku,name,unit,sale_price', ...rows].join('\n'), {
      dry_run: false,
    })
    expect(job).toMatchObject({ status: 'pending', total_rows: 1005, progress_bp: 0 })
    const def = jobs.find((j) => j.name === 'catalog.import')
    expect(def).toBeDefined()
    await def!.handler(
      {
        id: 'test',
        name: 'catalog.import',
        retryCount: 0,
        data: { tenant_id: shop.tenant.id, import_id: job.id, user_id: shop.owner.user.id },
      },
      t.deps,
    )
    const done = dataOf<ImportJob>(await req(shop).get(`/imports/${job.id}`))
    expect(done).toMatchObject({
      status: 'completed',
      progress_bp: 10_000,
      success_rows: 1005,
      summary: { created: 1005 },
    })
    expect(done.finished_at).not.toBeNull()
    const list = await req(shop).get(`/products?q=${tag}&limit=1`)
    expect(list.json<{ page: { total: number } }>().page.total).toBe(1005)
    // Running the handler again is a no-op.
    await runProductImportJob(t.deps, {
      tenant_id: shop.tenant.id,
      import_id: job.id,
      user_id: null,
    })
    expect(dataOf<ImportJob>(await req(shop).get(`/imports/${job.id}`)).summary.created).toBe(1005)
  })

  it('job dry run reports without writing', async () => {
    const shop = await createTestTenant(t)
    const tag = uniq('K').toUpperCase()
    const rows = Array.from(
      { length: 1001 },
      (_, i) => `${tag}-${String(i)},Item ${String(i)},${i === 7 ? 'x' : '5'}`,
    )
    const job = await runImport(shop, ['sku,name,sale_price', ...rows].join('\n'))
    expect(job.status).toBe('pending')
    await runProductImportJob(t.deps, {
      tenant_id: shop.tenant.id,
      import_id: job.id,
      user_id: shop.owner.user.id,
    })
    const done = dataOf<ImportJob>(await req(shop).get(`/imports/${job.id}`))
    expect(done).toMatchObject({
      status: 'completed',
      dry_run: true,
      error_rows: 1,
      summary: { created: 1000 },
    })
    expect(done.errors[0]).toMatchObject({ row: 9, field: 'sale_price', code: 'money_invalid' })
    expect(
      (await req(shop).get(`/products?q=${tag}`)).json<{ page: { total: number } }>().page.total,
    ).toBe(0)
  })

  it('checks permissions and tenant isolation of imports', async () => {
    const shop = await createTestTenant(t)
    const job = await runImport(shop, 'name,sale_price\nThing,10')
    const cashier = await shop.asRole('cashier')
    const fileId = await uploadCsv(t, shop, 'name,sale_price\nThing,10')
    expect(
      (await req(shop).post('/products/import', { file_id: fileId }, { as: cashier })).statusCode,
    ).toBe(403)
    const customersOnly = await shop.asRole('crm', { permissions: ['customers.write'] })
    const denied = await req(shop).get(`/imports/${job.id}`, { as: customersOnly })
    expect(denied.statusCode).toBe(403)
    const other = await createTestTenant(t)
    expect((await req(other).get(`/imports/${job.id}`)).statusCode).toBe(404)
    const foreignFile = await req(other).post('/products/import', { file_id: fileId })
    expect(foreignFile.statusCode).toBe(404)
    expect(errorOf(foreignFile).code).toBe('NOT_FOUND')
  })

  it('keeps pack size / batch tracking of stocked products and barcodes off variant parents', async () => {
    const shop = await createTestTenant(t, {
      business_type: 'apparel',
      settings: { catalog: { auto_generate_barcode: false } },
    })
    const tag = uniq('K').toUpperCase()
    const head = 'sku,barcode,name,unit,pack_size,gst_rate,sale_price,track_batches,parent_sku,size'
    await runImport(shop, [head, `${tag}-BOX,,Socks box,PCS,6,5,300,no,,`].join('\n'), {
      dry_run: false,
    })
    const box = await findBySku(shop, `${tag}-BOX`)
    await shop.tx((tx) =>
      postStock(tx, shop.ctx, [
        {
          store_id: shop.store.id,
          product_id: box.id,
          qty_milli: 12_000,
          movement_type: 'opening',
          unit_cost_paise: 200,
        },
      ]),
    )
    const code = ean()
    const job = await runImport(
      shop,
      [
        head,
        `${tag}-BOX,,Socks box,PCS,12,5,300,no,,`,
        `${tag}-T,${code},T-shirt,PCS,1,5,400,no,,`,
        `${tag}-T-M,,T-shirt - M,,,,400,,${tag}-T,M`,
      ].join('\n'),
      { dry_run: false },
    )
    expect(job.errors.map((e) => [e.row, e.code])).toEqual([
      [2, 'pack_size_in_use'],
      [3, 'parent_barcode'],
    ])
    expect((await findBySku(shop, `${tag}-BOX`)).pack_size).toBe(6)
    const parent = await findBySku(shop, `${tag}-T`)
    expect(parent).toMatchObject({ kind: 'variant_parent', barcodes: [] })
    // Batch tracking of a stocked product does not switch through an import either.
    const batches = await runImport(
      shop,
      [head, `${tag}-BOX,,Socks box,PCS,6,5,300,yes,,`].join('\n'),
      { dry_run: false },
    )
    expect(batches.errors.map((e) => [e.row, e.code])).toEqual([[2, 'stock_on_hand']])
    expect((await findBySku(shop, `${tag}-BOX`)).track_batches).toBe(false)
  })
})

describe('template & export', () => {
  it('serves the import template of a vertical', async () => {
    const shop = await createTestTenant(t)
    const res = await req(shop).get('/products/import/template')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toContain('general_store')
    expect(parseCsvTable(res.body).headers.slice(0, 3)).toEqual(['sku', 'barcode', 'name'])
    const pharmacy = await req(shop).get('/products/import/template?business_type=pharmacy')
    expect(parseCsvTable(pharmacy.body).headers).toContain('schedule')
    const cashier = await shop.asRole('cashier')
    expect((await req(shop).get('/products/import/template', { as: cashier })).statusCode).toBe(403)
  })

  it('exports filtered products as CSV and audits the export', async () => {
    const shop = await createTestTenant(t)
    const tag = uniq('E').toUpperCase()
    await runImport(
      shop,
      [
        HEAD,
        `${tag}-1,,Coffee ${tag},காபி,,,PCS,1,0901,5,100,95,80,yes,no,25,,yes`,
        `${tag}-2,,Tea ${tag},,,,PCS,1,0902,5,,50,40,no,no,,,`,
      ].join('\n'),
      { dry_run: false },
    )
    const res = await req(shop).get(`/products/export?q=${encodeURIComponent(`coffee ${tag}`)}`)
    expect(res.statusCode).toBe(200)
    expect(res.body.startsWith('﻿')).toBe(true)
    const table = parseCsvTable(res.body)
    expect(table.rows).toHaveLength(1)
    expect(table.rows[0]!.values).toMatchObject({
      sku: `${tag}-1`,
      name_ta: 'காபி',
      hsn_code: '0901',
      mrp: '100.00',
      sale_price: '95.00',
      price_includes_tax: 'yes',
      veg: 'yes',
      reorder_level: '25',
    })
    const audits = await shop.tx((tx) =>
      tx.selectFrom('audit_logs').select('action').where('action', '=', 'product.export').execute(),
    )
    expect(audits).toHaveLength(1)
    // Low stock (no stock, reorder level 25) narrows the export like the list.
    const low = await req(shop).get(`/products/export?q=${tag}&low_stock=true`)
    expect(low.statusCode, low.body).toBe(200)
    expect(parseCsvTable(low.body).rows.map((r) => r.values.sku)).toEqual([`${tag}-1`])
  })
})
