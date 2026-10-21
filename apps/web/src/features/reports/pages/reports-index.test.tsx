import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PLAN_FEATURES } from '@kadai/shared/features'
import { makeMe } from '@/test/fixtures'
import { renderApp, signIn } from '@/test/render'

const FIRST_PAINT = { timeout: 8_000 }

describe('Reports index', () => {
  it('groups the reports, links GST returns and marks reports outside the plan', async () => {
    await signIn(makeMe())
    renderApp('/reports')
    const sales = await screen.findByRole('region', { name: 'Sales' }, FIRST_PAINT)
    expect(within(sales).getByRole('link', { name: /Sales summary/ })).toHaveAttribute(
      'href',
      '/reports/sales-summary',
    )
    // Advanced reports are not in the Growth plan: still listed, with an upgrade badge.
    expect(
      within(sales).getByRole('link', { name: /Profit & margin.*Upgrade/ }),
    ).toBeInTheDocument()
    const gst = screen.getByRole('region', { name: 'GST' })
    expect(within(gst).getByRole('link', { name: /GST returns \(GSTR-1, 3B\)/ })).toHaveAttribute(
      'href',
      '/reports/gst',
    )
    expect(screen.getByRole('region', { name: 'Shifts & controls' })).toBeInTheDocument()
    // Not a pharmacy: no Schedule H1 register.
    expect(screen.queryByRole('region', { name: 'Pharmacy' })).not.toBeInTheDocument()
  })

  it('shows the pharmacy group to pharmacies', async () => {
    await signIn(makeMe({ businessType: 'pharmacy', features: [...DEFAULT_PLAN_FEATURES.pro] }))
    renderApp('/reports')
    const pharmacy = await screen.findByRole('region', { name: 'Pharmacy' }, FIRST_PAINT)
    expect(within(pharmacy).getByRole('link', { name: /Schedule H1 register/ })).toBeInTheDocument()
    expect(screen.queryByText('Upgrade')).not.toBeInTheDocument()
  })

  it('hides GST reports from members without reports.gst', async () => {
    await signIn(makeMe({ permissions: ['reports.read'] }))
    renderApp('/reports')
    await screen.findByRole('region', { name: 'Sales' }, FIRST_PAINT)
    expect(screen.queryByRole('region', { name: 'GST' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /GST returns/ })).not.toBeInTheDocument()
  })

  it('finds a report by name in either language', async () => {
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/reports')
    await screen.findByRole('region', { name: 'Sales' }, FIRST_PAINT)
    await user.type(screen.getByRole('searchbox', { name: /Find a report/ }), 'காலாவதி{Enter}')
    expect(await screen.findByRole('link', { name: /Expiry report/ })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Sales' })).not.toBeInTheDocument()
  })
})
