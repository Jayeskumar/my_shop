import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { DoctorCreateSchema, partiesRoutes } from '@kadai/shared/api/parties'
import { PERMISSION_CODES } from '@kadai/shared/permissions'
import { makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import { createPartiesApi } from '../testing/handlers'

function setup() {
  const api = createPartiesApi()
  server.use(...api.handlers)
  return api
}

describe('Doctors (pharmacy)', () => {
  it('lists doctors and adds one', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe({ businessType: 'pharmacy' }))
    renderApp('/parties/doctors')
    expect(await screen.findByText('Dr. S. Kumar')).toBeInTheDocument()
    expect(api.callsTo(partiesRoutes.listDoctors)[0]!.query.get('is_active')).toBe('true')

    await user.click(screen.getByRole('button', { name: 'Add doctor' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add doctor' })
    await user.click(within(dialog).getByRole('button', { name: 'Save doctor' }))
    expect(await within(dialog).findByText('This field is required')).toBeInTheDocument()

    await user.type(within(dialog).getByLabelText(/Doctor name/), 'Dr. Meena')
    await user.type(within(dialog).getByLabelText(/Registration no/), 'TNMC 61230')
    await user.type(within(dialog).getByLabelText(/Mobile number/), '9566778899')
    await user.click(within(dialog).getByRole('button', { name: 'Save doctor' }))
    await waitFor(() => expect(api.callsTo(partiesRoutes.createDoctor)).toHaveLength(1))
    expect(
      DoctorCreateSchema.parse(api.callsTo(partiesRoutes.createDoctor)[0]!.body),
    ).toMatchObject({
      name: 'Dr. Meena',
      registration_no: 'TNMC 61230',
      phone: '+919566778899',
    })
  })

  it('is read-only without customers.write', async () => {
    setup()
    await signIn(
      makeMe({
        businessType: 'pharmacy',
        permissions: PERMISSION_CODES.filter((p) => p !== 'customers.write'),
      }),
    )
    renderApp('/parties/doctors')
    expect(await screen.findByText('Dr. S. Kumar')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add doctor' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument()
  })
})
