import { describe, expect, it } from 'vitest'
import { LINE_ATTA, LINE_DAL, returnable } from '../testing/fixtures'
import {
  defaultSettlement,
  previewReturn,
  returnLineAmounts,
  settlementOptionsFor,
} from './returns'

describe('return preview (same maths as the server)', () => {
  it('pro-rates a partial line and rounds the note to the rupee', () => {
    const data = returnable()
    const preview = previewReturn(data, { [LINE_ATTA]: 1000 }, 'nearest_rupee')
    expect(preview.lines).toEqual([
      {
        invoice_line_id: LINE_ATTA,
        qty_milli: 1000,
        taxable_paise: 27_143,
        cgst_paise: 679,
        sgst_paise: 679,
        igst_paise: 0,
        cess_paise: 0,
        total_paise: 28_501,
      },
    ])
    expect(preview.round_off_paise).toBe(-1)
    expect(preview.total_paise).toBe(28_500)
    expect(preview.full_return).toBe(false)
  })

  it('keeps paise when the shop does not round off', () => {
    const preview = previewReturn(returnable(), { [LINE_ATTA]: 1000 }, 'none')
    expect(preview.total_paise).toBe(28_501)
    expect(preview.round_off_paise).toBe(0)
  })

  it('a full return gives back exactly the bill total', () => {
    const preview = previewReturn(
      returnable(),
      { [LINE_ATTA]: 2000, [LINE_DAL]: 1500 },
      'nearest_rupee',
    )
    expect(preview.full_return).toBe(true)
    expect(preview.total_paise).toBe(81_000)
    expect(preview.taxable_paise + preview.tax_paise).toBe(81_000)
  })

  it('ignores zero and over-the-limit quantities', () => {
    const data = returnable()
    expect(returnLineAmounts(data.lines[0]!, 0)).toBeNull()
    expect(returnLineAmounts(data.lines[0]!, 3000)).toBeNull()
    expect(previewReturn(data, { [LINE_ATTA]: null }, 'nearest_rupee').total_paise).toBe(0)
  })
})

describe('settlement choices', () => {
  it('offers refunds up to what was paid, the due adjustment and store credit', () => {
    const options = settlementOptionsFor(returnable(), 28_500)
    expect(options).toEqual(['cash', 'upi', 'bank_transfer', 'adjust_due', 'store_credit'])
    expect(defaultSettlement(options)).toBe('adjust_due')
  })

  it('no refund above the paid amount', () => {
    const options = settlementOptionsFor(returnable(), 60_000)
    expect(options).toEqual(['adjust_due', 'store_credit'])
  })

  it('a paid walk-in bill can only be refunded', () => {
    const data = returnable({
      customer_id: null,
      customer_name: null,
      due_paise: 0,
      paid_paise: 81_000,
    })
    const options = settlementOptionsFor({ ...data, refundable_paise: 81_000 }, 28_500)
    expect(options).toEqual(['cash', 'upi', 'bank_transfer'])
    expect(defaultSettlement(options)).toBe('cash')
  })
})
