import {
  CATALOG_ERROR_REASONS,
  CATALOG_VALIDATION_KEYS,
  LABEL_TEMPLATES,
  type LabelPrintModel,
  type StorePriceRow,
  PRODUCT_IMPORT_ERROR_CODES,
  ProductCreateSchema,
  ProductUpdateSchema,
  PromotionCreateSchema,
  PromotionUpdateSchema,
  StorePricesUpdateSchema,
  TaxSlabRuleCreateSchema,
  VariantGenerateSchema,
} from '@kadai/shared/api/catalog'
import { DEFAULT_SETTINGS } from '@kadai/shared/settings'
import i18next from 'i18next'
import { describe, expect, it } from 'vitest'
import { setLanguage } from '@/lib/i18n'
import { category, productDetail } from '../testing/fixtures'
import { ATTRIBUTE_FIELDS } from './attributes'
import { barcodeSvg, expiryText, labelCss, renderLabelsHtml, sheetCount } from './labels'
import { catalogValidationText, importErrorText } from './messages'
import {
  categoryTaxDefaults,
  defaultProductValues,
  productFormIssues,
  toCreateBody,
  toUpdateBody,
  valuesFromProduct,
} from './product-form'
import {
  defaultPromotionValues,
  promotionExample,
  promotionFormIssues,
  toPromotionCreate,
  toPromotionUpdate,
  valuesFromPromotion,
} from './promotion-form'
import { promotionText, scheduleText } from './promotion-text'
import { storePricesBody } from './store-prices'
import { examplePrices, ruleBody, ruleIssues } from './tax-rules'
import { axesFromVariants, buildVariantGenerate, previewCombinations } from './variants'

const ctx = { settings: DEFAULT_SETTINGS, businessType: 'general_store' as const }

describe('product form model', () => {
  it('builds a create body the contract accepts, with blanks cleared', () => {
    const v = {
      ...defaultProductValues(ctx),
      name: '  Toor Dal 1 kg ',
      name_ta: '',
      sku: 'DAL-1',
      gst_rate_bp: 500,
      sale_price_paise: 16_500,
      mrp_paise: 17_000,
      aliases: ['paruppu', ' '],
      barcodes: [{ barcode: '8901234567890', qty_milli: 1000 }],
      attributes: { veg: true, loose: null, shelf_life_days: null },
    }
    const body = toCreateBody(v)
    expect(body).toMatchObject({
      kind: 'standard',
      name: 'Toor Dal 1 kg',
      name_ta: null,
      sku: 'DAL-1',
      aliases: ['paruppu'],
      gst_rate_bp: 500,
      sale_price_paise: 16_500,
      generate_barcode: false,
      attributes: { veg: true },
    })
    expect(ProductCreateSchema.safeParse(body).success).toBe(true)
    expect(productFormIssues(v, 'create', ctx)).toEqual([])
  })

  it('reports required fields and the MRP rule with contract keys', () => {
    const v = {
      ...defaultProductValues(ctx),
      name: 'Soap',
      gst_rate_bp: null,
      sale_price_paise: null,
    }
    const paths = productFormIssues(v, 'create', ctx).map((i) => String(i.path[0]))
    expect(paths).toEqual(expect.arrayContaining(['sale_price_paise', 'gst_rate_bp']))
    const above = { ...v, gst_rate_bp: 1800, sale_price_paise: 5_000, mrp_paise: 4_500 }
    expect(productFormIssues(above, 'create', ctx)).toContainEqual(
      expect.objectContaining({ message: 'mrp_below_sale_price' }),
    )
    expect(productFormIssues({ ...above, allow_mrp_below_sale: true }, 'create', ctx)).toEqual([])
  })

  it('validates vertical attributes (pharmacy schedule)', () => {
    const pharmacy = { settings: DEFAULT_SETTINGS, businessType: 'pharmacy' as const }
    const v = {
      ...defaultProductValues(pharmacy),
      name: 'Dolo 650',
      gst_rate_bp: 500,
      sale_price_paise: 3_000,
      attributes: { schedule: 'Z' },
    }
    expect(productFormIssues(v, 'create', pharmacy).map((i) => i.path.join('.'))).toContain(
      'attributes.schedule',
    )
    expect(defaultProductValues(pharmacy).track_batches).toBe(true)
  })

  it('sends only the changed fields on update, with the stale-write guard', () => {
    const p = productDetail()
    const base = valuesFromProduct(p)
    expect(toUpdateBody(base, base, p)).toBeNull()
    const body = toUpdateBody(
      { ...base, sale_price_paise: 6_500, aliases: ['arisi', 'ponni'] },
      base,
      p,
    )
    expect(body).toEqual({
      sale_price_paise: 6_500,
      aliases: ['arisi', 'ponni'],
      if_updated_at: p.updated_at,
    })
    expect(ProductUpdateSchema.safeParse(body).success).toBe(true)
    // A switch to service is sent as kind and drops stock tracking.
    const service = toUpdateBody({ ...base, kind: 'service' }, base, p)
    expect(service).toMatchObject({ kind: 'service', track_inventory: false })
  })

  it('takes tax defaults from the category or its nearest ancestor', () => {
    const root = category({ name: 'Grocery', hsn_code: '1006', gst_rate_bp: 500 })
    const child = category({ name: 'Rice', parent_id: root.id, depth: 2, gst_rate_bp: 0 })
    expect(categoryTaxDefaults([root, child], child.id)).toEqual({
      hsn_code: '1006',
      gst_rate_bp: 0,
      tax_slab_rule_id: null,
    })
    expect(categoryTaxDefaults([root, child], null).gst_rate_bp).toBeNull()
  })
})

