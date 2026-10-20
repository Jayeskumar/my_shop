import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  BarcodeAddSchema,
  BrandSchema,
  CategoryCreateSchema,
  CategoryNodeSchema,
  CategoryUpdateSchema,
  HsnEntrySchema,
  LABEL_TEMPLATES,
  LabelPrintModelSchema,
  LabelRequestSchema,
  PriceChangeSchema,
  ProductBulkUpdateSchema,
  ProductCreateSchema,
  ProductDetailSchema,
  ProductImportSchema,
  ProductListItemSchema,
  ProductListQuerySchema,
  ProductLookupResultSchema,
  ProductUpdateSchema,
  PromotionCreateSchema,
  PromotionResponseSchema,
  PromotionUpdateSchema,
  StorePricesUpdateSchema,
  TaxSlabRuleCreateSchema,
  UnitsResponseSchema,
  VariantGenerateSchema,
  applyPriceChange,
  barcodeFormatFor,
  barcodeIssue,
  catalogRoutes,
  categoryDescendantIds,
  categoryPlacementIssue,
  categoryTree,
  flattenCategoryTree,
  mrpSavings,
  normalizeProductFlags,
  parsePercentBp,
  parseYesNo,
  productImportColumns,
  productImportTemplateCsv,
  productMargin,
  productRuleIssues,
  promotionStatus,
  promotionSummary,
  slabRateForPrice,
  variantCombinations,
  variantKey,
  variantName,
  variantPrices,
  variantSku,
} from '../../src/api/catalog'
import { parseCsv } from '../../src/api/identity'
import { newId } from '../../src/ids'
import { generateInternalBarcode, makeEan13 } from '../../src/scale'
import { UNITS } from '../../src/units'

const ok = (schema: z.ZodType, v: unknown) => schema.safeParse(v).success
const messages = (schema: z.ZodType, v: unknown) => {
  const r = schema.safeParse(v)
  return r.success ? [] : r.error.issues.map((i) => i.message)
}
const now = '2026-10-20T10:15:00.000Z'

describe('categories', () => {
  const grocery = {
    id: newId(),
    parent_id: null,
    name: 'Grocery',
    name_ta: 'மளிகை',
    sort_order: 10,
  }
  const rice = {
    id: newId(),
    parent_id: grocery.id,
    name: 'Rice',
    name_ta: 'அரிசி',
    sort_order: 10,
  }
  const ponni = { id: newId(), parent_id: rice.id, name: 'Ponni', name_ta: null, sort_order: 0 }
  const dairy = { id: newId(), parent_id: null, name: 'Dairy', name_ta: null, sort_order: 5 }
  const rows = [ponni, rice, grocery, dairy]

  it('builds the tree with depth and bilingual paths', () => {
    const tree = categoryTree(rows)
    expect(tree.map((n) => n.name)).toEqual(['Dairy', 'Grocery'])
    const flat = flattenCategoryTree(tree)
    expect(flat.map((n) => [n.path, n.depth])).toEqual([
      ['Dairy', 1],
      ['Grocery', 1],
      ['Grocery > Rice', 2],
      ['Grocery > Rice > Ponni', 3],
    ])
    expect(flat[3]!.path_ta).toBe('மளிகை > அரிசி > Ponni')
  })
  it('descendants and placement rules (cycles, max depth 3)', () => {
    expect(categoryDescendantIds(rows, grocery.id).sort()).toEqual(
      [grocery.id, rice.id, ponni.id].sort(),
    )
    expect(categoryPlacementIssue(rows, grocery.id, ponni.id)).toBe('category_cycle')
    expect(categoryPlacementIssue(rows, null, ponni.id)).toBe('category_depth')
    expect(categoryPlacementIssue(rows, null, rice.id)).toBeNull()
    expect(categoryPlacementIssue(rows, rice.id, dairy.id)).toBeNull()
    expect(categoryPlacementIssue(rows, grocery.id, dairy.id)).toBe('category_depth')
    expect(categoryPlacementIssue(rows, dairy.id, null)).toBeNull()
  })
  it('schemas: create defaults, recursive node, PATCH', () => {
    expect(CategoryCreateSchema.parse({ name: 'Oil', hsn_code: '' })).toMatchObject({
      parent_id: null,
      hsn_code: null,
      gst_rate_bp: null,
      sort_order: 0,
    })
    expect(ok(CategoryCreateSchema, { name: 'Oil', gst_rate_bp: 1300 })).toBe(false)
    expect(messages(CategoryCreateSchema, { name: 'Oil', hsn_code: '12' })).toEqual(['hsn'])
    const base = {
      parent_id: null,
      name_ta: null,
      hsn_code: null,
      gst_rate_bp: 500,
      tax_slab_rule_id: null,
      sort_order: 0,
      is_active: true,
      depth: 1,
      path: 'Grocery',
      path_ta: 'மளிகை',
      product_count: 3,
      child_count: 1,
      created_at: now,
      updated_at: now,
    }
    const node = CategoryNodeSchema.parse({
      ...base,
      id: grocery.id,
      name: 'Grocery',
      children: [
        {
          ...base,
          id: rice.id,
          name: 'Rice',
          parent_id: grocery.id,
          depth: 2,
          path: 'Grocery > Rice',
          child_count: 0,
          children: [],
        },
      ],
    })
    expect(node.children[0]!.path).toBe('Grocery > Rice')
    expect(messages(CategoryUpdateSchema, {})).toEqual(['empty_patch'])
  })
})

