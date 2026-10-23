import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { partiesRoutes } from '@kadai/shared/api/parties'
import { PERMISSION_CODES } from '@kadai/shared/permissions'
import { setLanguage } from '@/lib/i18n'
import { makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import { page } from '../testing/fixtures'
import { createPartiesApi } from '../testing/handlers'

function setup(replies: Parameters<typeof createPartiesApi>[0] = {}) {
  const api = createPartiesApi(replies)
  server.use(...api.handlers)
  return api
}

describe('Customers & khata list', () => {
  it('lists customers with dues, advances and overdue amounts', async () => {
    const api = setup()
    await signIn()
    renderApp('/parties/customers')
    const table = await screen.findByRole('table', { name: 'Customers & khata' })
    const murugan = (await within(table).findByText('Murugan K')).closest('tr')!
    expect(within(murugan).getByText('₹2,450.00')).toBeInTheDocument()
    expect(within(murugan).getByText('due')).toBeInTheDocument()
    expect(within(murugan).getByText('₹1,200 overdue')).toBeInTheDocument()
    const selvi = within(table).getByText('Selvi R').closest('tr')!
    expect(within(selvi).getByText('advance')).toBeInTheDocument()
    // Phones are tap-to-call links.
    expect(within(murugan).getByRole('link', { name: /98430 12345/ })).toHaveAttribute(
      'href',
      'tel:+919843012345',
    )
    const first = api.callsTo(partiesRoutes.listCustomers)[0]!
    expect(first.query.get('sort')).toBe('name')
    expect(first.query.get('is_active')).toBe('true')
    expect(first.query.get('limit')).toBe('50')
  })

  it('quick filter chips and search change the list query', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn()
    renderApp('/parties/customers')
    await screen.findByRole('table', { name: 'Customers & khata' })

    await user.click(screen.getByRole('button', { name: 'With due' }))
    await waitFor(() =>
      expect(api.callsTo(partiesRoutes.listCustomers).at(-1)!.query.get('has_due')).toBe('true'),
    )
    expect(screen.getByRole('button', { name: 'With due' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: 'Overdue' }))
    await waitFor(() => {
      const q = api.callsTo(partiesRoutes.listCustomers).at(-1)!.query
      expect(q.get('overdue')).toBe('true')
      expect(q.get('has_due')).toBeNull()
    })

    await user.click(screen.getByRole('button', { name: 'Wholesale' }))
    await waitFor(() =>
      expect(api.callsTo(partiesRoutes.listCustomers).at(-1)!.query.get('customer_type')).toBe(
        'wholesale',
      ),
    )

    await user.type(screen.getByRole('searchbox'), 'murugan{Enter}')
    await waitFor(() =>
      expect(api.callsTo(partiesRoutes.listCustomers).at(-1)!.query.get('q')).toBe('murugan'),
    )
  })

  it('pages through the list with offset', async () => {
    const api = setup({
      listCustomers: (c) => {
        const offset = Number(c.query.get('offset') ?? 0)
        return HttpResponse.json({
          data: [],
          page: page(120, Number(c.query.get('limit') ?? 50), offset),
        })
      },
    })
    const user = userEvent.setup()
    await signIn()
    renderApp('/parties/customers')
    await screen.findByText('1–50 of 120')
    await user.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() =>
      expect(api.callsTo(partiesRoutes.listCustomers).at(-1)!.query.get('offset')).toBe('50'),
    )
  })

  it('teaches the first steps when there are no customers yet', async () => {
    setup({ listCustomers: () => HttpResponse.json({ data: [], page: page(0) }) })
    await signIn()
    renderApp('/parties/customers')
    expect(await screen.findByText('Start your digital khata')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add your first customer' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import from Excel / CSV' })).toBeInTheDocument()
  })

  it('hides add and import for users who may only view customers', async () => {
    setup()
    await signIn(makeMe({ permissions: PERMISSION_CODES.filter((p) => p !== 'customers.write') }))
    renderApp('/parties/customers')
    await screen.findByRole('table', { name: 'Customers & khata' })
    expect(screen.queryByRole('button', { name: /Add customer/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument()
  })

  it('opens the khata page from a row', async () => {
    setup()
    const user = userEvent.setup()
    await signIn()
    const { router } = renderApp('/parties/customers')
    const table = await screen.findByRole('table', { name: 'Customers & khata' })
    await user.click(await within(table).findByText('Selvi R'))
    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(/^\/parties\/customers\/[0-9a-f-]{36}$/),
    )
  })

  it('speaks Tamil to Tamil users', async () => {
    setup()
    await signIn()
    await setLanguage('ta', { persist: false })
    renderApp('/parties/customers')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'வாடிக்கையாளர் & கடன்' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'நிலுவை உள்ளவர்கள்' })).toBeInTheDocument()
    // Tamil names first, English below.
    expect(await screen.findByText('முருகன்')).toBeInTheDocument()
    expect(screen.getAllByText('நிலுவை').length).toBeGreaterThan(0)
  })

  it('opens Add customer with Alt+N and focuses search with /', async () => {
    setup()
    const user = userEvent.setup()
    await signIn()
    renderApp('/parties/customers')
    await screen.findByRole('table', { name: 'Customers & khata' })
    await user.keyboard('/')
    expect(screen.getByRole('searchbox')).toHaveFocus()
    await user.keyboard('{Escape}')
    screen.getByRole('searchbox').blur()
    await user.keyboard('{Alt>}n{/Alt}')
    expect(await screen.findByRole('dialog', { name: 'Add customer' })).toBeInTheDocument()
  })
})
