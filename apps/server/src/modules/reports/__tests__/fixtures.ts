/**
 * Fixtures of the reports tests: master data (products with HSN / category / brand, customers
 * and suppliers with GSTINs, stores) and documents posted the way the owning modules post them —
 * invoices (stock 'sale' through core postStock → COGS, journal through postJournal, tenders
 * through recordPayment), credit notes (restock, journal, settlement), purchase bills and debit
 * notes (stock, journal, due), expenses and opening balances. Amounts are computed here from
 * exclusive prices so each test can state its expected numbers.
 */
import type { LightMyRequestResponse } from 'fastify'
import { sql } from 'kysely'
import {
  type PaymentMethod,
  addDays,
  gstinCheckChar,
  makeGstin,
  newId,
  roundDiv,
} from '@kadai/shared'
import { postStock } from '../../../core/inventory'
import { postJournal } from '../../../core/ledger'
import { cancelPayment, recordPayment } from '../../../core/payments'
import type { TestApp } from '../../../test/helpers'
import type { TestShop, TestShopMember } from '../../../test/tenants'

export const API = '/api/v1'

type Deps = Pick<TestApp, 'deps'>

export async function get<T>(
  shop: TestShop,
  url: string,
  as?: TestShopMember | null,
): Promise<{ status: number; body: T; res: LightMyRequestResponse }> {
  const res = await shop.inject({
    method: 'GET',
    url: `${API}${url}`,
    ...(as !== undefined ? { as } : {}),
  })
  return { status: res.statusCode, body: res.json() as T, res }
}

export function errorOf(res: { body: unknown }): {
  code: string
  details?: Record<string, unknown>
} {
  return (res.body as { error: { code: string; details?: Record<string, unknown> } }).error
}

/** A GSTIN with a deliberately wrong check character. */
export function badGstin(state = '33'): string {
  const good = makeGstin(state, 'AAAPZ1234C', '1')
  const first14 = good.slice(0, 14)
  const check = gstinCheckChar(first14)
  return first14 + (check === 'A' ? 'B' : 'A')
}

// ---------------------------------------------------------------------------------------------
// Master data
// ---------------------------------------------------------------------------------------------

export interface ProductFx {
  id: string
  name: string
  unit: string
  pack_size: number
  gst_rate_bp: number
  hsn_code: string | null
  track_inventory: boolean
}

export async function makeProduct(
  t: Deps,
  tenantId: string,
  opts: {
    name: string
    name_ta?: string | null
    sku?: string | null
    unit?: string
    pack_size?: number
    hsn_code?: string | null
    gst_rate_bp?: number
    category_id?: string | null
    brand_id?: string | null
    purchase_price_paise?: number
    sale_price_paise?: number
    mrp_paise?: number | null
    reorder_level_milli?: number | null
    track_batches?: boolean
    track_inventory?: boolean
    attributes?: Record<string, unknown>
  },
): Promise<ProductFx> {
  const id = newId()
  const unit = opts.unit ?? 'PCS'
  await t.deps.db.systemDb
    .insertInto('products')
    .values({
      id,
      tenant_id: tenantId,
      name: opts.name,
      name_ta: opts.name_ta ?? null,
      sku: opts.sku ?? null,
      unit,
      pack_size: opts.pack_size ?? 1,
      hsn_code: opts.hsn_code ?? null,
      gst_rate_bp: opts.gst_rate_bp ?? 0,
      category_id: opts.category_id ?? null,
      brand_id: opts.brand_id ?? null,
      purchase_price_paise: opts.purchase_price_paise ?? 0,
      sale_price_paise: opts.sale_price_paise ?? 0,
      mrp_paise: opts.mrp_paise ?? null,
      reorder_level_milli: opts.reorder_level_milli ?? null,
      track_batches: opts.track_batches ?? false,
      track_inventory: opts.track_inventory ?? true,
      decimal_qty: unit === 'KG',
      attributes: JSON.stringify(opts.attributes ?? {}),
    })
    .execute()
  return {
    id,
    name: opts.name,
    unit,
    pack_size: opts.pack_size ?? 1,
    gst_rate_bp: opts.gst_rate_bp ?? 0,
    hsn_code: opts.hsn_code ?? null,
    track_inventory: opts.track_inventory ?? true,
  }
}

export async function makeCategory(
  t: Deps,
  tenantId: string,
  name: string,
  parentId: string | null = null,
): Promise<string> {
  const id = newId()
  await t.deps.db.systemDb
    .insertInto('categories')
    .values({ id, tenant_id: tenantId, name: `${name}`, parent_id: parentId })
    .execute()
  return id
}

export async function makeBrand(t: Deps, tenantId: string, name: string): Promise<string> {
  const id = newId()
  await t.deps.db.systemDb.insertInto('brands').values({ id, tenant_id: tenantId, name }).execute()
  return id
}

export async function makeBatch(
  t: Deps,
  tenantId: string,
  productId: string,
  opts: {
    batch_no: string
    expiry_date?: string | null
    mrp_paise?: number | null
    supplier_id?: string | null
  },
): Promise<string> {
  const id = newId()
  await t.deps.db.systemDb
    .insertInto('batches')
    .values({
      id,
      tenant_id: tenantId,
      product_id: productId,
      batch_no: opts.batch_no,
      expiry_date: opts.expiry_date ?? null,
      mrp_paise: opts.mrp_paise ?? null,
      supplier_id: opts.supplier_id ?? null,
    })
    .execute()
  return id
}

