/**
 * Demo data for a local Kadai install: one supermarket in Chennai with its owner login, master
 * data (products, suppliers, customers) and purchases activity posted through the real API
 * (orders, bills → stock + ledger, a return, supplier payments, sales history for StockSense).
 *
 *   pnpm --filter @kadai/server exec tsx scripts/seed-demo.ts
 *
 * Master data goes straight into the tables (the catalogue / parties modules are not merged on
 * this branch yet); everything financial goes through the purchases routes and core services.
 * Refuses to run twice: delete the demo tenant (or the database) to reseed.
 */
import { addDays, makeGstin, newId } from '@kadai/shared'
import { buildApp } from '../src/app'
import { loadConfig, loadDotEnv } from '../src/config'
import { systemContext } from '../src/core/context'
import { createTenant } from '../src/core/onboarding'
import { recordPayment } from '../src/core/payments'
import { withTenant } from '../src/db/tenant'

export const DEMO_PHONE = '+919000000001'
export const DEMO_PASSWORD = 'KadaiDemo@2026'
const API = '/api/v1'

loadDotEnv()
const config = loadConfig({
  ...process.env,
  KADAI_SERVE_WEB: 'false',
  KADAI_EMBEDDED_WORKER: 'false',
  KADAI_MIGRATE_ON_BOOT: 'false',
  LOG_LEVEL: 'warn',
  RATE_LIMIT_GLOBAL_MAX: '100000',
})
const app = await buildApp(config)
await app.ready()
const { systemDb, appDb } = app.kadai.db

const existing = await systemDb
  .selectFrom('users')
  .select('id')
  .where('phone', '=', DEMO_PHONE)
  .executeTakeFirst()
if (existing) {
  console.log(`Demo data already present (user ${DEMO_PHONE}); nothing to do.`)
  await app.close()
  process.exit(0)
}

// ---- tenant, owner, store ------------------------------------------------------------------
const created = await createTenant(systemDb, {
  business_name: 'Sri Murugan Supermarket',
  business_name_ta: 'ஸ்ரீ முருகன் சூப்பர் மார்க்கெட்',
  business_type: 'supermarket',
  gstin: makeGstin('33', 'ABCPM1234K'),
  state_code: '33',
  address: { line1: '12, Usman Road', line2: 'T. Nagar', city: 'Chennai', district: 'Chennai', pincode: '600017', state_code: '33' },
  locale: 'en',
  owner: {
    full_name: 'Murugan Selvam',
    phone: DEMO_PHONE,
    email: 'owner@demo.kadai.local',
    password: DEMO_PASSWORD,
    pin: '2468',
  },
  store_name: 'T. Nagar',
  mode: 'cloud',
})
const tenantId = created.tenant.id
const storeId = created.store.id
const userId = created.user.id
console.log(`tenant ${created.tenant.name} (${tenantId})`)

// ---- categories & brands -------------------------------------------------------------------
const cats = await systemDb
  .selectFrom('categories')
  .select(['id', 'name'])
  .where('tenant_id', '=', tenantId)
  .execute()
const cat = (name: string): string | null => cats.find((c) => c.name === name)?.id ?? null

const brandIds = new Map<string, string>()
for (const name of ['Aachi', 'Aavin', 'Britannia', 'Gold Winner', 'Idhayam', 'Sakthi', 'Colgate', 'Hamam', 'Bru', 'Tata', 'Fortune', 'Surf Excel']) {
  const id = newId()
  await systemDb.insertInto('brands').values({ id, tenant_id: tenantId, name }).execute()
  brandIds.set(name, id)
}

