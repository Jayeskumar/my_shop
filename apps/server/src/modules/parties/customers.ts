/**
 * Customers (docs/API.md "parties"): CRUD, phone lookup for the POS, list with dues.
 *
 * * Phones are E.164 and unique per tenant: every write that sets a phone takes a transaction
 *   advisory lock on (tenant, phone) and checks first, so a duplicate is always 409 DUPLICATE
 *   with `details.existing_id` (never a bare unique violation).
 * * balance_paise is never written here: opening balances (and later changes of them) are posted
 *   through core/ledger (source 'opening'), which updates the balance.
 * * overdue_paise = Σ due of completed invoices older than the effective credit days, at most the
 *   current due (party-level, like the balance); last_invoice_at = latest completed invoice in
 *   the member's stores.
 */
import { type CustomerType, type PriceTier, type TenantSettings, newId } from '@kadai/shared'
import type {
  Customer,
  CustomerCreateParsed,
  CustomerListItem,
  CustomerListQuerySchema,
  CustomerUpdateSchema,
} from '@kadai/shared/api/parties'
import { type Expression, type Selectable, type SqlBool, type Updateable, sql } from 'kysely'
import type { z } from 'zod'
import type { DB } from '../../db/schema.generated'
import { jsonb } from '../../db/json'
import type { Tx } from '../../db/tenant'
import { audit, diffChanges } from '../../core/audit'
import type { RequestContext } from '../../core/context'
import { assertNotStale, duplicate, invalidField, notFound } from '../../core/errors'
import { type PageEnvelope, paginate, parsePage } from '../../core/http'
import { getSettings } from '../../core/settings'
import {
  anyOf,
  assertOpeningBalanceEdit,
  escapeLike,
  iso,
  isoOrNull,
  lockKey,
  phoneSearchDigits,
  postOpeningBalance,
  readAddress,
  rupees,
  storeScopeSql,
  tenantToday,
} from './common'

type Ctx = RequestContext
type CustomerRow = Selectable<DB['customers']>
type CustomerListQuery = z.output<typeof CustomerListQuerySchema>
export type CustomerUpdateParsed = z.output<typeof CustomerUpdateSchema>

interface CustomerFullRow extends CustomerRow {
  last_invoice_at: Date | null
  overdue_paise: number
}

// ---------------------------------------------------------------------------------------------
// Computed columns (correlated sub-queries on `customers`)
// ---------------------------------------------------------------------------------------------

/** invoice_at of the latest completed (non-estimate) invoice in the member's stores. */
function lastInvoiceAtSql(ctx: Pick<Ctx, 'storeIds'>) {
  return sql<Date | null>`(select max(si.invoice_at) from sales_invoices si
     where si.tenant_id = customers.tenant_id and si.customer_id = customers.id
       and si.status = 'completed' and si.doc_type <> 'estimate'
       ${storeScopeSql('si.store_id', ctx)})`
}

/**
 * Σ due of completed invoices whose invoice date + effective credit days is before `today`,
 * capped at the current due (balance_paise): an unallocated advance or credit offsets the
 * invoice dues, so a customer never shows more overdue than they owe.
 */
function overdueSql(today: string, defaultCreditDays: number) {
  return sql<number>`least(greatest(customers.balance_paise, 0), (select coalesce(sum(si.due_paise), 0)::bigint from sales_invoices si
     where si.tenant_id = customers.tenant_id and si.customer_id = customers.id
       and si.status = 'completed' and si.doc_type <> 'estimate' and si.due_paise > 0
       and si.invoice_date < ${today}::date - coalesce(customers.credit_days, ${defaultCreditDays})::int))::bigint`
}

interface DueContext {
  today: string
  settings: TenantSettings
}

async function dueContext(tx: Tx, ctx: Ctx): Promise<DueContext> {
  return { today: await tenantToday(tx, ctx), settings: await getSettings(tx, ctx) }
}

// ---------------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------------