export interface CustomerFx {
  id: string
  name: string
  gstin: string | null
  state_code: string | null
}

export async function makeCustomer(
  t: Deps,
  tenantId: string,
  opts: { name: string; gstin?: string | null; credit_days?: number | null; phone?: string | null },
): Promise<CustomerFx> {
  const id = newId()
  const gstin = opts.gstin ?? null
  await t.deps.db.systemDb
    .insertInto('customers')
    .values({
      id,
      tenant_id: tenantId,
      name: opts.name,
      gstin,
      state_code: gstin ? gstin.slice(0, 2) : null,
      credit_days: opts.credit_days ?? null,
      phone: opts.phone ?? null,
      customer_type: gstin ? 'business' : 'retail',
    })
    .execute()
  return { id, name: opts.name, gstin, state_code: gstin ? gstin.slice(0, 2) : null }
}

export interface SupplierFx {
  id: string
  name: string
  gstin: string | null
}

export async function makeSupplier(
  t: Deps,
  tenantId: string,
  opts: { name: string; gstin?: string | null },
): Promise<SupplierFx> {
  const id = newId()
  const gstin = opts.gstin ?? null
  await t.deps.db.systemDb
    .insertInto('suppliers')
    .values({
      id,
      tenant_id: tenantId,
      name: opts.name,
      gstin,
      state_code: gstin ? gstin.slice(0, 2) : null,
    })
    .execute()
  return { id, name: opts.name, gstin }
}

export async function makeStore(
  t: Deps,
  tenantId: string,
  code: string,
  opts: { gstin?: string | null; state_code?: string } = {},
): Promise<{ id: string; code: string }> {
  const id = newId()
  await t.deps.db.systemDb
    .insertInto('stores')
    .values({
      id,
      tenant_id: tenantId,
      code,
      name: `Branch ${code}`,
      state_code: opts.state_code ?? '33',
      gstin: opts.gstin ?? null,
    })
    .execute()
  return { id, code }
}

export async function makeRegister(
  t: Deps,
  tenantId: string,
  storeId: string,
  code: string,
): Promise<string> {
  const id = newId()
  await t.deps.db.systemDb
    .insertInto('registers')
    .values({ id, tenant_id: tenantId, store_id: storeId, code, name: `Counter ${code}` })
    .execute()
  return id
}

/** Opening stock through core postStock (movement 'opening'). */
export async function openingStock(
  shop: TestShop,
  storeId: string,
  product: ProductFx,
  qtyMilli: number,
  unitCostPaise: number,
  batchId: string | null = null,
): Promise<void> {
  await shop.tx((tx) =>
    postStock(tx, shop.ctx, [
      {
        store_id: storeId,
        product_id: product.id,
        batch_id: batchId,
        qty_milli: qtyMilli,
        movement_type: 'opening',
        unit_cost_paise: unitCostPaise,
        reason: 'Opening stock (test)',
      },
    ]),
  )
}

// ---------------------------------------------------------------------------------------------
// Line maths (exclusive prices)
// ---------------------------------------------------------------------------------------------

export interface LineSpec {
  product?: ProductFx
  /** Ad-hoc line (no product). */
  name?: string
  hsn_code?: string | null
  unit?: string
  gst_rate_bp?: number
  qty_milli: number
  /** Per pack, excl. tax. */
  unit_price_paise: number
  discount_paise?: number
  bill_discount_paise?: number
  promotion_id?: string | null
  batch_id?: string | null
  meta?: Record<string, unknown>
}

interface LineAmounts {
  gross: number
  discount: number
  taxable: number
  cgst: number
  sgst: number
  igst: number
  total: number
}

export function lineAmounts(l: LineSpec, interstate: boolean): LineAmounts {
  const pack = l.product?.pack_size ?? 1
  const rate = l.gst_rate_bp ?? l.product?.gst_rate_bp ?? 0
  const gross = roundDiv(l.unit_price_paise * l.qty_milli, pack * 1000)
  const discount = (l.discount_paise ?? 0) + (l.bill_discount_paise ?? 0)
  const taxable = gross - discount
  const gst = roundDiv(taxable * rate, 10_000)
  const sgst = interstate ? 0 : Math.floor(gst / 2)
  const cgst = interstate ? 0 : gst - sgst
  return { gross, discount, taxable, cgst, sgst, igst: interstate ? gst : 0, total: taxable + gst }
}

// ---------------------------------------------------------------------------------------------
// Sales invoices
// ---------------------------------------------------------------------------------------------

export interface InvoiceSpec {
  number: string
  date: string
  at?: Date
  store_id?: string
  store_state?: string
  register_id?: string | null
  shift_id?: string | null
  customer?: CustomerFx | null
  customer_name?: string | null
  /** Snapshot GSTIN (default: the customer's). */
  customer_gstin?: string | null
  place_of_supply?: string
  lines: LineSpec[]
  tenders?: Array<{ method: PaymentMethod; amount_paise: number }>
  created_by?: string
  due_days?: number
  rx?: Record<string, unknown> | null
  doc_type?: 'tax_invoice' | 'bill_of_supply'
  /** Taxes are not charged (composition / unregistered businesses). */
  no_tax?: boolean
  /** Post nothing: insert the bill as cancelled (payments taken and refunded on cancel). */
  cancelled?: { at: Date; reason: string; by?: string }
}