// ---- products ------------------------------------------------------------------------------
interface P {
  sku: string
  name: string
  name_ta: string
  unit: string
  gst: number // bp
  hsn: string
  cost: number // ₹ per pack excl. tax
  sale: number // ₹ incl. tax
  mrp: number | null
  reorder: [number, number] | null // [level, qty] in units
  category: string | null
  brand: string | null
  batches?: boolean
  barcode?: string
  /** Typical daily sales (units) for the demand history. */
  daily: number
  /** Shelf life in days (StockSense caps orders so stock sells before it expires). */
  shelf?: number
}
const R = (rupees: number): number => Math.round(rupees * 100)
const PRODUCTS: P[] = [
  { sku: 'RICE-PONNI-25', name: 'Ponni Raw Rice 25 kg bag', name_ta: 'பொன்னி அரிசி 25 கிலோ', unit: 'BAG', gst: 500, hsn: '1006', cost: 1250, sale: 1450, mrp: 1500, reorder: [8, 20], category: 'Ponni rice', brand: null, daily: 2.2 },
  { sku: 'RICE-IDLI-10', name: 'Idli Rice 10 kg', name_ta: 'இட்லி அரிசி 10 கிலோ', unit: 'BAG', gst: 500, hsn: '1006', cost: 430, sale: 520, mrp: 550, reorder: [6, 15], category: 'Idli rice', brand: null, daily: 1.4 },
  { sku: 'DAL-TOOR-1', name: 'Toor Dal 1 kg', name_ta: 'துவரம் பருப்பு 1 கிலோ', unit: 'PKT', gst: 500, hsn: '0713', cost: 138, sale: 165, mrp: 175, reorder: [30, 60], category: 'Toor dal', brand: null, barcode: '8901000000011', daily: 9 },
  { sku: 'DAL-URAD-1', name: 'Urad Dal 1 kg', name_ta: 'உளுத்தம் பருப்பு 1 கிலோ', unit: 'PKT', gst: 500, hsn: '0713', cost: 122, sale: 148, mrp: 155, reorder: [20, 40], category: 'Urad dal', brand: null, daily: 5.5 },
  { sku: 'DAL-CHANA-500', name: 'Chana Dal 500 g', name_ta: 'கடலைப் பருப்பு 500 கி', unit: 'PKT', gst: 500, hsn: '0713', cost: 44, sale: 55, mrp: 58, reorder: [20, 40], category: 'Chana dal', brand: null, daily: 4 },
  { sku: 'OIL-GN-1L', name: 'Idhayam Groundnut Oil 1 L', name_ta: 'இதயம் கடலை எண்ணெய் 1 லி', unit: 'BTL', gst: 500, hsn: '1508', cost: 172, sale: 199, mrp: 210, reorder: [24, 48], category: 'Groundnut oil', brand: 'Idhayam', barcode: '8901000000028', daily: 7 },
  { sku: 'OIL-GINGELLY-1L', name: 'Idhayam Gingelly Oil 1 L', name_ta: 'இதயம் நல்லெண்ணெய் 1 லி', unit: 'BTL', gst: 500, hsn: '1515', cost: 310, sale: 360, mrp: 380, reorder: [12, 24], category: 'Gingelly oil', brand: 'Idhayam', daily: 3 },
  { sku: 'OIL-SUN-1L', name: 'Gold Winner Sunflower Oil 1 L', name_ta: 'கோல்டு வின்னர் சூரியகாந்தி எண்ணெய் 1 லி', unit: 'BTL', gst: 500, hsn: '1512', cost: 128, sale: 149, mrp: 160, reorder: [36, 72], category: 'Sunflower oil', brand: 'Gold Winner', barcode: '8901000000035', daily: 12 },
  { sku: 'OIL-COCO-500', name: 'Coconut Oil 500 ml', name_ta: 'தேங்காய் எண்ணெய் 500 மி.லி', unit: 'BTL', gst: 500, hsn: '1513', cost: 118, sale: 140, mrp: 150, reorder: [12, 24], category: 'Coconut oil', brand: null, daily: 2.5 },
  { sku: 'SPC-SAMBAR-200', name: 'Aachi Sambar Powder 200 g', name_ta: 'ஆச்சி சாம்பார் பொடி 200 கி', unit: 'PKT', gst: 500, hsn: '0910', cost: 62, sale: 78, mrp: 82, reorder: [24, 48], category: 'Spices & masala', brand: 'Aachi', batches: true, daily: 6, shelf: 240 },
  { sku: 'SPC-CHILLI-200', name: 'Sakthi Chilli Powder 200 g', name_ta: 'சக்தி மிளகாய் தூள் 200 கி', unit: 'PKT', gst: 500, hsn: '0904', cost: 58, sale: 72, mrp: 76, reorder: [24, 48], category: 'Chillies', brand: 'Sakthi', batches: true, daily: 5, shelf: 240 },
  { sku: 'SPC-TURMERIC-100', name: 'Sakthi Turmeric Powder 100 g', name_ta: 'சக்தி மஞ்சள் தூள் 100 கி', unit: 'PKT', gst: 500, hsn: '0910', cost: 30, sale: 38, mrp: 40, reorder: [20, 40], category: 'Turmeric', brand: 'Sakthi', batches: true, daily: 3, shelf: 300 },
  { sku: 'MILK-AAVIN-500', name: 'Aavin Toned Milk 500 ml', name_ta: 'ஆவின் பால் 500 மி.லி', unit: 'PKT', gst: 0, hsn: '0401', cost: 22, sale: 25, mrp: 25, reorder: [60, 120], category: null, brand: 'Aavin', batches: true, daily: 70, shelf: 3 },
  { sku: 'GHEE-AAVIN-200', name: 'Aavin Ghee 200 ml', name_ta: 'ஆவின் நெய் 200 மி.லி', unit: 'BTL', gst: 1200, hsn: '0405', cost: 120, sale: 150, mrp: 155, reorder: [10, 20], category: null, brand: 'Aavin', batches: true, daily: 1.8, shelf: 270 },
  { sku: 'BIS-GOODDAY-75', name: 'Britannia Good Day 75 g', name_ta: 'பிரிட்டானியா குட் டே 75 கி', unit: 'PKT', gst: 1800, hsn: '1905', cost: 8, sale: 10, mrp: 10, reorder: [60, 120], category: null, brand: 'Britannia', batches: true, barcode: '8901000000042', daily: 25, shelf: 150 },
  { sku: 'BIS-MARIE-250', name: 'Britannia Marie Gold 250 g', name_ta: 'பிரிட்டானியா மேரி கோல்டு 250 கி', unit: 'PKT', gst: 1800, hsn: '1905', cost: 30, sale: 40, mrp: 40, reorder: [30, 60], category: null, brand: 'Britannia', batches: true, daily: 8, shelf: 180 },
  { sku: 'TEA-TATA-250', name: 'Tata Tea Gold 250 g', name_ta: 'டாடா டீ கோல்டு 250 கி', unit: 'PKT', gst: 500, hsn: '0902', cost: 150, sale: 180, mrp: 190, reorder: [15, 30], category: null, brand: 'Tata', daily: 3.5 },
  { sku: 'COF-BRU-200', name: 'Bru Filter Coffee 200 g', name_ta: 'ப்ரூ பில்டர் காபி 200 கி', unit: 'PKT', gst: 500, hsn: '0901', cost: 175, sale: 210, mrp: 220, reorder: [12, 24], category: null, brand: 'Bru', daily: 2.8 },
  { sku: 'SALT-TATA-1', name: 'Tata Salt 1 kg', name_ta: 'டாடா உப்பு 1 கிலோ', unit: 'PKT', gst: 0, hsn: '2501', cost: 24, sale: 28, mrp: 30, reorder: [30, 60], category: null, brand: 'Tata', barcode: '8901000000059', daily: 8 },
  { sku: 'SUGAR-1', name: 'Sugar 1 kg', name_ta: 'சர்க்கரை 1 கிலோ', unit: 'PKT', gst: 500, hsn: '1701', cost: 40, sale: 46, mrp: 48, reorder: [40, 80], category: null, brand: null, daily: 14 },
  { sku: 'ATTA-FORTUNE-5', name: 'Fortune Chakki Atta 5 kg', name_ta: 'பார்ச்சூன் கோதுமை மாவு 5 கிலோ', unit: 'BAG', gst: 500, hsn: '1101', cost: 225, sale: 265, mrp: 280, reorder: [10, 20], category: null, brand: 'Fortune', daily: 2 },
  { sku: 'SOAP-HAMAM-100', name: 'Hamam Soap 100 g', name_ta: 'ஹமாம் சோப் 100 கி', unit: 'PCS', gst: 1800, hsn: '3401', cost: 30, sale: 40, mrp: 42, reorder: [36, 72], category: null, brand: 'Hamam', barcode: '8901000000066', daily: 6 },
  { sku: 'PASTE-COLGATE-150', name: 'Colgate Strong Teeth 150 g', name_ta: 'கோல்கேட் பற்பசை 150 கி', unit: 'PCS', gst: 1800, hsn: '3306', cost: 78, sale: 99, mrp: 105, reorder: [24, 48], category: null, brand: 'Colgate', daily: 4 },
  { sku: 'DET-SURF-1', name: 'Surf Excel Easy Wash 1 kg', name_ta: 'சர்ப் எக்செல் 1 கிலோ', unit: 'PKT', gst: 1800, hsn: '3402', cost: 115, sale: 145, mrp: 150, reorder: [15, 30], category: null, brand: 'Surf Excel', daily: 3 },
]

