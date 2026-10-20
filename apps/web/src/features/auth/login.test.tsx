import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { LoginRequestSchema } from '@kadai/shared/api/auth'
import { IDS, makeMe, makeSession, testMembership } from '@/test/fixtures'
import { apiPath, errorResponse, server } from '@/test/msw'
import { renderApp, signOutState } from '@/test/render'

async function openLogin(path = '/login') {
  await signOutState()
  const view = renderApp(path)
  await screen.findByRole('heading', { name: 'Welcome back' })
  return view
}

describe('LoginPage', () => {
  it('shows localized inline errors for empty fields', async () => {
    const user = userEvent.setup()
    await openLogin()
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    const alerts = await screen.findAllByRole('alert')
    expect(alerts.map((a) => a.textContent)).toContain('Enter at least 3 characters')
    expect(screen.getByLabelText(/Mobile number or email/)).toHaveAttribute('aria-invalid', 'true')
  })

  it('signs in with a 10-digit mobile (sent as E.164) and opens the dashboard', async () => {
    const user = userEvent.setup()
    let body: unknown = null
    server.use(
      http.post(apiPath('/auth/login'), async ({ request }) => {
        body = await request.json()
        expect(LoginRequestSchema.safeParse(body).success).toBe(true)
        return HttpResponse.json({ data: makeSession() })
      }),
      http.get(apiPath('/me'), () => HttpResponse.json({ data: makeMe() })),
    )
    const { router } = await openLogin()
    await user.type(screen.getByLabelText(/Mobile number or email/), '98765 43210')
    await user.type(screen.getByLabelText(/^Password/), 'secret-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(body).toEqual({ identifier: '+919876543210', password: 'secret-password' })
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument()
  })

  it('returns to ?next after sign-in', async () => {
    const user = userEvent.setup()
    server.use(
      http.post(apiPath('/auth/login'), () => HttpResponse.json({ data: makeSession() })),
      http.get(apiPath('/me'), () => HttpResponse.json({ data: makeMe() })),
    )
    const { router } = await openLogin('/login?next=%2Finventory%2Fstock')
    await user.type(screen.getByLabelText(/Mobile number or email/), 'owner@example.com')
    await user.type(screen.getByLabelText(/^Password/), 'secret-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/inventory/stock'))
  })

  it('shows wrong-credential errors next to the password', async () => {
    const user = userEvent.setup()
    server.use(
      http.post(apiPath('/auth/login'), () => errorResponse(401, 'INVALID_CREDENTIALS', 'bad')),
    )
    await openLogin()
    await user.type(screen.getByLabelText(/Mobile number or email/), '9876543210')
    await user.type(screen.getByLabelText(/^Password/), 'not-my-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Wrong mobile number / email or password.')).toBeInTheDocument()
    expect(screen.getByLabelText(/^Password/)).toHaveValue('')
  })

  it('toggles password visibility', async () => {
    const user = userEvent.setup()
    await openLogin()
    const password = screen.getByLabelText(/^Password/)
    expect(password).toHaveAttribute('type', 'password')
    await user.click(screen.getByRole('button', { name: 'Show password' }))
    expect(password).toHaveAttribute('type', 'text')
  })

  it('switches the page to Tamil and back', async () => {
    const user = userEvent.setup()
    await openLogin()
    await user.click(screen.getByRole('radio', { name: 'தமிழ்' }))
    expect(await screen.findByRole('heading', { name: 'நல்வரவு' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'உள்நுழைக' })).toBeInTheDocument()
    expect(document.documentElement.lang).toBe('ta')
    await user.click(screen.getByRole('radio', { name: 'English' }))
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument()
    expect(document.documentElement.lang).toBe('en')
  })

  it('offers sign-up only in cloud mode', async () => {
    await openLogin()
    expect(screen.getByRole('link', { name: 'Create a free shop account' })).toHaveAttribute(
      'href',
      '/signup',
    )
  })

  it('lets a member of several businesses choose one', async () => {
    const user = userEvent.setup()
    const memberships = [
      testMembership,
      {
        ...testMembership,
        tenant_id: IDS.tenant2,
        tenant_name: 'Lakshmi Medicals',
        business_type: 'pharmacy' as const,
      },
    ]
    server.use(
      http.post(apiPath('/auth/login'), () =>
        HttpResponse.json({ data: makeSession({ tenant_id: null, memberships }) }),
      ),
      http.post(apiPath('/auth/select-tenant'), () =>
        HttpResponse.json({ data: makeSession({ tenant_id: IDS.tenant2, memberships }) }),
      ),
      http.get(apiPath('/me'), () =>
        HttpResponse.json({ data: makeMe({ tenantId: IDS.tenant2, businessType: 'pharmacy' }) }),
      ),
    )
    const { router } = await openLogin()
    await user.type(screen.getByLabelText(/Mobile number or email/), '9876543210')
    await user.type(screen.getByLabelText(/^Password/), 'secret-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/select-business'))
    await user.click(await screen.findByRole('button', { name: /Lakshmi Medicals/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
  })
})
