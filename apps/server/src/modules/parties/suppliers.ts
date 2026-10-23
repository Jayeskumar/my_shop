/**
 * Suppliers (docs/API.md "parties"): CRUD, list with dues, payable statement.
 *
 * * Bank details: only {account_name, account_no_last4, ifsc, bank_name} are ever stored — the
 *   contract's BankDetailsInputSchema turns a full account number into its last 4 digits and the
 *   writer below whitelists the keys (defence in depth). PATCH merges: omitted fields keep the
 *   stored value, null clears.
 * * Opening balance: Cr payable(supplier) / Dr opening_balance (+ = the shop owes the supplier);
 *   later changes post the delta (accounting permission, audited). balance_paise is changed only
 *   by core/ledger.
 * * overdue_paise = Σ due of posted bills whose due date (else supplier invoice date + payment
 *   terms) is past, at most the current payable.
 * * PAN: taken from the GSTIN when not given — on create and when a PATCH changes the GSTIN.
 */
import { newId, panFromGstin } from '@kadai/shared'
import {
  type BankDetails,
  BankDetailsSchema,
  type Supplier,
  type SupplierCreateParsed,
  type SupplierListItem,
  type SupplierListQuerySchema,
  type SupplierUpdateSchema,
} from '@kadai/shared/api/parties'
import { type Expression, type Selectable, type SqlBool, type Updateable, sql } from 'kysely'
import type { z } from 'zod'
import type { DB } from '../../db/schema.generated'
import { jsonb } from '../../db/json'
import type { Tx } from '../../db/tenant'
import { audit, diffChanges } from '../../core/audit'
import type { RequestContext } from '../../core/context'
import { assertNotStale, invalidField, notFound } from '../../core/errors'
import { type PageEnvelope, paginate, parsePage } from '../../core/http'
import {
  anyOf,
  assertOpeningBalanceEdit,
  escapeLike,
  iso,
  phoneSearchDigits,
  postOpeningBalance,
  readAddress,
  rupees,
  storeScopeSql,
  tenantToday,
} from './common'

type Ctx = RequestContext
type SupplierRow = Selectable<DB['suppliers']>
type SupplierListQuery = z.output<typeof SupplierListQuerySchema>
type SupplierUpdateParsed = z.output<typeof SupplierUpdateSchema>
type BankInput = NonNullable<SupplierCreateParsed['bank_details']>

interface SupplierFullRow extends SupplierRow {
  last_bill_date: string | null
  overdue_paise: number
}

function lastBillDateSql(ctx: Pick<Ctx, 'storeIds'>) {
  return sql<
    string | null
  >`(select to_char(max(pb.received_date), 'YYYY-MM-DD') from purchase_bills pb
     where pb.tenant_id = suppliers.tenant_id and pb.supplier_id = suppliers.id
       and pb.status = 'posted' ${storeScopeSql('pb.store_id', ctx)})`
}

/**
 * Σ due of posted bills past their due date — the bill's own due date, else the supplier invoice
 * date + the supplier's payment terms — capped at the current payable (an advance paid offsets
 * bill dues).
 */
function overdueSql(today: string) {
  return sql<number>`least(greatest(suppliers.balance_paise, 0), (select coalesce(sum(pb.due_paise), 0)::bigint from purchase_bills pb
     where pb.tenant_id = suppliers.tenant_id and pb.supplier_id = suppliers.id
       and pb.status = 'posted' and pb.due_paise > 0
       and coalesce(pb.due_date, pb.supplier_invoice_date + coalesce(suppliers.payment_terms_days, 0)) < ${today}::date))::bigint`
}

/** Stored bank details, sanitised (never more than the whitelisted keys). */
export function readBankDetails(value: unknown): BankDetails {
  const parsed = BankDetailsSchema.safeParse(value ?? {})
  const b = parsed.success ? parsed.data : BankDetailsSchema.parse({})
  const last4 = b.account_no_last4 ? b.account_no_last4.replace(/\D/g, '').slice(-4) || null : null
  return {
    account_name: b.account_name,
    account_no_last4: last4,
    ifsc: b.ifsc,
    bank_name: b.bank_name,
  }
}

/** Merges a bank details input over the stored value; the result is what gets stored. */
function mergeBankDetails(stored: BankDetails, input: BankInput | undefined): BankDetails {
  if (!input) return stored
  const pick = <K extends keyof BankDetails>(key: K, value: BankDetails[K] | undefined) =>
    value === undefined ? stored[key] : value
  const last4 = 'account_no_last4' in input ? input.account_no_last4 : undefined
  return {
    account_name: pick('account_name', input.account_name),
    account_no_last4: pick('account_no_last4', last4 === undefined ? undefined : (last4 ?? null)),
    ifsc: pick('ifsc', input.ifsc),
    bank_name: pick('bank_name', input.bank_name),
  }
}

