import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { makeMe, makeSession } from '@/test/fixtures'
import { apiPath, server } from '@/test/msw'
import { renderApp, signIn, signOutState } from '@/test/render'
import { safeNext } from './safe-next'

describe('route guards', () => {
  it('sends signed-out users to /login with the page as ?next=', async () => {
    await signOutState()
    const { router } = renderApp('/catalog/products?q=rice')
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(router.state.location.search).toBe(
      `?next=${encodeURIComponent('/catalog/products?q=rice')}`,
    )
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument()
  })

  it('renders the page inside the shell when the member is allowed', async () => {
    await signIn()
    // The catalog products page loads its list and the category filter.
    server.use(
      http.get(apiPath('/products'), () =>
        HttpResponse.json({ data: [], page: { limit: 50, offset: 0, total: 0 } }),
      ),
      http.get(apiPath('/categories'), () => HttpResponse.json({ data: [] })),
    )
    renderApp('/catalog/products')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Products' }, { timeout: 5000 }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toBeInTheDocument()
    expect(document.title).toBe('Products · Kadai')
  })

  it('shows the 403 page without the permission', async () => {
    await signIn(makeMe({ permissions: ['pos.use', 'sales.create', 'sales.read'] }))
    renderApp('/catalog/products')
    expect(await screen.findByText("You don't have access to this")).toBeInTheDocument()
  })

  it('shows the upgrade page when the plan lacks the feature', async () => {
    await signIn(makeMe({ features: ['pos', 'catalog', 'inventory'] }))
    renderApp('/purchases/bills')
    expect(await screen.findByText('Not included in your plan')).toBeInTheDocument()
    expect(screen.getByText(/“Purchases” is available on a higher plan/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'See plans' })).toHaveAttribute(
      'href',
      '/settings/billing',
    )
  })

  it('hides cloud-only screens on an on-prem server', async () => {
    await signIn(makeMe({ mode: 'onprem' }))
    renderApp('/settings/billing')
    expect(await screen.findByText('Not available here')).toBeInTheDocument()
  })

  it('treats pharmacy-only screens as not found for other shops', async () => {
    await signIn(makeMe({ businessType: 'general_store' }))
    renderApp('/parties/doctors')
    expect(await screen.findByText('Page not found')).toBeInTheDocument()
  })

  it('keeps platform administration for platform admins', async () => {
    await signIn()
    renderApp('/platform/tenants')
    expect(await screen.findByText("You don't have access to this")).toBeInTheDocument()
  })

  it('lets a platform admin without a business into /platform', async () => {
    await signIn(
      makeMe(),
      makeSession({
        tenant_id: null,
        memberships: [],
        user: { ...makeSession().user, is_platform_admin: true },
      }),
    )
    const { router } = renderApp('/')
    await waitFor(() => expect(router.state.location.pathname).toBe('/platform'))
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Platform overview' }),
    ).toBeInTheDocument()
  })

  it('redirects signed-in users away from the login page to ?next', async () => {
    await signIn()
    const { router } = renderApp('/login?next=%2Fsales%2Finvoices')
    await waitFor(() => expect(router.state.location.pathname).toBe('/sales/invoices'))
  })

  it('shows a 404 inside the shell for unknown paths', async () => {
    await signIn()
    renderApp('/no/such/page')
    expect(await screen.findByText('Page not found')).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Main navigation' })).toBeInTheDocument()
  })

  it('serves public pages without signing in', async () => {
    await signOutState()
    renderApp('/i/share-token-123')
    expect(await screen.findByRole('heading', { level: 1, name: 'Invoice' })).toBeInTheDocument()
  })
})

describe('navigation visibility', () => {
  it('hides menu items the member may not use', async () => {
    await signIn(
      makeMe({ permissions: ['pos.use', 'sales.create', 'sales.read', 'customers.read'] }),
    )
    renderApp('/')
    const nav = await screen.findByRole('complementary', { name: 'Main navigation' })
    await waitFor(() => expect(nav).toHaveTextContent('Sales invoices'))
    expect(nav).toHaveTextContent('Customers & khata')
    expect(nav).not.toHaveTextContent('Purchase bills')
    expect(nav).not.toHaveTextContent('Users')
    expect(nav).not.toHaveTextContent('Doctors')
  })
})

describe('safeNext', () => {
  it('accepts only same-app relative paths', () => {
    expect(safeNext('/sales/invoices?x=1')).toBe('/sales/invoices?x=1')
    expect(safeNext('https://evil.example')).toBe('/')
    expect(safeNext('//evil.example')).toBe('/')
    expect(safeNext('/\\evil.example')).toBe('/')
    expect(safeNext(null, '/home')).toBe('/home')
  })
})