const productIds = new Map<string, string>()
for (const p of PRODUCTS) {
  const id = newId()
  productIds.set(p.sku, id)
  await systemDb
    .insertInto('products')
    .values({
      id,
      tenant_id: tenantId,
      kind: 'standard',
      sku: p.sku,
      name: p.name,
      name_ta: p.name_ta,
      unit: p.unit,
      pack_size: 1,
      track_inventory: true,
      track_batches: p.batches ?? false,
      purchase_price_paise: R(p.cost),
      sale_price_paise: R(p.sale),
      mrp_paise: p.mrp === null ? null : R(p.mrp),
      gst_rate_bp: p.gst,
      hsn_code: p.hsn,
      price_includes_tax: true,
      reorder_level_milli: p.reorder ? p.reorder[0] * 1000 : null,
      reorder_qty_milli: p.reorder ? p.reorder[1] * 1000 : null,
      category_id: p.category ? cat(p.category) : null,
      attributes: JSON.stringify(p.shelf ? { shelf_life_days: p.shelf } : {}),
      brand_id: p.brand ? (brandIds.get(p.brand) ?? null) : null,
      created_by: userId,
    })
    .execute()
  if (p.barcode) {
    await systemDb
      .insertInto('product_barcodes')
      .values({ id: newId(), tenant_id: tenantId, product_id: id, barcode: p.barcode })
      .execute()
  }
}
const pid = (sku: string): string => productIds.get(sku)!
console.log(`${PRODUCTS.length} products`)