export interface InvoiceFx {
  id: string
  number: string
  total_paise: number
  taxable_paise: number
  cost_paise: number
  lines: Array<{
    id: string
    spec: LineSpec
    amounts: LineAmounts
    rate_bp: number
    cost_paise: number
    unit_cost_paise: number
  }>
  interstate: boolean
}

export async function makeInvoice(t: Deps, shop: TestShop, spec: InvoiceSpec): Promise<InvoiceFx> {
  const storeId = spec.store_id ?? shop.store.id
  const storeState = spec.store_state ?? '33'
  const pos = spec.place_of_supply ?? storeState
  const interstate = pos !== storeState
  const id = newId()
  const lines = spec.lines.map((l) => {
    const rate = spec.no_tax ? 0 : (l.gst_rate_bp ?? l.product?.gst_rate_bp ?? 0)
    const a = lineAmounts({ ...l, gst_rate_bp: rate }, interstate)
    return { id: newId(), spec: l, amounts: a, rate_bp: rate, cost_paise: 0, unit_cost_paise: 0 }
  })
  const sum = (f: (a: LineAmounts) => number) => lines.reduce((s, l) => s + f(l.amounts), 0)
  const itemDiscount = spec.lines.reduce((s, l) => s + (l.discount_paise ?? 0), 0)
  const billDiscount = spec.lines.reduce((s, l) => s + (l.bill_discount_paise ?? 0), 0)
  const total = sum((a) => a.total)
  const at = spec.at ?? new Date(`${spec.date}T11:00:00+05:30`)
  const createdBy = spec.created_by ?? shop.owner.user.id
  const gstin =
    spec.customer_gstin !== undefined ? spec.customer_gstin : (spec.customer?.gstin ?? null)
  await shop.tx(async (tx) => {
    await tx
      .insertInto('sales_invoices')
      .values({
        id,
        tenant_id: shop.tenant.id,
        store_id: storeId,
        register_id: spec.register_id === undefined ? shop.register.id : spec.register_id,
        shift_id: spec.shift_id ?? null,
        doc_type: spec.doc_type ?? 'tax_invoice',
        number: spec.number,
        fy: '2627',
        invoice_date: spec.date,
        invoice_at: at,
        due_date: spec.due_days !== undefined ? addDays(spec.date, spec.due_days) : null,
        status: 'completed',
        channel: 'pos',
        customer_id: spec.customer?.id ?? null,
        customer_name: spec.customer_name ?? spec.customer?.name ?? null,
        customer_gstin: gstin,
        customer_state_code: gstin ? gstin.slice(0, 2) : null,
        place_of_supply: pos,
        is_interstate: interstate,
        price_includes_tax: false,
        gross_paise: sum((a) => a.gross),
        item_discount_paise: itemDiscount,
        bill_discount_paise: billDiscount,
        taxable_paise: sum((a) => a.taxable),
        cgst_paise: sum((a) => a.cgst),
        sgst_paise: sum((a) => a.sgst),
        igst_paise: sum((a) => a.igst),
        cess_paise: 0,
        round_off_paise: 0,
        total_paise: total,
        due_paise: total,
        payment_status: total > 0 ? 'unpaid' : 'paid',
        item_count: lines.length,
        rx: spec.rx ? JSON.stringify(spec.rx) : null,
        completed_at: at,
        created_by: createdBy,
      })
      .execute()
    await tx
      .insertInto('sales_invoice_lines')
      .values(
        lines.map((l, i) => ({
          id: l.id,
          tenant_id: shop.tenant.id,
          invoice_id: id,
          line_no: i + 1,
          product_id: l.spec.product?.id ?? null,
          batch_id: l.spec.batch_id ?? null,
          name: l.spec.product?.name ?? l.spec.name ?? 'Item',
          hsn_code:
            l.spec.hsn_code !== undefined ? l.spec.hsn_code : (l.spec.product?.hsn_code ?? null),
          unit: l.spec.unit ?? l.spec.product?.unit ?? 'PCS',
          pack_size: l.spec.product?.pack_size ?? 1,
          qty_milli: l.spec.qty_milli,
          unit_price_paise: l.spec.unit_price_paise,
          discount_paise: l.amounts.discount,
          gross_paise: l.amounts.gross,
          taxable_paise: l.amounts.taxable,
          gst_rate_bp: l.rate_bp,
          cgst_paise: l.amounts.cgst,
          sgst_paise: l.amounts.sgst,
          igst_paise: l.amounts.igst,
          total_paise: l.amounts.total,
          promotion_id: l.spec.promotion_id ?? null,
          meta: JSON.stringify(l.spec.meta ?? {}),
        })),
      )
      .execute()
    if (spec.cancelled) return
    // Stock 'sale' → COGS per line.
    const stocked = lines.filter((l) => l.spec.product?.track_inventory)
    const posted = await postStock(
      tx,
      shop.ctx,
      stocked.map((l) => ({
        store_id: storeId,
        product_id: l.spec.product!.id,
        batch_id: l.spec.batch_id ?? null,
        qty_milli: -l.spec.qty_milli,
        movement_type: 'sale' as const,
        ref_type: 'sales_invoice',
        ref_id: id,
        ref_line_id: l.id,
      })),
      { allowNegative: true },
    )
    stocked.forEach((l, i) => {
      l.cost_paise = posted[i]!.cost_paise
      l.unit_cost_paise = posted[i]!.unit_cost_paise
    })
    for (const l of stocked) {
      await tx
        .updateTable('sales_invoice_lines')
        .set({ cost_paise: l.cost_paise, unit_cost_paise: l.unit_cost_paise })
        .where('tenant_id', '=', shop.tenant.id)
        .where('id', '=', l.id)
        .execute()
    }
    const cost = lines.reduce((s, l) => s + l.cost_paise, 0)
    await tx
      .updateTable('sales_invoices')
      .set({ cost_paise: cost })
      .where('tenant_id', '=', shop.tenant.id)
      .where('id', '=', id)
      .execute()
    const party = spec.customer ? { type: 'customer' as const, id: spec.customer.id } : null
    await postJournal(tx, shop.ctx, {
      entry_date: spec.date,
      store_id: storeId,
      source_type: 'sales_invoice',
      source_id: id,
      lines: [
        { account: { subtype: 'receivable' }, debit_paise: total, party },
        { account: { subtype: 'sales' }, credit_paise: sum((a) => a.taxable) },
        { account: { subtype: 'output_cgst' }, credit_paise: sum((a) => a.cgst) },
        { account: { subtype: 'output_sgst' }, credit_paise: sum((a) => a.sgst) },
        { account: { subtype: 'output_igst' }, credit_paise: sum((a) => a.igst) },
        { account: { subtype: 'cogs' }, debit_paise: cost },
        { account: { subtype: 'inventory' }, credit_paise: cost },
      ],
    })
  })
  for (const [i, tender] of (spec.tenders ?? []).entries()) {
    await shop.tx((tx) =>
      recordPayment(tx, shop.ctx, {
        direction: 'in',
        store_id: storeId,
        register_id: spec.register_id === undefined ? shop.register.id : spec.register_id,
        shift_id: spec.shift_id ?? null,
        method: tender.method,
        amount_paise: tender.amount_paise,
        payment_date: spec.date,
        party: spec.customer ? { type: 'customer', id: spec.customer.id } : null,
        allocations: [
          { target_type: 'sales_invoice', target_id: id, amount_paise: tender.amount_paise },
        ],
        client_ref: `tender:${id}:${i}`,
        paid_at: at,
      }),
    )
  }
  if (spec.cancelled) {
    const cancelled = spec.cancelled
    await shop.tx(async (tx) => {
      const pays = await tx
        .selectFrom('payment_allocations as a')
        .innerJoin('payments as p', (j) => j.onRef('p.id', '=', 'a.payment_id'))
        .select('p.id')
        .where('a.tenant_id', '=', shop.tenant.id)
        .where('a.target_id', '=', id)
        .execute()
      for (const p of pays) {
        await cancelPayment(tx, shop.ctx, {
          payment_id: p.id,
          reason: cancelled.reason,
          date: spec.date,
        })
      }
      await tx
        .updateTable('sales_invoices')
        .set({
          status: 'cancelled',
          cancelled_at: cancelled.at,
          cancelled_by: cancelled.by ?? shop.owner.user.id,
          cancel_reason: cancelled.reason,
        })
        .where('tenant_id', '=', shop.tenant.id)
        .where('id', '=', id)
        .execute()
    })
  }
  return {
    id,
    number: spec.number,
    total_paise: total,
    taxable_paise: sum((a) => a.taxable),
    cost_paise: lines.reduce((s, l) => s + l.cost_paise, 0),
    lines,
    interstate,
  }
}

