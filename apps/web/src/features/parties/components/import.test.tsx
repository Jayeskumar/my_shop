import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { CustomerImportSchema, partiesRoutes } from '@kadai/shared/api/parties'
import { identityRoutes } from '@kadai/shared/api/identity'
import { errorResponse, server } from '@/test/msw'
import { renderWithProviders, signIn } from '@/test/render'
import { pid } from '../testing/fixtures'
import { createPartiesApi } from '../testing/handlers'
import { CustomerImportDialog } from './CustomerImportDialog'

describe('CustomerImportDialog', () => {
  it('rejects non-CSV files before uploading', async () => {
    const api = createPartiesApi()
    server.use(...api.handlers)
    const user = userEvent.setup({ applyAccept: false })
    await signIn()
    renderWithProviders(<CustomerImportDialog open onOpenChange={() => {}} />)
    const input = screen.getByLabelText(/Tap to choose a CSV file/)
    await user.upload(
      input,
      new File(['x'], 'customers.xlsx', { type: 'application/vnd.ms-excel' }),
    )
    expect(screen.getByText(/Please choose a CSV file/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check file' })).toBeDisabled()
  })

  it('uploads, dry-runs, shows the problems and then imports the valid rows', async () => {
    const api = createPartiesApi()
    server.use(...api.handlers)
    const user = userEvent.setup()
    await signIn()
    renderWithProviders(<CustomerImportDialog open onOpenChange={() => {}} />)
    const file = new File(['name,phone\nKannan,9876500001\n'], 'customers.csv', {
      type: 'text/csv',
    })
    await user.upload(screen.getByLabelText(/Tap to choose a CSV file/), file)
    await user.click(screen.getByRole('button', { name: 'Check file' }))

    const dialog = await screen.findByRole('dialog', { name: 'Import customers' })
    expect(
      await within(dialog).findByText(/1 row has a problem and will be skipped/),
    ).toBeInTheDocument()
    expect(within(dialog).getByText('Enter a valid 10-digit mobile number')).toBeInTheDocument()
    expect(within(dialog).getByText('Kannan')).toBeInTheDocument()

    const upload = api.callsTo(identityRoutes.uploadFile)[0]!
    expect(upload.query.get('purpose')).toBe('import')
    const dry = api.callsTo(partiesRoutes.importCustomers)[0]!
    expect(CustomerImportSchema.parse(dry.body)).toEqual({
      file_id: pid(981),
      dry_run: true,
      mode: 'upsert',
      match_by: 'phone',
    })

    await user.click(within(dialog).getByRole('button', { name: 'Import 2 customers' }))
    expect(
      await within(dialog).findByText(/Done! 2 customers added or updated/),
    ).toBeInTheDocument()
    await waitFor(() => expect(api.callsTo(partiesRoutes.importCustomers)).toHaveLength(2))
    const real = api.callsTo(partiesRoutes.importCustomers)[1]!
    expect((real.body as { dry_run: boolean }).dry_run).toBe(false)
    expect(real.headers.get('idempotency-key')).toBeTruthy()
  })

  it('explains file-level problems next to the file picker', async () => {
    const api = createPartiesApi({
      importCustomers: () =>
        errorResponse(400, 'VALIDATION_ERROR', 'bad file', {
          issues: [{ path: 'file_id', message: 'import_missing_column', code: 'custom' }],
        }),
    })
    server.use(...api.handlers)
    const user = userEvent.setup()
    await signIn()
    renderWithProviders(<CustomerImportDialog open onOpenChange={() => {}} />)
    const file = new File(['phone\n9876500001\n'], 'customers.csv', { type: 'text/csv' })
    await user.upload(screen.getByLabelText(/Tap to choose a CSV file/), file)
    await user.click(screen.getByRole('button', { name: 'Check file' }))
    expect(
      await screen.findByText('A required column is missing. Use the template headings.'),
    ).toBeInTheDocument()
  })
})
