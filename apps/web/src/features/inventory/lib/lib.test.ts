import { AdjustmentCreateSchema } from '@kadai/shared/api/inventory'
import { describe, expect, it } from 'vitest'
import * as F from '../testing/fixtures'
import {
  type AdjLine,
  editorIssues,
  estimateSummary,
  lineDelta,
  linesForKind,
  linesPayload,
  uncountedLines,
} from './adjustment-form'
import { reasonLabel, reasonsForKind } from './labels'
import { fromListItem } from './lines'
import { parseExpiryText, parseOpeningPaste } from './opening-paste'
import { buildTransferNote, type TransferNoteLabels } from './print-transfer'

const rice = fromListItem(F.catalog()[0]!)
const para = fromListItem(F.catalog()[2]!)

function line(over: Partial<AdjLine> = {}): AdjLine {
  return {
    key: `k${Math.random()}`,
    product: rice,
    batch: null,
    direction: 1,
    qty_milli: null,
    counted_milli: null,
    system_milli: 18_000,
    unit_cost_paise: null,
    reason: null,
    ...over,
  }
}

describe('opening stock paste', () => {
  it('reads tab separated rows in the default column order', () => {
    const { rows, issues } = parseOpeningPaste(
      '8901234500017\t18\t1,380\n8901234500031\t235\t22\tpcm2408\t11/26\t35\n',
    )
    expect(issues).toEqual([])
    expect(rows).toEqual([
      {
        line: 1,
        code: '8901234500017',
        qty: '18',
        cost_paise: 138_000,
        batch_no: null,
        expiry_date: null,
        mrp_paise: null,
      },
      {
        line: 2,
        code: '8901234500031',
        qty: '235',
        cost_paise: 2_200,
        batch_no: 'pcm2408',
        expiry_date: '2026-11-30',
        mrp_paise: 3_500,
      },
    ])
  })

  it('maps named columns from a header row (English or Tamil) and reports bad cells', () => {
    const { rows, issues } = parseOpeningPaste(
      'Qty,Barcode,MRP,காலாவதி\n5,RICE-25,abc,31-12-2026\n,OIL-1L,,\n3,,,',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ line: 2, code: 'RICE-25', qty: '5', expiry_date: '2026-12-31' })
    expect(issues).toEqual([
      { line: 2, code: 'bad_mrp', value: 'abc' },
      { line: 3, code: 'missing_qty', value: 'OIL-1L' },
      { line: 4, code: 'missing_code' },
    ])
  })

  it('understands the expiry formats printed on packs', () => {
    expect(parseExpiryText('2027-03-31')).toBe('2027-03-31')
    expect(parseExpiryText('05-11-2026')).toBe('2026-11-05')
    expect(parseExpiryText('02/28')).toBe('2028-02-29')
    expect(parseExpiryText('13/26')).toBeNull()
  })
})

describe('adjustment editor rules', () => {
  it('builds the contract lines per kind', () => {
    const lines = [
      line({ qty_milli: 2_000, direction: -1, reason: 'damaged' }),
      line({
        product: para,
        batch: { id: F.B.para1, batch_no: 'PCM2408', expiry_date: null },
        qty_milli: 5_000,
        unit_cost_paise: 2_000,
      }),
    ]
    const adj = linesPayload('adjustment', lines)
    expect(adj).toEqual([
      { product_id: F.P.rice, batch_id: null, reason: 'damaged', qty_delta_milli: -2_000 },
      {
        product_id: F.P.paracetamol,
        batch_id: F.B.para1,
        reason: null,
        qty_delta_milli: 5_000,
        unit_cost_paise: 2_000,
      },
    ])
    // Write-offs are always losses, whatever the toggle says; no gain cost is sent.
    const damage = linesPayload('damage', linesForKind('damage', lines))
    expect(damage.map((l) => l.qty_delta_milli)).toEqual([-2_000, -5_000])
    expect(damage[1]).not.toHaveProperty('unit_cost_paise')
    expect(
      AdjustmentCreateSchema.safeParse({ store_id: F.STORE_ID, kind: 'damage', lines: damage })
        .success,
    ).toBe(true)
  })

  it('sends counted quantities for a stock take and leaves uncounted lines out', () => {
    const lines = [line({ counted_milli: 16_000 }), line({ product: { ...rice, id: F.P.oil } })]
    expect(linesPayload('stock_take', lines)).toEqual([
      { product_id: F.P.rice, batch_id: null, reason: null, counted_qty_milli: 16_000 },
    ])
    expect(uncountedLines('stock_take', lines)).toHaveLength(1)
    expect(lineDelta('stock_take', lines[0]!)).toBe(-2_000)
    // 2 bags short at ₹1,380 each.
    expect(estimateSummary('stock_take', lines)).toMatchObject({
      gain_paise: 0,
      loss_paise: 276_000,
      net_paise: -276_000,
      loss_account: 'inventory_adjustment',
    })
  })

  it('flags missing batches, quantities and duplicate lines', () => {
    const a = line({ product: para })
    const b = line({ qty_milli: 1_000 })
    const c = line({ qty_milli: 3_000 })
    const issues = editorIssues('adjustment', [a, b, c])
    expect(issues[a.key]).toEqual({ batch: 'batch_required', qty: 'required' })
    expect(issues[b.key]).toBeUndefined()
    expect(issues[c.key]).toEqual({ product: 'duplicate_line' })
    expect(estimateSummary('expiry_writeoff', [b]).loss_account).toBe('inventory_writeoff')
  })

  it('offers the reasons of each kind with bilingual labels', () => {
    expect(reasonsForKind('expiry_writeoff')).toEqual(['expired', 'other'])
    expect(reasonLabel('damaged', 'ta')).toBe('சேதமடைந்தது')
    expect(reasonLabel('Rat bite', 'en')).toBe('Rat bite')
  })
})

describe('transfer note', () => {
  const labels = Object.fromEntries(
    [
      'title',
      'number',
      'date',
      'status',
      'from',
      'to',
      'sno',
      'product',
      'batch',
      'expiry',
      'qty',
      'received',
      'rate',
      'value',
      'total',
      'shortfall',
      'notes',
      'dispatched_by',
      'received_by',
      'not_invoice',
      'draft',
    ].map((k) => [k, `L:${k}`]),
  ) as unknown as TransferNoteLabels

  it('prints both stores, the lines with packs and the total, escaping text', () => {
    const doc = F.transferDetail({ notes: '<b>Rush</b> & fragile' })
    const html = buildTransferNote(
      doc,
      {
        from: { code: 'S1', name: 'Main store', gstin: '33AAAPL1234C1ZV' },
        to: { code: 'S2', name: 'Anna Nagar' },
      },
      labels,
      'en',
      'Dispatched',
    )
    expect(html).toContain('TRS1/2627/00003')
    expect(html).toContain('GSTIN: 33AAAPL1234C1ZV')
    expect(html).toContain('Ponni Rice 25 kg')
    expect(html).toContain('பொன்னி அரிசி 25 கிலோ')
    expect(html).toContain('₹15,360.00')
    expect(html).toContain('&lt;b&gt;Rush&lt;/b&gt; &amp; fragile')
    expect(html).not.toContain('<b>Rush')
    // Received column only once the transfer is received.
    expect(html).not.toContain('L:received<')
  })
})