describe('promotion form model', () => {
  it('turns a buy 2 get 1 form into a valid create body with IST day boundaries', () => {
    const v = {
      ...defaultPromotionValues('buy_x_get_y'),
      name: 'Soap 2+1',
      category_ids: ['0192f0a0-0000-7000-8000-000000000777'],
      start_date: '2026-11-01',
      end_date: '2026-11-15',
      days_of_week: [0, 6],
    }
    const body = toPromotionCreate(v, 'Asia/Kolkata')
    expect(body).toMatchObject({
      kind: 'buy_x_get_y',
      starts_at: '2026-10-31T18:30:00.000Z',
      ends_at: '2026-11-15T18:30:00.000Z',
      days_of_week: [0, 6],
      rules: { buy_qty: 2, get_qty: 1, get_discount_bp: 10_000, category_ids: v.category_ids },
    })
    expect(PromotionCreateSchema.safeParse(body).success).toBe(true)
    expect(promotionFormIssues(v)).toEqual([])
  })

  it('round-trips a stored promotion and builds the PATCH with kind + rules', () => {
    const v = {
      ...defaultPromotionValues('bill_percent'),
      name: 'Diwali',
      percent_bp: 1000,
      end_date: '2026-11-15',
    }
    const created = PromotionCreateSchema.parse(toPromotionCreate(v))
    const stored = {
      ...created,
      name_ta: created.name_ta ?? null,
      id: '0192f0a0-0000-7000-8000-000000000999',
      status: 'active' as const,
      created_by: null,
      created_at: '2026-10-20T10:00:00.000Z',
      updated_at: '2026-10-20T10:00:00.000Z',
    }
    const back = valuesFromPromotion(stored)
    expect(back.end_date).toBe('2026-11-15')
    expect(back.percent_bp).toBe(1000)
    const patch = toPromotionUpdate({ ...back, percent_bp: 1500 }, stored)
    expect(patch).toMatchObject({
      kind: 'bill_percent',
      rules: { percent_bp: 1500 },
      if_updated_at: stored.updated_at,
    })
    expect(PromotionUpdateSchema.safeParse(patch).success).toBe(true)
  })

  it('maps targeting and missing amounts onto form fields', () => {
    const v = { ...defaultPromotionValues('item_percent'), name: 'x' }
    const paths = promotionFormIssues(v).map((i) => i.path)
    expect(paths).toContain('percent_bp')
    expect(promotionFormIssues({ ...v, percent_bp: 1000 })).toContainEqual({
      path: 'all_items',
      message: 'promotion_target',
    })
  })

  it('computes a worked example with the shared engine', () => {
    expect(
      promotionExample({
        ...defaultPromotionValues('item_percent'),
        percent_bp: 1000,
        all_items: true,
      }),
    ).toMatchObject({
      kind: 'items',
      units: 2,
      gross_paise: 20_000,
      discount_paise: 2_000,
      pays_paise: 18_000,
    })
    expect(
      promotionExample({
        ...defaultPromotionValues('bill_flat'),
        flat_paise: 5_000,
        min_bill_paise: 50_000,
      }),
    ).toMatchObject({ kind: 'bill', gross_paise: 100_000, discount_paise: 5_000 })
    expect(
      promotionExample({ ...defaultPromotionValues('buy_x_get_y'), all_items: true }),
    ).toMatchObject({ units: 3, discount_paise: 10_000 })
  })

  it('explains offers and schedules in Tamil and English', async () => {
    expect(promotionText({ kind: 'buy_x_get_y', rules: { buy_qty: 2, get_qty: 1 } })).toBe(
      'Buy 2 get 1 free',
    )
    expect(
      promotionText({ kind: 'bill_percent', rules: { percent_bp: 1000, min_bill_paise: 50_000 } }),
    ).toBe('10% off the bill (on bills of ₹500 or more)')
    expect(
      scheduleText({
        starts_at: '2026-10-31T18:30:00.000Z',
        ends_at: '2026-11-15T18:30:00.000Z',
        days_of_week: [6],
      }),
    ).toBe('01-11-2026 – 15-11-2026 · Sat')
    await setLanguage('ta', { persist: false })
    expect(promotionText({ kind: 'buy_x_get_y', rules: { buy_qty: 2, get_qty: 1 } })).toBe(
      '2 வாங்கினால் 1 இலவசம்',
    )
    await setLanguage('en', { persist: false })
  })
})

