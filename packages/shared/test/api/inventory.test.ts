import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  ADJUSTMENT_MOVEMENT_TYPE,
  AdjustmentCreateSchema,
  AdjustmentListQuerySchema,
  AdjustmentUpdateSchema,
  BatchListQuerySchema,
  BatchRowSchema,
  BatchUpdateSchema,
  MOVEMENT_DIRECTION,
  MovementListQuerySchema,
  MovementRowSchema,
  OpeningStockResultSchema,
  OpeningStockSchema,
  ProductStockSchema,
  StockAdjustmentDetailSchema,
  StockAlertsSchema,
  StockListQuerySchema,
  StockListResponseSchema,
  StockTransferDetailSchema,
  TransferCreateSchema,
  TransferReceiveSchema,
  TransferUpdateSchema,
  adjustmentKindOfMovement,
  adjustmentLineIssues,
  adjustmentPrefillPath,
  adjustmentValueSummary,
  BATCH_EXPIRY_TABS,
  batchExpiryTabDays,
  batchExpiryTabFor,
  batchesPagePath,
  expiryStatus,
  inventoryRoutes,
  parseInventoryPrefill,
  purchaseReturnPrefillPath,
  qtyAllowed,
  reorderPrefillPath,
  stockPagePath,
  stockStatus,
  stockTakeDelta,
  stockValuePaise,
  transferPrefillPath,
  transferShortfall,
} from '../../src/api/inventory'
import { StockMovementTypeSchema } from '../../src/enums'
import { newId } from '../../src/ids'

const ok = (schema: z.ZodType, v: unknown) => schema.safeParse(v).success
const messages = (schema: z.ZodType, v: unknown) => {
  const r = schema.safeParse(v)
  return r.success ? [] : r.error.issues.map((i) => i.message)
}
const now = '2026-10-20T10:15:00.000Z'

describe('pure helpers', () => {
  it('stock status', () => {
    expect(stockStatus(-1000, null)).toBe('negative')
    expect(stockStatus(0, 5000)).toBe('out')
    expect(stockStatus(5000, 5000)).toBe('low')
    expect(stockStatus(5001, 5000)).toBe('ok')
    expect(stockStatus(1, null)).toBe('ok')
  })
  it('expiry status: sellable on the expiry date, warning window', () => {
    expect(expiryStatus(null, '2026-10-20', 90)).toEqual({ status: 'none', days_to_expiry: null })
    expect(expiryStatus('2026-10-19', '2026-10-20', 90)).toEqual({
      status: 'expired',
      days_to_expiry: -1,
    })
    expect(expiryStatus('2026-10-20', '2026-10-20', 90)).toEqual({
      status: 'expiring',
      days_to_expiry: 0,
    })
    expect(expiryStatus('2027-01-18', '2026-10-20', 90)).toEqual({
      status: 'expiring',
      days_to_expiry: 90,
    })
    expect(expiryStatus('2027-01-19', '2026-10-20', 90)).toEqual({
      status: 'ok',
      days_to_expiry: 91,
    })
  })
  it('stock value at per-pack cost, signed', () => {
    expect(stockValuePaise(3500, 23_000, 10)).toBe(8050)
    expect(stockValuePaise(3500, -3000, 10)).toBe(-1050)
    expect(stockValuePaise(4567, 1500)).toBe(6851)
  })
  it('movement directions mirror every movement type', () => {
    expect(Object.keys(MOVEMENT_DIRECTION).sort()).toEqual(
      [...StockMovementTypeSchema.options].sort(),
    )
    expect(ADJUSTMENT_MOVEMENT_TYPE.expiry_writeoff).toBe('expiry_writeoff')
    expect(adjustmentKindOfMovement('stock_take')).toBe('stock_take')
    expect(adjustmentKindOfMovement('sale')).toBeNull()
  })
  it('stock take delta and value summary per kind', () => {
    expect(stockTakeDelta(10_000, 7_000)).toBe(-3_000)
    const lines = [
      { qty_delta_milli: -3000, unit_cost_paise: 3500, pack_size: 10 },
      { qty_delta_milli: 2000, unit_cost_paise: 1000, pack_size: 1 },
    ]
    expect(adjustmentValueSummary('stock_take', lines)).toEqual({
      gain_paise: 2000,
      loss_paise: 1050,
      net_paise: 950,
      loss_account: 'inventory_adjustment',
    })
    expect(adjustmentValueSummary('expiry_writeoff', [lines[0]!]).loss_account).toBe(
      'inventory_writeoff',
    )
  })
  it('transfer shortfall', () => {
    expect(transferShortfall(5000, null)).toBe(0)
    expect(transferShortfall(5000, 4000)).toBe(1000)
    expect(transferShortfall(5000, 6000)).toBe(0)
  })
})