describe('brands & tax slab rules', () => {
  it('brand row', () => {
    expect(
      BrandSchema.parse({
        id: newId(),
        name: 'Aachi',
        is_active: true,
        product_count: 4,
        created_at: now,
        updated_at: now,
      }).name,
    ).toBe('Aachi')
  })
  it('slab rule must end open-ended and ascend', () => {
    const slabs = [
      { max_unit_value_paise: 250_000, gst_rate_bp: 500 },
      { max_unit_value_paise: null, gst_rate_bp: 1800 },
    ]
    expect(ok(TaxSlabRuleCreateSchema, { name: 'Apparel', slabs })).toBe(true)
    expect(messages(TaxSlabRuleCreateSchema, { name: 'x', slabs: [slabs[0]] })).toEqual([
      'slab_last_unbounded',
    ])
    expect(
      ok(TaxSlabRuleCreateSchema, {
        name: 'x',
        slabs: [{ max_unit_value_paise: null, gst_rate_bp: 1300 }],
      }),
    ).toBe(false)
  })
  it('calculator: ₹2,400 → 5%, ₹2,600 incl. → 5%, ₹2,800 → 18%', () => {
    const slabs = [
      { max_unit_value_paise: 250_000, gst_rate_bp: 500 },
      { max_unit_value_paise: null, gst_rate_bp: 1800 },
    ] as const
    expect(slabRateForPrice(slabs, 240_000).gst_rate_bp).toBe(500)
    expect(slabRateForPrice(slabs, 260_000).gst_rate_bp).toBe(500)
    expect(slabRateForPrice(slabs, 280_000).gst_rate_bp).toBe(1800)
    expect(slabRateForPrice(slabs, 260_000, { price_includes_tax: false }).gst_rate_bp).toBe(1800)
  })
})

describe('barcodes', () => {
  it('validates check digits of numeric GTINs only', () => {
    const ean = makeEan13('890123456789')
    expect(barcodeIssue(ean)).toBeNull()
    expect(barcodeIssue(`${ean.slice(0, 12)}${(Number(ean[12]) + 1) % 10}`)).toBe(
      'barcode_checksum',
    )
    expect(barcodeIssue('ABC-123')).toBeNull()
    expect(barcodeIssue('123456')).toBeNull()
    expect(barcodeIssue('a b')).toBe('barcode_format')
    expect(barcodeFormatFor(ean)).toBe('EAN13')
    expect(barcodeFormatFor(generateInternalBarcode(42))).toBe('EAN13')
    expect(barcodeFormatFor('96385074')).toBe('EAN8')
    expect(barcodeFormatFor('036000291452')).toBe('UPC')
    expect(barcodeFormatFor('SHIRT-M')).toBe('CODE128')
  })
  it('add barcode: a code xor generate', () => {
    expect(BarcodeAddSchema.parse({ generate: true })).toEqual({ generate: true, qty_milli: 1000 })
    expect(BarcodeAddSchema.parse({ barcode: 'BOX-12', qty_milli: 12_000 }).qty_milli).toBe(12_000)
    expect(messages(BarcodeAddSchema, {})).toEqual(['barcode_or_generate'])
    expect(messages(BarcodeAddSchema, { barcode: 'X-1', generate: true })).toEqual([
      'barcode_or_generate',
    ])
  })
})

