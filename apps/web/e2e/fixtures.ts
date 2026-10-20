import type { Page } from '@playwright/test'

const tenantId = '0192f0a0-0000-7000-8000-000000000101'

export const user = {
  id: '0192f0a0-0000-7000-8000-000000000001',
  full_name: 'Murugan K',
  phone: '+919876543210',
  email: null,
  preferred_locale: 'ta',
  is_platform_admin: false,
}

export const session = {
  access_token: 'e2e-token',
  token_type: 'Bearer',
  expires_in: 900,
  user,
  memberships: [
    {
      tenant_id: tenantId,
      tenant_name: 'Sri Murugan Stores',
      business_type: 'general_store',
      role_code: 'owner',
    },
  ],
  tenant_id: tenantId,
}

export const me = {
  user,
  tenant: {
    id: tenantId,
    name: 'Sri Murugan Stores',
    name_ta: 'ஸ்ரீ முருகன் ஸ்டோர்ஸ்',
    legal_name: null,
    business_type: 'general_store',
    gst_scheme: 'regular',
    gstin: null,
    pan: null,
    state_code: '33',
    phone: null,
    email: null,
    address: {},
    logo_file_id: null,
    default_locale: 'ta',
    timezone: 'Asia/Kolkata',
    fy_start_month: 4,
    status: 'active',
    plan_code: 'free',
  },
  membership: {
    id: '0192f0a0-0000-7000-8000-000000000201',
    role_code: 'cashier',
    role_name: 'Cashier',
    permissions: ['pos.use', 'sales.create', 'sales.read', 'catalog.read', 'customers.read'],
    store_ids: null,
  },
  entitlements: {
    plan_code: 'free',
    features: [
      'pos',
      'catalog',
      'inventory',
      'customers',
      'suppliers',
      'upi_static',
      'reports_basic',
      'gst_invoice',
      'khata',
    ],
    limits: { stores: 1, users: 2, registers: 1, products: 1000, invoices_per_month: 300 },
    source: 'plan',
    valid_until: null,
  },
  settings: {},
  stores: [
    {
      id: '0192f0a0-0000-7000-8000-000000000301',
      code: 'S1',
      name: 'Main store',
      name_ta: 'முதன்மைக் கிளை',
      state_code: '33',
      gstin: null,
      is_active: true,
    },
  ],
  registers: [
    {
      id: '0192f0a0-0000-7000-8000-000000000401',
      store_id: '0192f0a0-0000-7000-8000-000000000301',
      code: 'A',
      name: 'Counter A',
      is_active: true,
    },
  ],
  mode: 'cloud',
  device: null,
}

/** Mocks the Kadai API for a cloud deployment; `signedIn` controls the refresh cookie. */
export async function mockApi(page: Page, { signedIn }: { signedIn: boolean }): Promise<void> {
  await page.route('**/health/live', (route) => route.fulfill({ json: { status: 'ok' } }))
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '')
    const error = (status: number, code: string) =>
      route.fulfill({ status, json: { error: { code, message: code } } })
    if (path === '/setup/status') return error(404, 'NOT_FOUND')
    if (path === '/auth/refresh')
      return signedIn ? route.fulfill({ json: { data: session } }) : error(401, 'UNAUTHENTICATED')
    if (path === '/auth/login') return route.fulfill({ json: { data: session } })
    if (path === '/me') return route.fulfill({ json: { data: me } })
    return error(404, 'NOT_FOUND')
  })
}