describe('variants model', () => {
  it('previews new vs existing combinations and builds the generate body', () => {
    const axes = [
      { name: 'size', values: ['M', 'L'] },
      { name: 'color', values: ['Red', 'Blue'] },
    ]
    const preview = previewCombinations(
      axes,
      ['size', 'color'],
      [{ variant_attributes: { size: 'm', color: 'red' } }],
    )
    expect(preview.cells).toHaveLength(4)
    expect(preview.newCount).toBe(3)
    const { body, error } = buildVariantGenerate({
      axes,
      priceAxis: 'size',
      prices: { L: 59_900, M: null },
      generateBarcodes: true,
    })
    expect(error).toBeNull()
    expect(body).toEqual({
      axes: { size: ['M', 'L'], color: ['Red', 'Blue'] },
      value_labels_ta: { color: { Red: 'சிவப்பு', Blue: 'நீலம்' } },
      price_overrides: [{ match: { size: 'L' }, sale_price_paise: 59_900 }],
      generate_barcodes: true,
    })
    expect(VariantGenerateSchema.safeParse(body).success).toBe(true)
  })

  it('adds a size to a saved size × colour parent with every existing colour', () => {
    const existing = [
      { variant_attributes: { size: 'S', color: 'White' } },
      { variant_attributes: { size: 'S', color: 'Sky Blue' } },
      { variant_attributes: { size: 'M', color: 'White' } },
    ]
    const axes = axesFromVariants(['size', 'color'], existing)
    expect(axes).toEqual([
      { name: 'size', values: ['S', 'M'] },
      { name: 'color', values: ['White', 'Sky Blue'] },
    ])
    const withNew = axes.map((a) =>
      a.name === 'size' ? { ...a, values: [...a.values, '3XL'] } : a,
    )
    const preview = previewCombinations(withNew, ['size', 'color'], existing)
    // M / Sky Blue was missing too; 3XL comes in both colours.
    expect(preview.newCount).toBe(3)
    const { body, error } = buildVariantGenerate({
      axes: withNew,
      priceAxis: 'size',
      prices: {},
      generateBarcodes: false,
    })
    expect(error).toBeNull()
    expect(body.axes).toEqual({ size: ['S', 'M', '3XL'], color: ['White', 'Sky Blue'] })
  })

  it('flags too many combinations', () => {
    const many = Array.from({ length: 30 }, (_, i) => `S${i}`)
    const p = previewCombinations(
      [
        { name: 'size', values: many },
        { name: 'color', values: many },
      ],
      [],
      [],
    )
    expect(p.tooMany).toBe(true)
  })
})