describe('products', () => {
  it('rules: MRP, min price, loose packs, decimal units, services', () => {
    expect(productRuleIssues({ mrp_paise: 1000, sale_price_paise: 1200 })).toEqual([
      { path: 'sale_price_paise', code: 'mrp_below_sale_price' },
    ])
    expect(
      productRuleIssues({ mrp_paise: 1000, sale_price_paise: 1200, allow_mrp_below_sale: true }),
    ).toEqual([])
    expect(productRuleIssues({ sale_price_paise: 1000, min_sale_price_paise: 1100 })[0]?.code).toBe(
      'min_price_above_sale_price',
    )
    expect(productRuleIssues({ allow_loose: true, pack_size: 1 })[0]?.code).toBe(
      'loose_requires_pack',
    )
    expect(productRuleIssues({ decimal_qty: true, unit: 'PCS' })[0]?.code).toBe('decimal_qty_unit')
    expect(productRuleIssues({ decimal_qty: true, unit: 'KG' })).toEqual([])
    expect(productRuleIssues({ kind: 'service', track_inventory: true })[0]?.code).toBe(
      'service_tracks_stock',
    )
    expect(
      normalizeProductFlags({ kind: 'variant_parent', track_inventory: true, track_batches: true }),
    ).toEqual({
      kind: 'variant_parent',
      track_inventory: false,
      track_batches: true,
    })
  })
  it('create: defaults, normalisation and rule messages', () => {
    const parsed = ProductCreateSchema.parse({
      name: '  Paracetamol 500 ',
      sku: '',
      unit: 'tab',
      pack_size: 10,
      allow_loose: true,
      hsn_code: '3004',
      gst_rate_bp: 500,
      mrp_paise: 3500,
      sale_price_paise: 3200,
      scale_plu: '',
      aliases: ['Dolo', 'dolo', 'crocin'],
      attributes: { schedule: 'H', generic_name: 'Paracetamol' },
      barcodes: [{ barcode: makeEan13('890123456789') }],
    })
    expect(parsed).toMatchObject({
      kind: 'standard',
      name: 'Paracetamol 500',
      sku: null,
      unit: 'TAB',
      scale_plu: null,
      aliases: ['Dolo', 'crocin'],
      track_inventory: true,
      cess_rate_bp: 0,
      barcodes: [{ qty_milli: 1000 }],
      allow_mrp_below_sale: false,
    })
    expect(parsed.price_includes_tax).toBeUndefined()
    expect(parsed.track_batches).toBeUndefined()
    expect(
      messages(ProductCreateSchema, { name: 'x', sale_price_paise: 500, mrp_paise: 400 }),
    ).toEqual(['mrp_below_sale_price'])
    expect(messages(ProductCreateSchema, { name: 'x', sale_price_paise: 1, unit: 'FOO' })).toEqual([
      'unit_unknown',
    ])
    expect(messages(ProductCreateSchema, { name: 'x', sale_price_paise: 1, sku: '-bad' })).toEqual([
      'sku_format',
    ])
    expect(
      messages(ProductCreateSchema, { name: 'x', sale_price_paise: 1, scale_plu: '12a' }),
    ).toEqual(['scale_plu_format'])
    expect(
      ProductCreateSchema.parse({ name: 'Tomato', sale_price_paise: 4000, scale_plu: '00123' })
        .scale_plu,
    ).toBe('123')
    expect(ok(ProductCreateSchema, { name: 'x', sale_price_paise: 1, kind: 'variant' })).toBe(false)
  })
  it('update: partial without defaults', () => {
    expect(ProductUpdateSchema.parse({ sale_price_paise: 1500, if_updated_at: now })).toEqual({
      sale_price_paise: 1500,
      if_updated_at: now,
    })
    expect(messages(ProductUpdateSchema, { if_updated_at: now })).toEqual(['empty_patch'])
    expect(messages(ProductUpdateSchema, { allow_mrp_below_sale: true })).toEqual(['empty_patch'])
    expect(messages(ProductUpdateSchema, { mrp_paise: 100, sale_price_paise: 200 })).toEqual([
      'mrp_below_sale_price',
    ])
    expect(ProductUpdateSchema.parse({ name_ta: '' })).toEqual({ name_ta: null })
    expect(ok(ProductUpdateSchema, { kind: 'variant_parent' })).toBe(false)
  })
  it('list query coerces filters', () => {
    const ids = [newId(), newId()]
    expect(
      ProductListQuerySchema.parse({
        q: 'rice',
        low_stock: 'true',
        ids: ids.join(','),
        sort: '-updated_at',
        limit: '20',
      }),
    ).toMatchObject({
      low_stock: true,
      ids,
      sort: { field: 'updated_at', direction: 'desc' },
      limit: 20,
    })
  })

  const productRow = {
    id: newId(),
    parent_id: null,
    kind: 'variant_parent',
    sku: 'SHIRT',
    name: 'Formal Shirt',
    name_ta: 'சட்டை',
    aliases: [],
    description: null,
    category_id: newId(),
    brand_id: null,
    unit: 'PCS',
    pack_size: 1,
    allow_loose: false,
    decimal_qty: false,
    hsn_code: '6205',
    gst_rate_bp: 500,
    cess_rate_bp: 0,
    tax_slab_rule_id: newId(),
    price_includes_tax: true,
    mrp_paise: 99_900,
    sale_price_paise: 89_900,
    wholesale_price_paise: null,
    purchase_price_paise: 50_000,
    min_sale_price_paise: null,
    max_discount_bp: null,
    track_inventory: false,
    track_batches: false,
    is_weighed: false,
    scale_plu: null,
    reorder_level_milli: null,
    reorder_qty_milli: null,
    variant_attributes: {},
    variant_axes: ['size', 'color'],
    attributes: { fabric: 'Cotton' },
    image_file_id: null,
    is_active: true,
    created_by: null,
    created_at: new Date(now),
    updated_at: now,
  }
  it('detail, list row and lookup responses', () => {
    const detail = ProductDetailSchema.parse({
      ...productRow,
      category: {
        id: productRow.category_id,
        name: 'Shirts',
        name_ta: null,
        path: 'Apparel > Shirts',
      },
      brand: null,
      tax_slab_rule: {
        id: productRow.tax_slab_rule_id,
        name: 'Apparel',
        slabs: [{ max_unit_value_paise: null, gst_rate_bp: 500 }],
      },
      barcodes: [],
      primary_barcode: null,
      parent: null,
      variants: [
        {
          id: newId(),
          sku: 'SHIRT-M-BLUE',
          name: 'Formal Shirt - M / Blue',
          name_ta: 'சட்டை - M / நீலம்',
          variant_attributes: { size: 'M', color: 'Blue' },
          sale_price_paise: 89_900,
          mrp_paise: 99_900,
          purchase_price_paise: 50_000,
          is_active: true,
          primary_barcode: generateInternalBarcode(1),
          stock_qty_milli: 4000,
        },
      ],
      stock_qty_milli: null,
    })
    expect(detail.created_at).toBe(now)
    expect(detail.variants).toHaveLength(1)
    expect(
      ProductListItemSchema.parse({
        ...productRow,
        category_name: 'Shirts',
        category_path: 'Apparel > Shirts',
        brand_name: null,
        primary_barcode: null,
        variant_count: 8,
        stock_qty_milli: null,
        low_stock: null,
      }).variant_count,
    ).toBe(8)
    const lookup = ProductLookupResultSchema.parse({
      match: 'scale',
      code: '2100123012345',
      product: {
        ...productRow,
        kind: 'standard',
        store_price_applied: false,
        stock_qty_milli: 1500,
      },
      qty_milli: 1234,
      price_paise: null,
      barcode_id: null,
    })
    expect(lookup.product.store_price_applied).toBe(false)
  })
})