describe('stock & movements', () => {
  it('list query coerces filters and scopes', () => {
    expect(
      StockListQuerySchema.parse({ store_id: 'all', low_stock: 'yes', sort: '-value' }),
    ).toMatchObject({
      store_id: 'all',
      low_stock: true,
      group: 'product',
      format: 'json',
      include_inactive: false,
      sort: { field: 'value', direction: 'desc' },
    })
    expect(ok(StockListQuerySchema, { store_id: 'some' })).toBe(false)
    expect(MovementListQuerySchema.parse({ type: 'sale' }).type).toEqual(['sale'])
    expect(MovementListQuerySchema.parse({ type: ['sale', 'sale_return'] }).type).toEqual([
      'sale',
      'sale_return',
    ])
    expect(messages(MovementListQuerySchema, { from: '2026-10-05', to: '2026-10-01' })).toEqual([
      'date_order',
    ])
  })
  const movement = {
    id: newId(),
    created_at: new Date(now),
    store_id: newId(),
    store_code: 'S1',
    product_id: newId(),
    product_name: 'Paracetamol 500',
    product_name_ta: null,
    sku: 'PCM500',
    unit: 'TAB',
    pack_size: 10,
    batch_id: newId(),
    batch_no: 'B2611',
    movement_type: 'sale',
    qty_milli: -3000,
    unit_cost_paise: 3500,
    value_paise: -1050,
    balance_after_milli: 20_000,
    ref_type: 'sales_invoice',
    ref_id: newId(),
    ref_line_id: newId(),
    ref_number: 'S1-A/2627/00042',
    reason: null,
    created_by: null,
    user_name: 'Selvi',
  }
  it('stock list response carries totals', () => {
    const res = StockListResponseSchema.parse({
      data: [
        {
          store_id: movement.store_id,
          product_id: movement.product_id,
          sku: 'PCM500',
          name: 'Paracetamol 500',
          name_ta: null,
          unit: 'TAB',
          pack_size: 10,
          allow_loose: true,
          track_batches: true,
          category_id: null,
          category_name: null,
          brand_name: null,
          batch_id: null,
          batch_no: null,
          expiry_date: null,
          qty_milli: 23_000,
          avg_cost_paise: 3500,
          value_cost_paise: 8050,
          mrp_paise: 4500,
          value_mrp_paise: 10_350,
          sale_price_paise: 4200,
          reorder_level_milli: 50_000,
          reorder_qty_milli: 100_000,
          status: 'low',
          batch_count: 2,
          nearest_expiry: '2027-03-31',
          last_movement_at: now,
        },
      ],
      page: { limit: 50, offset: 0, total: 1 },
      totals: {
        item_count: 1,
        value_cost_paise: 8050,
        value_mrp_paise: 10_350,
        low_stock_count: 1,
        out_of_stock_count: 0,
        negative_count: 0,
      },
    })
    expect(res.totals.value_cost_paise).toBe(8050)
  })
  it('movement row and product stock', () => {
    expect(MovementRowSchema.parse(movement).created_at).toBe(now)
    const ps = ProductStockSchema.parse({
      product: {
        id: movement.product_id,
        sku: 'PCM500',
        name: 'Paracetamol 500',
        name_ta: null,
        unit: 'TAB',
        pack_size: 10,
        allow_loose: true,
        track_inventory: true,
        track_batches: true,
        reorder_level_milli: null,
        reorder_qty_milli: null,
        mrp_paise: 4500,
        sale_price_paise: 4200,
        purchase_price_paise: 3500,
      },
      stores: [
        {
          store_id: movement.store_id,
          store_code: 'S1',
          store_name: 'Main',
          qty_milli: 20_000,
          avg_cost_paise: 3500,
          value_cost_paise: 7000,
          status: 'ok',
          batches: [
            {
              batch_id: movement.batch_id,
              batch_no: 'B2611',
              expiry_date: '2027-11-30',
              mfg_date: null,
              mrp_paise: 4500,
              sale_price_paise: null,
              qty_milli: 20_000,
              avg_cost_paise: 3500,
              value_cost_paise: 7000,
              expiry_status: 'ok',
              days_to_expiry: 406,
            },
          ],
        },
      ],
      total_qty_milli: 20_000,
      total_value_cost_paise: 7000,
      recent_movements: [movement],
    })
    expect(ps.recent_movements).toHaveLength(1)
  })
})

