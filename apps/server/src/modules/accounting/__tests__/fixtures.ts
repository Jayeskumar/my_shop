/**
 * Fixtures for the accounting integration tests. The sales, purchases and payments modules are
 * built elsewhere, so their documents are created here the way those modules post them: the
 * document row (consistent with the schema CHECKs), stock through core/inventory postStock,
 * the journal through core/ledger postJournal and money through core/payments recordPayment —
 * all in one tenant transaction (RLS) as the shop owner.
 */
import { type PaymentMethod, newId, splitGst, todayIn } from '@kadai/shared'
import type { LightMyRequestResponse } from 'fastify'
import { expect } from 'vitest'
import { postStock } from '../../../core/inventory'
import { postJournal } from '../../../core/ledger'
import { recordPayment } from '../../../core/payments'
import type { Tx } from '../../../db/tenant'
import type { TestApp } from '../../../test/helpers'
import {
  type TestShop,
  type TestShopMember,
  insertTestProduct,
  insertTestSupplier,
} from '../../../test/tenants'

export const api = (path: string) => `/api/v1${path}`
export const today = () => todayIn('Asia/Kolkata')

export type Data<T> = { data: T }

/** Parses a JSON response and asserts the status (prints the body on mismatch). */
export function expectStatus<T = unknown>(res: LightMyRequestResponse, status: number): T {
  expect(res.statusCode, res.body).toBe(status)
  return (res.body ? JSON.parse(res.body) : null) as T
}

/** Asserts an error envelope with the given code (and details.reason when given). */
export function expectError(
  res: LightMyRequestResponse,
  status: number,
  code: string,
  reason?: string,
): { code: string; message: string; details?: Record<string, unknown> } {
  const body = expectStatus<{
    error: { code: string; message: string; details?: Record<string, unknown> }
  }>(res, status)
  expect(body.error.code).toBe(code)
  if (reason !== undefined) expect(body.error.details?.reason).toBe(reason)
  return body.error
}

export async function get<T>(shop: TestShop, url: string, as?: TestShopMember): Promise<T> {
  return expectStatus<T>(await shop.inject({ method: 'GET', url: api(url), as }), 200)
}

export async function post<T>(
  shop: TestShop,
  url: string,
  payload: unknown,
  status = 201,
  as?: TestShopMember,
): Promise<T> {
  return expectStatus<T>(
    await shop.inject({ method: 'POST', url: api(url), payload: payload as object, as }),
    status,
  )
}

/** System account id by subtype. */
export async function accountId(t: TestApp, shop: TestShop, subtype: string): Promise<string> {
  const row = await t.deps.db.systemDb
    .selectFrom('accounts')
    .select('id')
    .where('tenant_id', '=', shop.tenant.id)
    .where('subtype', '=', subtype)
    .where('is_system', '=', true)
    .executeTakeFirstOrThrow()
  return row.id
}

/** Account id by code. */
export async function accountByCode(t: TestApp, shop: TestShop, code: string): Promise<string> {
  const row = await t.deps.db.systemDb
    .selectFrom('accounts')
    .select('id')
    .where('tenant_id', '=', shop.tenant.id)
    .where('code', '=', code)
    .executeTakeFirstOrThrow()
  return row.id
}

/** Natural balance per account subtype/code from journal_lines (Σ debit − Σ credit). */
export async function accountNet(t: TestApp, accountIdValue: string): Promise<number> {
  const row = await t.deps.db.systemDb
    .selectFrom('journal_lines')
    .select((eb) => [
      eb.fn.coalesce(eb.fn.sum<number>('debit_paise'), eb.lit(0)).as('d'),
      eb.fn.coalesce(eb.fn.sum<number>('credit_paise'), eb.lit(0)).as('c'),
    ])
    .where('account_id', '=', accountIdValue)
    .executeTakeFirstOrThrow()
  return Number(row.d) - Number(row.c)
}

export async function auditActions(t: TestApp, shop: TestShop): Promise<string[]> {
  const rows = await t.deps.db.systemDb
    .selectFrom('audit_logs')
    .select('action')
    .where('tenant_id', '=', shop.tenant.id)
    .orderBy('created_at')
    .execute()
  return rows.map((r) => r.action)
}

// ---------------------------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------------------------

