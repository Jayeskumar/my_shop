/**
 * Demo shop for StockSense: `pnpm --filter @kadai/server seed:stocksense`.
 *
 * Creates "Sri Murugan Stores" (owner 9876500001 / Kadai@Demo2026) with suppliers and kirana +
 * pharmacy items, then goes through the API like the owner would: purchase bills (stock, last
 * supplier and cost), a sent purchase order, 35 days of past sales as a CSV import, supplier lead
 * times and shelf lives. Re-running only refreshes the imported history and settings.
 */
import { addDays, dayOfWeek, newId, todayIn } from '@kadai/shared'
import { buildApp } from '../src/app'
import { loadConfig } from '../src/config'
import { createLogger } from '../src/core/logger'
import { createTenant } from '../src/core/onboarding'
import { createDeps, destroyDeps } from '../src/core/runtime'
import { JOB_DEFINITIONS } from '../src/jobs/registry'
import { VERSION } from '../src/version'

const PHONE = '9876500001'
const PASSWORD = 'Kadai@Demo2026'

interface Item {
  sku: string
  name: string
  name_ta: string
  category?: string
  unit?: string
  pack_size?: number
  sale: number
  cost: number
  gst: number
  supplier: 'anbu' | 'lakshmi' | 'saravana' | 'balaji' | null
  /** Bought today (base units). */
  stock: number
  /** Average daily sales in the history (base units). */
  daily: number
  weekend?: number
  shelf?: number
  batches?: { no: string; expiry_days: number; qty: number }[]
  reorder_level?: number
  reorder_qty?: number
}

const ITEMS: Item[] = [
  {
    sku: 'RICE5',
    name: 'Ponni rice 5 kg',
    name_ta: 'பொன்னி அரிசி 5 கி',
    category: 'Ponni rice',
    sale: 42_000,
    cost: 36_000,
    gst: 500,
    supplier: 'anbu',
    stock: 8,
    daily: 6,
  },
  {
    sku: 'DAL1',
    name: 'Toor dal 1 kg',
    name_ta: 'துவரம் பருப்பு 1 கி',
    category: 'Toor dal',
    sale: 16_000,
    cost: 13_500,
    gst: 500,
    supplier: 'anbu',
    stock: 40,
    daily: 5,
  },
  {
    sku: 'OIL1',
    name: 'Sunflower oil 1 L',
    name_ta: 'சூரியகாந்தி எண்ணெய் 1 லி',
    category: 'Sunflower oil',
    sale: 15_500,
    cost: 13_800,
    gst: 500,
    supplier: 'anbu',
    stock: 30,
    daily: 8,
  },
  {
    sku: 'MILK',
    name: 'Aavin milk 500 ml',
    name_ta: 'ஆவின் பால் 500 மிலி',
    category: 'Milk',
    sale: 2_700,
    cost: 2_400,
    gst: 0,
    supplier: 'lakshmi',
    stock: 15,
    daily: 40,
    weekend: 1.3,
    shelf: 2,
  },
  {
    sku: 'BREAD',
    name: 'Bread 400 g',
    name_ta: 'ரொட்டி 400 கி',
    category: 'Biscuits & snacks',
    sale: 4_500,
    cost: 3_800,
    gst: 0,
    supplier: 'lakshmi',
    stock: 10,
    daily: 12,
    shelf: 4,
  },
  {
    sku: 'CURD',
    name: 'Curd 500 g',
    name_ta: 'தயிர் 500 கி',
    category: 'Curd & buttermilk',
    sale: 3_500,
    cost: 2_900,
    gst: 0,
    supplier: 'lakshmi',
    stock: 20,
    daily: 15,
    weekend: 1.8,
    shelf: 3,
  },
  {
    sku: 'SUGAR',
    name: 'Sugar 1 kg',
    name_ta: 'சர்க்கரை 1 கி',
    category: 'Sugar & jaggery',
    sale: 4_800,
    cost: 4_300,
    gst: 500,
    supplier: 'anbu',
    stock: 150,
    daily: 10,
  },
  {
    sku: 'TEA',
    name: 'Tea powder 250 g',
    name_ta: 'டீ தூள் 250 கி',
    category: 'Tea',
    sale: 14_000,
    cost: 11_500,
    gst: 500,
    supplier: 'anbu',
    stock: 20,
    daily: 3,
  },
  {
    sku: 'MARIE',
    name: 'Marie biscuits (carton of 24)',
    name_ta: 'மேரி பிஸ்கட் (24 அட்டைப்பெட்டி)',
    category: 'Biscuits',
    pack_size: 24,
    sale: 24_000,
    cost: 20_000,
    gst: 1800,
    supplier: 'saravana',
    stock: 48,
    daily: 30,
  },
  {
    sku: 'SOAP',
    name: 'Neem soap 100 g',
    name_ta: 'வேப்ப சோப்பு 100 கி',
    category: 'Bath soaps',
    sale: 4_000,
    cost: 3_000,
    gst: 1800,
    supplier: 'anbu',
    stock: 400,
    daily: 1,
  },
  {
    sku: 'AGAR',
    name: 'Agarbatti',
    name_ta: 'ஊதுபத்தி',
    category: 'Agarbatti',
    sale: 3_000,
    cost: 2_000,
    gst: 500,
    supplier: 'saravana',
    stock: 60,
    daily: 0,
  },
  {
    sku: 'PARA',
    name: 'Paracetamol 500 (strip of 10)',
    name_ta: 'பாராசிட்டமால் 500 (10 மாத்திரை)',
    unit: 'TAB',
    pack_size: 10,
    sale: 3_000,
    cost: 1_800,
    gst: 1200,
    supplier: 'balaji',
    stock: 0,
    daily: 8,
    batches: [
      { no: 'PX2611', expiry_days: 12, qty: 200 },
      { no: 'PX2709', expiry_days: 300, qty: 100 },
    ],
  },
  {
    sku: 'RAVA',
    name: 'Rava 500 g',
    name_ta: 'ரவை 500 கி',
    category: 'Rava / sooji',
    sale: 4_500,
    cost: 3_600,
    gst: 500,
    supplier: null,
    stock: 0,
    daily: 0,
    reorder_level: 10,
    reorder_qty: 24,
  },
]