// ---------------------------------------------------------------------------------------------
// Credit notes
// ---------------------------------------------------------------------------------------------

export interface CreditNoteSpec {
  number: string
  date: string
  invoice: InvoiceFx
  customer?: CustomerFx | null
  /** Returned quantity per invoice line index (amounts pro rata). */
  lines: Array<{ line: number; qty_milli: number; restock?: boolean }>
  settlement: 'adjust_due' | 'cash'
  store_id?: string
  created_by?: string
  cancelled?: { at: Date; reason: string }
}

export async function makeCreditNote(
  t: Deps,
  shop: TestShop,
  spec: CreditNoteSpec,
): Promise<{ id: string; total_paise: number; taxable_paise: number; cost_paise: number }> {
  const id = newId()
  const storeId = spec.store_id ?? shop.store.id
  const inv = spec.invoice
  const invRow = await t.deps.db.systemDb
    .selectFrom('sales_invoices')
    .select(['place_of_supply', 'is_interstate', 'customer_gstin', 'customer_name', 'customer_id'])
    .where('id', '=', inv.id)
    .executeTakeFirstOrThrow()
  const lines = spec.lines.map((r) => {
    const src = inv.lines[r.line]!
    const share = (v: number) => roundDiv(v * r.qty_milli, src.spec.qty_milli)
    const a = {
      taxable: share(src.amounts.taxable),
      cgst: share(src.amounts.cgst),
      sgst: share(src.amounts.sgst),
      igst: share(src.amounts.igst),
    }
    return { id: newId(), r, src, a, total: a.taxable + a.cgst + a.sgst + a.igst, cost: 0 }
  })
  const sum = (f: (l: (typeof lines)[number]) => number) => lines.reduce((s, l) => s + f(l), 0)
  const total = sum((l) => l.total)
  const taxable = sum((l) => l.a.taxable)
  const customerId = invRow.customer_id
  await shop.tx(async (tx) => {
    await tx
      .insertInto('credit_notes')
      .values({
        id,
        tenant_id: shop.tenant.id,
        store_id: storeId,
        number: spec.number,
        fy: '2627',
        note_date: spec.date,
        invoice_id: inv.id,
        customer_id: customerId,
        customer_name: invRow.customer_name,
        customer_gstin: invRow.customer_gstin,
        place_of_supply: invRow.place_of_supply,
        is_interstate: invRow.is_interstate,
        reason: 'return',
        status: 'completed',
        taxable_paise: taxable,
        cgst_paise: sum((l) => l.a.cgst),
        sgst_paise: sum((l) => l.a.sgst),
        igst_paise: sum((l) => l.a.igst),
        total_paise: total,
        settlement: spec.settlement,
        created_by: spec.created_by ?? shop.owner.user.id,
        created_at: new Date(`${spec.date}T16:00:00+05:30`),
      })
      .execute()
    await tx
      .insertInto('credit_note_lines')
      .values(
        lines.map((l, i) => ({
          id: l.id,
          tenant_id: shop.tenant.id,
          credit_note_id: id,
          line_no: i + 1,
          invoice_line_id: l.src.id,
          product_id: l.src.spec.product?.id ?? null,
          batch_id: l.src.spec.batch_id ?? null,
          name: l.src.spec.product?.name ?? l.src.spec.name ?? 'Item',
          hsn_code:
            l.src.spec.hsn_code !== undefined
              ? l.src.spec.hsn_code
              : (l.src.spec.product?.hsn_code ?? null),
          unit: l.src.spec.unit ?? l.src.spec.product?.unit ?? 'PCS',
          pack_size: l.src.spec.product?.pack_size ?? 1,
          qty_milli: l.r.qty_milli,
          unit_price_paise: l.src.spec.unit_price_paise,
          taxable_paise: l.a.taxable,
          gst_rate_bp: l.src.rate_bp,
          cgst_paise: l.a.cgst,
          sgst_paise: l.a.sgst,
          igst_paise: l.a.igst,
          total_paise: l.total,
          unit_cost_paise: l.src.unit_cost_paise,
          restock: l.r.restock ?? true,
        })),
      )
      .execute()
    if (spec.cancelled) {
      await tx
        .updateTable('credit_notes')
        .set({
          status: 'cancelled',
          cancelled_at: spec.cancelled.at,
          cancel_reason: spec.cancelled.reason,
        })
        .where('tenant_id', '=', shop.tenant.id)
        .where('id', '=', id)
        .execute()
      return
    }
    const restocked = lines.filter(
      (l) => (l.r.restock ?? true) && l.src.spec.product?.track_inventory,
    )
    const posted = await postStock(
      tx,
      shop.ctx,
      restocked.map((l) => ({
        store_id: storeId,
        product_id: l.src.spec.product!.id,
        batch_id: l.src.spec.batch_id ?? null,
        qty_milli: l.r.qty_milli,
        movement_type: 'sale_return' as const,
        unit_cost_paise: l.src.unit_cost_paise,
        ref_type: 'credit_note',
        ref_id: id,
        ref_line_id: l.id,
      })),
    )
    restocked.forEach((l, i) => (l.cost = posted[i]!.cost_paise))
    for (const l of restocked) {
      await tx
        .updateTable('credit_note_lines')
        .set({ cost_paise: l.cost })
        .where('tenant_id', '=', shop.tenant.id)
        .where('id', '=', l.id)
        .execute()
    }
    const cost = sum((l) => l.cost)
    await tx
      .updateTable('credit_notes')
      .set({ cost_paise: cost })
      .where('tenant_id', '=', shop.tenant.id)
      .where('id', '=', id)
      .execute()
    const party = customerId ? { type: 'customer' as const, id: customerId } : null
    await postJournal(tx, shop.ctx, {
      entry_date: spec.date,
      store_id: storeId,
      source_type: 'credit_note',
      source_id: id,
      lines: [
        { account: { subtype: 'sales_returns' }, debit_paise: taxable },
        { account: { subtype: 'output_cgst' }, debit_paise: sum((l) => l.a.cgst) },
        { account: { subtype: 'output_sgst' }, debit_paise: sum((l) => l.a.sgst) },
        { account: { subtype: 'output_igst' }, debit_paise: sum((l) => l.a.igst) },
        { account: { subtype: 'receivable' }, credit_paise: total, party },
        { account: { subtype: 'inventory' }, debit_paise: cost },
        { account: { subtype: 'cogs' }, credit_paise: cost },
      ],
    })
    if (spec.settlement === 'adjust_due') {
      const row = await tx
        .selectFrom('sales_invoices')
        .select(['due_paise', 'paid_paise'])
        .where('tenant_id', '=', shop.tenant.id)
        .where('id', '=', inv.id)
        .executeTakeFirstOrThrow()
      const adjusted = Math.min(total, row.due_paise)
      await tx
        .updateTable('sales_invoices')
        .set({ due_paise: row.due_paise - adjusted })
        .where('tenant_id', '=', shop.tenant.id)
        .where('id', '=', inv.id)
        .execute()
      await tx
        .updateTable('credit_notes')
        .set({ settled_paise: adjusted })
        .where('tenant_id', '=', shop.tenant.id)
        .where('id', '=', id)
        .execute()
    }
    await tx
      .updateTable('sales_invoices')
      .set((eb) => ({ returned_paise: eb('returned_paise', '+', total) }))
      .where('tenant_id', '=', shop.tenant.id)
      .where('id', '=', inv.id)
      .execute()
  })
  if (spec.settlement === 'cash' && !spec.cancelled) {
    await shop.tx((tx) =>
      recordPayment(tx, shop.ctx, {
        direction: 'out',
        store_id: storeId,
        method: 'cash',
        amount_paise: total,
        payment_date: spec.date,
        party: customerId ? { type: 'customer', id: customerId } : null,
        allocations: [{ target_type: 'credit_note', target_id: id, amount_paise: total }],
        client_ref: `cn:${id}`,
        paid_at: new Date(`${spec.date}T16:05:00+05:30`),
      }),
    )
  }
  return { id, total_paise: total, taxable_paise: taxable, cost_paise: sum((l) => l.cost) }
}