// ---- suppliers & customers -----------------------------------------------------------------
const SUPPLIERS = [
  { key: 'rice', name: 'Kaveri Rice Traders', contact: 'Ramesh K', phone: '+919000000101', pan: 'AAKFK1234R', state: '33', terms: 15, city: 'Kumbakonam' },
  { key: 'oil', name: 'Idhayam Oil Distributors', contact: 'Senthil V', phone: '+919000000102', pan: 'AAACI5678D', state: '33', terms: 21, city: 'Virudhunagar' },
  { key: 'fmcg', name: 'Chennai FMCG Agencies', contact: 'Priya S', phone: '+919000000103', pan: 'AADFC2345M', state: '33', terms: 30, city: 'Chennai' },
  { key: 'dairy', name: 'Aavin Milk Depot – T. Nagar', contact: 'Depot desk', phone: '+919000000104', pan: 'AAATT0001A', state: '33', terms: 7, city: 'Chennai' },
  { key: 'spice', name: 'Bengaluru Spice Wholesale', contact: 'Manjunath B', phone: '+919000000105', pan: 'AAGFB3456S', state: '29', terms: 30, city: 'Bengaluru' },
] as const
const supplierIds = new Map<string, string>()
for (const s of SUPPLIERS) {
  const id = newId()
  supplierIds.set(s.key, id)
  await systemDb
    .insertInto('suppliers')
    .values({
      id,
      tenant_id: tenantId,
      name: s.name,
      contact_person: s.contact,
      phone: s.phone,
      gstin: makeGstin(s.state, s.pan),
      pan: s.pan,
      state_code: s.state,
      address: JSON.stringify({ city: s.city, state_code: s.state }),
      payment_terms_days: s.terms,
      created_by: userId,
    })
    .execute()
}
const sid = (key: string): string => supplierIds.get(key)!

