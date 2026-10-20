import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  OtpRequestSchema,
  OtpVerifyRequestSchema,
  SignupRequestSchema,
} from '@kadai/shared/api/auth'
import { makeGstin } from '@kadai/shared/gst'
import { makeMe, makeSession } from '@/test/fixtures'
import { apiPath, errorResponse, server } from '@/test/msw'
import { renderApp, signOutState } from '@/test/render'
import { OtpCodeInput } from './components/OtpCodeInput'

const VALID_TN_GSTIN = makeGstin('33', 'AAAPL1234C')

async function openSignup() {
  await signOutState()
  const view = renderApp('/signup')
  await screen.findByRole('heading', { name: 'Create your shop' })
  return view
}

async function fillToOwnerStep(user: UserEvent, { gstin }: { gstin?: string } = {}) {
  await user.click(screen.getByRole('radio', { name: /General store/ }))
  await user.click(screen.getByRole('button', { name: /Next/ }))
  await user.type(await screen.findByLabelText(/Shop \/ business name/), 'Sri Murugan Stores')
  await user.type(screen.getByLabelText(/Shop name in Tamil/), 'ஸ்ரீ முருகன் ஸ்டோர்ஸ்')
  if (gstin) await user.type(screen.getByLabelText(/^GSTIN/), gstin)
  await user.click(screen.getByRole('button', { name: /Next/ }))
}

async function fillOwner(user: UserEvent) {
  await user.type(await screen.findByLabelText(/Your name/), 'Murugan K')
  await user.type(screen.getByLabelText(/Mobile number/), '9876543210')
  await user.type(screen.getByLabelText(/Create a password/), 'kadai-secret-1')
}

