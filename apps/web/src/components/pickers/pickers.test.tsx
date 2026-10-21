import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { AccountBalance } from '@kadai/shared/api/accounting'
import type { Brand, Category, ProductListItem, SellableProduct } from '@kadai/shared/api/catalog'
import type { UserDirectoryEntry } from '@kadai/shared/api/identity'
import type { BatchRow } from '@kadai/shared/api/inventory'
import type { CustomerListItem, Doctor, SupplierListItem } from '@kadai/shared/api/parties'
import { setLanguage } from '@/lib/i18n'
import { IDS, makeMe } from '@/test/fixtures'
import { apiPath, errorResponse, server } from '@/test/msw'
import { renderWithProviders, signIn } from '@/test/render'
import {
  AccountPicker,
  BatchPicker,
  BrandPicker,
  CategoryPicker,
  CustomerPicker,
  DoctorPicker,
  ProductPicker,
  RegisterPicker,
  StorePicker,
  SupplierPicker,
  UserPicker,
  fefoOrder,
  isCodeLike,
  phoneQuery,
} from './index'

const NOW = '2026-10-20T10:00:00.000Z'
let seq = 0
const uid = () => `0192f0a0-0000-7000-8000-${String(++seq).padStart(12, '0')}`
const page = (n: number) => ({ limit: 20, offset: 0, total: n })

function product(over: Partial<ProductListItem> = {}): ProductListItem {
  return {
    id: uid(),
    parent_id: null,
    kind: 'standard',
    sku: 'RICE-5',
    name: 'Ponni Rice 5 kg',
    name_ta: 'பொன்னி அரிசி 5 கிலோ',
    category_id: null,
    category_name: null,
    category_path: null,
    brand_id: null,
    brand_name: null,
    unit: 'PCS',
    pack_size: 1,
    hsn_code: '1006',
    gst_rate_bp: 500,
    tax_slab_rule_id: null,
    price_includes_tax: true,
    mrp_paise: 42_000,
    sale_price_paise: 39_900,
    purchase_price_paise: 35_000,
    track_inventory: true,
    track_batches: false,
    is_active: true,
    image_file_id: null,
    primary_barcode: '8901234567890',
    variant_attributes: {},
    variant_count: 0,
    reorder_level_milli: 5_000,
    stock_qty_milli: 12_000,
    low_stock: false,
    updated_at: NOW,
    ...over,
  }
}

/** The lookup's SellableProduct view of a list row. */
function sellable(p: ProductListItem): SellableProduct {
  return {
    id: p.id,
    parent_id: p.parent_id,
    kind: p.kind,
    sku: p.sku,
    name: p.name,
    name_ta: p.name_ta,
    category_id: p.category_id,
    brand_id: p.brand_id,
    unit: p.unit,
    pack_size: p.pack_size,
    allow_loose: false,
    decimal_qty: false,
    hsn_code: p.hsn_code,
    gst_rate_bp: p.gst_rate_bp,
    cess_rate_bp: 0,
    tax_slab_rule_id: p.tax_slab_rule_id,
    price_includes_tax: p.price_includes_tax,
    mrp_paise: p.mrp_paise,
    sale_price_paise: p.sale_price_paise,
    wholesale_price_paise: null,
    min_sale_price_paise: null,
    max_discount_bp: null,
    track_inventory: p.track_inventory,
    track_batches: p.track_batches,
    is_weighed: false,
    variant_attributes: p.variant_attributes,
    attributes: {},
    image_file_id: null,
    is_active: p.is_active,
    store_price_applied: false,
    stock_qty_milli: p.stock_qty_milli,
  }
}

function customer(over: Partial<CustomerListItem> = {}): CustomerListItem {
  return {
    id: uid(),
    code: null,
    name: 'Lakshmi',
    name_ta: 'லட்சுமி',
    phone: '+919876543210',
    gstin: null,
    state_code: '33',
    customer_type: 'retail',
    price_tier: 'retail',
    balance_paise: 125_000,
    credit_limit_paise: null,
    credit_days: null,
    overdue_paise: 0,
    loyalty_points: 0,
    tags: [],
    whatsapp_opt_in: true,
    is_active: true,
    last_invoice_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  }
}