const CUSTOMERS = [
  ['Lakshmi Narayanan', 'லட்சுமி நாராயணன்', '+919000000201', 'retail', 500_000],
  ['Karthik Raja', 'கார்த்திக் ராஜா', '+919000000202', 'retail', 300_000],
  ['Meena Sundaram', 'மீனா சுந்தரம்', '+919000000203', 'retail', null],
  ['Hotel Saravana Bhavan Mess', 'ஹோட்டல் சரவணா மெஸ்', '+919000000204', 'wholesale', 2_500_000],
  ['Anitha Devi', 'அனிதா தேவி', '+919000000205', 'retail', 200_000],
  ['Ganesh Tiffin Centre', 'கணேஷ் டிபன் சென்டர்', '+919000000206', 'business', 1_000_000],
] as const
for (const [name, name_ta, phone, type, limit] of CUSTOMERS) {
  await systemDb
    .insertInto('customers')
    .values({
      id: newId(),
      tenant_id: tenantId,
      name,
      name_ta,
      phone,
      state_code: '33',
      customer_type: type,
      price_tier: type === 'retail' ? 'retail' : 'wholesale',
      credit_limit_paise: limit,
      credit_days: limit ? 15 : null,
      created_by: userId,
    })
    .execute()
}
console.log(`${SUPPLIERS.length} suppliers, ${CUSTOMERS.length} customers`)

// ---- API session ---------------------------------------------------------------------------
const login = await app.inject({
  method: 'POST',
  url: `${API}/auth/login`,
  headers: { 'x-kadai-token-delivery': 'body' },
  payload: { identifier: DEMO_PHONE, password: DEMO_PASSWORD },
})
if (login.statusCode !== 200) throw new Error(`login failed: ${login.body}`)
const token = login.json<{ data: { access_token: string } }>().data.access_token