// ---------------------------------------------------------------------------------------------
// Purchases, debit notes, expenses
// ---------------------------------------------------------------------------------------------

export interface BillSpec {
  supplier: SupplierFx
  number: string
  supplier_invoice_no: string
  date: string
  supplier_invoice_date?: string
  due_date?: string | null
  interstate?: boolean
  reverse_charge?: boolean
  itc_eligible?: boolean
  store_id?: string
  supplier_gstin?: string | null
  lines: Array<{
    product: ProductFx
    qty_milli: number
    unit_cost_paise: number
    gst_rate_bp?: number
    batch_id?: string | null
  }>
}

export interface BillFx {
  id: string
  total_paise: number
  taxable_paise: number
  lines: Array<{
    id: string
    product: ProductFx
    qty_milli: number
    amounts: LineAmounts
    rate: number
  }>
}

export async function makeBill(t: Deps, shop: TestShop, spec: BillSpec): Promise<BillFx> {
  const id = newId()
  const storeId = spec.store_id ?? shop.store.id
  const inter = spec.interstate ?? false
  const itc = spec.itc_eligible ?? true
  const lines = spec.lines.map((l) => {
    const rate = l.gst_rate_bp ?? l.product.gst_rate_bp
    return {
      id: newId(),
      ...l,
      rate,
      amounts: lineAmounts(
        {
          product: l.product,
          qty_milli: l.qty_milli,
          unit_price_paise: l.unit_cost_paise,
          gst_rate_bp: rate,
        },
        inter,
      ),
    }
  })
  const sum = (f: (a: LineAmounts) => number) => lines.reduce((s, l) => s + f(l.amounts), 0)
  const total = sum((a) => a.total)
  const taxable = sum((a) => a.taxable)
  const taxes = total - taxable
  await shop.tx(async (tx) => {
    await tx
      .insertInto('purchase_bills')
      .values({
        id,
        tenant_id: shop.tenant.id,
        store_id: storeId,
        supplier_id: spec.supplier.id,
        number: spec.number,
        fy: '2627',
        supplier_invoice_no: spec.supplier_invoice_no,
        supplier_invoice_date: spec.supplier_invoice_date ?? spec.date,
        received_date: spec.date,
        due_date: spec.due_date ?? null,
        supplier_gstin:
          spec.supplier_gstin !== undefined ? spec.supplier_gstin : spec.supplier.gstin,
        supplier_state_code: spec.supplier.gstin ? spec.supplier.gstin.slice(0, 2) : null,
        is_interstate: inter,
        reverse_charge: spec.reverse_charge ?? false,
        itc_eligible: itc,
        status: 'posted',
        gross_paise: sum((a) => a.gross),
        taxable_paise: taxable,
        cgst_paise: sum((a) => a.cgst),
        sgst_paise: sum((a) => a.sgst),
        igst_paise: sum((a) => a.igst),
        total_paise: total,
        due_paise: total,
        posted_at: new Date(`${spec.date}T12:00:00+05:30`),
      })
      .execute()
    await tx
      .insertInto('purchase_bill_lines')
      .values(
        lines.map((l, i) => ({
          id: l.id,
          tenant_id: shop.tenant.id,
          bill_id: id,
          line_no: i + 1,
          product_id: l.product.id,
          batch_id: l.batch_id ?? null,
          hsn_code: l.product.hsn_code,
          unit: l.product.unit,
          pack_size: l.product.pack_size,
          qty_milli: l.qty_milli,
          unit_cost_paise: l.unit_cost_paise,
          gross_paise: l.amounts.gross,
          taxable_paise: l.amounts.taxable,
          gst_rate_bp: l.rate,
          cgst_paise: l.amounts.cgst,
          sgst_paise: l.amounts.sgst,
          igst_paise: l.amounts.igst,
          total_paise: l.amounts.total,
          landed_unit_cost_paise: l.unit_cost_paise,
        })),
      )
      .execute()
    await postStock(
      tx,
      shop.ctx,
      lines
        .filter((l) => l.product.track_inventory)
        .map((l) => ({
          store_id: storeId,
          product_id: l.product.id,
          batch_id: l.batch_id ?? null,
          qty_milli: l.qty_milli,
          movement_type: 'purchase' as const,
          unit_cost_paise: l.unit_cost_paise,
          ref_type: 'purchase_bill',
          ref_id: id,
          ref_line_id: l.id,
        })),
    )
    const party = { type: 'supplier' as const, id: spec.supplier.id }
    await postJournal(tx, shop.ctx, {
      entry_date: spec.date,
      store_id: storeId,
      source_type: 'purchase_bill',
      source_id: id,
      lines: [
        { account: { subtype: 'inventory' }, debit_paise: taxable + (itc ? 0 : taxes) },
        { account: { subtype: 'input_cgst' }, debit_paise: itc ? sum((a) => a.cgst) : 0 },
        { account: { subtype: 'input_sgst' }, debit_paise: itc ? sum((a) => a.sgst) : 0 },
        { account: { subtype: 'input_igst' }, debit_paise: itc ? sum((a) => a.igst) : 0 },
        { account: { subtype: 'payable' }, credit_paise: total, party },
      ],
    })
  })
  return { id, total_paise: total, taxable_paise: taxable, lines }
}