describe('variants', () => {
  const axes = { size: ['S', 'M', 'L', 'XL'], color: ['Red', 'Blue'] }
  it('cartesian product, keys, names and SKUs', () => {
    const combos = variantCombinations(axes)
    expect(combos).toHaveLength(8)
    expect(combos[0]).toEqual({ size: 'S', color: 'Red' })
    expect(combos[7]).toEqual({ size: 'XL', color: 'Blue' })
    const order = ['size', 'color']
    expect(variantKey({ color: 'Red', size: 'M' }, order)).toBe('m|red')
    expect(variantName('T-Shirt', { size: 'M', color: 'Red' }, order)).toBe('T-Shirt - M / Red')
    expect(
      variantName('டி-சட்டை', { size: 'M', color: 'Red' }, order, { color: { Red: 'சிவப்பு' } }),
    ).toBe('டி-சட்டை - M / சிவப்பு')
    expect(variantSku('TSHIRT', { size: 'M', color: 'Sky Blue' }, order)).toBe('TSHIRT-M-SKYBLUE')
  })
  it('idempotent generation: existing combinations are skipped by key', () => {
    const order = ['size', 'color']
    const existing = new Set([variantKey({ size: 'M', color: 'red' }, order)])
    const toCreate = variantCombinations(axes, order).filter(
      (c) => !existing.has(variantKey(c, order)),
    )
    expect(toCreate).toHaveLength(7)
    const again = new Set([...existing, ...toCreate.map((c) => variantKey(c, order))])
    expect(
      variantCombinations(axes, order).filter((c) => !again.has(variantKey(c, order))),
    ).toEqual([])
  })
  it('price overrides apply in order', () => {
    const base = {
      sale_price_paise: 50_000,
      mrp_paise: 60_000,
      purchase_price_paise: 30_000,
      wholesale_price_paise: null,
    }
    const overrides = VariantGenerateSchema.parse({
      axes,
      price_overrides: [
        { match: { size: 'XL' }, sale_price_paise: 55_000 },
        { match: { size: 'xl', color: 'Blue' }, sale_price_paise: 56_000, mrp_paise: 65_000 },
      ],
    }).price_overrides
    expect(variantPrices(base, { size: 'XL', color: 'Red' }, overrides).sale_price_paise).toBe(
      55_000,
    )
    expect(variantPrices(base, { size: 'XL', color: 'Blue' }, overrides)).toMatchObject({
      sale_price_paise: 56_000,
      mrp_paise: 65_000,
    })
    expect(variantPrices(base, { size: 'S', color: 'Blue' }, overrides)).toEqual(base)
  })
  it('generate body validation', () => {
    expect(VariantGenerateSchema.parse({ axes })).toMatchObject({
      generate_barcodes: false,
      price_overrides: [],
    })
    expect(messages(VariantGenerateSchema, { axes: { size: ['M', 'm'] } })).toEqual([
      'variant_duplicate_value',
    ])
    expect(messages(VariantGenerateSchema, { axes: {} })).toEqual(['variant_axes_count'])
    expect(messages(VariantGenerateSchema, { axes: { Size: ['M'] } })).toContain('variant_axis')
    const big = {
      a: Array.from({ length: 30 }, (_, i) => `${i}`),
      b: Array.from({ length: 20 }, (_, i) => `${i}`),
    }
    expect(messages(VariantGenerateSchema, { axes: big })).toEqual(['variant_combinations_limit'])
  })
})