describe('batches', () => {
  it('query and patch', () => {
    expect(BatchListQuerySchema.parse({ expiring_within_days: '30' })).toMatchObject({
      expiring_within_days: 30,
      with_stock_only: false,
      sort: { field: 'expiry_date', direction: 'asc' },
    })
    expect(ok(BatchListQuerySchema, { expiring_within_days: '1000' })).toBe(false)
    expect(BatchUpdateSchema.parse({ mrp_paise: 4800 })).toEqual({ mrp_paise: 4800 })
    expect(
      messages(BatchUpdateSchema, { mfg_date: '2027-01-01', expiry_date: '2026-01-01' }),
    ).toEqual(['batch_dates'])
    expect(messages(BatchUpdateSchema, {})).toEqual(['empty_patch'])
  })
  it('batch row', () => {
    expect(
      BatchRowSchema.parse({
        id: newId(),
        product_id: newId(),
        product_name: 'Amoxicillin 500',
        product_name_ta: null,
        sku: null,
        unit: 'CAP',
        pack_size: 10,
        batch_no: 'AMX-01',
        mfg_date: '2025-11-01',
        expiry_date: '2026-11-10',
        mrp_paise: 9_000,
        purchase_price_paise: 6_000,
        sale_price_paise: null,
        supplier_id: null,
        supplier_name: null,
        is_active: true,
        qty_milli: 40_000,
        value_cost_paise: 24_000,
        expiry_status: 'expiring',
        days_to_expiry: 21,
        created_at: now,
        updated_at: now,
      }).days_to_expiry,
    ).toBe(21)
  })
})