/** Renders a picker with its value kept in state; `onChange` spies every change. */
function Controlled<V>({
  initial,
  render,
}: {
  initial: V
  render: (value: V, setValue: (v: V) => void) => React.ReactNode
}) {
  const [value, setValue] = useState<V>(initial)
  return <>{render(value, setValue)}</>
}

async function openPicker(user: ReturnType<typeof userEvent.setup>, name?: RegExp) {
  await user.click(name ? screen.getByRole('combobox', { name }) : screen.getByRole('combobox'))
  return screen.findByRole('dialog')
}

describe('picker helpers', () => {
  it('detects codes and phone numbers', () => {
    expect(isCodeLike('8901234567890')).toBe(true)
    expect(isCodeLike('SKU-12')).toBe(true)
    expect(isCodeLike('rice')).toBe(false)
    expect(isCodeLike('rice 5kg')).toBe(false)
    expect(phoneQuery('98765 43210')).toBe('+919876543210')
    expect(phoneQuery('+91 98765-43210')).toBe('+919876543210')
    expect(phoneQuery('12345')).toBeNull()
  })

  it('orders batches FEFO (no expiry last, then oldest)', () => {
    const rows = [
      { expiry_date: null, created_at: '2026-01-01T00:00:00Z' },
      { expiry_date: '2027-03-31', created_at: '2026-02-01T00:00:00Z' },
      { expiry_date: '2026-12-31', created_at: '2026-03-01T00:00:00Z' },
      { expiry_date: '2026-12-31', created_at: '2026-01-15T00:00:00Z' },
    ]
    expect(
      [...rows].sort(fefoOrder).map((r) => `${r.expiry_date}@${r.created_at.slice(5, 7)}`),
    ).toEqual(['2026-12-31@01', '2026-12-31@03', '2027-03-31@02', 'null@01'])
  })
})