describe('tax rule editor model', () => {
  it('builds ascending slabs with an open last slab and checks them', () => {
    const draft = {
      name: 'Garments',
      description: '',
      is_active: true,
      slabs: [
        { max: 250_000, rate: 500 },
        { max: null, rate: 1800 },
      ],
    }
    expect(TaxSlabRuleCreateSchema.safeParse(ruleBody(draft)).success).toBe(true)
    expect(ruleIssues(draft)).toEqual({})
    expect(examplePrices(draft.slabs)).toEqual([240_000, 280_000])
    const bad = {
      ...draft,
      slabs: [
        { max: 250_000, rate: 500 },
        { max: 100_000, rate: 1200 },
        { max: null, rate: null },
      ],
    }
    const issues = ruleIssues(bad)
    expect(issues['slabs.2.gst_rate_bp']).toBe('slab_rate_required')
    expect(Object.values(issues)).toContain('slab_ascending')
  })
})

describe('store prices', () => {
  it('upserts edited prices and deletes cleared overrides', () => {
    const row = (product_id: string, store_sale_price_paise: number | null): StorePriceRow => ({
      store_id: '0192f0a0-0000-7000-8000-000000000301',
      product_id,
      sku: null,
      name: product_id,
      name_ta: null,
      unit: 'PCS',
      pack_size: 1,
      base_sale_price_paise: 10_000,
      base_mrp_paise: null,
      store_sale_price_paise,
      store_mrp_paise: null,
      updated_at: null,
    })
    const rows = [row('a', 1000), row('b', null)]
    const body = storePricesBody(
      '0192f0a0-0000-7000-8000-000000000301',
      { a: { sale: null, mrp: null }, b: { sale: 9_000, mrp: 9_500 } },
      rows,
    )
    expect(body).toEqual({
      store_id: '0192f0a0-0000-7000-8000-000000000301',
      upserts: [{ product_id: 'b', sale_price_paise: 9_000, mrp_paise: 9_500 }],
      deletes: ['a'],
    })
    expect(
      StorePricesUpdateSchema.safeParse({
        ...body,
        upserts: (body.upserts ?? []).map((u) => ({
          ...u,
          product_id: '0192f0a0-0000-7000-8000-000000000302',
        })),
        deletes: ['0192f0a0-0000-7000-8000-000000000303'],
      }).success,
    ).toBe(true)
  })
})