export async function stockedProduct(
  t: TestApp,
  shop: TestShop,
  opts: { cost_paise: number; qty_milli: number; date?: string },
): Promise<{ id: string; name: string }> {
  const product = await insertTestProduct(t.deps, shop.tenant.id, {
    purchase_price_paise: opts.cost_paise,
    sale_price_paise: opts.cost_paise * 2,
    gst_rate_bp: 500,
  })
  const value = (opts.cost_paise * opts.qty_milli) / 1000
  await shop.tx(async (tx) => {
    await postStock(tx, shop.ctx, [
      {
        store_id: shop.store.id,
        product_id: product.id,
        qty_milli: opts.qty_milli,
        movement_type: 'opening',
        unit_cost_paise: opts.cost_paise,
      },
    ])
    await postJournal(tx, shop.ctx, {
      entry_date: opts.date ?? today(),
      store_id: shop.store.id,
      source_type: 'opening',
      source_id: product.id,
      narration: 'Opening stock',
      lines: [
        { account: { subtype: 'inventory' }, debit_paise: value },
        { account: { subtype: 'opening_balance' }, credit_paise: value },
      ],
    })
  })
  return product
}

// ---------------------------------------------------------------------------------------------
// Sales (as the sales module posts them)
// ---------------------------------------------------------------------------------------------

export interface SaleLine {
  product_id: string
  qty_milli: number
  /** Taxable value of the line (5% GST on top, CGST + SGST). */
  taxable_paise: number
}

export interface Tender {
  method: PaymentMethod
  amount_paise: number
}

export interface SaleInput {
  lines: SaleLine[]
  customer_id?: string | null
  shift_id?: string | null
  date?: string
  round_off_paise?: number
  item_discount_paise?: number
  tenders?: Tender[]
  status?: 'completed' | 'cancelled'
}

export interface PostedSale {
  id: string
  number: string
  total_paise: number
  cost_paise: number
  line_ids: string[]
}

export async function postSale(t: TestApp, shop: TestShop, input: SaleInput): Promise<PostedSale> {
  const date = input.date ?? today()
  const id = newId()
  const number = `S1-A/T${id.slice(-8).toUpperCase()}`
  const lines = input.lines.map((l, i) => {
    const gst = Math.round(l.taxable_paise * 0.05)
    const split = splitGst(gst)
    return {
      ...l,
      id: newId(),
      line_no: i + 1,
      cgst: split.cgst_paise,
      sgst: split.sgst_paise,
      total: l.taxable_paise + gst,
    }
  })
  const taxable = lines.reduce((s, l) => s + l.taxable_paise, 0)
  const cgst = lines.reduce((s, l) => s + l.cgst, 0)
  const sgst = lines.reduce((s, l) => s + l.sgst, 0)
  const roundOff = input.round_off_paise ?? 0
  const total = taxable + cgst + sgst + roundOff
  const itemDiscount = input.item_discount_paise ?? 0
  return shop.tx(async (tx) => {
    await tx
      .insertInto('sales_invoices')
      .values({
        id,
        tenant_id: shop.tenant.id,
        store_id: shop.store.id,
        register_id: input.shift_id ? shop.register.id : null,
        shift_id: input.shift_id ?? null,
        number,
        fy: '2627',
        invoice_date: date,
        status: 'completed',
        customer_id: input.customer_id ?? null,
        place_of_supply: '33',
        gross_paise: taxable + itemDiscount,
        item_discount_paise: itemDiscount,
        taxable_paise: taxable,
        cgst_paise: cgst,
        sgst_paise: sgst,
        round_off_paise: roundOff,
        total_paise: total,
        paid_paise: 0,
        due_paise: total,
        payment_status: 'unpaid',
        item_count: lines.length,
        completed_at: new Date(),
        created_by: shop.owner.user.id,
      })
      .execute()
    await tx
      .insertInto('sales_invoice_lines')
      .values(
        lines.map((l) => ({
          id: l.id,
          tenant_id: shop.tenant.id,
          invoice_id: id,
          line_no: l.line_no,
          product_id: l.product_id,
          name: `Item ${l.line_no}`,
          unit: 'PCS',
          qty_milli: l.qty_milli,
          unit_price_paise: Math.round((l.taxable_paise * 1000) / l.qty_milli),
          gross_paise: l.taxable_paise,
          taxable_paise: l.taxable_paise,
          gst_rate_bp: 500,
          cgst_paise: l.cgst,
          sgst_paise: l.sgst,
          total_paise: l.total,
        })),
      )
      .execute()
    const moves = await postStock(
      tx,
      shop.ctx,
      lines.map((l) => ({
        store_id: shop.store.id,
        product_id: l.product_id,
        qty_milli: -l.qty_milli,
        movement_type: 'sale' as const,
        ref_type: 'sales_invoice',
        ref_id: id,
        ref_line_id: l.id,
      })),
    )
    const cost = moves.reduce((s, m) => s + m.cost_paise, 0)
    await tx.updateTable('sales_invoices').set({ cost_paise: cost }).where('id', '=', id).execute()
    const party = input.customer_id ? { type: 'customer' as const, id: input.customer_id } : null
    await postJournal(tx, shop.ctx, {
      entry_date: date,
      store_id: shop.store.id,
      source_type: 'sales_invoice',
      source_id: id,
      narration: `Sale ${number}`,
      lines: [
        { account: { subtype: 'receivable' }, debit_paise: total, party },
        { account: { subtype: 'sales' }, credit_paise: taxable },
        { account: { subtype: 'output_cgst' }, credit_paise: cgst },
        { account: { subtype: 'output_sgst' }, credit_paise: sgst },
        roundOff >= 0
          ? { account: { subtype: 'round_off' }, credit_paise: roundOff }
          : { account: { subtype: 'round_off' }, debit_paise: -roundOff },
        { account: { subtype: 'cogs' }, debit_paise: cost },
        { account: { subtype: 'inventory' }, credit_paise: cost },
      ],
    })
    for (const tender of input.tenders ?? []) {
      await recordPayment(tx, shop.ctx, {
        direction: 'in',
        store_id: shop.store.id,
        shift_id: input.shift_id ?? null,
        method: tender.method,
        amount_paise: tender.amount_paise,
        payment_date: date,
        party,
        allocations: [
          { target_type: 'sales_invoice', target_id: id, amount_paise: tender.amount_paise },
        ],
      })
    }
    if (input.status === 'cancelled') {
      await tx
        .updateTable('sales_invoices')
        .set({ status: 'cancelled', cancelled_at: new Date(), cancel_reason: 'Wrong bill' })
        .where('id', '=', id)
        .execute()
    }
    return { id, number, total_paise: total, cost_paise: cost, line_ids: lines.map((l) => l.id) }
  })
}