function toSupplier(r: SupplierFullRow): Supplier {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    contact_person: r.contact_person,
    phone: r.phone,
    gstin: r.gstin,
    state_code: r.state_code,
    drug_license_no: r.drug_license_no,
    payment_terms_days: r.payment_terms_days,
    lead_time_days: r.lead_time_days,
    balance_paise: r.balance_paise,
    overdue_paise: Number(r.overdue_paise),
    upi_vpa: r.upi_vpa,
    is_active: r.is_active,
    last_bill_date: r.last_bill_date,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    email: r.email,
    pan: r.pan,
    address: readAddress(r.address),
    opening_balance_paise: r.opening_balance_paise,
    bank_details: readBankDetails(r.bank_details),
    notes: r.notes,
    created_by: r.created_by,
  }
}

function toListItem(s: Supplier): SupplierListItem {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    contact_person: s.contact_person,
    phone: s.phone,
    gstin: s.gstin,
    state_code: s.state_code,
    drug_license_no: s.drug_license_no,
    payment_terms_days: s.payment_terms_days,
    lead_time_days: s.lead_time_days ?? null,
    balance_paise: s.balance_paise,
    overdue_paise: s.overdue_paise,
    upi_vpa: s.upi_vpa,
    is_active: s.is_active,
    last_bill_date: s.last_bill_date,
    created_at: s.created_at,
    updated_at: s.updated_at,
  }
}

async function loadSuppliers(
  tx: Tx,
  ctx: Ctx,
  ids: readonly string[],
  today?: string,
): Promise<Map<string, Supplier>> {
  if (ids.length === 0) return new Map()
  const day = today ?? (await tenantToday(tx, ctx))
  const rows = await tx
    .selectFrom('suppliers')
    .selectAll('suppliers')
    .select([lastBillDateSql(ctx).as('last_bill_date'), overdueSql(day).as('overdue_paise')])
    .where('suppliers.tenant_id', '=', ctx.tenantId)
    .where('suppliers.id', 'in', [...ids])
    .execute()
  return new Map(rows.map((r) => [r.id, toSupplier(r)]))
}

export async function getSupplier(tx: Tx, ctx: Ctx, id: string): Promise<Supplier> {
  const found = (await loadSuppliers(tx, ctx, [id])).get(id)
  if (!found) throw notFound('supplier', id)
  return found
}

function supplierSearch(q: string): Expression<SqlBool> {
  const lower = escapeLike(q.toLowerCase())
  const parts: Expression<SqlBool>[] = [
    sql<SqlBool>`lower(suppliers.name) like ${`%${lower}%`}`,
    sql<SqlBool>`lower(suppliers.contact_person) like ${`%${lower}%`}`,
    sql<SqlBool>`lower(suppliers.code) like ${`${lower}%`}`,
  ]
  const digits = phoneSearchDigits(q)
  if (digits) parts.push(sql<SqlBool>`suppliers.phone like ${`%${digits}%`}`)
  if (/^[0-9a-z]{2,15}$/i.test(q))
    parts.push(sql<SqlBool>`suppliers.gstin like ${`${escapeLike(q.toUpperCase())}%`}`)
  return anyOf(parts)
}

export async function listSuppliers(
  tx: Tx,
  ctx: Ctx,
  query: SupplierListQuery,
): Promise<PageEnvelope<SupplierListItem>> {
  const today = await tenantToday(tx, ctx)
  let qb = tx
    .selectFrom('suppliers')
    .select('suppliers.id')
    .where('suppliers.tenant_id', '=', ctx.tenantId)
  if (query.q) qb = qb.where(supplierSearch(query.q))
  if (query.has_due !== undefined)
    qb = qb.where('suppliers.balance_paise', query.has_due ? '>' : '<=', 0)
  if (query.overdue !== undefined) {
    const overdue = overdueSql(today)
    qb = qb.where(query.overdue ? sql<SqlBool>`${overdue} > 0` : sql<SqlBool>`${overdue} = 0`)
  }
  if (query.is_active !== undefined) qb = qb.where('suppliers.is_active', '=', query.is_active)
  if (query.ids) {
    if (query.ids.length === 0) return { data: [], page: { ...parsePage(query), total: 0 } }
    qb = qb.where('suppliers.id', 'in', query.ids)
  }
  const { field, direction } = query.sort
  switch (field) {
    case 'name':
      qb = qb.orderBy(sql`lower(suppliers.name)`, direction)
      break
    case 'balance_paise':
      qb = qb.orderBy('suppliers.balance_paise', direction).orderBy(sql`lower(suppliers.name)`)
      break
    case 'last_bill_date':
      qb = qb
        .orderBy(lastBillDateSql(ctx), (ob) =>
          direction === 'desc' ? ob.desc().nullsLast() : ob.asc().nullsLast(),
        )
        .orderBy(sql`lower(suppliers.name)`)
      break
    case 'created_at':
      qb = qb.orderBy('suppliers.created_at', direction)
      break
  }
  qb = qb.orderBy('suppliers.id')
  const page = await paginate(qb, parsePage(query))
  const loaded = await loadSuppliers(
    tx,
    ctx,
    page.data.map((r) => r.id),
    today,
  )
  return {
    data: page.data.flatMap((r) => {
      const s = loaded.get(r.id)
      return s ? [toListItem(s)] : []
    }),
    page: page.page,
  }
}