describe('ProductPicker', () => {
  it('suggests products, searches as you type and shows names, price and stock', async () => {
    await signIn(makeMe())
    const queries: URLSearchParams[] = []
    const rice = product()
    const dal = product({
      name: 'Toor Dal 1 kg',
      name_ta: 'துவரம் பருப்பு',
      sku: 'DAL-1',
      sale_price_paise: 16_500,
      stock_qty_milli: null,
    })
    server.use(
      http.get(apiPath('/products'), ({ request }) => {
        const q = new URL(request.url).searchParams
        queries.push(q)
        const rows = q.get('q') ? [dal] : [rice, dal]
        return HttpResponse.json({ data: rows, page: page(rows.length) })
      }),
    )
    const onChange = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(
      <Controlled<ProductListItem | null>
        initial={null}
        render={(value, set) => (
          <ProductPicker
            aria-label="Product"
            value={value}
            onChange={(p, pick) => {
              onChange(p, pick)
              set(p)
            }}
          />
        )}
      />,
    )
    const dialog = await openPicker(user)
    expect(await within(dialog).findByText('Ponni Rice 5 kg')).toBeInTheDocument()
    // Other-language name, SKU and barcode under the name; price and stock on the right.
    expect(
      within(dialog).getByText(/பொன்னி அரிசி 5 கிலோ · RICE-5 · 8901234567890/),
    ).toBeInTheDocument()
    expect(within(dialog).getByText('₹399.00')).toBeInTheDocument()
    expect(within(dialog).getAllByText(/Stock/)[0]).toBeInTheDocument()
    const first = queries[0]!
    expect(first.get('hide_variants')).toBe('true')
    expect(first.get('is_active')).toBe('true')
    expect(first.get('store_id')).toBe(IDS.store)

    await user.type(within(dialog).getByRole('combobox'), 'dal')
    await waitFor(() => expect(queries.at(-1)?.get('q')).toBe('dal'))
    expect(queries.at(-1)?.get('hide_variants')).toBeNull()
    await waitFor(() => expect(within(dialog).queryByText('Ponni Rice 5 kg')).toBeNull())
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ id: dal.id }), undefined)
    expect(screen.getByRole('combobox', { name: 'Product' })).toHaveTextContent('Toor Dal 1 kg')
  })

  it('shows the Tamil name first in the Tamil UI', async () => {
    await signIn(makeMe())
    await setLanguage('ta', { persist: false })
    server.use(
      http.get(apiPath('/products'), () => HttpResponse.json({ data: [product()], page: page(1) })),
    )
    const user = userEvent.setup()
    renderWithProviders(<ProductPicker value={null} onChange={() => {}} />)
    const dialog = await openPicker(user)
    expect(await within(dialog).findByText('பொன்னி அரிசி 5 கிலோ')).toBeInTheDocument()
    expect(within(dialog).getByText(/Ponni Rice 5 kg/)).toBeInTheDocument()
  })

  it('looks up a scanned code on Enter and reports the lookup', async () => {
    await signIn(makeMe())
    const rice = product()
    let lookups = 0
    server.use(
      http.get(apiPath('/products/lookup'), ({ request }) => {
        lookups++
        const code = new URL(request.url).searchParams.get('code')
        if (code !== '8901234567890') return errorResponse(404, 'NOT_FOUND')
        return HttpResponse.json({
          data: {
            match: 'barcode',
            code,
            product: sellable(rice),
            qty_milli: 2000,
            price_paise: null,
            barcode_id: uid(),
          },
        })
      }),
      http.get(apiPath('/products'), ({ request }) => {
        const q = new URL(request.url).searchParams
        if (q.getAll('ids').length) return HttpResponse.json({ data: [rice], page: page(1) })
        return HttpResponse.json({ data: [], page: page(0) })
      }),
    )
    const onChange = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(<ProductPicker value={null} onChange={onChange} />)
    const dialog = await openPicker(user)
    const input = within(dialog).getByRole('combobox')
    await user.type(input, '8901234567890{Enter}')
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
    const [picked, pick] = onChange.mock.calls[0]!
    expect(picked.id).toBe(rice.id)
    expect(pick.lookup).toMatchObject({ match: 'barcode', qty_milli: 2000 })

    await openPicker(user)
    await user.type(screen.getByPlaceholderText('Name, SKU or scan barcode'), '0000111{Enter}')
    expect(await screen.findByText('No product with code 0000111')).toBeInTheDocument()
    expect(lookups).toBe(2)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('opens a variant parent instead of picking it, with a way back', async () => {
    await signIn(makeMe())
    const parent = product({
      kind: 'variant_parent',
      name: 'Cotton Shirt',
      name_ta: null,
      sku: 'SHIRT',
      variant_count: 2,
      primary_barcode: null,
    })
    const small = product({
      kind: 'variant',
      parent_id: parent.id,
      name: 'Cotton Shirt',
      name_ta: null,
      sku: 'SHIRT-S',
      variant_attributes: { size: 'S' },
    })
    const medium = product({
      kind: 'variant',
      parent_id: parent.id,
      name: 'Cotton Shirt',
      name_ta: null,
      sku: 'SHIRT-M',
      variant_attributes: { size: 'M' },
    })
    server.use(
      http.get(apiPath('/products'), ({ request }) => {
        const q = new URL(request.url).searchParams
        const rows = q.get('parent_id') === parent.id ? [small, medium] : [parent]
        return HttpResponse.json({ data: rows, page: page(rows.length) })
      }),
    )
    const onChange = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(<ProductPicker value={null} onChange={onChange} />)
    const dialog = await openPicker(user)
    await user.click(await within(dialog).findByText('2 variants'))
    expect(onChange).not.toHaveBeenCalled()
    expect(await within(dialog).findByText('Variants of Cotton Shirt')).toBeInTheDocument()
    expect(await within(dialog).findByText('M')).toBeInTheDocument()
    await user.click(within(dialog).getByText('All products'))
    expect(await within(dialog).findByText('2 variants')).toBeInTheDocument()
    await user.click(within(dialog).getByText('2 variants'))
    await user.click(await within(dialog).findByText('M'))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: medium.id }), undefined)
  })
})