describe('bulk update & price changes', () => {
  it('applyPriceChange', () => {
    const pct = PriceChangeSchema.parse({ mode: 'percent', percent_bp: 1000 })
    expect(applyPriceChange(12_345, pct)).toEqual({ price_paise: 13_580, capped: false })
    expect(applyPriceChange(12_345, { ...pct, round_to_rupee: true })).toEqual({
      price_paise: 13_600,
      capped: false,
    })
    expect(applyPriceChange(12_345, pct, 13_000)).toEqual({ price_paise: 13_000, capped: true })
    expect(
      applyPriceChange(500, PriceChangeSchema.parse({ mode: 'amount', amount_paise: -800 })),
    ).toEqual({
      price_paise: 0,
      capped: false,
    })
    expect(
      applyPriceChange(500, PriceChangeSchema.parse({ mode: 'set', price_paise: 999 })),
    ).toEqual({
      price_paise: 999,
      capped: false,
    })
    expect(messages(PriceChangeSchema, { mode: 'percent', percent_bp: 0 })).toEqual([
      'price_change_zero',
    ])
  })
  it('bulk body', () => {
    const id = newId()
    expect(ok(ProductBulkUpdateSchema, { ids: [id], set: { is_active: false } })).toBe(true)
    expect(messages(ProductBulkUpdateSchema, { ids: [id, id], set: { is_active: false } })).toEqual(
      ['duplicate_id'],
    )
    expect(messages(ProductBulkUpdateSchema, { ids: [id], set: {} })).toEqual(['empty_patch'])
    expect(
      ok(ProductBulkUpdateSchema, {
        ids: Array.from({ length: 501 }, newId),
        set: { is_active: true },
      }),
    ).toBe(false)
  })
  it('margins and MRP savings', () => {
    expect(
      productMargin({
        sale_price_paise: 11_800,
        purchase_price_paise: 8_000,
        price_includes_tax: true,
        gst_rate_bp: 1800,
      }),
    ).toEqual({
      sale_excl_tax_paise: 10_000,
      margin_paise: 2_000,
      margin_bp: 2000,
      markup_bp: 2500,
    })
    expect(
      productMargin({
        sale_price_paise: 0,
        purchase_price_paise: 0,
        price_includes_tax: false,
        gst_rate_bp: 0,
      }),
    ).toMatchObject({
      margin_bp: null,
      markup_bp: null,
    })
    expect(mrpSavings(7200, 6800)).toEqual({ savings_paise: 400, savings_bp: 556 })
    expect(mrpSavings(null, 6800)).toEqual({ savings_paise: 0, savings_bp: 0 })
  })
})