describe('labels', () => {
  const model: LabelPrintModel = {
    template: LABEL_TEMPLATES['38x25'],
    shop: { name: 'Sri Murugan Stores', name_ta: 'ஸ்ரீ முருகன் ஸ்டோர்ஸ்' },
    labels: [
      {
        product_id: 'p1',
        batch_id: null,
        sku: 'RICE-1',
        name: 'Ponni Rice <1 kg>',
        name_ta: 'பொன்னி அரிசி',
        price_paise: 6_800,
        mrp_paise: 7_200,
        barcode: '8901234567890',
        barcode_format: 'EAN13',
        barcode_generated: false,
        batch_no: 'B12',
        expiry_date: '2027-03-31',
        mfg_date: null,
        size: null,
        color: null,
        variant_label: null,
        unit: 'PCS',
        pack_size: 1,
        copies: 3,
      },
    ],
    total_copies: 3,
  }
  const opts = {
    showShop: true,
    showMrp: true,
    showPrice: true,
    nameMode: 'both' as const,
    words: { mrp: 'MRP', price: 'Our price', batch: 'B.No', expiry: 'Exp' },
  }

  it('renders one roll page per copy with exact mm geometry, escaped text and SVG barcodes', () => {
    const html = renderLabelsHtml(model, opts)
    expect(html.match(/class="sheet"/g)).toHaveLength(3)
    expect(html).toContain('Ponni Rice &lt;1 kg&gt;')
    expect(html).toContain('பொன்னி அரிசி')
    expect(html).toContain('B.No B12 · Exp 03/2027')
    // Labels print compact amounts: whole rupees without decimals, paise only when present.
    expect(html).toContain('MRP ₹72<')
    expect(html).toContain('Our price ₹68<')
    const paise = renderLabelsHtml(
      {
        ...model,
        labels: [{ ...model.labels[0]!, price_paise: 6_850, copies: 1 }],
        total_copies: 1,
      },
      opts,
    )
    expect(paise).toContain('Our price ₹68.50')
    expect(html).toContain('<svg')
    const css = labelCss(model)
    expect(css).toContain('@page { size: 38mm 25mm; margin: 0; }')
    expect(css).toContain('.label { width: 38mm; height: 25mm;')
    expect(sheetCount(model)).toBe(3)
  })

  it('lays out 65 labels per A4 sheet', () => {
    const a4 = {
      ...model,
      template: LABEL_TEMPLATES.a4_65,
      labels: [{ ...model.labels[0]!, copies: 70 }],
      total_copies: 70,
    }
    expect(renderLabelsHtml(a4, opts).match(/class="sheet"/g)).toHaveLength(2)
    expect(labelCss(a4)).toContain('grid-template-columns: repeat(5, 38.1mm)')
    expect(sheetCount(a4)).toBe(2)
  })

  it('falls back to CODE128 for codes without a valid check digit', () => {
    expect(barcodeSvg('ABC-123')).toContain('<svg')
    expect(barcodeSvg('8901234567890', 'EAN13')).toContain('<svg')
    expect(expiryText(null)).toBeNull()
  })
})

describe('catalog translations', () => {
  const both = async (check: () => void) => {
    check()
    await setLanguage('ta', { persist: false })
    check()
    await setLanguage('en', { persist: false })
  }

  it('has a text for every contract validation key, error reason and import error code', async () => {
    await both(() => {
      for (const key of CATALOG_VALIDATION_KEYS)
        expect(catalogValidationText(key), key).toBeTruthy()
      for (const reason of CATALOG_ERROR_REASONS)
        expect(i18next.exists(`catalog:error_reasons.${reason}`), reason).toBe(true)
      for (const code of PRODUCT_IMPORT_ERROR_CODES)
        expect(importErrorText(code, '__fallback__'), code).not.toBe('__fallback__')
    })
  })

  it('has labels for every vertical attribute field and option', () => {
    for (const fields of Object.values(ATTRIBUTE_FIELDS))
      for (const f of fields) {
        expect(i18next.exists(`catalog:attributes.${f.key}`), f.key).toBe(true)
        if (f.kind === 'enum')
          for (const o of f.options)
            expect(
              i18next.exists(`catalog:attributes.options.${f.key}.${o}`),
              `${f.key}.${o}`,
            ).toBe(true)
        if (f.kind === 'bool')
          expect(i18next.exists(`catalog:attributes.hints.${f.key}`), f.key).toBe(true)
      }
  })
})