function toCustomer(r: CustomerFullRow): Customer {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    name_ta: r.name_ta,
    phone: r.phone,
    gstin: r.gstin,
    state_code: r.state_code,
    customer_type: r.customer_type as CustomerType,
    price_tier: r.price_tier as PriceTier,
    balance_paise: r.balance_paise,
    credit_limit_paise: r.credit_limit_paise,
    credit_days: r.credit_days,
    overdue_paise: Number(r.overdue_paise),
    loyalty_points: r.loyalty_points,
    tags: r.tags,
    whatsapp_opt_in: r.whatsapp_opt_in,
    is_active: r.is_active,
    last_invoice_at: isoOrNull(r.last_invoice_at),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    alt_phone: r.alt_phone,
    email: r.email,
    address: readAddress(r.address),
    opening_balance_paise: r.opening_balance_paise,
    date_of_birth: r.date_of_birth,
    anniversary: r.anniversary,
    notes: r.notes,
    created_by: r.created_by,
  }
}

export function toCustomerListItem(c: Customer): CustomerListItem {
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    name_ta: c.name_ta,
    phone: c.phone,
    gstin: c.gstin,
    state_code: c.state_code,
    customer_type: c.customer_type,
    price_tier: c.price_tier,
    balance_paise: c.balance_paise,
    credit_limit_paise: c.credit_limit_paise,
    credit_days: c.credit_days,
    overdue_paise: c.overdue_paise,
    loyalty_points: c.loyalty_points,
    tags: c.tags,
    whatsapp_opt_in: c.whatsapp_opt_in,
    is_active: c.is_active,
    last_invoice_at: c.last_invoice_at,
    created_at: c.created_at,
    updated_at: c.updated_at,
  }
}

/** Loads customers with their computed columns, keyed by id. */
async function loadCustomers(
  tx: Tx,
  ctx: Ctx,
  ids: readonly string[],
  due?: DueContext,
): Promise<Map<string, Customer>> {
  if (ids.length === 0) return new Map()
  const d = due ?? (await dueContext(tx, ctx))
  const rows = await tx
    .selectFrom('customers')
    .selectAll('customers')
    .select([
      lastInvoiceAtSql(ctx).as('last_invoice_at'),
      overdueSql(d.today, d.settings.credit.default_credit_days).as('overdue_paise'),
    ])
    .where('customers.tenant_id', '=', ctx.tenantId)
    .where('customers.id', 'in', [...ids])
    .execute()
  return new Map(rows.map((r) => [r.id, toCustomer(r)]))
}

export async function getCustomer(tx: Tx, ctx: Ctx, id: string): Promise<Customer> {
  const found = (await loadCustomers(tx, ctx, [id])).get(id)
  if (!found) throw notFound('customer', id)
  return found
}

/** Exact lookup by (normalised) phone — the POS fast path. */
export async function lookupCustomerByPhone(
  tx: Tx,
  ctx: Ctx,
  phone: string,
): Promise<CustomerListItem> {
  const row = await tx
    .selectFrom('customers')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('phone', '=', phone)
    .executeTakeFirst()
  if (!row) throw notFound('customer')
  return toCustomerListItem(await getCustomer(tx, ctx, row.id))
}

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

/** q: name / Tamil name (trigram index expression), phone digits, GSTIN prefix, code prefix. */
function customerSearch(q: string): Expression<SqlBool> {
  const lower = q.toLowerCase()
  const parts: Expression<SqlBool>[] = [
    sql<SqlBool>`lower(customers.name || ' ' || coalesce(customers.name_ta, '')) like ${`%${escapeLike(lower)}%`}`,
    sql<SqlBool>`lower(customers.code) like ${`${escapeLike(lower)}%`}`,
  ]
  const digits = phoneSearchDigits(q)
  if (digits) parts.push(sql<SqlBool>`customers.phone like ${`%${digits}%`}`)
  if (/^[0-9a-z]{2,15}$/i.test(q))
    parts.push(sql<SqlBool>`customers.gstin like ${`${escapeLike(q.toUpperCase())}%`}`)
  return anyOf(parts)
}