describe('SignupPage wizard', () => {
  it('requires a shop type before moving on', async () => {
    const user = userEvent.setup()
    await openSignup()
    await user.click(screen.getByRole('button', { name: /Next/ }))
    expect(await screen.findByText('Please choose an option')).toBeInTheDocument()
    expect(screen.getByText('What kind of shop do you run?')).toBeInTheDocument()
  })

  it('validates the GSTIN checksum live and fills the state from it', async () => {
    const user = userEvent.setup()
    await openSignup()
    await user.click(screen.getByRole('radio', { name: /Pharmacy/ }))
    await user.click(screen.getByRole('button', { name: /Next/ }))
    const gstin = await screen.findByLabelText(/^GSTIN/)
    await user.type(gstin, '33AAAPL1234C1ZZ') // wrong check character
    expect(gstin).toHaveAttribute('aria-invalid', 'true')
    await user.clear(gstin)
    await user.type(gstin, VALID_TN_GSTIN.toLowerCase())
    expect(await screen.findByText(/Valid GSTIN · PAN AAAPL1234C/)).toBeInTheDocument()
    // A valid GSTIN switches the registration type to Regular.
    expect(screen.getByRole('radio', { name: /Regular/ })).toBeChecked()
  })

  it('blocks a registered scheme without GSTIN on the business step', async () => {
    const user = userEvent.setup()
    await openSignup()
    await user.click(screen.getByRole('radio', { name: /General store/ }))
    await user.click(screen.getByRole('button', { name: /Next/ }))
    await user.type(await screen.findByLabelText(/Shop \/ business name/), 'Sri Murugan Stores')
    await user.click(screen.getByRole('radio', { name: /Composition/ }))
    await user.click(screen.getByRole('button', { name: /Next/ }))
    expect(
      await screen.findByText('GSTIN is required for registered businesses'),
    ).toBeInTheDocument()
  })

  it('creates the shop with a body that satisfies the shared contract and signs in', async () => {
    const user = userEvent.setup()
    let body: Record<string, unknown> | null = null
    server.use(
      http.post(apiPath('/auth/signup'), async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        const parsed = SignupRequestSchema.safeParse(body)
        if (!parsed.success) return errorResponse(400, 'VALIDATION_ERROR', parsed.error.message)
        return HttpResponse.json({ data: makeSession() }, { status: 201 })
      }),
      http.get(apiPath('/me'), () => HttpResponse.json({ data: makeMe() })),
    )
    const { router } = await openSignup()
    await fillToOwnerStep(user, { gstin: VALID_TN_GSTIN })
    await fillOwner(user)
    await user.click(screen.getByRole('button', { name: 'Create my shop' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(body).toMatchObject({
      business_type: 'general_store',
      business_name: 'Sri Murugan Stores',
      business_name_ta: 'ஸ்ரீ முருகன் ஸ்டோர்ஸ்',
      state_code: '33',
      gstin: VALID_TN_GSTIN,
      gst_scheme: 'regular',
      owner_name: 'Murugan K',
      phone: '+919876543210',
      password: 'kadai-secret-1',
      locale: 'en',
    })
    expect(await screen.findByText('Your shop is ready. Vanakkam!')).toBeInTheDocument()
  })

  it('maps server field errors back to their step', async () => {
    const user = userEvent.setup()
    server.use(
      http.post(apiPath('/auth/signup'), () =>
        errorResponse(400, 'VALIDATION_ERROR', 'Invalid', {
          issues: [{ path: 'business_name', message: 'Invalid GSTIN' }],
        }),
      ),
    )
    await openSignup()
    await fillToOwnerStep(user)
    await fillOwner(user)
    await user.click(screen.getByRole('button', { name: 'Create my shop' }))
    expect(await screen.findByText('Tell us about your business')).toBeInTheDocument()
    expect(
      await screen.findByText('This GSTIN is not valid. Check for typing mistakes.'),
    ).toBeInTheDocument()
  })

  it('verifies the owner phone by OTP when the server asks for it, then resubmits', async () => {
    const user = userEvent.setup()
    const signupBodies: Record<string, unknown>[] = []
    server.use(
      http.post(apiPath('/auth/signup'), async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        signupBodies.push(body)
        if (!body.otp_token) {
          return errorResponse(400, 'VALIDATION_ERROR', 'otp required', {
            issues: [{ path: 'otp_token', message: 'Required' }],
          })
        }
        return HttpResponse.json({ data: makeSession() }, { status: 201 })
      }),
      http.post(apiPath('/auth/otp/request'), async ({ request }) => {
        const parsed = OtpRequestSchema.parse(await request.json())
        expect(parsed).toEqual({ phone: '+919876543210', purpose: 'signup' })
        return HttpResponse.json({ data: { expires_in: 300, resend_after: 30 } })
      }),
      http.post(apiPath('/auth/otp/verify'), async ({ request }) => {
        const parsed = OtpVerifyRequestSchema.parse(await request.json())
        if (parsed.code !== '246810') return errorResponse(400, 'OTP_INVALID')
        return HttpResponse.json({
          data: { otp_token: 'otp-token-0123456789abcdef', expires_in: 600 },
        })
      }),
      http.get(apiPath('/me'), () => HttpResponse.json({ data: makeMe() })),
    )
    const { router } = await openSignup()
    await fillToOwnerStep(user)
    await fillOwner(user)
    await user.click(screen.getByRole('button', { name: 'Create my shop' }))

    expect(
      await screen.findByRole('heading', { name: 'Verify your mobile number' }),
    ).toBeInTheDocument()
    expect(
      await screen.findByText(/Enter the 6-digit code sent to \+91 98765 43210/),
    ).toBeInTheDocument()
    // Wrong code first
    await user.type(screen.getByLabelText('Digit 1 of 6'), '111111')
    expect(await screen.findByText('The OTP is incorrect.')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Digit 1 of 6'), '246810')
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(signupBodies).toHaveLength(2)
    expect(signupBodies[1]).toMatchObject({
      otp_token: 'otp-token-0123456789abcdef',
      phone: '+919876543210',
    })
  })
})

describe('OtpCodeInput', () => {
  function Harness({ onComplete }: { onComplete: (v: string) => void }) {
    const [value, setValue] = useState('')
    return <OtpCodeInput value={value} onChange={setValue} onComplete={onComplete} />
  }

  it('fills every box from a pasted SMS text and completes', () => {
    const onComplete = vi.fn()
    render(<Harness onComplete={onComplete} />)
    const first = screen.getByLabelText('Digit 1 of 6')
    fireEvent.paste(first, {
      clipboardData: { getData: () => 'Your Kadai OTP is 482913. Do not share.' },
    })
    expect(onComplete).toHaveBeenCalledWith('482913')
    expect(screen.getByLabelText('Digit 6 of 6')).toHaveValue('3')
  })

  it('moves back with Backspace', async () => {
    const user = userEvent.setup()
    render(<Harness onComplete={() => {}} />)
    await user.type(screen.getByLabelText('Digit 1 of 6'), '12')
    expect(screen.getByLabelText('Digit 2 of 6')).toHaveValue('2')
    await user.keyboard('{Backspace}{Backspace}')
    expect(screen.getByLabelText('Digit 1 of 6')).toHaveValue('')
  })
})