export async function createSupplier(
  tx: Tx,
  ctx: Ctx,
  body: SupplierCreateParsed,
): Promise<Supplier> {
  const id = newId()
  const bank = mergeBankDetails(readBankDetails({}), body.bank_details)
  await tx
    .insertInto('suppliers')
    .values({
      id,
      tenant_id: ctx.tenantId,
      code: body.code ?? null,
      name: body.name,
      contact_person: body.contact_person ?? null,
      phone: body.phone ?? null,
      email: body.email ?? null,
      gstin: body.gstin ?? null,
      pan: body.pan ?? (body.gstin ? panFromGstin(body.gstin) : null),
      state_code: body.state_code ?? body.address.state_code ?? null,
      address: jsonb(body.address),
      drug_license_no: body.drug_license_no ?? null,
      payment_terms_days: body.payment_terms_days,
      lead_time_days: body.lead_time_days ?? null,
      opening_balance_paise: body.opening_balance_paise,
      bank_details: jsonb(bank),
      upi_vpa: body.upi_vpa ?? null,
      notes: body.notes ?? null,
      created_by: ctx.userId,
    })
    .execute()
  if (body.opening_balance_paise !== 0) {
    await postOpeningBalance(tx, ctx, {
      party: 'supplier',
      party_id: id,
      amount_paise: body.opening_balance_paise,
      entry_date: await tenantToday(tx, ctx),
      narration: `Opening balance: ${body.name}`,
    })
  }
  await audit(tx, ctx, {
    action: 'supplier.create',
    entity_type: 'supplier',
    entity_id: id,
    summary: `Supplier ${body.name} added${
      body.opening_balance_paise !== 0
        ? ` with opening balance ${rupees(body.opening_balance_paise)}`
        : ''
    }`,
  })
  return getSupplier(tx, ctx, id)
}

function editable(r: SupplierRow): Record<string, unknown> {
  return {
    name: r.name,
    code: r.code,
    contact_person: r.contact_person,
    phone: r.phone,
    email: r.email,
    gstin: r.gstin,
    pan: r.pan,
    state_code: r.state_code,
    address: readAddress(r.address),
    drug_license_no: r.drug_license_no,
    payment_terms_days: r.payment_terms_days,
    lead_time_days: r.lead_time_days,
    opening_balance_paise: r.opening_balance_paise,
    bank_details: readBankDetails(r.bank_details),
    upi_vpa: r.upi_vpa,
    notes: r.notes,
    is_active: r.is_active,
  }
}

async function lockSupplier(tx: Tx, ctx: Ctx, id: string): Promise<SupplierRow> {
  const row = await tx
    .selectFrom('suppliers')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!row) throw notFound('supplier', id)
  return row
}