describe('import / export', () => {
  it('columns per vertical and the template CSV', () => {
    const pharmacy = productImportColumns('pharmacy').map((c) => c.key)
    expect(pharmacy.slice(0, 3)).toEqual(['sku', 'barcode', 'name'])
    expect(pharmacy).toContain('schedule')
    expect(productImportColumns('apparel').map((c) => c.key)).toEqual(
      expect.arrayContaining(['parent_sku', 'size', 'color']),
    )
    expect(new Set(productImportColumns('supermarket').map((c) => c.key)).size).toBe(
      productImportColumns('supermarket').length,
    )
    const [header, example] = parseCsv(productImportTemplateCsv('general_store'))
    expect(header).toEqual(productImportColumns('general_store').map((c) => c.key))
    expect(example).toHaveLength(header!.length)
  })
  it('cell parsers', () => {
    expect(parsePercentBp('18')).toBe(1800)
    expect(parsePercentBp('0.25')).toBe(25)
    expect(parsePercentBp('5%')).toBe(500)
    expect(parsePercentBp('abc')).toBeNull()
    expect(parseYesNo('Yes')).toBe(true)
    expect(parseYesNo('இல்லை')).toBe(false)
    expect(parseYesNo('')).toBeNull()
    expect(parseYesNo('maybe')).toBeUndefined()
  })
  it('import body defaults to a dry run', () => {
    expect(ProductImportSchema.parse({ file_id: newId() })).toMatchObject({
      mode: 'upsert',
      dry_run: true,
      match_by: 'sku_or_barcode',
      create_categories: true,
    })
  })
})