const SUPPLIERS = {
  anbu: { name: 'Anbu Agencies', lead: 2 },
  lakshmi: { name: 'Lakshmi Dairy', lead: 1 },
  saravana: { name: 'Saravana Distributors', lead: null },
  balaji: { name: 'Sri Balaji Pharma', lead: 3 },
} as const

async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger(config, VERSION)
  const deps = createDeps(config, {
    logger,
    applicationName: 'kadai-seed',
    jobDefinitions: JOB_DEFINITIONS,
    jobRole: 'producer',
  })
  const app = await buildApp(config, { deps })
  const db = deps.db.systemDb
  try {
    let user = await db
      .selectFrom('users')
      .select('id')
      .where('phone', '=', `+91${PHONE}`)
      .executeTakeFirst()
    if (!user) {
      await createTenant(db, {
        business_name: 'Sri Murugan Stores',
        business_name_ta: 'ஸ்ரீ முருகன் ஸ்டோர்ஸ்',
        business_type: 'general_store',
        gst_scheme: 'unregistered',
        gstin: null,
        state_code: '33',
        locale: 'ta',
        owner: { full_name: 'Murugan', phone: PHONE, password: PASSWORD, pin: null },
        mode: config.mode,
      })
      user = await db
        .selectFrom('users')
        .select('id')
        .where('phone', '=', `+91${PHONE}`)
        .executeTakeFirstOrThrow()
    }
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: PHONE, password: PASSWORD },
    })
    if (login.statusCode !== 200) throw new Error(`login failed: ${login.body}`)
    const session = login.json<{ data: { access_token: string; tenant_id: string } }>().data
    const tenantId = session.tenant_id

    // Ensure the demo tenant is on the 'pro' (Peru) plan and the owner is also a platform admin
    // so every module, feature (shifts, accounting, gst_reports, api_access, notifications) and
    // /platform/* screen can be explored immediately.
    await db
      .updateTable('users')
      .set({ is_platform_admin: true })
      .where('id', '=', user.id)
      .execute()
    await db
      .updateTable('tenants')
      .set({
        plan_code: 'pro',
        gst_scheme: 'regular',
        gstin: '33AABCU9603R1ZM',
      })
      .where('id', '=', tenantId)
      .execute()
    await db
      .updateTable('subscriptions')
      .set({ plan_code: 'pro', status: 'active' })
      .where('tenant_id', '=', tenantId)
      .execute()
    await deps.entitlements.invalidate(tenantId)

    const api = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
      const res = await app.inject({
        method,
        url: `/api/v1${url}`,
        headers: { authorization: `Bearer ${session.access_token}`, 'idempotency-key': newId() },
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      })
      if (res.statusCode >= 300)
        throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`)
      return res.json<{ data: Record<string, unknown> }>().data
    }
    const store = await db
      .selectFrom('stores')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at')
      .executeTakeFirstOrThrow()
    const today = todayIn('Asia/Kolkata')

    const supplierIds: Record<string, string> = {}
    for (const [key, s] of Object.entries(SUPPLIERS)) {
      const existing = await db
        .selectFrom('suppliers')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('name', '=', s.name)
        .executeTakeFirst()
      const id = existing?.id ?? newId()
      if (!existing) {
        await db
          .insertInto('suppliers')
          .values({
            id,
            tenant_id: tenantId,
            name: s.name,
            state_code: '33',
            phone: `+9198400${String(10_001 + Object.keys(supplierIds).length)}`,
          })
          .execute()
      }
      supplierIds[key] = id
    }

    const cats = await db
      .selectFrom('categories')
      .select(['id', 'name'])
      .where('tenant_id', '=', tenantId)
      .execute()
    const categoryIdByName = new Map(cats.map((c) => [c.name, c.id]))

    const productIds: Record<string, string> = {}
    for (const it of ITEMS) {
      const categoryId = it.category ? (categoryIdByName.get(it.category) ?? null) : null
      const existing = await db
        .selectFrom('products')
        .select(['id', 'category_id'])
        .where('tenant_id', '=', tenantId)
        .where('sku', '=', it.sku)
        .executeTakeFirst()
      const id = existing?.id ?? newId()
      if (!existing) {
        await db
          .insertInto('products')
          .values({
            id,
            tenant_id: tenantId,
            kind: 'standard',
            sku: it.sku,
            name: it.name,
            name_ta: it.name_ta,
            category_id: categoryId,
            unit: it.unit ?? 'PCS',
            pack_size: it.pack_size ?? 1,
            track_inventory: true,
            track_batches: Boolean(it.batches),
            sale_price_paise: it.sale,
            purchase_price_paise: it.cost,
            gst_rate_bp: it.gst,
            price_includes_tax: true,
            reorder_level_milli: it.reorder_level ? it.reorder_level * 1000 : null,
            reorder_qty_milli: it.reorder_qty ? it.reorder_qty * 1000 : null,
          })
          .execute()
      } else if (!existing.category_id && categoryId) {
        await db
          .updateTable('products')
          .set({ category_id: categoryId })
          .where('tenant_id', '=', tenantId)
          .where('id', '=', id)
          .execute()
      }
      productIds[it.sku] = id
    }

    const billed = await db
      .selectFrom('purchase_bills')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst()
    if (!billed) {
      // Stock arrives through posted purchase bills, one per supplier.
      for (const key of Object.keys(SUPPLIERS)) {
        const lines = ITEMS.filter(
          (it) => it.supplier === key && (it.stock > 0 || it.batches),
        ).flatMap((it) =>
          it.batches
            ? it.batches.map((b) => ({
                product_id: productIds[it.sku]!,
                qty_milli: b.qty * 1000,
                unit_cost_paise: it.cost,
                batch_no: b.no,
                expiry_date: addDays(today, b.expiry_days),
                mrp_paise: it.sale,
              }))
            : [
                {
                  product_id: productIds[it.sku]!,
                  qty_milli: it.stock * 1000,
                  unit_cost_paise: it.cost,
                },
              ],
        )
        if (lines.length === 0) continue
        const bill = await api('POST', '/purchase-bills', {
          supplier_id: supplierIds[key],
          store_id: store.id,
          supplier_invoice_no: `INV-${newId().slice(-6)}`,
          supplier_invoice_date: today,
          received_date: today,
          lines,
        })
        await api('POST', `/purchase-bills/${String(bill.id)}/post`, {})
      }
      // Four more bread already ordered from the dairy.
      const po = await api('POST', '/purchase-orders', {
        store_id: store.id,
        supplier_id: supplierIds.lakshmi,
        expected_date: addDays(today, 1),
        lines: [{ product_id: productIds.BREAD, qty_milli: 4_000, unit_cost_paise: 3_800 }],
      })
      await api('POST', `/purchase-orders/${String(po.id)}/send`, { via: null })
    }

    // 35 days of past sales (deterministic wobble, weekend peaks for dairy).
    const rows = ['product,date,qty']
    for (let d = 1; d <= 35; d++) {
      const date = addDays(today, -d)
      const dow = dayOfWeek(date)
      ITEMS.forEach((it, i) => {
        if (it.daily <= 0) return
        const weekend = dow === 0 || dow === 6 ? (it.weekend ?? 1) : 1
        const wobble = 1 + 0.2 * Math.sin(d * 1.7 + i)
        const qty = Math.max(0, Math.round(it.daily * weekend * wobble))
        if (qty > 0) rows.push(`${it.sku},${date},${qty}`)
      })
    }
    const imported = await api('POST', '/purchases/sales-history', {
      store_id: store.id,
      csv: rows.join('\n'),
    })

    await api('PUT', '/purchases/stocksense/settings', {
      suppliers: Object.entries(SUPPLIERS).map(([key, s]) => ({
        supplier_id: supplierIds[key],
        lead_time_days: s.lead,
      })),
      products: ITEMS.filter((it) => it.shelf).map((it) => ({
        product_id: productIds[it.sku],
        shelf_life_days: it.shelf,
      })),
    })

    // Seed customers, shift, sales invoices, expenses, payments, UPI provider & API key (idempotent).
    const register = await db
      .selectFrom('registers')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('store_id', '=', store.id)
      .orderBy('created_at')
      .executeTakeFirstOrThrow()

    const existingCustomer = await db
      .selectFrom('customers')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst()
    let customerId = existingCustomer?.id ?? null
    if (!customerId) {
      const cust1 = await api('POST', '/customers', {
        name: 'Lakshmi Mess',
        name_ta: 'லட்சுமி மெஸ்',
        phone: '9840020001',
        customer_type: 'retail',
        credit_limit_paise: 1_500_000,
        credit_days: 15,
        opening_balance_paise: 85_000,
        whatsapp_opt_in: true,
        tags: ['regular', 'mess'],
      })
      customerId = String(cust1.id)
      await api('POST', '/customers', {
        name: 'Ramesh Tea Stall',
        name_ta: 'ரமேஷ் டீ கடை',
        phone: '9840020002',
        customer_type: 'wholesale',
        credit_limit_paise: 2_500_000,
        credit_days: 7,
        opening_balance_paise: 140_000,
        whatsapp_opt_in: true,
        tags: ['tea-shop'],
      })
    }

    const existingShift = await db
      .selectFrom('register_shifts')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'open')
      .executeTakeFirst()
    if (!existingShift) {
      await api('POST', '/shifts/open', {
        register_id: register.id,
        opening_cash_paise: 250_000,
        notes: 'Morning float',
      })
    }

    const existingInvoice = await db
      .selectFrom('sales_invoices')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst()
    if (!existingInvoice) {
      await api('POST', '/sales/invoices', {
        client_ref: newId(),
        status: 'completed',
        store_id: store.id,
        register_id: register.id,
        customer_id: customerId,
        lines: [
          { product_id: productIds.RICE5, qty_milli: 2_000 },
          { product_id: productIds.DAL1, qty_milli: 3_000 },
          { product_id: productIds.OIL1, qty_milli: 2_000 },
        ],
        tenders: [
          { method: 'cash', amount_paise: 100_000, tendered_paise: 100_000 },
          { method: 'upi', amount_paise: 63_000, reference: 'UPI-429811203' },
        ],
      })
      await api('POST', '/sales/invoices', {
        client_ref: newId(),
        status: 'completed',
        store_id: store.id,
        register_id: register.id,
        customer_id: customerId,
        lines: [
          { product_id: productIds.SUGAR, qty_milli: 5_000 },
          { product_id: productIds.TEA, qty_milli: 2_000 },
        ],
        tenders: [{ method: 'cash', amount_paise: 20_000, tendered_paise: 20_000 }],
      })
    }

    const existingExpense = await db
      .selectFrom('expenses')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst()
    if (!existingExpense) {
      const expAcct = await db
        .selectFrom('accounts')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('type', '=', 'expense')
        .where('code', '=', '5310')
        .executeTakeFirst()
      if (expAcct) {
        await api('POST', '/expenses', {
          store_id: store.id,
          expense_date: today,
          expense_account_id: expAcct.id,
          description: 'TNEB shop electricity bill',
          taxable_paise: 185_000,
          gst_rate_bp: 0,
          itc_eligible: false,
          payment_method: 'upi',
          reference: 'TNEB-OCT-2026',
        })
      }
    }

    const existingProvider = await db
      .selectFrom('payment_provider_accounts')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst()
    if (!existingProvider) {
      await api('POST', '/payment-providers', {
        display_name: 'Shop Counter UPI',
        provider: 'upi_vpa',
        store_id: store.id,
        is_default: true,
        vpa: 'srimurugan@okaxis',
        payee_name: 'Sri Murugan Stores',
        merchant_code: '5411',
      })
    }

    const existingApiKey = await db
      .selectFrom('api_keys')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst()
    if (!existingApiKey) {
      await api('POST', '/api-keys', {
        name: 'Tally Prime Sync',
        permissions: ['catalog.read', 'sales.read', 'inventory.read', 'accounting.read'],
        store_ids: null,
        expires_at: null,
      })
    }

    console.log(
      `StockSense demo ready: ${String(imported.imported_rows)} history rows. Sign in with ${PHONE} / ${PASSWORD} and open /purchases/stocksense.`,
    )
  } finally {
    await app.close()
    await destroyDeps(deps)
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