describe('adjustments', () => {
  const store_id = newId()
  const p1 = newId()
  const p2 = newId()
  it('line rules per kind', () => {
    expect(adjustmentLineIssues('stock_take', [{ product_id: p1, batch_id: null }])).toEqual([
      { path: ['lines', 0, 'counted_qty_milli'], code: 'counted_qty_required' },
    ])
    expect(
      adjustmentLineIssues('damage', [{ product_id: p1, batch_id: null, qty_delta_milli: 1000 }])[0]
        ?.code,
    ).toBe('loss_must_be_negative')
    expect(
      adjustmentLineIssues('adjustment', [
        { product_id: p1, batch_id: null, qty_delta_milli: 0 },
      ])[0]?.code,
    ).toBe('qty_delta_zero')
    expect(
      adjustmentLineIssues('adjustment', [
        { product_id: p1, batch_id: null, qty_delta_milli: 1000 },
        { product_id: p1, batch_id: null, qty_delta_milli: -1000 },
      ])[0]?.code,
    ).toBe('duplicate_line')
  })
  it('create / update drafts', () => {
    expect(AdjustmentCreateSchema.parse({ store_id })).toMatchObject({
      kind: 'adjustment',
      lines: [],
    })
    expect(
      AdjustmentCreateSchema.parse({
        store_id,
        kind: 'stock_take',
        lines: [
          { product_id: p1, counted_qty_milli: 7000, reason: 'count_correction' },
          { product_id: p2, batch_id: newId(), counted_qty_milli: 0 },
        ],
      }).lines[0],
    ).toMatchObject({ batch_id: null, counted_qty_milli: 7000 })
    expect(
      messages(AdjustmentCreateSchema, {
        store_id,
        kind: 'expiry_writeoff',
        lines: [{ product_id: p1 }],
      }),
    ).toEqual(['qty_delta_required'])
    expect(ok(AdjustmentCreateSchema, { store_id, kind: 'opening' })).toBe(false)
    expect(AdjustmentUpdateSchema.parse({ notes: 'Shelf 3' })).toEqual({ notes: 'Shelf 3' })
    expect(
      messages(AdjustmentUpdateSchema, {
        kind: 'damage',
        lines: [{ product_id: p1, qty_delta_milli: 5 }],
      }),
    ).toEqual(['loss_must_be_negative'])
    expect(AdjustmentListQuerySchema.parse({}).sort).toEqual({
      field: 'adjustment_date',
      direction: 'desc',
    })
  })
  it('detail response', () => {
    const d = StockAdjustmentDetailSchema.parse({
      id: newId(),
      number: 'ADJS1/2627/00001',
      fy: '2026-27',
      store_id,
      store_code: 'S1',
      store_name: 'Main',
      adjustment_date: '2026-10-20',
      kind: 'stock_take',
      status: 'posted',
      notes: null,
      total_value_paise: -1050,
      line_count: 1,
      posted_at: now,
      posted_by: newId(),
      posted_by_name: 'Owner',
      created_by: null,
      created_by_name: null,
      created_at: now,
      updated_at: now,
      lines: [
        {
          id: newId(),
          line_no: 1,
          product_id: p1,
          product_name: 'Paracetamol 500',
          product_name_ta: null,
          sku: null,
          unit: 'TAB',
          pack_size: 10,
          track_batches: false,
          batch_id: null,
          batch_no: null,
          expiry_date: null,
          system_qty_milli: 10_000,
          counted_qty_milli: 7_000,
          qty_delta_milli: -3_000,
          unit_cost_paise: 3500,
          value_paise: -1050,
          reason: null,
          current_qty_milli: null,
        },
      ],
      gain_value_paise: 0,
      loss_value_paise: 1050,
      movements: [],
      journal_entry_id: newId(),
      cancelled_at: null,
      cancelled_by_name: null,
      cancel_reason: null,
    })
    expect(d.lines[0]!.qty_delta_milli).toBe(stockTakeDelta(10_000, 7_000))
  })
})

describe('opening stock', () => {
  const store_id = newId()
  const p1 = newId()
  it('lines with batches; duplicates and ambiguity rejected', () => {
    const parsed = OpeningStockSchema.parse({
      store_id,
      lines: [
        {
          product_id: p1,
          qty_milli: 20_000,
          unit_cost_paise: 3500,
          batch: { batch_no: 'b1', expiry_date: '2027-06-30' },
        },
        { product_id: p1, qty_milli: 10_000, unit_cost_paise: 3500, batch: { batch_no: 'B2' } },
      ],
    })
    expect(parsed).toMatchObject({ force: false })
    expect(parsed.lines[1]!.batch).toEqual({
      batch_no: 'B2',
      expiry_date: null,
      mfg_date: null,
      mrp_paise: null,
      sale_price_paise: null,
    })
    expect(
      messages(OpeningStockSchema, {
        store_id,
        lines: [
          { product_id: p1, qty_milli: 1000, unit_cost_paise: 1, batch: { batch_no: 'b1' } },
          { product_id: p1, qty_milli: 1000, unit_cost_paise: 1, batch: { batch_no: 'B1' } },
        ],
      }),
    ).toEqual(['duplicate_line'])
    expect(
      messages(OpeningStockSchema, {
        store_id,
        lines: [
          {
            product_id: p1,
            qty_milli: 1000,
            unit_cost_paise: 1,
            batch_id: newId(),
            batch: { batch_no: 'x' },
          },
        ],
      }),
    ).toEqual(['batch_ambiguous'])
    expect(ok(OpeningStockSchema, { store_id, lines: [] })).toBe(false)
    expect(
      ok(OpeningStockSchema, {
        store_id,
        lines: [{ product_id: p1, qty_milli: 0, unit_cost_paise: 1 }],
      }),
    ).toBe(false)
  })
  it('result schema', () => {
    expect(OpeningStockResultSchema.shape.batches_created).toBeDefined()
  })
})