/** A sales return (credit note) of whole lines of a sale, restocked, optionally refunded. */
export async function postReturn(
  t: TestApp,
  shop: TestShop,
  input: {
    sale: PostedSale
    line: SaleLine & { line_id: string; unit_cost_paise: number }
    customer_id?: string | null
    shift_id?: string | null
    refund?: Tender | null
    date?: string
  },
): Promise<{ id: string; total_paise: number }> {
  const date = input.date ?? today()
  const id = newId()
  const gst = Math.round(input.line.taxable_paise * 0.05)
  const split = splitGst(gst)
  const total = input.line.taxable_paise + gst
  const cost = Math.round((input.line.unit_cost_paise * input.line.qty_milli) / 1000)
  const party = input.customer_id ? { type: 'customer' as const, id: input.customer_id } : null
  await shop.tx(async (tx: Tx) => {
    await tx
      .insertInto('credit_notes')
      .values({
        id,
        tenant_id: shop.tenant.id,
        store_id: shop.store.id,
        register_id: input.shift_id ? shop.register.id : null,
        shift_id: input.shift_id ?? null,
        number: `CNS1/T${id.slice(-6).toUpperCase()}`,
        fy: '2627',
        note_date: date,
        invoice_id: input.sale.id,
        customer_id: input.customer_id ?? null,
        place_of_supply: '33',
        reason: 'return',
        taxable_paise: input.line.taxable_paise,
        cgst_paise: split.cgst_paise,
        sgst_paise: split.sgst_paise,
        total_paise: total,
        cost_paise: cost,
        settlement: input.refund ? 'cash' : 'adjust_due',
      })
      .execute()
    await postStock(tx, shop.ctx, [
      {
        store_id: shop.store.id,
        product_id: input.line.product_id,
        qty_milli: input.line.qty_milli,
        movement_type: 'sale_return',
        unit_cost_paise: input.line.unit_cost_paise,
        ref_type: 'credit_note',
        ref_id: id,
      },
    ])
    await postJournal(tx, shop.ctx, {
      entry_date: date,
      store_id: shop.store.id,
      source_type: 'credit_note',
      source_id: id,
      narration: 'Sales return',
      lines: [
        { account: { subtype: 'sales_returns' }, debit_paise: input.line.taxable_paise },
        { account: { subtype: 'output_cgst' }, debit_paise: split.cgst_paise },
        { account: { subtype: 'output_sgst' }, debit_paise: split.sgst_paise },
        { account: { subtype: 'receivable' }, credit_paise: total, party },
        { account: { subtype: 'inventory' }, debit_paise: cost },
        { account: { subtype: 'cogs' }, credit_paise: cost },
      ],
    })
    if (input.refund) {
      await recordPayment(tx, shop.ctx, {
        direction: 'out',
        store_id: shop.store.id,
        shift_id: input.shift_id ?? null,
        method: input.refund.method,
        amount_paise: input.refund.amount_paise,
        payment_date: date,
        party,
        allocations: [
          { target_type: 'credit_note', target_id: id, amount_paise: input.refund.amount_paise },
        ],
      })
    }
  })
  return { id, total_paise: total }
}

