import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { BusinessProfileUpdateSchema, identityRoutes } from '@kadai/shared/api/identity'
import { server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import { businessProfile, NOW, storeScopedMe } from '../testing/fixtures'
import { onRoute, type RecordedRequest } from '../testing/handlers'

const LATER = '2026-10-20T11:00:00.000Z'

function serveProfile(over: Parameters<typeof businessProfile>[0] = {}) {
  const calls: RecordedRequest[] = []
  server.use(
    onRoute(identityRoutes.getBusinessProfile, { data: businessProfile(over) }),
    onRoute(
      identityRoutes.updateBusinessProfile,
      (req) => ({
        data: businessProfile({
          ...over,
          ...(req.body as Record<string, unknown>),
          updated_at: LATER,
        } as Parameters<typeof businessProfile>[0]),
      }),
      calls,
    ),
  )
  return calls
}

describe('business details', () => {
  it('checks the GSTIN live, fills PAN and state from it and saves only the changes', async () => {
    const user = userEvent.setup()
    const calls = serveProfile({ pan: null })
    await signIn()
    renderApp('/settings/business')
    const gstin = await screen.findByLabelText(/^GSTIN/)
    expect(gstin).toHaveValue('33AAAPL1234C1ZL')

    await user.clear(gstin)
    await user.type(gstin, '33AAACM1234A1ZG')
    expect(screen.getByText(/check character doesn't match/i)).toBeInTheDocument()

    await user.clear(gstin)
    await user.type(gstin, '33aaacm1234a1zf')
    expect(await screen.findByText(/Valid GSTIN · Tamil Nadu/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^PAN/)).toHaveValue('AAACM1234A')

    await user.click(screen.getByRole('button', { name: /Save changes/ }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.body).toEqual({
      gstin: '33AAACM1234A1ZF',
      pan: 'AAACM1234A',
      if_updated_at: NOW,
    })
    expect(BusinessProfileUpdateSchema.safeParse(calls[0]!.body).success).toBe(true)
    expect(await screen.findByText('Business details saved')).toBeInTheDocument()
    // Saved: the unsaved-changes bar is gone.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Save changes/ })).not.toBeInTheDocument(),
    )
  })

  it('blocks saving a registered scheme without GSTIN', async () => {
    const user = userEvent.setup()
    const calls = serveProfile()
    await signIn()
    renderApp('/settings/business')
    const gstin = await screen.findByLabelText(/^GSTIN/)
    await user.clear(gstin)
    await user.click(screen.getByRole('button', { name: /Save changes/ }))
    expect(
      await screen.findByText('GSTIN is required for registered businesses'),
    ).toBeInTheDocument()
    expect(calls).toHaveLength(0)
  })

  it('asks before changing the GST scheme once bills exist in the year', async () => {
    const user = userEvent.setup()
    const calls = serveProfile({ gst_scheme_change_requires_confirm: true })
    await signIn()
    renderApp('/settings/business')
    await user.click(await screen.findByRole('radio', { name: /Composition scheme/ }))
    await user.click(screen.getByRole('button', { name: /Save changes/ }))
    expect(await screen.findByText('Change the GST scheme?')).toBeInTheDocument()
    expect(calls).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Yes, change it' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.body).toMatchObject({
      gst_scheme: 'composition',
      confirm_gst_scheme_change: true,
      if_updated_at: NOW,
    })
  })

  it('is read-only for a member limited to some stores', async () => {
    serveProfile()
    await signIn(storeScopedMe())
    renderApp('/settings/business')
    expect(
      await screen.findByText(/Business-wide settings can be changed only/),
    ).toBeInTheDocument()
    expect(await screen.findByLabelText(/^GSTIN/)).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Upload logo' })).not.toBeInTheDocument()
  })
})