export async function listCustomers(
  tx: Tx,
  ctx: Ctx,
  query: CustomerListQuery,
): Promise<PageEnvelope<CustomerListItem>> {
  const due = await dueContext(tx, ctx)
  const overdue = overdueSql(due.today, due.settings.credit.default_credit_days)
  let qb = tx
    .selectFrom('customers')
    .select('customers.id')
    .where('customers.tenant_id', '=', ctx.tenantId)
  if (query.q) qb = qb.where(customerSearch(query.q))
  if (query.has_due !== undefined)
    qb = qb.where('customers.balance_paise', query.has_due ? '>' : '<=', 0)
  if (query.credit !== undefined)
    qb = qb.where('customers.balance_paise', query.credit ? '<' : '>=', 0)
  if (query.overdue !== undefined)
    qb = qb.where(query.overdue ? sql<SqlBool>`${overdue} > 0` : sql<SqlBool>`${overdue} = 0`)
  if (query.tag) qb = qb.where(sql<SqlBool>`customers.tags @> array[${query.tag}]::text[]`)
  if (query.customer_type) qb = qb.where('customers.customer_type', '=', query.customer_type)
  if (query.is_active !== undefined) qb = qb.where('customers.is_active', '=', query.is_active)
  if (query.ids) {
    if (query.ids.length === 0) return { data: [], page: { ...parsePage(query), total: 0 } }
    qb = qb.where('customers.id', 'in', query.ids)
  }

  const { field, direction } = query.sort
  switch (field) {
    case 'name':
      qb = qb.orderBy(sql`lower(customers.name)`, direction)
      break
    case 'balance_paise':
      qb = qb.orderBy('customers.balance_paise', direction).orderBy(sql`lower(customers.name)`)
      break
    case 'last_invoice_at':
      qb = qb
        .orderBy(lastInvoiceAtSql(ctx), (ob) =>
          direction === 'desc' ? ob.desc().nullsLast() : ob.asc().nullsLast(),
        )
        .orderBy(sql`lower(customers.name)`)
      break
    case 'created_at':
      qb = qb.orderBy('customers.created_at', direction)
      break
  }
  qb = qb.orderBy('customers.id')

  const page = await paginate(qb, parsePage(query))
  const loaded = await loadCustomers(
    tx,
    ctx,
    page.data.map((r) => r.id),
    due,
  )
  return {
    data: page.data.flatMap((r) => {
      const c = loaded.get(r.id)
      return c ? [toCustomerListItem(c)] : []
    }),
    page: page.page,
  }
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

/** 409 DUPLICATE {existing_id} when another customer of the tenant has this phone. */
export async function assertPhoneFree(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  phone: string,
  exceptId?: string,
): Promise<void> {
  await lockKey(tx, `customer_phone:${ctx.tenantId}:${phone}`)
  let q = tx
    .selectFrom('customers')
    .select(['id', 'name'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('phone', '=', phone)
  if (exceptId) q = q.where('id', '<>', exceptId)
  const existing = await q.executeTakeFirst()
  if (existing) {
    throw duplicate('A customer with this phone number already exists', {
      field: 'phone',
      existing_id: existing.id,
      existing_name: existing.name,
    })
  }
}

/** Inserts a customer (phone already checked) and posts its opening balance. Returns the id. */
export async function insertCustomer(
  tx: Tx,
  ctx: Ctx,
  body: CustomerCreateParsed,
  today: string,
): Promise<string> {
  const id = newId()
  await tx
    .insertInto('customers')
    .values({
      id,
      tenant_id: ctx.tenantId,
      code: body.code ?? null,
      name: body.name,
      name_ta: body.name_ta ?? null,
      phone: body.phone ?? null,
      alt_phone: body.alt_phone ?? null,
      email: body.email ?? null,
      gstin: body.gstin ?? null,
      state_code: body.state_code ?? body.address.state_code ?? null,
      address: jsonb(body.address),
      customer_type: body.customer_type,
      price_tier: body.price_tier,
      credit_limit_paise: body.credit_limit_paise,
      credit_days: body.credit_days,
      opening_balance_paise: body.opening_balance_paise,
      date_of_birth: body.date_of_birth,
      anniversary: body.anniversary,
      notes: body.notes ?? null,
      tags: body.tags,
      whatsapp_opt_in: body.whatsapp_opt_in,
      created_by: ctx.userId,
    })
    .execute()
  if (body.opening_balance_paise !== 0) {
    await postOpeningBalance(tx, ctx, {
      party: 'customer',
      party_id: id,
      amount_paise: body.opening_balance_paise,
      entry_date: today,
      narration: `Opening balance: ${body.name}`,
    })
  }
  return id
}

export async function createCustomer(
  tx: Tx,
  ctx: Ctx,
  body: CustomerCreateParsed,
): Promise<Customer> {
  if (body.phone) await assertPhoneFree(tx, ctx, body.phone)
  const id = await insertCustomer(tx, ctx, body, await tenantToday(tx, ctx))
  await audit(tx, ctx, {
    action: 'customer.create',
    entity_type: 'customer',
    entity_id: id,
    summary: `Customer ${body.name} added${
      body.opening_balance_paise !== 0
        ? ` with opening balance ${rupees(body.opening_balance_paise)}`
        : ''
    }`,
  })
  return getCustomer(tx, ctx, id)
}

/** Fields of a customer that PATCH may change (audited diff), as stored. */
function editable(r: CustomerRow): Record<string, unknown> {
  return {
    name: r.name,
    name_ta: r.name_ta,
    code: r.code,
    phone: r.phone,
    alt_phone: r.alt_phone,
    email: r.email,
    gstin: r.gstin,
    state_code: r.state_code,
    address: readAddress(r.address),
    customer_type: r.customer_type,
    price_tier: r.price_tier,
    credit_limit_paise: r.credit_limit_paise,
    credit_days: r.credit_days,
    opening_balance_paise: r.opening_balance_paise,
    date_of_birth: r.date_of_birth,
    anniversary: r.anniversary,
    notes: r.notes,
    tags: r.tags,
    whatsapp_opt_in: r.whatsapp_opt_in,
    is_active: r.is_active,
  }
}

/**
 * Applies a parsed PATCH to a locked customer row: phone uniqueness, GSTIN/state consistency
 * with the stored values, opening-balance delta journal (permission-checked, audited) and the
 * row update. Returns the stored-field diff (null when nothing changed). Shared by PATCH and the
 * import (upsert).
 */
export async function applyCustomerChanges(
  tx: Tx,
  ctx: Ctx,
  existing: CustomerRow,
  body: Omit<CustomerUpdateParsed, 'if_updated_at'>,
  today: string,
): Promise<{ before: Record<string, unknown>; after: Record<string, unknown> } | null> {
  const patch: Updateable<DB['customers']> = {}
  const set = <K extends keyof Updateable<DB['customers']>>(
    key: K,
    value: Updateable<DB['customers']>[K] | undefined,
  ) => {
    if (value !== undefined) patch[key] = value
  }
  set('name', body.name)
  set('name_ta', body.name_ta)
  set('code', body.code)
  set('alt_phone', body.alt_phone)
  set('email', body.email)
  set('gstin', body.gstin)
  set('state_code', body.state_code)
  if (body.address !== undefined) patch.address = jsonb(body.address)
  set('customer_type', body.customer_type)
  set('price_tier', body.price_tier)
  set('credit_limit_paise', body.credit_limit_paise)
  set('credit_days', body.credit_days)
  set('date_of_birth', body.date_of_birth)
  set('anniversary', body.anniversary)
  set('notes', body.notes)
  set('tags', body.tags)
  set('whatsapp_opt_in', body.whatsapp_opt_in)
  set('is_active', body.is_active)

  if (body.phone !== undefined && body.phone !== existing.phone) {
    if (body.phone) await assertPhoneFree(tx, ctx, body.phone, existing.id)
    patch.phone = body.phone
  }

  const gstin = body.gstin !== undefined ? body.gstin : existing.gstin
  const stateCode = body.state_code !== undefined ? body.state_code : existing.state_code
  if (gstin && stateCode && gstin.slice(0, 2) !== stateCode) {
    throw invalidField(body.state_code !== undefined ? 'state_code' : 'gstin', 'gstin_state')
  }

  const openingChange =
    body.opening_balance_paise !== undefined &&
    body.opening_balance_paise !== existing.opening_balance_paise
      ? body.opening_balance_paise
      : null
  if (openingChange !== null) {
    assertOpeningBalanceEdit(ctx)
    patch.opening_balance_paise = openingChange
  }

  const before = editable(existing)
  const changes = diffChanges(before, { ...before, ...patchView(patch, body) })
  if (!changes) return null

  if (openingChange !== null) {
    await postOpeningBalance(tx, ctx, {
      party: 'customer',
      party_id: existing.id,
      amount_paise: openingChange - existing.opening_balance_paise,
      entry_date: today,
      narration: `Opening balance changed from ${rupees(existing.opening_balance_paise)} to ${rupees(openingChange)}: ${existing.name}`,
    })
    await audit(tx, ctx, {
      action: 'customer.opening_balance_change',
      entity_type: 'customer',
      entity_id: existing.id,
      summary: `Opening balance of ${existing.name} changed from ${rupees(
        existing.opening_balance_paise,
      )} to ${rupees(openingChange)}`,
      changes: {
        before: { opening_balance_paise: existing.opening_balance_paise },
        after: { opening_balance_paise: openingChange },
        delta_paise: openingChange - existing.opening_balance_paise,
      },
    })
  }
  await tx
    .updateTable('customers')
    .set(patch)
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', existing.id)
    .execute()
  return changes
}

/** The patch as comparable stored values (address parsed back, not as JSON text). */
function patchView(
  patch: Updateable<DB['customers']>,
  body: Omit<CustomerUpdateParsed, 'if_updated_at'>,
): Record<string, unknown> {
  const { address: _address, ...rest } = patch
  return body.address !== undefined ? { ...rest, address: body.address } : rest
}

export async function lockCustomerRow(tx: Tx, ctx: Ctx, id: string): Promise<CustomerRow> {
  const row = await tx
    .selectFrom('customers')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!row) throw notFound('customer', id)
  return row
}

export async function updateCustomer(
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: CustomerUpdateParsed,
): Promise<Customer> {
  const existing = await lockCustomerRow(tx, ctx, id)
  assertNotStale(existing.updated_at, body.if_updated_at, 'customer', id)
  const { if_updated_at: _ignored, ...changes } = body
  const diff = await applyCustomerChanges(tx, ctx, existing, changes, await tenantToday(tx, ctx))
  if (diff) {
    const action =
      body.is_active === false && existing.is_active
        ? 'customer.deactivate'
        : body.is_active === true && !existing.is_active
          ? 'customer.activate'
          : 'customer.update'
    await audit(tx, ctx, {
      action,
      entity_type: 'customer',
      entity_id: id,
      summary: `Customer ${existing.name} updated: ${Object.keys(diff.after).join(', ')}`,
      changes: diff,
    })
  }
  return getCustomer(tx, ctx, id)
}

/** True when the customer appears on any document, payment, journal line or loyalty entry. */
async function customerHasHistory(tx: Tx, ctx: Ctx, id: string): Promise<boolean> {
  const res = await sql<{ used: boolean }>`select
      exists (select 1 from sales_invoices where tenant_id = ${ctx.tenantId} and customer_id = ${id})
   or exists (select 1 from credit_notes where tenant_id = ${ctx.tenantId} and customer_id = ${id})
   or exists (select 1 from payment_intents where tenant_id = ${ctx.tenantId} and customer_id = ${id})
   or exists (select 1 from payments where tenant_id = ${ctx.tenantId} and party_type = 'customer' and party_id = ${id})
   or exists (select 1 from journal_lines where tenant_id = ${ctx.tenantId} and party_type = 'customer' and party_id = ${id})
   or exists (select 1 from loyalty_ledger where tenant_id = ${ctx.tenantId} and customer_id = ${id})
   as used`.execute(tx)
  return res.rows[0]?.used ?? true
}

/** DELETE: removes a customer without history, otherwise deactivates it (both audited). */
export async function deleteCustomer(
  tx: Tx,
  ctx: Ctx,
  id: string,
): Promise<{ id: string; result: 'deleted' | 'deactivated' }> {
  const existing = await lockCustomerRow(tx, ctx, id)
  if (await customerHasHistory(tx, ctx, id)) {
    if (existing.is_active) {
      await tx
        .updateTable('customers')
        .set({ is_active: false })
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', id)
        .execute()
    }
    await audit(tx, ctx, {
      action: 'customer.deactivate',
      entity_type: 'customer',
      entity_id: id,
      summary: `Customer ${existing.name} deactivated (has history)`,
    })
    return { id, result: 'deactivated' }
  }
  await tx
    .deleteFrom('customers')
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
  await audit(tx, ctx, {
    action: 'customer.delete',
    entity_type: 'customer',
    entity_id: id,
    summary: `Customer ${existing.name} deleted`,
    changes: { before: editable(existing) },
  })
  return { id, result: 'deleted' }
}