describe('CustomerPicker', () => {
  it('shows dues, looks up a mobile number on Enter and offers to add an unknown one', async () => {
    await signIn(makeMe())
    const lakshmi = customer()
    const overdue = customer({ name: 'Murugan', name_ta: null, phone: null, overdue_paise: 50_000 })
    server.use(
      http.get(apiPath('/customers'), () =>
        HttpResponse.json({ data: [lakshmi, overdue], page: page(2) }),
      ),
      http.get(apiPath('/customers/lookup'), ({ request }) => {
        const phone = new URL(request.url).searchParams.get('phone')
        return phone === '+919876543210'
          ? HttpResponse.json({ data: lakshmi })
          : errorResponse(404, 'NOT_FOUND')
      }),
    )
    const onChange = vi.fn()
    const onCreate = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(<CustomerPicker value={null} onChange={onChange} onCreate={onCreate} />)
    const dialog = await openPicker(user)
    expect(await within(dialog).findByText('Due ₹1,250.00')).toBeInTheDocument()
    expect(within(dialog).getByText('Overdue ₹500.00')).toBeInTheDocument()
    expect(within(dialog).getByText(/98765 43210/)).toBeInTheDocument()

    await user.type(within(dialog).getByRole('combobox'), '98765 43210{Enter}')
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(lakshmi))

    await openPicker(user)
    const input = screen.getByPlaceholderText('Name or mobile number')
    await user.type(input, '9000012345')
    await user.click(await screen.findByText('Add customer with 90000 12345'))
    expect(onCreate).toHaveBeenCalledWith({ phone: '+919000012345' })
    await openPicker(user)
    await user.type(screen.getByPlaceholderText('Name or mobile number'), 'Kavitha')
    await user.click(await screen.findByText('Add “Kavitha”'))
    expect(onCreate).toHaveBeenLastCalledWith({ name: 'Kavitha' })
  })
})