// ---------------------------------------------------------------------------------------------
// Purchases (as the purchases module posts a bill)
// ---------------------------------------------------------------------------------------------

export async function postPurchase(
  t: TestApp,
  shop: TestShop,
  input: {
    supplier_id: string
    product_id: string
    qty_milli: number
    unit_cost_paise: number
    date?: string
  },
): Promise<{ id: string; total_paise: number }> {
  const date = input.date ?? today()
  const id = newId()
  const taxable = Math.round((input.unit_cost_paise * input.qty_milli) / 1000)
  const gst = Math.round(taxable * 0.05)
  const split = splitGst(gst)
  const total = taxable + gst
  await shop.tx(async (tx) => {
    await tx
      .insertInto('purchase_bills')
      .values({
        id,
        tenant_id: shop.tenant.id,
        store_id: shop.store.id,
        supplier_id: input.supplier_id,
        number: `GRNS1/T${id.slice(-6).toUpperCase()}`,
        fy: '2627',
        supplier_invoice_no: `INV-${id.slice(-6)}`,
        supplier_invoice_date: date,
        received_date: date,
        status: 'posted',
        gross_paise: taxable,
        taxable_paise: taxable,
        cgst_paise: split.cgst_paise,
        sgst_paise: split.sgst_paise,
        total_paise: total,
        due_paise: total,
        posted_at: new Date(),
      })
      .execute()
    await postStock(tx, shop.ctx, [
      {
        store_id: shop.store.id,
        product_id: input.product_id,
        qty_milli: input.qty_milli,
        movement_type: 'purchase',
        unit_cost_paise: input.unit_cost_paise,
        ref_type: 'purchase_bill',
        ref_id: id,
      },
    ])
    await postJournal(tx, shop.ctx, {
      entry_date: date,
      store_id: shop.store.id,
      source_type: 'purchase_bill',
      source_id: id,
      narration: 'Purchase bill',
      lines: [
        { account: { subtype: 'inventory' }, debit_paise: taxable },
        { account: { subtype: 'input_cgst' }, debit_paise: split.cgst_paise },
        { account: { subtype: 'input_sgst' }, debit_paise: split.sgst_paise },
        {
          account: { subtype: 'payable' },
          credit_paise: total,
          party: { type: 'supplier', id: input.supplier_id },
        },
      ],
    })
  })
  return { id, total_paise: total }
}

/** A standalone payment through core/payments (receipts, supplier payments, refunds). */
export async function pay(
  shop: TestShop,
  input: Parameters<typeof recordPayment>[2],
): Promise<{ id: string }> {
  const p = await shop.tx((tx) => recordPayment(tx, shop.ctx, input))
  return { id: p.id }
}

export async function newSupplier(
  t: TestApp,
  shop: TestShop,
  state_code: string | null = null,
): Promise<{ id: string; name: string }> {
  const s = await insertTestSupplier(t.deps, shop.tenant.id)
  if (state_code) {
    await t.deps.db.systemDb
      .updateTable('suppliers')
      .set({ state_code })
      .where('id', '=', s.id)
      .execute()
  }
  return s
}

/** Σ debit / Σ credit of every journal line of the tenant (must always be equal). */
export async function ledgerTotals(
  t: TestApp,
  shop: TestShop,
): Promise<{ debit: number; credit: number }> {
  const row = await t.deps.db.systemDb
    .selectFrom('journal_lines')
    .select((eb) => [
      eb.fn.coalesce(eb.fn.sum<number>('debit_paise'), eb.lit(0)).as('d'),
      eb.fn.coalesce(eb.fn.sum<number>('credit_paise'), eb.lit(0)).as('c'),
    ])
    .where('tenant_id', '=', shop.tenant.id)
    .executeTakeFirstOrThrow()
  return { debit: Number(row.d), credit: Number(row.c) }
}
