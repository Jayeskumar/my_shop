import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GstPeriodQuerySchema, Gstr1ExportQuerySchema } from '@kadai/shared/api/reports'
import { addPeriods, periodOf, todayIn } from '@kadai/shared/fy'
import type { MeResponse } from '@kadai/shared/api/auth'
import { makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import { compositionFixture, gstr1Fixture } from '../testing/fixtures'
import { apiError, createReportsApi, json } from '../testing/handlers'

const FIRST_PAINT = { timeout: 8_000 }
const lastMonth = addPeriods(periodOf(todayIn('Asia/Kolkata')), -1)

function setup(replies: Parameters<typeof createReportsApi>[0] = {}) {
  const api = createReportsApi(replies)
  server.use(...api.handlers)
  return api
}

function meWithScheme(scheme: MeResponse['tenant']['gst_scheme']): MeResponse {
  const me = makeMe()
  return {
    ...me,
    tenant: {
      ...me.tenant,
      gst_scheme: scheme,
      gstin: scheme === 'unregistered' ? null : me.tenant.gstin,
    },
  }
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:gst')
  URL.revokeObjectURL = vi.fn()
})

describe('GST returns', () => {
  it('opens last month’s GSTR-1 with the warnings to fix and the section cards', async () => {
    const api = setup()
    await signIn(makeMe())
    renderApp('/reports/gst')
    const warnings = await screen.findByRole('region', { name: 'Check before filing' }, FIRST_PAINT)
    expect(within(warnings).getByText(/customer's GSTIN is not valid/)).toBeInTheDocument()
    const fixLinks = within(warnings).getAllByRole('link', { name: /Fix/ })
    expect(fixLinks[0]).toHaveAttribute('href', expect.stringMatching(/^\/parties\/customers\//))
    expect(screen.getByText('33AAAPL1234C1ZV')).toBeInTheDocument()

    const query = api.callsTo('gstr1')[0]!.query
    expect(query.get('period')).toBe(lastMonth)
    expect(query.get('gstin')).toBeNull()
    expect(GstPeriodQuerySchema.safeParse(Object.fromEntries(query)).success).toBe(true)

    // B2B is open first; B2C others drills down on click.
    const b2b = screen.getByRole('table', { name: 'B2B invoices (4A)' })
    expect(within(b2b).getByRole('link', { name: 'S1/2627/00412' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/sales\/invoices\//),
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('tab', { name: /B2C others \(7\)/ }))
    const b2cs = await screen.findByRole('table', { name: 'B2C others (7)' })
    expect(within(b2cs).getAllByText('33 · Tamil Nadu').length).toBeGreaterThan(0)
  })

  it('asks before downloading the portal JSON while errors remain, then downloads it', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/reports/gst')
    await screen.findByRole('region', { name: 'Check before filing' }, FIRST_PAINT)
    await user.click(screen.getByRole('button', { name: 'Download JSON for GST portal' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/1 problem may make the portal reject/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Download anyway' }))
    await waitFor(() => expect(api.callsTo('gstr1Export')).toHaveLength(1))
    const query = api.callsTo('gstr1Export')[0]!.query
    expect(query.get('format')).toBe('json')
    expect(query.get('period')).toBe(lastMonth)
    expect(query.get('section')).toBeNull()
    expect(Gstr1ExportQuerySchema.safeParse(Object.fromEntries(query)).success).toBe(true)
    expect(
      await screen.findByText(/Downloaded GSTR1_33AAAPL1234C1ZV_092026.json/),
    ).toBeInTheDocument()
  })

  it('downloads one section as CSV straight away when nothing blocks filing', async () => {
    const api = setup({ gstr1: () => json({ data: gstr1Fixture({ warnings: [] }) }) })
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/reports/gst')
    expect(await screen.findByText(/No problems found/, {}, FIRST_PAINT)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'CSV of this section' }))
    await waitFor(() => expect(api.callsTo('gstr1Export')).toHaveLength(1))
    const query = api.callsTo('gstr1Export')[0]!.query
    expect(query.get('format')).toBe('csv')
    expect(query.get('section')).toBe('b2b')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('moves between months and shows GSTR-3B in the form layout', async () => {
    const api = setup()
    const user = userEvent.setup()
    await signIn(makeMe())
    renderApp('/reports/gst')
    await screen.findByRole('region', { name: 'Check before filing' }, FIRST_PAINT)
    await user.click(screen.getByRole('button', { name: 'Previous month' }))
    await waitFor(() =>
      expect(api.callsTo('gstr1').at(-1)!.query.get('period')).toBe(addPeriods(lastMonth, -1)),
    )
    await user.click(screen.getByRole('tab', { name: 'GSTR-3B' }))
    expect(await screen.findByText('Tax to pay in cash')).toBeInTheDocument()
    expect(screen.getByRole('table', { name: '6.1 Payment of tax' })).toBeInTheDocument()
    expect(api.callsTo('gstr3b').at(-1)!.query.get('period')).toBe(addPeriods(lastMonth, -1))
  })

  it('shows composition dealers their quarterly summary', async () => {
    const api = setup({ gstr1: () => json({ data: compositionFixture() }) })
    await signIn(meWithScheme('composition'))
    renderApp('/reports/gst')
    const table = await screen.findByRole(
      'table',
      { name: 'Composition summary 2026-27' },
      FIRST_PAINT,
    )
    expect(within(table).getByText('Jul – Sep (Q2)')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'GSTR-3B' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Download JSON for GST portal' }),
    ).not.toBeInTheDocument()
    expect(api.callsTo('gstr3b')).toHaveLength(0)
  })

  it('explains that unregistered shops file no return, without calling the server', async () => {
    const api = setup()
    await signIn(meWithScheme('unregistered'))
    renderApp('/reports/gst')
    expect(
      await screen.findByText('Your business is not registered under GST', {}, FIRST_PAINT),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Business settings' })).toHaveAttribute(
      'href',
      '/settings/business',
    )
    expect(api.callsTo('gstr1')).toHaveLength(0)
  })

  it('tells a store-restricted member that returns need every store', async () => {
    setup({ gstr1: () => apiError(403, 'FORBIDDEN', { reason: 'all_stores_required' }) })
    await signIn(makeMe())
    renderApp('/reports/gst')
    expect(
      await screen.findByText('GST returns need all stores', {}, FIRST_PAINT),
    ).toBeInTheDocument()
  })
})