/** Debit note (purchase return) against a bill, adjusted against its due ('adjust_due'). */
export async function makeDebitNote(
  t: Deps,
  shop: TestShop,
  spec: {
    bill: BillFx | null
    supplier: SupplierFx
    number: string
    date: string
    interstate?: boolean
    lines: Array<{
      product: ProductFx
      qty_milli: number
      unit_cost_paise: number
      gst_rate_bp?: number
    }>
    adjust?: boolean
  },
): Promise<{ id: string; total_paise: number }> {
  const id = newId()
  const inter = spec.interstate ?? false
  const lines = spec.lines.map((l) => {
    const rate = l.gst_rate_bp ?? l.product.gst_rate_bp
    return {
      id: newId(),
      ...l,
      rate,
      amounts: lineAmounts(
        {
          product: l.product,
          qty_milli: l.qty_milli,
          unit_price_paise: l.unit_cost_paise,
          gst_rate_bp: rate,
        },
        inter,
      ),
    }
  })
  const sum = (f: (a: LineAmounts) => number) => lines.reduce((s, l) => s + f(l.amounts), 0)
  const total = sum((a) => a.total)
  const taxable = sum((a) => a.taxable)
  await shop.tx(async (tx) => {
    await tx
      .insertInto('debit_notes')
      .values({
        id,
        tenant_id: shop.tenant.id,
        store_id: shop.store.id,
        supplier_id: spec.supplier.id,
        bill_id: spec.bill?.id ?? null,
        number: spec.number,
        fy: '2627',
        note_date: spec.date,
        reason: 'return',
        is_interstate: inter,
        taxable_paise: taxable,
        cgst_paise: sum((a) => a.cgst),
        sgst_paise: sum((a) => a.sgst),
        igst_paise: sum((a) => a.igst),
        total_paise: total,
      })
      .execute()
    await tx
      .insertInto('debit_note_lines')
      .values(
        lines.map((l, i) => ({
          id: l.id,
          tenant_id: shop.tenant.id,
          debit_note_id: id,
          line_no: i + 1,
          product_id: l.product.id,
          hsn_code: l.product.hsn_code,
          unit: l.product.unit,
          pack_size: l.product.pack_size,
          qty_milli: l.qty_milli,
          unit_cost_paise: l.unit_cost_paise,
          taxable_paise: l.amounts.taxable,
          gst_rate_bp: l.rate,
          cgst_paise: l.amounts.cgst,
          sgst_paise: l.amounts.sgst,
          igst_paise: l.amounts.igst,
          total_paise: l.amounts.total,
        })),
      )
      .execute()
    await postStock(
      tx,
      shop.ctx,
      lines.map((l) => ({
        store_id: shop.store.id,
        product_id: l.product.id,
        qty_milli: -l.qty_milli,
        movement_type: 'purchase_return' as const,
        ref_type: 'debit_note',
        ref_id: id,
        ref_line_id: l.id,
      })),
      { allowNegative: true },
    )
    await postJournal(tx, shop.ctx, {
      entry_date: spec.date,
      store_id: shop.store.id,
      source_type: 'debit_note',
      source_id: id,
      lines: [
        {
          account: { subtype: 'payable' },
          debit_paise: total,
          party: { type: 'supplier', id: spec.supplier.id },
        },
        { account: { subtype: 'inventory' }, credit_paise: taxable },
        { account: { subtype: 'input_cgst' }, credit_paise: sum((a) => a.cgst) },
        { account: { subtype: 'input_sgst' }, credit_paise: sum((a) => a.sgst) },
        { account: { subtype: 'input_igst' }, credit_paise: sum((a) => a.igst) },
      ],
    })
    if (spec.bill && (spec.adjust ?? true)) {
      await tx
        .updateTable('purchase_bills')
        .set((eb) => ({
          due_paise: eb('due_paise', '-', total),
          returned_paise: eb('returned_paise', '+', total),
        }))
        .where('tenant_id', '=', shop.tenant.id)
        .where('id', '=', spec.bill.id)
        .execute()
    }
  })
  return { id, total_paise: total }
}