describe('transfers', () => {
  const a = newId()
  const b = newId()
  const p = newId()
  it('create / update / receive bodies', () => {
    expect(
      TransferCreateSchema.parse({
        from_store_id: a,
        to_store_id: b,
        lines: [{ product_id: p, qty_milli: 5000 }],
      }).lines[0],
    ).toEqual({
      product_id: p,
      batch_id: null,
      qty_milli: 5000,
    })
    expect(
      messages(TransferCreateSchema, {
        from_store_id: a,
        to_store_id: a,
        lines: [{ product_id: p, qty_milli: 1 }],
      }),
    ).toEqual(['transfer_same_store'])
    expect(
      messages(TransferCreateSchema, {
        from_store_id: a,
        to_store_id: b,
        lines: [
          { product_id: p, qty_milli: 1 },
          { product_id: p, qty_milli: 2 },
        ],
      }),
    ).toEqual(['duplicate_line'])
    expect(messages(TransferUpdateSchema, {})).toEqual(['empty_patch'])
    expect(TransferReceiveSchema.parse({})).toEqual({})
    expect(
      ok(TransferReceiveSchema, { lines: [{ line_id: newId(), received_qty_milli: -1 }] }),
    ).toBe(false)
    expect(inventoryRoutes.receiveTransfer.body.safeParse(undefined).success).toBe(true)
  })
  it('detail with timeline', () => {
    const t = StockTransferDetailSchema.parse({
      id: newId(),
      number: 'TRS1/2627/00003',
      fy: '2026-27',
      from_store_id: a,
      from_store_code: 'S1',
      from_store_name: 'Main',
      to_store_id: b,
      to_store_code: 'S2',
      to_store_name: 'Branch',
      transfer_date: '2026-10-20',
      status: 'received',
      notes: null,
      line_count: 1,
      total_value_paise: 17_500,
      shortfall_value_paise: 3_500,
      dispatched_at: now,
      dispatched_by_name: 'Owner',
      received_at: now,
      received_by_name: 'Manager',
      created_by_name: 'Owner',
      created_at: now,
      updated_at: now,
      lines: [
        {
          id: newId(),
          line_no: 1,
          product_id: p,
          product_name: 'Ponni Rice 25 kg',
          product_name_ta: null,
          sku: null,
          unit: 'BAG',
          pack_size: 1,
          track_batches: false,
          batch_id: null,
          batch_no: null,
          expiry_date: null,
          qty_milli: 5000,
          received_qty_milli: 4000,
          shortfall_qty_milli: transferShortfall(5000, 4000),
          unit_cost_paise: 3500,
          value_paise: 17_500,
          available_qty_milli: null,
        },
      ],
      timeline: [
        { event: 'created', at: now, user_id: null, user_name: 'Owner', note: null },
        { event: 'dispatched', at: now, user_id: null, user_name: 'Owner', note: null },
        { event: 'received', at: now, user_id: null, user_name: 'Manager', note: '1 bag torn' },
      ],
    })
    expect(t.lines[0]!.shortfall_qty_milli).toBe(1000)
  })
})

