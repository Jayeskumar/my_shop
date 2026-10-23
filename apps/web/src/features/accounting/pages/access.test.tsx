/**
 * Route access of the accounting screens (permission + plan feature from the route handles) and
 * the Tamil UI of the daily screens.
 */
import { accountingRoutes as r } from '@kadai/shared/api/accounting'
import { DEFAULT_PLAN_FEATURES } from '@kadai/shared/features'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it } from 'vitest'
import { setLanguage } from '@/lib/i18n'
import { makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderApp, renderWithProviders, signIn } from '@/test/render'
import { CloseShiftDialog, OpenShiftDialog, ShiftStatusBadge } from '../components'
import * as F from '../testing/fixtures'
import { createAccountingApi } from '../testing/handlers'
import { PRELOAD_TIMEOUT_MS, preloadAccountingPages } from '../testing/preload'

beforeAll(preloadAccountingPages, PRELOAD_TIMEOUT_MS)

function setup() {
  const api = createAccountingApi()
  server.use(...api.handlers)
  return api
}

describe('Accounting route access', () => {
  it('shows "no access" to members without the read permission', async () => {
    setup()
    await signIn(makeMe({ permissions: ['pos.use', 'sales.read'] }))
    renderApp('/accounting/journal')
    expect(await screen.findByText("You don't have access to this")).toBeInTheDocument()
  })

  it('keeps expenses on every plan but asks to upgrade for the books and shifts', async () => {
    const api = setup()
    await signIn(makeMe({ features: [...DEFAULT_PLAN_FEATURES.free] }))
    const first = renderApp('/accounting/statements')
    expect(await screen.findByText('Not included in your plan')).toBeInTheDocument()
    first.unmount()

    const second = renderApp('/accounting/shifts')
    expect(await screen.findByText('Not included in your plan')).toBeInTheDocument()
    second.unmount()

    renderApp('/accounting/expenses')
    expect(await screen.findByRole('table', { name: 'Expenses' })).toBeInTheDocument()
    expect(api.callsTo(r.profitLoss)).toHaveLength(0)
    expect(api.callsTo(r.listShifts)).toHaveLength(0)
  })
})

describe('Tamil UI', () => {
  it('shows the expense screen and the quick-add tiles in Tamil', async () => {
    setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    await setLanguage('ta', { persist: false })
    renderApp('/accounting/expenses')
    expect(await screen.findByRole('heading', { name: 'செலவுகள்' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /செலவைச் சேர்/ }))
    const dialog = await screen.findByRole('dialog', { name: 'செலவைச் சேர்' })
    for (const tile of ['வாடகை', 'மின்சாரம்', 'சம்பளம்', 'போக்குவரத்து']) {
      expect(await within(dialog).findByRole('radio', { name: tile })).toBeInTheDocument()
    }
  })

  it('names the statements the way Tamil Nadu accountants do', async () => {
    setup()
    await signIn(makeMe())
    await setLanguage('ta', { persist: false })
    renderApp('/accounting/statements')
    expect(await screen.findByRole('tab', { name: 'இலாப நஷ்ட கணக்கு' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'இருப்புநிலைக் குறிப்பு' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'சோதனை இருப்பு' })).toBeInTheDocument()
  })
})

describe('Reusable shift components (POS)', () => {
  it('opens a shift for a given counter without asking for the counter', async () => {
    setup()
    await signIn(makeMe())
    renderWithProviders(<OpenShiftDialog open onOpenChange={() => {}} registerId={F.REGISTER_ID} />)
    const dialog = await screen.findByRole('dialog', { name: 'Open shift' })
    expect(within(dialog).queryByRole('combobox', { name: /Counter/ })).toBeNull()
    expect(within(dialog).getByRole('group', { name: 'Cash count by note' })).toBeInTheDocument()
  })

  it('closes a shift passed in by the POS and shows its expected cash', async () => {
    setup()
    await signIn(makeMe())
    renderWithProviders(
      <>
        <ShiftStatusBadge status="closed" differenceStatus="short" differencePaise={-2_000} />
        <CloseShiftDialog open onOpenChange={() => {}} shift={F.shiftDetail()} />
      </>,
    )
    expect(screen.getByText('Short ₹20')).toBeInTheDocument()
    const dialog = await screen.findByRole('dialog', { name: 'Close shift · Counter A' })
    expect(within(dialog).getByText('₹12,980.00')).toBeInTheDocument()
    // Nothing counted yet: closing is disabled.
    expect(within(dialog).getByRole('button', { name: 'Close shift' })).toBeDisabled()
  })
})