describe('promotions', () => {
  const productId = newId()
  it('create per kind with defaults and date order', () => {
    const p = PromotionCreateSchema.parse({
      name: 'Buy 2 get 1',
      kind: 'buy_x_get_y',
      rules: { product_ids: [productId], buy_qty: 2, get_qty: 1 },
    })
    expect(p).toMatchObject({ store_ids: null, priority: 0, stackable: false, is_active: true })
    expect(p.kind === 'buy_x_get_y' && p.rules.get_discount_bp).toBe(10_000)
    expect(
      ok(PromotionCreateSchema, { name: 'x', kind: 'bill_percent', rules: { flat_paise: 10 } }),
    ).toBe(false)
    expect(
      messages(PromotionCreateSchema, {
        name: 'x',
        kind: 'bill_flat',
        rules: { flat_paise: 1000 },
        starts_at: '2026-11-01T00:00:00+05:30',
        ends_at: '2026-10-01T00:00:00+05:30',
      }),
    ).toEqual(['promotion_dates'])
  })
  it('update validates rules with the given kind', () => {
    expect(PromotionUpdateSchema.parse({ is_active: false })).toMatchObject({ is_active: false })
    const parsed = PromotionUpdateSchema.parse({
      kind: 'item_percent',
      rules: { all_items: true, percent_bp: 500 },
    })
    expect(parsed.rules).toMatchObject({ all_items: true, percent_bp: 500, product_ids: [] })
    expect(messages(PromotionUpdateSchema, { rules: { percent_bp: 5 } })).toEqual([
      'promotion_kind_required',
    ])
    expect(messages(PromotionUpdateSchema, { kind: 'item_flat' })).toEqual([
      'promotion_rules_required',
    ])
    expect(ok(PromotionUpdateSchema, { kind: 'item_percent', rules: { percent_bp: 500 } })).toBe(
      false,
    )
  })
  it('status and summary', () => {
    const at = new Date('2026-10-20T06:00:00Z')
    expect(promotionStatus({ is_active: true, starts_at: null, ends_at: null }, at)).toBe('active')
    expect(promotionStatus({ is_active: false, starts_at: null, ends_at: null }, at)).toBe(
      'inactive',
    )
    expect(
      promotionStatus({ is_active: true, starts_at: '2026-10-21T00:00:00Z', ends_at: null }, at),
    ).toBe('scheduled')
    expect(
      promotionStatus(
        { is_active: true, starts_at: null, ends_at: new Date('2026-10-20T06:00:00Z') },
        at,
      ),
    ).toBe('expired')
    expect(promotionSummary({ kind: 'buy_x_get_y', rules: { buy_qty: 2, get_qty: 1 } })).toEqual({
      key: 'buy_x_get_y_free',
      params: { buy_qty: 2, get_qty: 1 },
    })
    expect(
      promotionSummary({
        kind: 'buy_x_get_y',
        rules: { buy_qty: 1, get_qty: 1, get_discount_bp: 5000 },
      }).key,
    ).toBe('buy_x_get_y_discount')
    expect(
      promotionSummary({ kind: 'bill_flat', rules: { flat_paise: 5000, min_bill_paise: 100_000 } }),
    ).toEqual({
      key: 'bill_flat',
      params: { flat_paise: 5000, min_bill_paise: 100_000 },
    })
  })
  it('response parses the stored row', () => {
    const r = PromotionResponseSchema.parse({
      id: newId(),
      name: 'Deepavali 10%',
      name_ta: 'தீபாவளி 10%',
      kind: 'bill_percent',
      rules: { percent_bp: 1000 },
      store_ids: null,
      starts_at: new Date('2026-10-25T00:00:00+05:30'),
      ends_at: null,
      days_of_week: [0, 6],
      priority: 10,
      stackable: false,
      is_active: true,
      status: 'scheduled',
      created_by: null,
      created_at: now,
      updated_at: now,
    })
    expect(r.starts_at).toBe('2026-10-24T18:30:00.000Z')
  })
})

