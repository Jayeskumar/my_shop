import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { NumberSeriesUpdateSchema, identityRoutes } from '@kadai/shared/api/identity'
import { DEFAULT_PLAN_FEATURES } from '@kadai/shared/features'
import { IDS, makeMe } from '@/test/fixtures'
import { server } from '@/test/msw'
import { renderApp, signIn } from '@/test/render'
import { auditLog, page, series } from '../testing/fixtures'
import { onRoute, type RecordedRequest } from '../testing/handlers'

describe('number series', () => {
  it('edits a series with a live example and the 16-character GST limit', async () => {
    const user = userEvent.setup()
    const s = series()
    const calls: RecordedRequest[] = []
    const listCalls: RecordedRequest[] = []
    server.use(
      onRoute(identityRoutes.listNumberSeries, { data: [s] }, listCalls),
      onRoute(
        identityRoutes.updateNumberSeries,
        { data: series({ next_number: 100, next: 'S1-A/2627/00100' }) },
        calls,
      ),
    )
    await signIn()
    renderApp('/settings/number-series')
    expect(await screen.findByText('S1-A/2627/00042')).toBeInTheDocument()
    expect(listCalls[0]!.query.get('fy')).toBe('2026-27')

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog')
    const prefix = within(dialog).getByLabelText(/^Prefix/)
    await user.clear(prefix)
    await user.type(prefix, 'MURUGAN-A/2627/')
    expect(within(dialog).getByText('MURUGAN-A/2627/00042')).toBeInTheDocument()
    expect(
      within(dialog).getByText(/Too long — GST allows at most 16 characters/),
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()

    await user.clear(prefix)
    await user.type(prefix, 's1-a/2627/')
    const next = within(dialog).getByLabelText(/^Next number/)
    await user.clear(next)
    await user.type(next, '10')
    expect(
      within(dialog).getByText(
        'The next number cannot go down — numbers already used must not repeat',
      ),
    ).toBeInTheDocument()
    await user.clear(next)
    await user.type(next, '100')
    expect(within(dialog).getByText('S1-A/2627/00100')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.params).toEqual({ id: s.id })
    expect(calls[0]!.body).toEqual({ next_number: 100, if_updated_at: s.updated_at })
    expect(NumberSeriesUpdateSchema.safeParse(calls[0]!.body).success).toBe(true)
  })

  it('creates a not-yet-used series to continue old numbering', async () => {
    const user = userEvent.setup()
    const unused = series({
      id: null,
      key: `${IDS.store}:-:credit_note:2026-27`,
      register_id: null,
      register_code: null,
      doc_type: 'credit_note',
      prefix: 'CN-S1/2627/',
      next_number: 1,
      next: 'CN-S1/2627/00001',
      issued_count: 0,
      updated_at: null,
    })
    const calls: RecordedRequest[] = []
    server.use(
      onRoute(identityRoutes.listNumberSeries, { data: [unused] }),
      onRoute(identityRoutes.createNumberSeries, { data: { ...unused, id: IDS.device } }, calls),
    )
    await signIn()
    renderApp('/settings/number-series')
    await user.click(await screen.findByRole('button', { name: 'Customise' }))
    const dialog = await screen.findByRole('dialog')
    const next = within(dialog).getByLabelText(/^Next number/)
    await user.clear(next)
    await user.type(next, '231')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.body).toEqual({
      store_id: IDS.store,
      register_id: null,
      doc_type: 'credit_note',
      fy: '2026-27',
      prefix: 'CN-S1/2627/',
      padding: 5,
      next_number: 231,
    })
  })
})

describe('audit log', () => {
  const proMe = () => makeMe({ features: [...DEFAULT_PLAN_FEATURES.pro] })
  // The member filter (shared UserPicker) loads the directory.
  beforeEach(() => {
    server.use(onRoute(identityRoutes.userDirectory, { data: [] }))
  })

  it('lists entries with links and a before → after diff, and filters by area', async () => {
    const user = userEvent.setup()
    const calls: RecordedRequest[] = []
    server.use(onRoute(identityRoutes.listAuditLogs, { data: [auditLog()], page: page(1) }, calls))
    await signIn(proMe())
    renderApp('/settings/audit-log')
    expect(await screen.findByText('Ponni Rice 5 kg: ₹399 → ₹389')).toBeInTheDocument()
    expect(screen.getByText('Price changed')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open record' })).toHaveAttribute(
      'href',
      '/catalog/products/0192f0a0-0000-7000-8000-000000000801',
    )
    await user.click(screen.getByRole('button', { name: 'What changed' }))
    expect(screen.getByText('sale_price_paise')).toBeInTheDocument()
    expect(screen.getByText('39900')).toBeInTheDocument()
    expect(screen.getByText('38900')).toBeInTheDocument()
    expect(calls[0]!.query.get('limit')).toBe('50')
  })

  it('opens the history of one record from the URL', async () => {
    const calls: RecordedRequest[] = []
    server.use(onRoute(identityRoutes.listAuditLogs, { data: [], page: page(0) }, calls))
    await signIn(proMe())
    renderApp(`/settings/audit-log?entity_type=customer&entity_id=${IDS.device}&area=customer`)
    expect(await screen.findByText('History of one Customer')).toBeInTheDocument()
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(calls[0]!.query.get('entity_type')).toBe('customer')
    expect(calls[0]!.query.get('entity_id')).toBe(IDS.device)
    expect(calls[0]!.query.get('action')).toBe('customer')
    expect(screen.getByText('No results found')).toBeInTheDocument()
  })
})

describe('settings navigation', () => {
  it('lists only what the member may open; plan-locked sections are marked', async () => {
    await signIn(makeMe({ features: [...DEFAULT_PLAN_FEATURES.growth] }))
    renderApp('/settings')
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Business details/ })).toHaveAttribute(
      'href',
      '/settings/business',
    )
    // Growth has no audit log: shown with an upgrade mark.
    expect(screen.getByRole('link', { name: /Audit log.*Upgrade/ })).toBeInTheDocument()
    // Pharmacy settings only for pharmacies.
    expect(screen.queryByRole('link', { name: /^Pharmacy/ })).not.toBeInTheDocument()
  })

  it('shows a cashier no settings sections', async () => {
    await signIn(makeMe({ permissions: ['pos.use', 'sales.create', 'sales.read'] }))
    renderApp('/settings')
    expect(await screen.findByText('No settings to change')).toBeInTheDocument()
  })

  it('shows the sub-nav next to a settings page, with pharmacy for pharmacies', async () => {
    server.use(onRoute(identityRoutes.listNumberSeries, { data: [] }))
    await signIn(makeMe({ businessType: 'pharmacy' }))
    renderApp('/settings/number-series')
    const nav = (await screen.findAllByRole('navigation', { name: 'Settings sections' }))[0]!
    expect(within(nav).getByRole('link', { name: /Number series/ })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(nav).getByRole('link', { name: /Pharmacy/ })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: /UPI & payments/ })).toHaveAttribute(
      'href',
      '/settings/payments',
    )
  })
})