export async function makeExpense(
  t: Deps,
  shop: TestShop,
  spec: {
    date: string
    number: string
    account_code: string
    taxable_paise: number
    gst_rate_bp: number
    itc_eligible: boolean
    supplier?: SupplierFx | null
    description?: string
  },
): Promise<{ id: string; total_paise: number }> {
  const id = newId()
  const gst = roundDiv(spec.taxable_paise * spec.gst_rate_bp, 10_000)
  const sgst = Math.floor(gst / 2)
  const cgst = gst - sgst
  const total = spec.taxable_paise + gst
  await shop.tx(async (tx) => {
    const acct = await tx
      .selectFrom('accounts')
      .select('id')
      .where('tenant_id', '=', shop.tenant.id)
      .where('code', '=', spec.account_code)
      .executeTakeFirstOrThrow()
    await tx
      .insertInto('expenses')
      .values({
        id,
        tenant_id: shop.tenant.id,
        store_id: shop.store.id,
        number: spec.number,
        fy: '2627',
        expense_date: spec.date,
        expense_account_id: acct.id,
        supplier_id: spec.supplier?.id ?? null,
        description: spec.description ?? 'Expense',
        taxable_paise: spec.taxable_paise,
        gst_rate_bp: spec.gst_rate_bp,
        cgst_paise: cgst,
        sgst_paise: sgst,
        itc_eligible: spec.itc_eligible,
        total_paise: total,
        payment_method: 'cash',
        status: 'posted',
        created_by: shop.owner.user.id,
      })
      .execute()
    await postJournal(tx, shop.ctx, {
      entry_date: spec.date,
      store_id: shop.store.id,
      source_type: 'expense',
      source_id: id,
      lines: [
        {
          account: { id: acct.id },
          debit_paise: spec.taxable_paise + (spec.itc_eligible ? 0 : gst),
        },
        { account: { subtype: 'input_cgst' }, debit_paise: spec.itc_eligible ? cgst : 0 },
        { account: { subtype: 'input_sgst' }, debit_paise: spec.itc_eligible ? sgst : 0 },
        { account: { subtype: 'cash' }, credit_paise: total },
      ],
    })
  })
  return { id, total_paise: total }
}