describe('SupplierPicker, DoctorPicker, BrandPicker', () => {
  it('search their lists and render their facts', async () => {
    await signIn(makeMe())
    const supplier: SupplierListItem = {
      id: uid(),
      code: null,
      name: 'Sri Balaji Agencies',
      contact_person: 'Ravi',
      phone: '+919444012345',
      gstin: '33AAAPL1234C1ZV',
      state_code: '33',
      drug_license_no: null,
      payment_terms_days: 30,
      balance_paise: 1_500_000,
      overdue_paise: 0,
      upi_vpa: null,
      is_active: true,
      last_bill_date: '2026-10-01',
      created_at: NOW,
      updated_at: NOW,
    }
    const doctor: Doctor = {
      id: uid(),
      name: 'Dr. Meena',
      registration_no: 'TNMC 12345',
      qualification: 'MBBS',
      phone: null,
      clinic_name: 'Meena Clinic',
      address: {
        line1: undefined,
        line2: undefined,
        city: 'Madurai',
        district: undefined,
        pincode: undefined,
      },
      is_active: true,
      created_at: NOW,
      updated_at: NOW,
    }
    const brand: Brand = {
      id: uid(),
      name: 'Aachi',
      is_active: true,
      product_count: 12,
      created_at: NOW,
      updated_at: NOW,
    }
    let brandQuery: string | null = null
    server.use(
      http.get(apiPath('/suppliers'), () => HttpResponse.json({ data: [supplier], page: page(1) })),
      http.get(apiPath('/doctors'), () => HttpResponse.json({ data: [doctor], page: page(1) })),
      http.get(apiPath('/brands'), ({ request }) => {
        brandQuery = new URL(request.url).searchParams.get('q')
        return HttpResponse.json({ data: brandQuery === 'zz' ? [] : [brand], page: page(1) })
      }),
    )
    const onSupplier = vi.fn()
    const onBrandCreate = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(
      <>
        <SupplierPicker aria-label="Supplier" value={null} onChange={onSupplier} />
        <DoctorPicker aria-label="Doctor" value={null} onChange={() => {}} />
        <BrandPicker aria-label="Brand" value={null} onChange={() => {}} onCreate={onBrandCreate} />
      </>,
    )
    let dialog = await openPicker(user, /Supplier/)
    expect(await within(dialog).findByText('To pay ₹15,000.00')).toBeInTheDocument()
    expect(within(dialog).getByText(/Ravi · 94440 12345 · 33AAAPL1234C1ZV/)).toBeInTheDocument()
    await user.click(within(dialog).getByText('Sri Balaji Agencies'))
    expect(onSupplier).toHaveBeenCalledWith(supplier)

    dialog = await openPicker(user, /Doctor/)
    expect(
      await within(dialog).findByText('Reg. TNMC 12345 · MBBS · Meena Clinic'),
    ).toBeInTheDocument()
    await user.keyboard('{Escape}')

    dialog = await openPicker(user, /Brand/)
    expect(await within(dialog).findByText('Aachi')).toBeInTheDocument()
    await user.type(within(dialog).getByRole('combobox'), 'zz')
    await user.click(await within(dialog).findByText('Add “zz”'))
    expect(onBrandCreate).toHaveBeenCalledWith('zz')
  })
})

describe('AccountPicker and CategoryPicker', () => {
  function account(over: Partial<AccountBalance>): AccountBalance {
    return {
      id: uid(),
      code: '1001',
      name: 'Cash in hand',
      name_ta: 'கையிருப்பு ரொக்கம்',
      type: 'asset',
      subtype: 'cash',
      parent_id: null,
      is_system: true,
      is_active: true,
      store_id: null,
      money_kind: 'cash',
      details: {},
      created_at: NOW,
      updated_at: NOW,
      debit_paise: null,
      credit_paise: null,
      balance_paise: null,
      rollup_balance_paise: null,
      depth: 0,
      has_entries: true,
      ...over,
    } as AccountBalance
  }

  it('loads the chart once (no balances), filters and searches by code', async () => {
    await signIn(makeMe())
    const cash = account({})
    const bank = account({
      code: '1100',
      name: 'SBI current',
      name_ta: null,
      subtype: 'bank',
      money_kind: 'bank',
    })
    const otherStore = account({
      code: '1002',
      name: 'Cash S2',
      name_ta: null,
      store_id: IDS.store2,
    })
    let search = ''
    server.use(
      http.get(apiPath('/accounts'), ({ request }) => {
        search = new URL(request.url).search
        return HttpResponse.json({
          data: {
            as_of: '2026-10-20',
            store_id: null,
            accounts: [cash, bank, otherStore],
            totals: [],
          },
        })
      }),
    )
    const onChange = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(
      <AccountPicker value={null} onChange={onChange} types={['asset']} storeId={IDS.store} />,
    )
    const dialog = await openPicker(user)
    expect(search).toContain('balances=false')
    expect(search).toContain('type=asset')
    expect(await within(dialog).findByText('1001 · Cash in hand')).toBeInTheDocument()
    expect(within(dialog).queryByText(/Cash S2/)).toBeNull()
    await user.type(within(dialog).getByRole('combobox'), '1100')
    await waitFor(() => expect(within(dialog).queryByText('1001 · Cash in hand')).toBeNull())
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith(bank.id, expect.objectContaining({ code: '1100' }))
  })

  it('indents the tree, hides a category with its descendants and limits the depth', async () => {
    await signIn(makeMe())
    const base = {
      hsn_code: null,
      gst_rate_bp: null,
      tax_slab_rule_id: null,
      sort_order: 0,
      is_active: true,
      product_count: 0,
      child_count: 0,
      created_at: NOW,
      updated_at: NOW,
      children: [],
    }
    const grocery: Category = {
      ...base,
      id: uid(),
      parent_id: null,
      name: 'Grocery',
      name_ta: 'மளிகை',
      depth: 1,
      path: 'Grocery',
      path_ta: 'மளிகை',
    }
    const rice: Category = {
      ...base,
      id: uid(),
      parent_id: grocery.id,
      name: 'Rice',
      name_ta: 'அரிசி',
      depth: 2,
      path: 'Grocery > Rice',
      path_ta: 'மளிகை > அரிசி',
    }
    const ponni: Category = {
      ...base,
      id: uid(),
      parent_id: rice.id,
      name: 'Ponni',
      name_ta: null,
      depth: 3,
      path: 'Grocery > Rice > Ponni',
      path_ta: 'மளிகை > அரிசி > Ponni',
    }
    const dairy: Category = {
      ...base,
      id: uid(),
      parent_id: null,
      name: 'Dairy',
      name_ta: null,
      depth: 1,
      path: 'Dairy',
      path_ta: 'Dairy',
    }
    server.use(
      http.get(apiPath('/categories'), ({ request }) => {
        expect(new URL(request.url).searchParams.get('flat')).toBe('true')
        return HttpResponse.json({ data: [grocery, rice, ponni, dairy] })
      }),
    )
    const onChange = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(
      <CategoryPicker value={null} onChange={onChange} excludeId={rice.id} maxDepth={1} />,
    )
    const dialog = await openPicker(user)
    expect(await within(dialog).findByText('Grocery')).toBeInTheDocument()
    expect(within(dialog).queryByText('Rice')).toBeNull()
    expect(within(dialog).queryByText('Ponni')).toBeNull()
    await user.type(within(dialog).getByRole('combobox'), 'மளிகை')
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith(grocery.id, expect.objectContaining({ name: 'Grocery' }))
  })
})