export async function updateSupplier(
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: SupplierUpdateParsed,
): Promise<Supplier> {
  const existing = await lockSupplier(tx, ctx, id)
  assertNotStale(existing.updated_at, body.if_updated_at, 'supplier', id)

  const patch: Updateable<DB['suppliers']> = {}
  const view: Record<string, unknown> = {}
  const set = <K extends keyof Updateable<DB['suppliers']> & string>(
    key: K,
    value: Updateable<DB['suppliers']>[K] | undefined,
  ) => {
    if (value === undefined) return
    patch[key] = value
    view[key] = value
  }
  set('name', body.name)
  set('code', body.code)
  set('contact_person', body.contact_person)
  set('phone', body.phone)
  set('email', body.email)
  set('gstin', body.gstin)
  // A new GSTIN carries its own PAN: follow it unless the request sets the PAN itself.
  set(
    'pan',
    body.pan === undefined && body.gstin && body.gstin !== existing.gstin
      ? panFromGstin(body.gstin)
      : body.pan,
  )
  set('state_code', body.state_code)
  set('drug_license_no', body.drug_license_no)
  set('payment_terms_days', body.payment_terms_days)
  set('lead_time_days', body.lead_time_days)
  set('upi_vpa', body.upi_vpa)
  set('notes', body.notes)
  set('is_active', body.is_active)
  if (body.address !== undefined) {
    patch.address = jsonb(body.address)
    view.address = body.address
  }
  if (body.bank_details !== undefined) {
    const bank = mergeBankDetails(readBankDetails(existing.bank_details), body.bank_details)
    patch.bank_details = jsonb(bank)
    view.bank_details = bank
  }

  const gstin = body.gstin !== undefined ? body.gstin : existing.gstin
  const stateCode = body.state_code !== undefined ? body.state_code : existing.state_code
  if (gstin && stateCode && gstin.slice(0, 2) !== stateCode)
    throw invalidField(body.state_code !== undefined ? 'state_code' : 'gstin', 'gstin_state')
  const pan = patch.pan !== undefined ? patch.pan : existing.pan
  if (gstin && pan && panFromGstin(gstin) !== pan)
    throw invalidField(body.pan !== undefined ? 'pan' : 'gstin', 'pan_gstin_mismatch')

  const openingChange =
    body.opening_balance_paise !== undefined &&
    body.opening_balance_paise !== existing.opening_balance_paise
      ? body.opening_balance_paise
      : null
  if (openingChange !== null) {
    assertOpeningBalanceEdit(ctx)
    patch.opening_balance_paise = openingChange
    view.opening_balance_paise = openingChange
  }

  const before = editable(existing)
  const changes = diffChanges(before, { ...before, ...view })
  if (changes) {
    if (openingChange !== null) {
      await postOpeningBalance(tx, ctx, {
        party: 'supplier',
        party_id: id,
        amount_paise: openingChange - existing.opening_balance_paise,
        entry_date: await tenantToday(tx, ctx),
        narration: `Opening balance changed from ${rupees(existing.opening_balance_paise)} to ${rupees(openingChange)}: ${existing.name}`,
      })
      await audit(tx, ctx, {
        action: 'supplier.opening_balance_change',
        entity_type: 'supplier',
        entity_id: id,
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
      .updateTable('suppliers')
      .set(patch)
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', id)
      .execute()
    const action =
      body.is_active === false && existing.is_active
        ? 'supplier.deactivate'
        : body.is_active === true && !existing.is_active
          ? 'supplier.activate'
          : 'supplier.update'
    await audit(tx, ctx, {
      action,
      entity_type: 'supplier',
      entity_id: id,
      summary: `Supplier ${existing.name} updated: ${Object.keys(changes.after).join(', ')}`,
      changes,
    })
  }
  return getSupplier(tx, ctx, id)
}

async function supplierHasHistory(tx: Tx, ctx: Ctx, id: string): Promise<boolean> {
  const res = await sql<{ used: boolean }>`select
      exists (select 1 from purchase_orders where tenant_id = ${ctx.tenantId} and supplier_id = ${id})
   or exists (select 1 from purchase_bills where tenant_id = ${ctx.tenantId} and supplier_id = ${id})
   or exists (select 1 from debit_notes where tenant_id = ${ctx.tenantId} and supplier_id = ${id})
   or exists (select 1 from expenses where tenant_id = ${ctx.tenantId} and supplier_id = ${id})
   or exists (select 1 from batches where tenant_id = ${ctx.tenantId} and supplier_id = ${id})
   or exists (select 1 from payments where tenant_id = ${ctx.tenantId} and party_type = 'supplier' and party_id = ${id})
   or exists (select 1 from journal_lines where tenant_id = ${ctx.tenantId} and party_type = 'supplier' and party_id = ${id})
   as used`.execute(tx)
  return res.rows[0]?.used ?? true
}

export async function deleteSupplier(
  tx: Tx,
  ctx: Ctx,
  id: string,
): Promise<{ id: string; result: 'deleted' | 'deactivated' }> {
  const existing = await lockSupplier(tx, ctx, id)
  if (await supplierHasHistory(tx, ctx, id)) {
    if (existing.is_active) {
      await tx
        .updateTable('suppliers')
        .set({ is_active: false })
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', id)
        .execute()
    }
    await audit(tx, ctx, {
      action: 'supplier.deactivate',
      entity_type: 'supplier',
      entity_id: id,
      summary: `Supplier ${existing.name} deactivated (has history)`,
    })
    return { id, result: 'deactivated' }
  }
  await tx
    .deleteFrom('suppliers')
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
  await audit(tx, ctx, {
    action: 'supplier.delete',
    entity_type: 'supplier',
    entity_id: id,
    summary: `Supplier ${existing.name} deleted`,
    changes: { before: editable(existing) },
  })
  return { id, result: 'deleted' }
}
