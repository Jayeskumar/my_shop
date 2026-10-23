import { screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { DEFAULT_PLAN_FEATURES } from '@kadai/shared/features'
import { DEFAULT_SETTINGS } from '@kadai/shared/settings'
import { makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderWithProviders, signIn } from '@/test/render'
import { customerBook, customerLedger, supplierLedger } from '../testing/fixtures'
import { createPartiesApi } from '../testing/handlers'
import { CustomerSummaryCard, PartyLedgerTable, statementHtml, statementShareText } from './index'

describe('exported parties components', () => {
  it('CustomerSummaryCard shows due, overdue, credit left and loyalty value', async () => {
    const api = createPartiesApi()
    server.use(...api.handlers)
    const me = makeMe({ features: [...DEFAULT_PLAN_FEATURES.pro] })
    me.settings = { ...DEFAULT_SETTINGS, loyalty: { ...DEFAULT_SETTINGS.loyalty, enabled: true } }
    await signIn(me)
    const onClear = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(<CustomerSummaryCard customer={customerBook()[0]!} onClear={onClear} />)
    const card = screen.getByTestId('customer-summary-card')
    expect(within(card).getByRole('link', { name: 'Murugan K' })).toHaveAttribute(
      'href',
      `/parties/customers/${customerBook()[0]!.id}`,
    )
    expect(within(card).getByText('₹2,450.00')).toBeInTheDocument()
    expect(within(card).getByText('₹1,200 overdue')).toBeInTheDocument()
    expect(await within(card).findByText('₹2,550 available')).toBeInTheDocument()
    expect(within(card).getByText('340 points')).toBeInTheDocument()
    expect(within(card).getByText('worth ₹340.00')).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Remove customer' }))
    expect(onClear).toHaveBeenCalled()
  })

  it('PartyLedgerTable renders the opening row, running balances and closing balance', async () => {
    await signIn()
    renderWithProviders(<PartyLedgerTable partyType="supplier" ledger={supplierLedger()} />)
    const table = screen.getByRole('table', { name: 'Statement' })
    expect(within(table).getByText('Opening balance')).toBeInTheDocument()
    expect(within(table).getByText('Bills (credit)')).toBeInTheDocument()
    const rows = within(table).getAllByRole('row')
    // header, opening, 3 entries, closing
    expect(rows).toHaveLength(6)
    expect(within(rows[3]!).getByText('₹12,500.00')).toBeInTheDocument()
    // closing row: total credit and closing balance are both ₹23,500.00
    expect(within(rows[5]!).getAllByText('₹23,500.00')).toHaveLength(2)
  })

  it('builds a Tamil or English statement for print and sharing', async () => {
    const me = makeMe()
    const ledger = customerLedger()
    const ta = statementHtml({ ledger, partyType: 'customer', lang: 'ta', tenant: me.tenant })
    expect(ta).toContain('கணக்கு அறிக்கை')
    expect(ta).toContain('முருகன்')
    expect(ta).toContain('₹2,450.00 நிலுவை')
    expect(ta).toContain('S1-A/2627/00412')
    const en = statementHtml({ ledger, partyType: 'customer', lang: 'en', tenant: me.tenant })
    expect(en).toContain('Statement of account')
    expect(en).toContain('Murugan K')
    expect(en).toContain('In words: ')
    // Untrusted text is escaped.
    const evil = { ...ledger, party: { ...ledger.party, name: '<b>x</b>', name_ta: null } }
    expect(
      statementHtml({ ledger: evil, partyType: 'customer', lang: 'en', tenant: me.tenant }),
    ).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(
      statementShareText({ ledger, partyType: 'customer', lang: 'en', tenant: me.tenant }),
    ).toBe(
      'Hello Murugan K, your account with Sri Murugan Stores (Up to 20-10-2026): bills ₹3,000.00, paid ₹550.00. Balance: ₹2,450.00 due. Thank you!',
    )
  })
})