describe('StorePicker, RegisterPicker and UserPicker', () => {
  it('use the /me stores and registers, with "All stores"', async () => {
    await signIn(makeMe())
    const onStore = vi.fn()
    const onRegister = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(
      <>
        <StorePicker aria-label="Store" value="all" allowAll onChange={onStore} />
        <RegisterPicker
          aria-label="Counter"
          value={null}
          storeId={IDS.store2}
          onChange={onRegister}
        />
      </>,
    )
    expect(screen.getByRole('combobox', { name: 'Store' })).toHaveTextContent('All stores')
    let dialog = await openPicker(user, /Store/)
    await user.click(within(dialog).getByText('S2 · Anna Nagar'))
    expect(onStore).toHaveBeenCalledWith(IDS.store2, expect.objectContaining({ code: 'S2' }))
    dialog = await openPicker(user, /Counter/)
    const options = within(dialog).getAllByRole('option')
    expect(options).toHaveLength(1)
    await user.click(options[0]!)
    expect(onRegister).toHaveBeenCalledWith(IDS.register2, expect.objectContaining({ code: 'A' }))
  })

  it('opens on typing into the closed field and filters locally', async () => {
    await signIn(makeMe())
    const user = userEvent.setup()
    renderWithProviders(<StorePicker aria-label="Store" value={null} onChange={() => {}} />)
    screen.getByRole('combobox', { name: 'Store' }).focus()
    await user.keyboard('a')
    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByRole('combobox')
    expect(input).toHaveValue('a')
    await user.type(input, 'nna')
    await waitFor(() => expect(within(dialog).getAllByRole('option')).toHaveLength(1))
    expect(within(dialog).getByRole('option')).toHaveTextContent('S2 · Anna Nagar')
  })

  it('lists members from the user directory', async () => {
    await signIn(makeMe())
    const selvi: UserDirectoryEntry = {
      id: uid(),
      full_name: 'Selvi',
      role_code: 'cashier',
      role_name: 'Cashier',
      role_name_ta: 'காசாளர்',
      status: 'active',
      store_ids: null,
    }
    let search = ''
    server.use(
      http.get(apiPath('/users/directory'), ({ request }) => {
        search = new URL(request.url).search
        return HttpResponse.json({ data: [selvi] })
      }),
    )
    const onChange = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(
      <UserPicker value={null} onChange={onChange} storeId={IDS.store} includeDisabled />,
    )
    await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
    const dialog = await openPicker(user)
    expect(search).toContain(`store_id=${IDS.store}`)
    expect(search).toContain('include_disabled=true')
    await user.click(await within(dialog).findByText('Selvi'))
    expect(onChange).toHaveBeenCalledWith(selvi.id, selvi)
  })
})

