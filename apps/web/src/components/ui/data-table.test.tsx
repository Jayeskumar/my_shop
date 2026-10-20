import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { DataTable, type DataTableColumn } from './data-table'
import { Money } from './money'
import { TooltipProvider } from './tooltip'

interface Row {
  id: string
  name: string
  price_paise: number
}

const columns: DataTableColumn<Row>[] = [
  { accessorKey: 'name', header: 'Name', enableSorting: true, meta: { mobile: 'title' } },
  {
    accessorKey: 'price_paise',
    header: 'Price',
    enableSorting: true,
    cell: (c) => <Money paise={c.getValue<number>()} />,
    meta: { align: 'right' },
  },
]

const rows: Row[] = [
  { id: 'a', name: 'Ponni rice 25 kg', price_paise: 145000 },
  { id: 'b', name: 'Toor dal 1 kg', price_paise: 16500 },
]

function renderTable(props: Partial<Parameters<typeof DataTable<Row>>[0]> = {}) {
  return render(
    <TooltipProvider>
      <DataTable<Row>
        columns={columns}
        data={rows}
        getRowId={(r) => r.id}
        label="Products"
        {...props}
      />
    </TooltipProvider>,
  )
}

describe('DataTable', () => {
  it('renders rows with formatted cells', () => {
    renderTable()
    const table = screen.getByRole('table', { name: 'Products' })
    const bodyRows = within(table).getAllByRole('row').slice(1)
    expect(bodyRows).toHaveLength(2)
    expect(within(bodyRows[0]!).getByText('Ponni rice 25 kg')).toBeInTheDocument()
    expect(within(bodyRows[0]!).getByText('₹1,450.00')).toBeInTheDocument()
  })

  it('shows skeleton rows on first load and an empty state when there is no data', () => {
    const { rerender } = renderTable({ data: [], loading: true })
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true')
    rerender(
      <TooltipProvider>
        <DataTable<Row> columns={columns} data={[]} getRowId={(r) => r.id} />
      </TooltipProvider>,
    )
    expect(screen.getByText('No results found')).toBeInTheDocument()
  })

  it('shows a localized error with retry', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    renderTable({
      data: [],
      error: new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'x' }),
      onRetry,
    })
    expect(screen.getByText(/Could not reach the server/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalled()
  })

  it('calls onRowClick for clicks and Enter', async () => {
    const user = userEvent.setup()
    const onRowClick = vi.fn()
    renderTable({ onRowClick })
    await user.click(screen.getByText('Toor dal 1 kg'))
    expect(onRowClick).toHaveBeenCalledWith(rows[1])
    screen.getAllByRole('row')[1]!.focus()
    await user.keyboard('{Enter}')
    expect(onRowClick).toHaveBeenLastCalledWith(rows[0])
  })

  it('cycles server sorting asc → desc → none via the header', async () => {
    const user = userEvent.setup()
    const onSortChange = vi.fn()
    const { rerender } = renderTable({ sort: null, onSortChange })
    await user.click(screen.getByRole('button', { name: /Name/ }))
    expect(onSortChange).toHaveBeenLastCalledWith('name')
    rerender(
      <TooltipProvider>
        <DataTable<Row>
          columns={columns}
          data={rows}
          getRowId={(r) => r.id}
          sort="name"
          onSortChange={onSortChange}
        />
      </TooltipProvider>,
    )
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )
    await user.click(screen.getByRole('button', { name: /Name/ }))
    expect(onSortChange).toHaveBeenLastCalledWith('-name')
  })

  it('paginates with offset/limit callbacks', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderTable({ pagination: { offset: 0, limit: 50, total: 120, onChange } })
    expect(screen.getByText('1–50 of 120')).toBeInTheDocument()
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Next page' }))
    expect(onChange).toHaveBeenLastCalledWith({ offset: 50, limit: 50 })
    await user.click(screen.getByRole('button', { name: 'Last page' }))
    expect(onChange).toHaveBeenLastCalledWith({ offset: 100, limit: 50 })
  })

  it('supports row selection for bulk actions', async () => {
    const user = userEvent.setup()
    const onSelection = vi.fn()
    renderTable({ selection: { selected: new Set(), onChange: onSelection } })
    const boxes = screen.getAllByRole('checkbox', { name: 'Select' })
    await user.click(boxes[2]!)
    expect(onSelection).toHaveBeenLastCalledWith(new Set(['b']))
    await user.click(boxes[0]!)
    expect(onSelection).toHaveBeenLastCalledWith(new Set(['a', 'b']))
  })

  it('collapses to stacked cards on phones', () => {
    const width = window.innerWidth
    window.innerWidth = 390
    try {
      renderTable()
      expect(screen.queryByRole('table')).not.toBeInTheDocument()
      const list = screen.getByRole('list', { name: 'Products' })
      expect(within(list).getAllByRole('listitem')).toHaveLength(2)
      expect(within(list).getAllByText('Price')).toHaveLength(2)
    } finally {
      window.innerWidth = width
    }
  })
})
