import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@/lib/i18n'
import {
  formatMoneyInputValue,
  formatScaled,
  moneyEditingText,
  parseMoneyText,
  parseQtyText,
  parseScaled,
} from './input-parsing'
import { MoneyInput } from './money-input'
import { NumberInput } from './number-input'
import { QtyInput } from './qty-input'

describe('input parsing helpers', () => {
  it('parses rupees to integer paise, ignoring grouping typed mid-way', () => {
    expect(parseMoneyText('1,234.5')).toBe(123450)
    expect(parseMoneyText('1,5')).toBe(1500) // while typing "1,500"
    expect(parseMoneyText('0.1')).toBe(10)
    expect(parseMoneyText('')).toBeNull()
    expect(parseMoneyText('12.345')).toBeNull()
    expect(parseMoneyText('-10')).toBeNull()
    expect(parseMoneyText('-10', true)).toBe(-1000)
    expect(formatMoneyInputValue(12345650)).toBe('1,23,456.50')
    expect(moneyEditingText(50000)).toBe('500')
    expect(moneyEditingText(50050)).toBe('500.50')
  })

  it('parses quantities per unit (decimals only for decimal units)', () => {
    expect(parseQtyText('1.5', 'KG')).toBe(1500)
    expect(parseQtyText('0.250', 'KG')).toBe(250)
    expect(parseQtyText('2', 'PCS')).toBe(2000)
    expect(parseQtyText('2.5', 'PCS')).toBeNull()
    expect(parseQtyText('2.5', 'TAB', { allowDecimal: true })).toBe(2500)
    expect(parseQtyText('0', 'PCS')).toBe(0)
    expect(parseQtyText('0', 'PCS', { min: 1000 })).toBeNull()
    expect(parseQtyText('', 'KG')).toBeNull()
  })

  it('scales numbers exactly (percent → basis points)', () => {
    expect(parseScaled('12.5', 100, 2, false)).toBe(1250)
    expect(parseScaled('0.25', 100, 2, false)).toBe(25)
    expect(parseScaled('18', 100, 2, false)).toBe(1800)
    expect(parseScaled('12.555', 100, 2, false)).toBeNull()
    expect(parseScaled('-5', 1, 0, false)).toBeNull()
    expect(parseScaled('-5', 1, 0, true)).toBe(-5)
    expect(formatScaled(1250, 100)).toBe('12.5')
    expect(formatScaled(1800, 100)).toBe('18')
  })
})

function MoneyHarness({
  initial = null,
  onValue,
}: {
  initial?: number | null
  onValue: (v: number | null) => void
}) {
  const [value, setValue] = useState<number | null>(initial)
  return (
    <>
      <label htmlFor="amt">Amount</label>
      <MoneyInput
        id="amt"
        value={value}
        onChange={(v) => {
          setValue(v)
          onValue(v)
        }}
      />
      <button type="button">elsewhere</button>
    </>
  )
}

describe('MoneyInput', () => {
  it('emits paise while typing and formats with Indian grouping on blur', async () => {
    const user = userEvent.setup()
    const onValue = vi.fn()
    render(<MoneyHarness onValue={onValue} />)
    const input = screen.getByLabelText('Amount')
    await user.type(input, '123456.5')
    expect(onValue).toHaveBeenLastCalledWith(12345650)
    await user.click(screen.getByRole('button', { name: 'elsewhere' }))
    expect(input).toHaveValue('1,23,456.50')
  })

  it('blocks letters and a third decimal digit', async () => {
    const user = userEvent.setup()
    const onValue = vi.fn()
    render(<MoneyHarness onValue={onValue} />)
    const input = screen.getByLabelText('Amount')
    await user.type(input, '12a.345')
    expect(input).toHaveValue('12.34')
    expect(onValue).toHaveBeenLastCalledWith(1234)
  })

  it('accepts pasted amounts like "₹ 1,250/-"', () => {
    const onValue = vi.fn()
    render(<MoneyHarness onValue={onValue} />)
    const input = screen.getByLabelText('Amount')
    fireEvent.paste(input, { clipboardData: { getData: () => '₹ 1,250/-' } })
    expect(onValue).toHaveBeenLastCalledWith(125000)
  })

  it('shows an external value and clears to null', async () => {
    const user = userEvent.setup()
    const onValue = vi.fn()
    render(<MoneyHarness initial={9900} onValue={onValue} />)
    const input = screen.getByLabelText('Amount')
    expect(input).toHaveValue('99.00')
    await user.clear(input)
    expect(onValue).toHaveBeenLastCalledWith(null)
  })
})

function QtyHarness({
  unit,
  onValue,
  allowDecimal,
}: {
  unit: string
  onValue: (v: number | null) => void
  allowDecimal?: boolean
}) {
  const [value, setValue] = useState<number | null>(1000)
  return (
    <>
      <label htmlFor="qty">Quantity</label>
      <QtyInput
        id="qty"
        unit={unit}
        allowDecimal={allowDecimal}
        value={value}
        onChange={(v) => {
          setValue(v)
          onValue(v)
        }}
      />
    </>
  )
}

describe('QtyInput', () => {
  it('accepts decimals for weighed units and shows the unit', async () => {
    const user = userEvent.setup()
    const onValue = vi.fn()
    render(<QtyHarness unit="KG" onValue={onValue} />)
    const input = screen.getByLabelText('Quantity')
    await user.clear(input)
    await user.type(input, '1.25')
    expect(onValue).toHaveBeenLastCalledWith(1250)
    expect(screen.getByText('kg')).toBeInTheDocument()
  })

  it('rejects decimals for piece units', async () => {
    const user = userEvent.setup()
    const onValue = vi.fn()
    render(<QtyHarness unit="PCS" onValue={onValue} />)
    const input = screen.getByLabelText('Quantity')
    await user.clear(input)
    await user.type(input, '2.5')
    expect(input).toHaveValue('25')
    expect(onValue).toHaveBeenLastCalledWith(25000)
  })

  it('steps with the +/− buttons and arrow keys, never below the minimum', async () => {
    const user = userEvent.setup()
    const onValue = vi.fn()
    render(<QtyHarness unit="PCS" onValue={onValue} />)
    await user.click(screen.getByRole('button', { name: 'Increase' }))
    expect(onValue).toHaveBeenLastCalledWith(2000)
    await user.click(screen.getByLabelText('Quantity'))
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(onValue).toHaveBeenLastCalledWith(0)
    expect(screen.getByRole('button', { name: 'Decrease' })).toBeDisabled()
  })

  it('uses Tamil unit symbols in Tamil', async () => {
    await setLanguage('ta', { persist: false })
    render(<QtyHarness unit="KG" onValue={() => {}} />)
    expect(screen.getByText('கிலோ')).toBeInTheDocument()
  })
})

describe('NumberInput', () => {
  it('stores a percentage as basis points', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    function Harness() {
      const [v, setV] = useState<number | null>(null)
      return (
        <NumberInput
          aria-label="Discount"
          value={v}
          scale={100}
          decimals={2}
          max={10000}
          suffix="%"
          onChange={(n) => {
            setV(n)
            onChange(n)
          }}
        />
      )
    }
    render(<Harness />)
    await user.type(screen.getByLabelText('Discount'), '12.5')
    expect(onChange).toHaveBeenLastCalledWith(1250)
    await user.clear(screen.getByLabelText('Discount'))
    await user.type(screen.getByLabelText('Discount'), '120')
    expect(screen.getByLabelText('Discount')).toHaveAttribute('aria-invalid', 'true')
  })
})