describe('BatchPicker', () => {
  function batch(over: Partial<BatchRow>): BatchRow {
    return {
      id: uid(),
      product_id: IDS.user,
      product_name: 'Paracetamol 500',
      product_name_ta: null,
      sku: null,
      unit: 'TAB',
      pack_size: 10,
      batch_no: 'B1',
      mfg_date: null,
      expiry_date: '2027-06-30',
      mrp_paise: 3_000,
      purchase_price_paise: 2_000,
      sale_price_paise: null,
      supplier_id: null,
      supplier_name: null,
      is_active: true,
      qty_milli: 50_000,
      value_cost_paise: 10_000,
      expiry_status: 'ok',
      days_to_expiry: 253,
      created_at: NOW,
      updated_at: NOW,
      ...over,
    }
  }

  it('lists batches FEFO with stock, disables expired ones and needs a product', async () => {
    await signIn(makeMe())
    const later = batch({ batch_no: 'LATE', expiry_date: '2027-06-30' })
    const soon = batch({
      batch_no: 'SOON',
      expiry_date: '2026-11-10',
      expiry_status: 'expiring',
      days_to_expiry: 21,
    })
    const expired = batch({
      batch_no: 'OLD',
      expiry_date: '2026-09-30',
      expiry_status: 'expired',
      days_to_expiry: -20,
    })
    let search = ''
    server.use(
      http.get(apiPath('/batches'), ({ request }) => {
        search = new URL(request.url).search
        return HttpResponse.json({ data: [later, expired, soon], page: page(3) })
      }),
    )
    const onChange = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(
      <Controlled<string | null>
        initial={null}
        render={(productId, setProductId) => (
          <>
            <button type="button" onClick={() => setProductId(IDS.user)}>
              choose product
            </button>
            <BatchPicker
              aria-label="Batch"
              productId={productId}
              value={null}
              onChange={onChange}
            />
          </>
        )}
      />,
    )
    const trigger = screen.getByRole('combobox', { name: 'Batch' })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveTextContent('Choose a product first')
    await user.click(screen.getByText('choose product'))
    await waitFor(() => expect(trigger).toBeEnabled())
    const dialog = await openPicker(user, /Batch/)
    await within(dialog).findByText('LATE')
    expect(search).toContain('with_stock_only=true')
    expect(search).toContain(`store_id=${IDS.store}`)
    const options = within(dialog).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('OLD'),
      expect.stringContaining('SOON'),
      expect.stringContaining('LATE'),
    ])
    expect(options[0]).toHaveAttribute('aria-disabled', 'true')
    expect(within(dialog).getByText('Expires in 21 days')).toBeInTheDocument()
    expect(within(options[2]!).getByText('5 packs', { exact: false })).toBeInTheDocument()
    await user.click(within(dialog).getByText('OLD'))
    expect(onChange).not.toHaveBeenCalled()
    await user.click(within(dialog).getByText('SOON'))
    expect(onChange).toHaveBeenCalledWith(soon.id, expect.objectContaining({ batch_no: 'SOON' }))
  })
})
