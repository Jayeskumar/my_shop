import { describe, expect, it } from 'vitest'
import {
  type PosTender,
  cashNeeded,
  cashTendered,
  remainingForNonCash,
  suggestNonCash,
  suggestTendered,
  summarizeTenders,
  toTenderInputs,
} from '../lib/tenders'

const cash = (amount: number): PosTender => ({ id: 'c', method: 'cash', amount_paise: amount })
const upi = (amount: number, extra: Partial<PosTender> = {}): PosTender => ({
  id: `u${amount}`,
  method: 'upi',
  amount_paise: amount,
  ...extra,
})

describe('tender maths', () => {
  it('cash over the bill gives change', () => {
    expect(summarizeTenders(79_100, [cash(100_000)])).toEqual({
      total_paise: 79_100,
      paid_paise: 79_100,
      change_paise: 20_900,
      due_paise: 0,
      issue: null,
    })
  })

  it('split: UPI first, the cash covers the rest', () => {
    const s = summarizeTenders(79_100, [upi(29_100), cash(50_000)])
    expect(s).toMatchObject({ paid_paise: 79_100, change_paise: 0, due_paise: 0, issue: null })
    expect(remainingForNonCash(79_100, [upi(29_100)])).toBe(50_000)
    expect(cashNeeded(79_100, [upi(29_100)])).toBe(50_000)
  })

  it('a short payment leaves a due (khata)', () => {
    expect(summarizeTenders(79_100, [cash(50_000)])).toMatchObject({
      paid_paise: 50_000,
      due_paise: 29_100,
    })
  })

  it('non-cash above what is left is rejected, cash that is not needed is flagged', () => {
    expect(summarizeTenders(79_100, [upi(80_000)]).issue?.code).toBe('tender_exceeds_due')
    expect(summarizeTenders(79_100, [upi(79_100), cash(1_000)]).issue?.code).toBe(
      'cash_tender_not_needed',
    )
  })

  it('suggests the remainder after cash for UPI / card, or the whole bill when cash already covers it', () => {
    expect(suggestNonCash(79_100, [], 50_000)).toBe(29_100)
    expect(suggestNonCash(79_100, [], 100_000)).toBe(79_100)
    expect(suggestNonCash(79_100, [], 0)).toBe(79_100)
    expect(suggestNonCash(79_100, [upi(9_100)], 50_000)).toBe(20_000)
  })

  it('suggests the notes a customer is likely to hand over', () => {
    expect(suggestTendered(34_700)).toEqual([35_000, 40_000, 50_000, 100_000])
    expect(suggestTendered(50_000)).toEqual([100_000, 150_000])
    expect(suggestTendered(79_100)).toEqual([80_000, 100_000, 150_000])
    expect(suggestTendered(0)).toEqual([])
  })

  it('request tenders drop empty rows and carry intent / provider / reference', () => {
    expect(
      toTenderInputs([
        cash(0),
        cash(10_000),
        upi(5_000, { payment_intent_id: 'pi', reference: '123456789012' }),
        upi(1_000, { provider_account_id: 'acc' }),
      ]),
    ).toEqual([
      { method: 'cash', amount_paise: 10_000 },
      { method: 'upi', amount_paise: 5_000, payment_intent_id: 'pi', reference: '123456789012' },
      { method: 'upi', amount_paise: 1_000, provider_account_id: 'acc' },
    ])
    expect(cashTendered([cash(10_000), upi(5_000), cash(2_000)])).toBe(12_000)
  })
})
