import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CHART,
  EXPENSE_ACCOUNT_PRESETS,
  EXPENSE_ACCOUNT_SUGGESTIONS,
  SYSTEM_ACCOUNT_SUBTYPES,
  isSystemAccountSubtype,
  naturalBalance,
  normalBalanceOf,
} from '../src/accounting'

describe('default chart of accounts (ARCHITECTURE §8.3)', () => {
  it('matches the documented codes and subtypes', () => {
    const bySubtype = Object.fromEntries(
      DEFAULT_CHART.filter((a) => a.subtype).map((a) => [a.subtype, a.code]),
    )
    expect(bySubtype).toEqual({
      cash: '1100',
      bank: '1200',
      upi_clearing: '1210',
      card_clearing: '1220',
      receivable: '1300',
      inventory: '1400',
      input_cgst: '1510',
      input_sgst: '1520',
      input_igst: '1530',
      input_cess: '1540',
      payable: '2100',
      output_cgst: '2210',
      output_sgst: '2220',
      output_igst: '2230',
      output_cess: '2240',
      customer_advance: '2300',
      capital: '3100',
      drawings: '3200',
      opening_balance: '3900',
      sales: '4100',
      sales_returns: '4200',
      other_income: '4300',
      round_off: '4400',
      discount_received: '4500',
      cogs: '5100',
      inventory_adjustment: '5200',
      inventory_writeoff: '5210',
      bank_charges: '5360',
      discount_allowed: '5400',
    })
  })
  it('every system subtype appears exactly once; codes are unique and well-formed', () => {
    for (const st of SYSTEM_ACCOUNT_SUBTYPES)
      expect(DEFAULT_CHART.filter((a) => a.subtype === st)).toHaveLength(1)
    const codes = DEFAULT_CHART.map((a) => a.code)
    expect(new Set(codes).size).toBe(codes.length)
    for (const code of codes) expect(code).toMatch(/^[0-9]{3,6}$/)
    expect([...codes].sort()).toEqual(codes)
  })
  it('types follow the code ranges', () => {
    const typeFor = (code: string) =>
      ({ '1': 'asset', '2': 'liability', '3': 'equity', '4': 'income', '5': 'expense' })[code[0]!]
    for (const a of DEFAULT_CHART) expect(a.type).toBe(typeFor(a.code))
  })
  it('has Tamil names', () => {
    for (const a of DEFAULT_CHART) expect(a.name_ta).toMatch(/[஀-௿]/)
    expect(DEFAULT_CHART.find((a) => a.subtype === 'cash')?.name_ta).toBe('கையிருப்பு ரொக்கம்')
  })
  it('seeds the expense heads 5300–5390', () => {
    expect(EXPENSE_ACCOUNT_PRESETS.map((a) => a.code)).toEqual([
      '5300',
      '5310',
      '5320',
      '5330',
      '5340',
      '5350',
      '5360',
      '5370',
      '5390',
    ])
    for (const e of EXPENSE_ACCOUNT_PRESETS) expect(DEFAULT_CHART).toContainEqual(e)
    for (const s of EXPENSE_ACCOUNT_SUGGESTIONS) expect(s.name_ta).toMatch(/[஀-௿]/)
  })
  it('balance helpers', () => {
    expect(normalBalanceOf('asset')).toBe('debit')
    expect(normalBalanceOf('expense')).toBe('debit')
    expect(normalBalanceOf('income')).toBe('credit')
    expect(normalBalanceOf('liability')).toBe('credit')
    expect(naturalBalance('asset', 500, 200)).toBe(300)
    expect(naturalBalance('income', 500, 200)).toBe(-300)
    expect(isSystemAccountSubtype('cash')).toBe(true)
    expect(isSystemAccountSubtype('rent')).toBe(false)
  })
})