describe('alerts & navigation', () => {
  it('alerts payload', () => {
    expect(
      StockAlertsSchema.parse({
        store_id: null,
        as_of: '2026-10-20',
        expiry_warning_days: 90,
        counts: { low_stock: 3, out_of_stock: 1, negative: 0, expiring: 2, expired: 1 },
        low_stock: [],
        out_of_stock: [],
        expiring: [
          {
            store_id: null,
            batch_id: newId(),
            batch_no: 'X1',
            product_id: newId(),
            name: 'Cough syrup',
            name_ta: null,
            unit: 'BTL',
            pack_size: 1,
            expiry_date: '2026-11-01',
            days_to_expiry: 12,
            qty_milli: 6000,
            value_cost_paise: 30_000,
          },
        ],
        expired: [],
        expiring_value_paise: 30_000,
        expired_value_paise: 0,
      }).counts.expiring,
    ).toBe(2)
  })
  it('prefill paths round-trip through the parser', () => {
    const store = newId()
    const supplier = newId()
    const batches = [newId(), newId()]
    const path = purchaseReturnPrefillPath({
      batch_ids: batches,
      store_id: store,
      supplier_id: supplier,
    })
    expect(path.startsWith('/purchases/returns/new?')).toBe(true)
    const parsed = parseInventoryPrefill(path.slice(path.indexOf('?')))
    expect(parsed).toMatchObject({
      store_id: store,
      supplier_id: supplier,
      batch_ids: batches,
      kind: null,
    })
    const adj = adjustmentPrefillPath({ kind: 'expiry_writeoff', batch_ids: [batches[0]!] })
    expect(parseInventoryPrefill(adj.split('?')[1]!)).toMatchObject({
      kind: 'expiry_writeoff',
      batch_ids: [batches[0]],
    })
    expect(reorderPrefillPath()).toBe('/purchases/orders/new?source=reorder')
    expect(transferPrefillPath({})).toBe('/inventory/transfers/new')
    expect(
      parseInventoryPrefill('?batch_ids=nope,' + batches[1] + '&kind=bogus&store_id=x'),
    ).toMatchObject({
      batch_ids: [batches[1]],
      kind: null,
      store_id: null,
    })
  })
  it('page links match the stock and batches pages URL state', () => {
    const store = newId()
    expect(stockPagePath()).toBe('/inventory/stock')
    expect(stockPagePath({ store_id: store, filter: 'low' })).toBe(
      `/inventory/stock?store=${store}&filter=low`,
    )
    expect(batchesPagePath({ store_id: store, tab: 'expired' })).toBe(
      `/inventory/batches?store=${store}&tab=expired`,
    )
    expect(batchesPagePath({ tab: batchExpiryTabFor(45) })).toBe('/inventory/batches?tab=d60')
    expect([7, 30, 31, 60, 90, 91, 365].map(batchExpiryTabFor)).toEqual([
      'd30',
      'd30',
      'd60',
      'd60',
      'd90',
      'all',
      'all',
    ])
    expect(BATCH_EXPIRY_TABS.map(batchExpiryTabDays)).toEqual([null, 30, 60, 90, null])
  })
  it('quantities must be whole units unless the product is measured in decimals', () => {
    expect(qtyAllowed({ unit: 'PCS' }, 3000)).toBe(true)
    expect(qtyAllowed({ unit: 'PCS' }, 1500)).toBe(false)
    expect(qtyAllowed({ unit: 'TAB', decimal_qty: false }, -2000)).toBe(true)
    expect(qtyAllowed({ unit: 'KG' }, 1250)).toBe(true)
    expect(qtyAllowed({ unit: 'PCS', decimal_qty: true }, 1250)).toBe(true)
  })
  it('route catalogue', () => {
    for (const [name, def] of Object.entries(inventoryRoutes)) {
      expect(def.path.startsWith('/'), name).toBe(true)
      if (def.method === 'GET') expect('body' in def, name).toBe(false)
    }
    expect(inventoryRoutes.createTransfer.feature).toBe('stock_transfers')
    expect(inventoryRoutes.updateBatch.permission).toEqual(['inventory.adjust', 'catalog.write'])
    expect(inventoryRoutes.postOpeningStock.idempotent).toBe(true)
  })
})
