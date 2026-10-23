import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  MemberCreateSchema,
  RoleCreateSchema,
  identityRoutes,
  permissionCatalog,
} from '@kadai/shared/api/identity'
import { DEFAULT_PLAN_FEATURES } from '@kadai/shared/features'
import { makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import { member, page, role, selfMember, systemRole } from '../testing/fixtures'
import { onRoute, type RecordedRequest } from '../testing/handlers'

const ROLES = [systemRole('owner'), systemRole('manager'), systemRole('cashier')]

function serveUsers(rows = [selfMember(), member()]) {
  const calls: RecordedRequest[] = []
  server.use(
    onRoute(identityRoutes.listUsers, (req) => {
      calls.push(req)
      const limit = Number(req.query.get('limit') ?? 50)
      return { data: limit === 1 ? [] : rows, page: page(limit === 1 ? 2 : rows.length, limit) }
    }),
    onRoute(identityRoutes.listRoles, { data: ROLES, page: page(ROLES.length, 200) }),
  )
  return calls
}

describe('users', () => {
  it('sends search and filters as list query parameters', async () => {
    const user = userEvent.setup()
    const calls = serveUsers()
    await signIn()
    renderApp('/settings/users')
    expect(await screen.findByText('Selvi R')).toBeInTheDocument()
    const listCalls = () => calls.filter((c) => c.query.get('limit') === '50')
    expect(listCalls().at(-1)!.query.get('sort')).toBe('full_name')

    await user.type(screen.getByPlaceholderText('Search by name or mobile'), 'selvi')
    await waitFor(() => expect(listCalls().at(-1)!.query.get('q')).toBe('selvi'))
    expect(listCalls().at(-1)!.query.get('offset')).toBe('0')
  })

  it('hides disable and password reset on your own row', async () => {
    const user = userEvent.setup()
    serveUsers()
    await signIn()
    renderApp('/settings/users')
    await user.click(await screen.findByRole('button', { name: 'Actions for Murugan K' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: /Set or reset PIN/ })).toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: /Disable/ })).not.toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: /Reset password/ })).not.toBeInTheDocument()
  })

  it('invites a member and shows the temporary password once', async () => {
    const user = userEvent.setup()
    serveUsers()
    const calls: RecordedRequest[] = []
    server.use(
      onRoute(
        identityRoutes.createUser,
        {
          data: {
            member: member({ full_name: 'Karthik S', status: 'invited', phone: '+919840012345' }),
            existing_user: false,
            temporary_password: 'k7mq-9x4p-a2bd',
            otp_sent: false,
          },
        },
        calls,
      ),
    )
    await signIn()
    renderApp('/settings/users')
    await user.click(await screen.findByRole('button', { name: /Invite member/ }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/^Mobile number/), '98400 12345')
    await user.type(within(dialog).getByLabelText(/^Full name/), 'Karthik S')
    await user.type(within(dialog).getByLabelText(/^Billing PIN/), '4826')
    await user.click(within(dialog).getByRole('button', { name: 'Send invite' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.body).toEqual({
      phone: '98400 12345',
      full_name: 'Karthik S',
      email: null,
      role_id: ROLES[2]!.id,
      store_ids: null,
      pin: '4826',
      first_login: 'temporary_password',
      preferred_locale: 'ta',
    })
    expect(MemberCreateSchema.safeParse(calls[0]!.body).success).toBe(true)
    expect(await screen.findByTestId('temporary-password')).toHaveTextContent('k7mq-9x4p-a2bd')
    await user.click(screen.getByRole('button', { name: "I've noted it" }))
    await waitFor(() => expect(screen.queryByTestId('temporary-password')).not.toBeInTheDocument())
  })
})

describe('roles', () => {
  function serveRoles(extra = [role()]) {
    server.use(
      onRoute(identityRoutes.listRoles, { data: [...ROLES, ...extra], page: page(4, 200) }),
      onRoute(identityRoutes.listPermissions, { data: permissionCatalog() }),
    )
  }

  it('shows built-in roles read-only', async () => {
    const user = userEvent.setup()
    serveRoles()
    await signIn()
    renderApp('/settings/roles')
    await user.click(await screen.findByRole('button', { name: /^Cashier/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/permissions can't be changed/)).toBeInTheDocument()
    const posUse = await within(dialog).findByRole('checkbox', {
      name: 'Use the billing counter (POS)',
    })
    expect(posUse).toBeChecked()
    expect(posUse).toBeDisabled()
    expect(within(dialog).queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
  })

  it('creates a custom role with "select all" in a group', async () => {
    const user = userEvent.setup()
    serveRoles([])
    const calls: RecordedRequest[] = []
    server.use(onRoute(identityRoutes.createRole, { data: role({ name: 'Stock helper' }) }, calls))
    await signIn(makeMe({ features: [...DEFAULT_PLAN_FEATURES.pro] }))
    renderApp('/settings/roles')
    await user.click(await screen.findByRole('button', { name: 'New role' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/^Role name\*?$/), 'Stock helper')
    await user.click(
      await within(dialog).findByRole('checkbox', { name: 'Select all in Products' }),
    )
    await user.click(within(dialog).getByRole('button', { name: 'Create role' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    const body = calls[0]!.body as { name: string; permissions: string[] }
    expect(body.name).toBe('Stock helper')
    const catalogGroup = permissionCatalog().groups.find((g) => g.code === 'catalog')!
    // Implied permissions (catalog.write → catalog.read) are locked, the rest are selected.
    expect(body.permissions).toContain('catalog.write')
    expect(body.permissions.every((p) => p.startsWith('catalog.'))).toBe(true)
    expect(body.permissions.length).toBeLessThanOrEqual(catalogGroup.permissions.length)
    expect(RoleCreateSchema.safeParse(body).success).toBe(true)
  })

  it('offers an upgrade instead of custom roles without the plan feature', async () => {
    serveRoles([])
    await signIn(
      makeMe({ features: [...DEFAULT_PLAN_FEATURES.pro].filter((f) => f !== 'custom_roles') }),
    )
    renderApp('/settings/roles')
    expect(await screen.findByText(/is not in your current plan/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New role' })).not.toBeInTheDocument()
  })
})