describe('store prices, labels, units, HSN', () => {
  it('store price upserts', () => {
    const storeId = newId()
    const a = newId()
    expect(
      StorePricesUpdateSchema.parse({
        store_id: storeId,
        upserts: [{ product_id: a, sale_price_paise: 100 }],
      }),
    ).toMatchObject({
      upserts: [{ product_id: a, sale_price_paise: 100, mrp_paise: null }],
      deletes: [],
    })
    expect(messages(StorePricesUpdateSchema, { store_id: storeId })).toEqual(['empty_patch'])
    expect(
      messages(StorePricesUpdateSchema, {
        store_id: storeId,
        upserts: [{ product_id: a, sale_price_paise: 100 }],
        deletes: [a],
      }),
    ).toEqual(['store_price_conflict'])
    expect(
      messages(StorePricesUpdateSchema, {
        store_id: storeId,
        upserts: [{ product_id: a, sale_price_paise: 100, mrp_paise: 90 }],
      }),
    ).toEqual(['mrp_below_sale_price'])
  })
  it('label templates fit their media and requests are bounded', () => {
    const a4 = LABEL_TEMPLATES.a4_65
    expect(a4.columns * a4.rows).toBe(65)
    const usedWidth =
      a4.margin_left_mm * 2 + a4.columns * a4.label_width_mm + (a4.columns - 1) * a4.gap_x_mm
    expect(usedWidth).toBeLessThanOrEqual(a4.page_width_mm + 0.01)
    expect(a4.margin_top_mm * 2 + a4.rows * a4.label_height_mm).toBeLessThanOrEqual(
      a4.page_height_mm + 0.01,
    )
    const productId = newId()
    expect(
      LabelRequestSchema.parse({ template: '38x25', items: [{ product_id: productId }] }).items[0],
    ).toEqual({
      product_id: productId,
      batch_id: null,
      copies: 1,
    })
    expect(
      messages(LabelRequestSchema, {
        template: '50x25',
        items: [
          { product_id: productId, copies: 3000 },
          { product_id: newId(), copies: 3000 },
        ],
      }),
    ).toEqual(['label_copies_limit'])
    const model = LabelPrintModelSchema.parse({
      template: LABEL_TEMPLATES['38x25'],
      shop: { name: 'Murugan Stores', name_ta: null },
      labels: [
        {
          product_id: productId,
          batch_id: null,
          sku: 'X',
          name: 'Shirt',
          name_ta: null,
          price_paise: 49_900,
          mrp_paise: 59_900,
          barcode: generateInternalBarcode(7),
          barcode_format: 'EAN13',
          barcode_generated: true,
          batch_no: null,
          expiry_date: null,
          mfg_date: null,
          size: 'M',
          color: 'Blue',
          variant_label: 'M / Blue',
          unit: 'PCS',
          pack_size: 1,
          copies: 2,
        },
      ],
      total_copies: 2,
    })
    expect(model.labels[0]!.barcode_format).toBe('EAN13')
  })
  it('units and HSN entries', () => {
    expect(
      UnitsResponseSchema.parse({ units: UNITS, suggested: ['PCS', 'KG'] }).units,
    ).toHaveLength(UNITS.length)
    expect(
      HsnEntrySchema.parse({
        code: '1006',
        description: 'Rice',
        gst_rate_bp: 500,
        group: 'Groceries',
        slab_rule_hint: null,
      }).code,
    ).toBe('1006')
  })
})

describe('route catalogue', () => {
  it('shapes, features and permissions', () => {
    for (const [name, def] of Object.entries(catalogRoutes)) {
      expect(def.path.startsWith('/'), name).toBe(true)
      if (def.method === 'GET') expect('body' in def, name).toBe(false)
    }
    expect(catalogRoutes.generateVariants.feature).toBe('variants')
    expect(catalogRoutes.listPromotions.feature).toBe('promotions')
    expect(catalogRoutes.updateStorePrices.feature).toBe('store_pricing')
    expect(catalogRoutes.printLabels.feature).toBe('barcode_labels')
    expect(catalogRoutes.getImport.permission).toEqual(['catalog.write', 'customers.write'])
    expect(catalogRoutes.exportProducts.stream).toBe('csv')
  })
})

describe('auto SKU', () => {
  it('formats prefix + sequence', async () => {
    const { formatAutoSku } = await import('../../src/api/catalog')
    expect(formatAutoSku('P', 42)).toBe('P00042')
    expect(formatAutoSku('', 123456)).toBe('123456')
    expect(() => formatAutoSku('P', 0)).toThrow(RangeError)
  })
})