/** Opening balance of a party: the stored column + the 'opening' journal (as parties posts it). */
export async function openingBalance(
  shop: TestShop,
  party: { type: 'customer' | 'supplier'; id: string },
  amountPaise: number,
  date: string,
): Promise<void> {
  await shop.tx(async (tx) => {
    if (party.type === 'customer') {
      await tx
        .updateTable('customers')
        .set({ opening_balance_paise: amountPaise })
        .where('tenant_id', '=', shop.tenant.id)
        .where('id', '=', party.id)
        .execute()
    } else {
      await tx
        .updateTable('suppliers')
        .set({ opening_balance_paise: amountPaise })
        .where('tenant_id', '=', shop.tenant.id)
        .where('id', '=', party.id)
        .execute()
    }
    const amount = Math.abs(amountPaise)
    // Customers: + = owes the shop (debit receivable); suppliers: + = the shop owes (credit payable).
    const partyDebit = (party.type === 'customer') === amountPaise > 0
    await postJournal(tx, shop.ctx, {
      entry_date: date,
      source_type: 'opening',
      source_id: party.id,
      lines: [
        {
          account: { subtype: party.type === 'customer' ? 'receivable' : 'payable' },
          ...(partyDebit ? { debit_paise: amount } : { credit_paise: amount }),
          party,
        },
        {
          account: { subtype: 'opening_balance' },
          ...(partyDebit ? { credit_paise: amount } : { debit_paise: amount }),
        },
      ],
    })
  })
}

/** A customer receipt / supplier payment (core recordPayment). */
export async function pay(
  shop: TestShop,
  spec: {
    direction: 'in' | 'out'
    party: { type: 'customer' | 'supplier'; id: string }
    amount_paise: number
    date: string
    method?: PaymentMethod
    allocations?: Array<{
      target_type: 'sales_invoice' | 'purchase_bill' | 'opening_balance'
      target_id: string
      amount_paise: number
    }>
    store_id?: string
  },
): Promise<string> {
  const p = await shop.tx((tx) =>
    recordPayment(tx, shop.ctx, {
      direction: spec.direction,
      store_id: spec.store_id ?? shop.store.id,
      method: spec.method ?? 'cash',
      amount_paise: spec.amount_paise,
      payment_date: spec.date,
      party: spec.party,
      allocations: spec.allocations ?? [],
      paid_at: new Date(`${spec.date}T13:00:00+05:30`),
    }),
  )
  return p.id
}

/** Inserts a historical inbound movement (fixture history: backdated, with its stock row). */
export async function historicalInbound(
  t: Deps,
  shop: TestShop,
  product: ProductFx,
  qtyMilli: number,
  unitCostPaise: number,
  at: Date,
  batchId: string | null = null,
): Promise<void> {
  const db = t.deps.db.systemDb
  await db
    .insertInto('stock_levels')
    .values({
      id: newId(),
      tenant_id: shop.tenant.id,
      store_id: shop.store.id,
      product_id: product.id,
      batch_id: batchId,
      qty_milli: qtyMilli,
      avg_cost_paise: unitCostPaise,
      last_movement_at: at,
    })
    .execute()
  await db
    .insertInto('stock_movements')
    .values({
      id: newId(),
      tenant_id: shop.tenant.id,
      store_id: shop.store.id,
      product_id: product.id,
      batch_id: batchId,
      movement_type: 'purchase',
      qty_milli: qtyMilli,
      unit_cost_paise: unitCostPaise,
      balance_after_milli: qtyMilli,
      created_at: at,
    })
    .execute()
}

/** Audit actions of a tenant (newest first). */
export async function auditActions(t: Deps, tenantId: string): Promise<string[]> {
  const rows = await sql<{ action: string }>`
    select action from audit_logs where tenant_id = ${tenantId} order by id desc`.execute(
    t.deps.db.systemDb,
  )
  return rows.rows.map((r) => r.action)
}