async function call<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
): Promise<T> {
  const res = await app.inject({
    method,
    url: `${API}${url}`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  })
  if (res.statusCode >= 300) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`)
  return res.json<{ data: T }>().data
}

// ---- dates ---------------------------------------------------------------------------------
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
const d = (offset: number): string => addDays(today, offset)

// ---- purchase bills (stock in) -------------------------------------------------------------
interface Line {
  sku: string
  qty: number
  cost?: number
  batch?: boolean
  expiryDays?: number
}
function billLines(lines: Line[], billDate: string) {
  return lines.map((l, i) => {
    const p = PRODUCTS.find((x) => x.sku === l.sku)!
    return {
      product_id: pid(l.sku),
      qty_milli: l.qty * 1000,
      unit_cost_paise: R(l.cost ?? p.cost),
      ...(p.mrp ? { mrp_paise: R(p.mrp) } : {}),
      ...(p.batches
        ? {
            batch_no: `${l.sku.split('-')[0]}${billDate.replaceAll('-', '').slice(2)}${i}`,
            mfg_date: addDays(billDate, -10),
            expiry_date: addDays(billDate, l.expiryDays ?? 180),
          }
        : {}),
    }
  })
}

interface BillOut {
  id: string
  number: string | null
  total_paise: number
  updated_at: string
  lines: { id: string; product_id: string; qty_milli: number }[]
}
async function postedBill(
  supplier: string,
  invoiceNo: string,
  date: string,
  lines: Line[],
  extra: Record<string, unknown> = {},
): Promise<BillOut> {
  const draft = await call<BillOut>('POST', '/purchase-bills', {
    supplier_id: sid(supplier),
    store_id: storeId,
    supplier_invoice_no: invoiceNo,
    supplier_invoice_date: date,
    received_date: date,
    lines: billLines(lines, date),
    ...extra,
  })
  await call('POST', `/purchase-bills/${draft.id}/post`, { if_updated_at: draft.updated_at })
  return call<BillOut>('GET', `/purchase-bills/${draft.id}`)
}

const bills: BillOut[] = []
bills.push(
  await postedBill('rice', 'KRT/2627/0412', d(-40), [
    { sku: 'RICE-PONNI-25', qty: 40 },
    { sku: 'RICE-IDLI-10', qty: 30 },
    { sku: 'DAL-TOOR-1', qty: 150 },
    { sku: 'DAL-URAD-1', qty: 100 },
    { sku: 'DAL-CHANA-500', qty: 80 },
    { sku: 'SUGAR-1', qty: 200 },
    { sku: 'ATTA-FORTUNE-5', qty: 40 },
  ]),
)
bills.push(
  await postedBill('oil', 'IOD-5531', d(-35), [
    { sku: 'OIL-GN-1L', qty: 120 },
    { sku: 'OIL-GINGELLY-1L', qty: 60 },
    { sku: 'OIL-SUN-1L', qty: 200 },
    { sku: 'OIL-COCO-500', qty: 48 },
  ]),
)
bills.push(
  await postedBill('fmcg', 'CFA/INV/88214', d(-30), [
    { sku: 'BIS-GOODDAY-75', qty: 600, batch: true, expiryDays: 150 },
    { sku: 'BIS-MARIE-250', qty: 200, batch: true, expiryDays: 180 },
    { sku: 'TEA-TATA-250', qty: 60 },
    { sku: 'COF-BRU-200', qty: 48 },
    { sku: 'SALT-TATA-1', qty: 200 },
    { sku: 'SOAP-HAMAM-100', qty: 144 },
    { sku: 'PASTE-COLGATE-150', qty: 96 },
    { sku: 'DET-SURF-1', qty: 60 },
  ]),
)
bills.push(
  await postedBill('spice', 'BSW-2026-1187', d(-25), [
    { sku: 'SPC-SAMBAR-200', qty: 120, expiryDays: 240 },
    { sku: 'SPC-CHILLI-200', qty: 120, expiryDays: 240 },
    { sku: 'SPC-TURMERIC-100', qty: 80, expiryDays: 300 },
  ]),
)
bills.push(
  await postedBill('dairy', 'AAVIN-TN-30981', d(-3), [
    { sku: 'MILK-AAVIN-500', qty: 150, expiryDays: 3 },
    { sku: 'GHEE-AAVIN-200', qty: 24, expiryDays: 270 },
  ]),
)
bills.push(
  await postedBill('rice', 'KRT/2627/0498', d(-12), [
    { sku: 'DAL-TOOR-1', qty: 120 },
    { sku: 'RICE-PONNI-25', qty: 25 },
  ]),
)
console.log(`${bills.length} purchase bills posted`)

// ---- supplier payments ---------------------------------------------------------------------
const ctx = systemContext(tenantId, { userId, locale: 'en' })
async function pay(bill: BillOut, supplier: string, amount: number, method: 'cash' | 'bank_transfer' | 'upi', date: string, ref?: string) {
  await withTenant(appDb, ctx, (tx) =>
    recordPayment(tx, ctx, {
      direction: 'out',
      store_id: storeId,
      method,
      amount_paise: amount,
      payment_date: date,
      party: { type: 'supplier', id: sid(supplier) },
      reference: ref ?? null,
      allocations: [{ target_type: 'purchase_bill', target_id: bill.id, amount_paise: amount }],
      number: true,
    }),
  )
}
await pay(bills[0]!, 'rice', bills[0]!.total_paise, 'bank_transfer', d(-26), 'NEFT UTIB0012345')
await pay(bills[1]!, 'oil', bills[1]!.total_paise, 'upi', d(-15), 'UPI 629104558812')
await pay(bills[2]!, 'fmcg', Math.round(bills[2]!.total_paise / 2 / 100) * 100, 'cash', d(-10))
console.log('3 supplier payments (2 full, 1 partial)')

// ---- purchase return (debit note) ----------------------------------------------------------
const marieLine = bills[2]!.lines.find((l) => l.product_id === pid('BIS-MARIE-250'))!
await call('POST', '/debit-notes', {
  bill_id: bills[2]!.id,
  note_date: d(-20),
  reason: 'damaged',
  settlement: 'adjust_due',
  lines: [{ bill_line_id: marieLine.id, qty_milli: 12_000 }],
  notes: 'Crushed cartons in delivery — 12 packets returned',
})
console.log('1 debit note (damaged goods)')

// ---- purchase orders -----------------------------------------------------------------------
interface OrderOut {
  id: string
  updated_at: string
}
// Received in full: PO → bill from order → post.
const poRecv = await call<OrderOut>('POST', '/purchase-orders', {
  store_id: storeId,
  supplier_id: sid('oil'),
  order_date: d(-9),
  expected_date: d(-6),
  lines: [
    { product_id: pid('OIL-SUN-1L'), qty_milli: 96_000 },
    { product_id: pid('OIL-GN-1L'), qty_milli: 48_000 },
  ],
  notes: 'Festival stock for Deepavali',
})
await call('POST', `/purchase-orders/${poRecv.id}/send`, {})
const fromOrder = await call<BillOut>('POST', `/purchase-bills/from-order/${poRecv.id}`, {
  supplier_invoice_no: 'IOD-5702',
  supplier_invoice_date: d(-6),
  received_date: d(-6),
})
await call('POST', `/purchase-bills/${fromOrder.id}/post`, { if_updated_at: fromOrder.updated_at })

// Sent, awaiting delivery.
const poSent = await call<OrderOut>('POST', '/purchase-orders', {
  store_id: storeId,
  supplier_id: sid('fmcg'),
  order_date: d(-2),
  expected_date: d(3),
  lines: [
    { product_id: pid('BIS-GOODDAY-75'), qty_milli: 480_000 },
    { product_id: pid('SOAP-HAMAM-100'), qty_milli: 72_000 },
    { product_id: pid('DET-SURF-1'), qty_milli: 30_000 },
  ],
})
await call('POST', `/purchase-orders/${poSent.id}/send`, {})

// Draft.
await call('POST', '/purchase-orders', {
  store_id: storeId,
  supplier_id: sid('spice'),
  expected_date: d(7),
  lines: [
    { product_id: pid('SPC-SAMBAR-200'), qty_milli: 96_000 },
    { product_id: pid('SPC-CHILLI-200'), qty_milli: 96_000 },
  ],
  notes: 'Confirm rates before sending',
})
console.log('3 purchase orders (received, sent, draft)')

// Draft bill waiting to be checked and posted.
await call('POST', '/purchase-bills', {
  supplier_id: sid('dairy'),
  store_id: storeId,
  supplier_invoice_no: 'AAVIN-TN-31044',
  supplier_invoice_date: today,
  received_date: today,
  lines: billLines([{ sku: 'MILK-AAVIN-500', qty: 120, expiryDays: 3 }], today),
  notes: 'Morning milk delivery — count before posting',
})
console.log('1 draft bill')

// ---- sales history for StockSense ----------------------------------------------------------
// 60 days of daily sales per product (weekend bump, deterministic noise).
const rows: string[] = ['product,date,qty']
let seed = 7
const rand = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647)
for (const p of PRODUCTS) {
  for (let back = 60; back >= 1; back--) {
    const date = d(-back)
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
    const factor = dow === 0 || dow === 6 ? 1.35 : 1
    const qty = Math.max(0, Math.round(p.daily * factor * (0.7 + rand() * 0.6)))
    if (qty > 0) rows.push(`${p.sku},${date},${qty}`)
  }
}
const imported = await call<{ imported_rows: number }>('POST', '/purchases/sales-history', {
  store_id: storeId,
  csv: rows.join('\n'),
})
console.log(`${imported.imported_rows} sales-history rows imported`)

await app.close()
console.log(`\nDone. Sign in with ${DEMO_PHONE.slice(3)} / ${DEMO_PASSWORD}`)
