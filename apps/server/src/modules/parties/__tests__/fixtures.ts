/**
 * Fixtures for the parties integration tests: raw sales / purchase documents (the sales and
 * purchases modules are built elsewhere), sale journals through core/ledger and ledger sums.
 */
import { newId } from '@kadai/shared'
import { sql } from 'kysely'
import { expect } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { postJournal } from '../../../core/ledger'
import type { TestApp } from '../../../test/helpers'
import type { TestShop } from '../../../test/tenants'

export const api = (path: string) => `/api/v1${path}`

/** Parses a JSON response and asserts the status (prints the body on mismatch). */
export function expectStatus<T = unknown>(res: LightMyRequestResponse, status: number): T {
  expect(res.statusCode, res.body).toBe(status)
  return (res.body ? JSON.parse(res.body) : null) as T
}

export interface InvoiceFixture {
  customer_id: string | null
  invoice_date: string
  total_paise: number
  due_paise?: number
  store_id?: string
  status?: 'completed' | 'cancelled' | 'held'
  doc_type?: 'tax_invoice' | 'bill_of_supply' | 'estimate'
  invoice_at?: Date
  lines?: Array<{
    product_id?: string | null
    name: string
    unit?: string
    qty_milli: number
    total_paise: number
  }>
}

/** Inserts a sales invoice (and lines) directly; totals are consistent with the CHECKs. */
export async function insertInvoice(
  t: TestApp,
  shop: TestShop,
  inv: InvoiceFixture,
): Promise<{ id: string; number: string }> {
  const id = newId()
  const number = `T${id.slice(-10).toUpperCase()}`
  const due = inv.due_paise ?? 0
  await t.deps.db.systemDb
    .insertInto('sales_invoices')
    .values({
      id,
      tenant_id: shop.tenant.id,
      store_id: inv.store_id ?? shop.store.id,
      doc_type: inv.doc_type ?? 'tax_invoice',
      number: inv.status === 'held' ? null : number,
      fy: '2627',
      invoice_date: inv.invoice_date,
      invoice_at: inv.invoice_at ?? new Date(`${inv.invoice_date}T10:00:00+05:30`),
      status: inv.status ?? 'completed',
      customer_id: inv.customer_id,
      place_of_supply: '33',
      gross_paise: inv.total_paise,
      taxable_paise: inv.total_paise,
      total_paise: inv.total_paise,
      paid_paise: inv.total_paise - due,
      due_paise: due,
      payment_status: due === 0 ? 'paid' : due === inv.total_paise ? 'unpaid' : 'partial',
      item_count: inv.lines?.length ?? 0,
    })
    .execute()
  if (inv.lines?.length) {
    await t.deps.db.systemDb
      .insertInto('sales_invoice_lines')
      .values(
        inv.lines.map((l, i) => ({
          id: newId(),
          tenant_id: shop.tenant.id,
          invoice_id: id,
          line_no: i + 1,
          product_id: l.product_id ?? null,
          name: l.name,
          unit: l.unit ?? 'PCS',
          qty_milli: l.qty_milli,
          unit_price_paise: Math.round((l.total_paise * 1000) / l.qty_milli),
          gross_paise: l.total_paise,
          taxable_paise: l.total_paise,
          total_paise: l.total_paise,
        })),
      )
      .execute()
  }
  return { id, number }
}

/** Posts the receivable side of a credit sale: Dr receivable(customer) / Cr sales. */
export async function postSaleJournal(
  shop: TestShop,
  input: { invoice_id: string; customer_id: string; amount_paise: number; date: string },
): Promise<void> {
  await shop.tx((tx) =>
    postJournal(tx, shop.ctx, {
      entry_date: input.date,
      store_id: shop.store.id,
      source_type: 'sales_invoice',
      source_id: input.invoice_id,
      narration: 'Credit sale',
      lines: [
        {
          account: { subtype: 'receivable' },
          debit_paise: input.amount_paise,
          party: { type: 'customer', id: input.customer_id },
        },
        { account: { subtype: 'sales' }, credit_paise: input.amount_paise },
      ],
    }),
  )
}

/** Σ (debit − credit) of a party's lines on its control account, and the stored balance. */
export async function partyBalances(
  t: TestApp,
  shop: TestShop,
  type: 'customer' | 'supplier',
  id: string,
): Promise<{ ledger: number; stored: number }> {
  const subtype = type === 'customer' ? 'receivable' : 'payable'
  const res = await sql<{ d: string; c: string }>`
    select coalesce(sum(l.debit_paise), 0)::bigint as d, coalesce(sum(l.credit_paise), 0)::bigint as c
      from journal_lines l join accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
     where l.tenant_id = ${shop.tenant.id} and l.party_type = ${type} and l.party_id = ${id}
       and a.subtype = ${subtype}`.execute(t.deps.db.systemDb)
  const d = Number(res.rows[0]?.d ?? 0)
  const c = Number(res.rows[0]?.c ?? 0)
  const row = await t.deps.db.systemDb
    .selectFrom(type === 'customer' ? 'customers' : 'suppliers')
    .select('balance_paise')
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
  return { ledger: type === 'customer' ? d - c : c - d, stored: Number(row.balance_paise) }
}

/** Journal entries (with lines) posted for a party with source 'opening'. */
export async function openingEntries(
  t: TestApp,
  shop: TestShop,
  partyId: string,
): Promise<Array<{ subtype: string | null; debit_paise: number; credit_paise: number }>> {
  const rows = await t.deps.db.systemDb
    .selectFrom('journal_lines as l')
    .innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
    .innerJoin('accounts as a', 'a.id', 'l.account_id')
    .select(['a.subtype', 'l.debit_paise', 'l.credit_paise', 'l.created_at', 'l.id'])
    .where('e.tenant_id', '=', shop.tenant.id)
    .where('e.source_type', '=', 'opening')
    .where('e.source_id', '=', partyId)
    .orderBy('l.created_at')
    .orderBy('l.id')
    .execute()
  return rows.map((r) => ({
    subtype: r.subtype,
    debit_paise: Number(r.debit_paise),
    credit_paise: Number(r.credit_paise),
  }))
}

/** Audit actions recorded for an entity. */
export async function auditActions(
  t: TestApp,
  shop: TestShop,
  entityId: string,
): Promise<string[]> {
  const rows = await t.deps.db.systemDb
    .selectFrom('audit_logs')
    .select('action')
    .where('tenant_id', '=', shop.tenant.id)
    .where('entity_id', '=', entityId)
    .orderBy('created_at')
    .execute()
  return rows.map((r) => r.action)
}

/** A fresh valid Indian mobile as typed by a cashier (10 digits). */
export function localMobile(): string {
  return `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`
}
