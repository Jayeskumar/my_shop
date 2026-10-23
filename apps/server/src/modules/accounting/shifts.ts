/**
 * Register shifts (feature `shifts`): open with a float, pay-ins / pay-outs, live X report, close
 * with the counted cash → Z report and the short / excess journal.
 *
 *  - One open shift per register: an advisory lock per register serialises opens (409
 *    shift_already_open {shift_id}); the partial unique index register_shifts_one_open_uq is
 *    the backstop.
 *  - Members with shifts.operate act on their own shifts; shifts.manage acts on everyone's (403
 *    not_own_shift otherwise). No reopen: corrections are manual journals.
 *  - Expected drawer cash (expectedShiftCash) = opening + cash receipts on the shift (completed
 *    payments in, method cash: POS tenders net of change, dues collected) − cash payments out on
 *    the shift (refunds, supplier payments) + pay-ins − pay-outs − posted cash expenses of the
 *    shift. The close difference (counted − expected) posts to cash_short_excess against the
 *    store's drawer cash account (journal source 'shift', source_id = shift id), like the cash
 *    entries.
 *  - The X report is computed live; the Z report is computed under the shift row lock at close
 *    and stored in register_shifts.summary.
 */
import {
  type PaymentMethod,
  type ShiftCashEntryKind,
  instantRangeForDates,
  newId,
  roundDiv,
  sumSafe,
} from '@kadai/shared'
import type {
  ShiftCashEntryCreateSchema,
  ShiftCloseSchema,
  ShiftListQuerySchema,
  ShiftOpenSchema,
} from '@kadai/shared/api/accounting'
import {
  SHIFT_DIFFERENCE_LABELS,
  SHIFT_STATUS_LABELS,
  SHIFT_TOP_ITEMS,
  type Shift,
  type ShiftCashEntry,
  type ShiftDetail,
  type ShiftDifferenceStatus,
  type ShiftListResponse,
  type ShiftSummary,
  ShiftSummarySchema,
  cashEntryJournalLines,
  defaultCashEntryCounter,
  expectedShiftCash,
  shiftDifference,
  shiftDifferenceJournalLines,
  DenominationsSchema,
  type Denominations,
} from '@kadai/shared/api/accounting'
import { toCsv } from '@kadai/shared/api/identity'
import { type SqlBool, sql } from 'kysely'
import type { z } from 'zod'
import { audit } from '../../core/audit'
import { canAccessStore } from '../../core/context'
import {
  AppError,
  conflict,
  forbidden,
  notFound,
  unprocessable,
  validationError,
} from '../../core/errors'
import { type JournalLineInput, postJournal, systemAccountId } from '../../core/ledger'
import type { Tx } from '../../db/tenant'
import { jsonb } from '../../db/json'
import {
  CSV_MAX_ROWS,
  type Ctx,
  type Locale,
  businessCalendar,
  can,
  csvAmount,
  findAccount,
  loadChart,
  loadStore,
  lockKey,
  rupees,
  storeCashAccountId,
  storeScopeCondition,
} from './common'

type ShiftOpenBody = z.output<typeof ShiftOpenSchema>
type ShiftCloseBody = z.output<typeof ShiftCloseSchema>
type ShiftCashEntryBody = z.output<typeof ShiftCashEntryCreateSchema>
type ShiftListQuery = z.output<typeof ShiftListQuerySchema>

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

interface ShiftRow {
  id: string
  store_id: string
  store_name: string
  register_id: string
  register_code: string
  register_name: string
  status: string
  opened_by: string
  opened_by_name: string | null
  opened_at: Date
  opening_cash_paise: number
  closed_by: string | null
  closed_by_name: string | null
  closed_at: Date | null
  expected_cash_paise: number | null
  counted_cash_paise: number | null
  difference_paise: number | null
  denominations: unknown
  summary: unknown
  notes: string | null
  created_at: Date
  updated_at: Date
}

function shiftBaseQuery(tx: Tx, ctx: Pick<Ctx, 'tenantId'>) {
  return tx
    .selectFrom('register_shifts as sh')
    .innerJoin('stores as st', (j) =>
      j.onRef('st.tenant_id', '=', 'sh.tenant_id').onRef('st.id', '=', 'sh.store_id'),
    )
    .innerJoin('registers as rg', (j) =>
      j.onRef('rg.tenant_id', '=', 'sh.tenant_id').onRef('rg.id', '=', 'sh.register_id'),
    )
    .leftJoin('users as ou', 'ou.id', 'sh.opened_by')
    .leftJoin('users as cu', 'cu.id', 'sh.closed_by')
    .where('sh.tenant_id', '=', ctx.tenantId)
}

const SHIFT_COLUMNS = [
  'sh.id',
  'sh.store_id',
  'st.name as store_name',
  'sh.register_id',
  'rg.code as register_code',
  'rg.name as register_name',
  'sh.status',
  'sh.opened_by',
  'ou.full_name as opened_by_name',
  'sh.opened_at',
  'sh.opening_cash_paise',
  'sh.closed_by',
  'cu.full_name as closed_by_name',
  'sh.closed_at',
  'sh.expected_cash_paise',
  'sh.counted_cash_paise',
  'sh.difference_paise',
  'sh.denominations',
  'sh.summary',
  'sh.notes',
  'sh.created_at',
  'sh.updated_at',
] as const

function differenceStatus(d: number | null): ShiftDifferenceStatus | null {
  if (d === null) return null
  return d < 0 ? 'short' : d > 0 ? 'excess' : 'balanced'
}

function storedSummary(value: unknown): ShiftSummary | null {
  if (value === null || value === undefined) return null
  const parsed = ShiftSummarySchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function readDenominations(value: unknown): Denominations | null {
  if (value === null || value === undefined) return null
  const parsed = DenominationsSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function toShift(r: ShiftRow): Shift {
  const closed = r.status === 'closed'
  const z = closed ? storedSummary(r.summary) : null
  return {
    id: r.id,
    store_id: r.store_id,
    store_name: r.store_name,
    register_id: r.register_id,
    register_code: r.register_code,
    register_name: r.register_name,
    status: closed ? 'closed' : 'open',
    opened_by: r.opened_by,
    opened_by_name: r.opened_by_name,
    opened_at: r.opened_at.toISOString(),
    opening_cash_paise: r.opening_cash_paise,
    closed_by: r.closed_by,
    closed_by_name: r.closed_by_name,
    closed_at: r.closed_at ? r.closed_at.toISOString() : null,
    expected_cash_paise: closed ? r.expected_cash_paise : null,
    counted_cash_paise: closed ? r.counted_cash_paise : null,
    difference_paise: closed ? r.difference_paise : null,
    difference_status: closed ? differenceStatus(r.difference_paise) : null,
    bills_count: z ? z.bills.count : null,
    sales_total_paise: z ? z.bills.total_paise : null,
    notes: r.notes,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  }
}

async function lockShift(tx: Tx, ctx: Ctx, id: string): Promise<void> {
  const row = await tx
    .selectFrom('register_shifts')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!row) throw notFound('shift', id)
}

async function loadShiftRow(tx: Tx, ctx: Ctx, id: string): Promise<ShiftRow> {
  const row = await shiftBaseQuery(tx, ctx)
    .select(SHIFT_COLUMNS)
    .where('sh.id', '=', id)
    .executeTakeFirst()
  if (!row || !canAccessStore(ctx, row.store_id)) throw notFound('shift', id)
  return row as ShiftRow
}

function isOwnShift(ctx: Ctx, row: Pick<ShiftRow, 'opened_by'>): boolean {
  return ctx.userId !== null && row.opened_by === ctx.userId
}

function assertOwnOrManage(ctx: Ctx, row: ShiftRow, action: string): void {
  if (!isOwnShift(ctx, row) && !can(ctx, 'shifts.manage')) {
    throw forbidden(`Only the cashier who opened this shift or a manager can ${action} it`, {
      reason: 'not_own_shift',
      required: ['shifts.manage'],
    })
  }
}

// ---------------------------------------------------------------------------------------------
// X / Z report
// ---------------------------------------------------------------------------------------------

/** Cash movements of the shift's drawer (completed payments, posted expenses, cash entries). */
async function shiftCashMovements(tx: Tx, ctx: Ctx, row: ShiftRow) {
  const t = ctx.tenantId
  const pay = await tx
    .selectFrom('payments')
    .select([
      sql<number>`coalesce(sum(amount_paise) filter (where direction = 'in'), 0)::int8`.as('cin'),
      sql<number>`coalesce(sum(amount_paise) filter (where direction = 'out'), 0)::int8`.as('cout'),
    ])
    .where('tenant_id', '=', t)
    .where('shift_id', '=', row.id)
    .where('status', '=', 'completed')
    .where('method', '=', 'cash')
    .executeTakeFirstOrThrow()
  const entries = await tx
    .selectFrom('shift_cash_entries')
    .select([
      sql<number>`coalesce(sum(amount_paise) filter (where kind = 'pay_in'), 0)::int8`.as('ins'),
      sql<number>`coalesce(sum(amount_paise) filter (where kind = 'pay_out'), 0)::int8`.as('outs'),
    ])
    .where('tenant_id', '=', t)
    .where('shift_id', '=', row.id)
    .executeTakeFirstOrThrow()
  const expenses = await tx
    .selectFrom('expenses')
    .select([
      sql<number>`count(*)::int8`.as('count'),
      sql<number>`coalesce(sum(total_paise) filter (where payment_method = 'cash'), 0)::int8`.as(
        'cash',
      ),
    ])
    .where('tenant_id', '=', t)
    .where('shift_id', '=', row.id)
    .where('status', '=', 'posted')
    .executeTakeFirstOrThrow()
  return {
    movements: {
      opening_cash_paise: row.opening_cash_paise,
      cash_receipts_paise: pay.cin,
      cash_payments_paise: pay.cout,
      pay_ins_paise: entries.ins,
      pay_outs_paise: entries.outs,
      cash_expenses_paise: expenses.cash,
    },
    expenses: { count: expenses.count, cash_paise: expenses.cash },
  }
}

/** X (live) or Z (closing) report of a shift. */
export async function computeShiftSummary(
  tx: Tx,
  ctx: Ctx,
  row: ShiftRow,
  opts: { report: 'X' | 'Z'; now: Date; counted_cash_paise?: number | null },
): Promise<ShiftSummary> {
  const t = ctx.tenantId
  const bills = await tx
    .selectFrom('sales_invoices')
    .select([
      sql<number>`count(*)::int8`.as('count'),
      sql<number>`coalesce(sum(gross_paise), 0)::int8`.as('gross_paise'),
      sql<number>`coalesce(sum(item_discount_paise), 0)::int8`.as('item_discount_paise'),
      sql<number>`coalesce(sum(bill_discount_paise), 0)::int8`.as('bill_discount_paise'),
      sql<number>`coalesce(sum(taxable_paise), 0)::int8`.as('taxable_paise'),
      sql<number>`coalesce(sum(cgst_paise + sgst_paise + igst_paise + cess_paise), 0)::int8`.as(
        'tax_paise',
      ),
      sql<number>`coalesce(sum(round_off_paise), 0)::int8`.as('round_off_paise'),
      sql<number>`coalesce(sum(total_paise), 0)::int8`.as('total_paise'),
      sql<number>`coalesce(sum(due_paise), 0)::int8`.as('credit_paise'),
    ])
    .where('tenant_id', '=', t)
    .where('shift_id', '=', row.id)
    .where('status', '=', 'completed')
    .where('doc_type', '<>', 'estimate')
    .executeTakeFirstOrThrow()
  const itemLines = await tx
    .selectFrom('sales_invoice_lines as l')
    .innerJoin('sales_invoices as i', (j) =>
      j.onRef('i.tenant_id', '=', 'l.tenant_id').onRef('i.id', '=', 'l.invoice_id'),
    )
    .select(sql<number>`count(*)::int8`.as('n'))
    .where('l.tenant_id', '=', t)
    .where('i.shift_id', '=', row.id)
    .where('i.status', '=', 'completed')
    .where('i.doc_type', '<>', 'estimate')
    .executeTakeFirstOrThrow()

  const payments = await tx
    .selectFrom('payments')
    .select([
      'direction',
      'method',
      sql<number>`count(*)::int8`.as('count'),
      sql<number>`coalesce(sum(amount_paise), 0)::int8`.as('amount_paise'),
    ])
    .where('tenant_id', '=', t)
    .where('shift_id', '=', row.id)
    .where('status', '=', 'completed')
    .groupBy(['direction', 'method'])
    .orderBy('method')
    .execute()
  const byMethod = (direction: 'in' | 'out') =>
    payments
      .filter((p) => p.direction === direction)
      .map((p) => ({
        method: p.method as PaymentMethod,
        count: p.count,
        amount_paise: p.amount_paise,
      }))

  // Receipts on the shift not applied to the shift's own bills: dues of earlier bills, advances.
  const receivedMoney = sumSafe(
    payments
      .filter((p) => p.direction === 'in' && p.method !== 'store_credit')
      .map((p) => p.amount_paise),
  )
  const ownBillAllocations = await tx
    .selectFrom('payment_allocations as pa')
    .innerJoin('payments as p', (j) =>
      j.onRef('p.tenant_id', '=', 'pa.tenant_id').onRef('p.id', '=', 'pa.payment_id'),
    )
    .innerJoin('sales_invoices as i', (j) =>
      j.onRef('i.tenant_id', '=', 'pa.tenant_id').onRef('i.id', '=', 'pa.target_id'),
    )
    .select(sql<number>`coalesce(sum(pa.amount_paise), 0)::int8`.as('n'))
    .where('pa.tenant_id', '=', t)
    .where('pa.target_type', '=', 'sales_invoice')
    .where('p.shift_id', '=', row.id)
    .where('p.status', '=', 'completed')
    .where('p.direction', '=', 'in')
    .where('p.method', '<>', 'store_credit')
    .where('i.shift_id', '=', row.id)
    .executeTakeFirstOrThrow()

  const returns = await tx
    .selectFrom('credit_notes')
    .select([
      sql<number>`count(*)::int8`.as('count'),
      sql<number>`coalesce(sum(total_paise), 0)::int8`.as('total_paise'),
    ])
    .where('tenant_id', '=', t)
    .where('shift_id', '=', row.id)
    .where('status', '=', 'completed')
    .executeTakeFirstOrThrow()

  const cancelled = await tx
    .selectFrom('sales_invoices as i')
    .leftJoin('users as u', 'u.id', 'i.cancelled_by')
    .select([
      'i.id as invoice_id',
      'i.number',
      'i.total_paise',
      'i.cancel_reason as reason',
      'u.full_name as cancelled_by_name',
    ])
    .where('i.tenant_id', '=', t)
    .where('i.shift_id', '=', row.id)
    .where('i.status', '=', 'cancelled')
    .where('i.doc_type', '<>', 'estimate')
    .orderBy('i.cancelled_at')
    .orderBy('i.id')
    .execute()

  const topItems = await tx
    .selectFrom('sales_invoice_lines as l')
    .innerJoin('sales_invoices as i', (j) =>
      j.onRef('i.tenant_id', '=', 'l.tenant_id').onRef('i.id', '=', 'l.invoice_id'),
    )
    .select([
      'l.product_id',
      'l.name',
      'l.name_ta',
      'l.unit',
      'l.pack_size',
      sql<number>`coalesce(sum(l.qty_milli + l.free_qty_milli), 0)::int8`.as('qty_milli'),
      sql<number>`coalesce(sum(l.total_paise), 0)::int8`.as('total_paise'),
    ])
    .where('l.tenant_id', '=', t)
    .where('i.shift_id', '=', row.id)
    .where('i.status', '=', 'completed')
    .where('i.doc_type', '<>', 'estimate')
    .groupBy(['l.product_id', 'l.name', 'l.name_ta', 'l.unit', 'l.pack_size'])
    .orderBy(sql`total_paise`, 'desc')
    .orderBy('l.name')
    .limit(SHIFT_TOP_ITEMS)
    .execute()

  const { movements, expenses } = await shiftCashMovements(tx, ctx, row)
  const expected = expectedShiftCash(movements)
  const counted = opts.counted_cash_paise ?? null
  const difference = counted === null ? null : shiftDifference(expected, counted).difference_paise

  return {
    version: 1,
    report: opts.report,
    generated_at: opts.now.toISOString(),
    from: row.opened_at.toISOString(),
    to: opts.now.toISOString(),
    bills: {
      count: bills.count,
      gross_paise: bills.gross_paise,
      discount_paise: bills.item_discount_paise + bills.bill_discount_paise,
      taxable_paise: bills.taxable_paise,
      tax_paise: bills.tax_paise,
      round_off_paise: bills.round_off_paise,
      total_paise: bills.total_paise,
      avg_bill_paise: bills.count > 0 ? roundDiv(bills.total_paise, bills.count) : 0,
      item_lines: itemLines.n,
      credit_paise: bills.credit_paise,
    },
    payments_in: byMethod('in'),
    payments_out: byMethod('out'),
    dues_collected_paise: Math.max(0, receivedMoney - ownBillAllocations.n),
    returns: { count: returns.count, total_paise: returns.total_paise },
    cancelled_bills: {
      count: cancelled.length,
      total_paise: sumSafe(cancelled.map((c) => c.total_paise)),
      items: cancelled,
    },
    discounts: {
      item_paise: bills.item_discount_paise,
      bill_paise: bills.bill_discount_paise,
      total_paise: bills.item_discount_paise + bills.bill_discount_paise,
    },
    top_items: topItems,
    expenses,
    cash: {
      ...movements,
      expected_cash_paise: expected,
      counted_cash_paise: counted,
      difference_paise: difference,
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------------------------

async function cashEntries(tx: Tx, ctx: Ctx, shiftId: string): Promise<ShiftCashEntry[]> {
  const rows = await tx
    .selectFrom('shift_cash_entries as ce')
    .leftJoin('accounts as a', (j) =>
      j.onRef('a.tenant_id', '=', 'ce.tenant_id').onRef('a.id', '=', 'ce.account_id'),
    )
    .leftJoin('users as u', 'u.id', 'ce.created_by')
    .select([
      'ce.id',
      'ce.shift_id',
      'ce.kind',
      'ce.amount_paise',
      'ce.account_id',
      'a.code as account_code',
      'a.name as account_name',
      'ce.reason',
      'ce.created_by',
      'u.full_name as created_by_name',
      'ce.created_at',
    ])
    .where('ce.tenant_id', '=', ctx.tenantId)
    .where('ce.shift_id', '=', shiftId)
    .orderBy('ce.created_at')
    .orderBy('ce.id')
    .execute()
  return rows.map((r) => ({
    ...r,
    kind: r.kind as ShiftCashEntryKind,
    created_at: r.created_at.toISOString(),
  }))
}

async function shiftDetail(tx: Tx, ctx: Ctx, row: ShiftRow): Promise<ShiftDetail> {
  const open = row.status === 'open'
  const summary =
    (!open ? storedSummary(row.summary) : null) ??
    (await computeShiftSummary(tx, ctx, row, {
      report: open ? 'X' : 'Z',
      now: open ? new Date() : (row.closed_at ?? new Date()),
      counted_cash_paise: open ? null : row.counted_cash_paise,
    }))
  const actor =
    open && can(ctx, 'shifts.operate') && (isOwnShift(ctx, row) || can(ctx, 'shifts.manage'))
  return {
    ...toShift(row),
    denominations: readDenominations(row.denominations),
    summary,
    cash_entries: await cashEntries(tx, ctx, row.id),
    can_close: actor,
    can_add_cash_entry: actor,
  }
}

export async function getShift(tx: Tx, ctx: Ctx, id: string): Promise<ShiftDetail> {
  const row = await loadShiftRow(tx, ctx, id)
  assertOwnOrManage(ctx, row, 'view')
  return shiftDetail(tx, ctx, row)
}

async function loadRegister(tx: Tx, ctx: Ctx, registerId: string) {
  const register = await tx
    .selectFrom('registers')
    .select(['id', 'store_id', 'code', 'name', 'is_active'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', registerId)
    .executeTakeFirst()
  if (!register) throw notFound('register', registerId)
  if (!canAccessStore(ctx, register.store_id)) {
    throw forbidden('You do not have access to this counter', { store_id: register.store_id })
  }
  return register
}

/** GET /shifts/current: the register's open shift (any cashier of the store), or null. */
export async function currentShift(
  tx: Tx,
  ctx: Ctx,
  registerId: string,
): Promise<ShiftDetail | null> {
  const register = await loadRegister(tx, ctx, registerId)
  const open = await tx
    .selectFrom('register_shifts')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('register_id', '=', register.id)
    .where('status', '=', 'open')
    .executeTakeFirst()
  if (!open) return null
  return shiftDetail(tx, ctx, await loadShiftRow(tx, ctx, open.id))
}

// ---------------------------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------------------------

export async function openShift(tx: Tx, ctx: Ctx, body: ShiftOpenBody): Promise<ShiftDetail> {
  if (!ctx.userId) {
    throw unprocessable('A shift belongs to a user; sign in as the cashier to open it', {
      reason: 'shift_user_required',
    })
  }
  const register = await loadRegister(tx, ctx, body.register_id)
  if (!register.is_active) {
    throw unprocessable('This counter is inactive', {
      path: 'register_id',
      register_id: register.id,
    })
  }
  await loadStore(tx, ctx, register.store_id)
  // One open shift per register: serialise opens of the same register.
  await lockKey(tx, `shift-open:${ctx.tenantId}:${register.id}`)
  const existing = await tx
    .selectFrom('register_shifts')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('register_id', '=', register.id)
    .where('status', '=', 'open')
    .executeTakeFirst()
  if (existing) {
    throw conflict('This counter already has an open shift', {
      reason: 'shift_already_open',
      shift_id: existing.id,
    })
  }
  const id = newId()
  const now = new Date()
  await tx
    .insertInto('register_shifts')
    .values({
      id,
      tenant_id: ctx.tenantId,
      store_id: register.store_id,
      register_id: register.id,
      status: 'open',
      opened_by: ctx.userId,
      opened_at: now,
      opening_cash_paise: body.opening_cash_paise,
      denominations: body.denominations ? jsonb(body.denominations) : null,
      notes: body.notes ?? null,
    })
    .execute()
  await audit(tx, ctx, {
    action: 'shift.open',
    entity_type: 'shift',
    entity_id: id,
    summary: `Shift opened on counter ${register.code} with ${rupees(body.opening_cash_paise)}`,
    changes: { register_id: register.id, opening_cash_paise: body.opening_cash_paise },
  })
  return shiftDetail(tx, ctx, await loadShiftRow(tx, ctx, id))
}

// ---------------------------------------------------------------------------------------------
// Cash entries (pay-in / pay-out)
// ---------------------------------------------------------------------------------------------

export async function addCashEntry(
  tx: Tx,
  ctx: Ctx,
  shiftId: string,
  body: ShiftCashEntryBody,
): Promise<ShiftCashEntry> {
  await lockShift(tx, ctx, shiftId)
  const row = await loadShiftRow(tx, ctx, shiftId)
  assertOwnOrManage(ctx, row, 'move cash in')
  if (row.status !== 'open') {
    throw conflict('This shift is closed', { reason: 'shift_closed', shift_id: row.id })
  }
  const chart = await loadChart(tx, ctx)
  const cashAccountId = await storeCashAccountId(tx, ctx, chart, row.store_id)
  let counterId: string
  if (body.account_id) {
    const account = findAccount(chart, ctx, body.account_id)
    if (!account.is_active) {
      throw unprocessable(`The account ${account.name} is inactive`, {
        reason: 'account_inactive',
        path: 'account_id',
      })
    }
    if (account.subtype === 'receivable' || account.subtype === 'payable') {
      throw unprocessable('Customer / supplier accounts need a party; record a payment instead', {
        reason: 'party_required',
        path: 'account_id',
      })
    }
    if (account.id === cashAccountId) {
      throw validationError([{ path: 'account_id', message: 'cash_entry_same_account' }])
    }
    counterId = account.id
  } else {
    counterId = await systemAccountId(tx, ctx, body.counter ?? defaultCashEntryCounter(body.kind))
  }

  const cal = await businessCalendar(tx, ctx)
  const id = newId()
  await tx
    .insertInto('shift_cash_entries')
    .values({
      id,
      tenant_id: ctx.tenantId,
      shift_id: row.id,
      kind: body.kind,
      amount_paise: body.amount_paise,
      account_id: counterId,
      reason: body.reason,
      created_by: ctx.userId,
    })
    .execute()
  const lines: JournalLineInput[] = cashEntryJournalLines(
    body.kind,
    body.amount_paise,
    cashAccountId,
    { id: counterId },
  ).map((l) => ({
    account: l.account,
    debit_paise: l.debit_paise,
    credit_paise: l.credit_paise,
    memo: body.reason,
  }))
  await postJournal(tx, ctx, {
    entry_date: cal.today,
    store_id: row.store_id,
    source_type: 'shift',
    source_id: row.id,
    narration: `${body.kind === 'pay_in' ? 'Cash in' : 'Cash out'} — counter ${row.register_code}: ${body.reason}`,
    lines,
  })
  await audit(tx, ctx, {
    action: 'shift.cash_entry',
    entity_type: 'shift',
    entity_id: row.id,
    summary: `${body.kind === 'pay_in' ? 'Cash in' : 'Cash out'} ${rupees(body.amount_paise)} on counter ${row.register_code}: ${body.reason}`,
    changes: {
      cash_entry_id: id,
      kind: body.kind,
      amount_paise: body.amount_paise,
      account_id: counterId,
    },
  })
  const entries = await cashEntries(tx, ctx, row.id)
  const entry = entries.find((e) => e.id === id)
  if (!entry) throw new AppError('INTERNAL', 'cash entry missing after insert')
  return entry
}

// ---------------------------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------------------------

export async function closeShift(
  tx: Tx,
  ctx: Ctx,
  shiftId: string,
  body: ShiftCloseBody,
): Promise<ShiftDetail> {
  await lockShift(tx, ctx, shiftId)
  const row = await loadShiftRow(tx, ctx, shiftId)
  assertOwnOrManage(ctx, row, 'close')
  if (row.status !== 'open') {
    throw conflict('This shift is already closed', { reason: 'shift_closed', shift_id: row.id })
  }
  const now = new Date()
  const summary = await computeShiftSummary(tx, ctx, row, {
    report: 'Z',
    now,
    counted_cash_paise: body.counted_cash_paise,
  })
  const expected = summary.cash.expected_cash_paise
  const { difference_paise: difference } = shiftDifference(expected, body.counted_cash_paise)

  if (difference !== 0) {
    const chart = await loadChart(tx, ctx)
    const cashAccountId = await storeCashAccountId(tx, ctx, chart, row.store_id)
    const cal = await businessCalendar(tx, ctx)
    await postJournal(tx, ctx, {
      entry_date: cal.today,
      store_id: row.store_id,
      source_type: 'shift',
      source_id: row.id,
      narration: `Shift close — counter ${row.register_code}: cash ${difference < 0 ? 'short' : 'excess'} ${rupees(Math.abs(difference))}`,
      lines: shiftDifferenceJournalLines(difference, cashAccountId).map((l) => ({
        account: l.account,
        debit_paise: l.debit_paise,
        credit_paise: l.credit_paise,
      })),
    })
  }

  const notes = [row.notes, body.notes].filter((n): n is string => Boolean(n)).join('\n') || null
  await tx
    .updateTable('register_shifts')
    .set({
      status: 'closed',
      closed_by: ctx.userId,
      closed_at: now,
      expected_cash_paise: expected,
      counted_cash_paise: body.counted_cash_paise,
      difference_paise: difference,
      denominations: body.denominations ? jsonb(body.denominations) : null,
      summary: jsonb(summary),
      notes,
      updated_at: now,
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', row.id)
    .execute()
  await audit(tx, ctx, {
    action: 'shift.close',
    entity_type: 'shift',
    entity_id: row.id,
    summary: `Shift on counter ${row.register_code} closed: expected ${rupees(expected)}, counted ${rupees(body.counted_cash_paise)}, difference ${rupees(difference)}`,
    changes: {
      expected_cash_paise: expected,
      counted_cash_paise: body.counted_cash_paise,
      difference_paise: difference,
      closed_for: isOwnShift(ctx, row) ? null : row.opened_by,
    },
  })
  return shiftDetail(tx, ctx, await loadShiftRow(tx, ctx, row.id))
}

// ---------------------------------------------------------------------------------------------
// List (GET /shifts)
// ---------------------------------------------------------------------------------------------

const SORT_COLUMNS = {
  opened_at: 'sh.opened_at',
  closed_at: 'sh.closed_at',
  difference_paise: 'sh.difference_paise',
} as const

async function filteredShifts(tx: Tx, ctx: Ctx, query: ShiftListQuery) {
  let q = shiftBaseQuery(tx, ctx)
  if (query.store_id) {
    await loadStore(tx, ctx, query.store_id)
    q = q.where('sh.store_id', '=', query.store_id)
  }
  const scope = storeScopeCondition('sh.store_id', ctx)
  if (scope) q = q.where(scope)
  if (!can(ctx, 'shifts.manage')) {
    // Operate-only members see their own shifts (API keys, which have no user, see none).
    const userId = ctx.userId
    q = userId ? q.where('sh.opened_by', '=', userId) : q.where(sql<SqlBool>`false`)
  }
  if (query.user_id) q = q.where('sh.opened_by', '=', query.user_id)
  if (query.register_id) q = q.where('sh.register_id', '=', query.register_id)
  if (query.status) q = q.where('sh.status', '=', query.status)
  if (query.from || query.to) {
    const cal = await businessCalendar(tx, ctx)
    const range = instantRangeForDates(
      query.from ?? '2000-01-01',
      query.to ?? cal.today,
      cal.timezone,
    )
    if (query.from) q = q.where('sh.opened_at', '>=', range.start)
    if (query.to) q = q.where('sh.opened_at', '<', range.end)
  }
  if (query.difference) {
    q = q.where('sh.status', '=', 'closed')
    q =
      query.difference === 'short'
        ? q.where('sh.difference_paise', '<', 0)
        : query.difference === 'excess'
          ? q.where('sh.difference_paise', '>', 0)
          : q.where('sh.difference_paise', '=', 0)
  }
  return q
}

export async function listShifts(
  tx: Tx,
  ctx: Ctx,
  query: ShiftListQuery,
  opts: { all?: boolean } = {},
): Promise<ShiftListResponse> {
  const base = await filteredShifts(tx, ctx, query)
  const summary = await base
    .select([
      sql<number>`count(*)::int8`.as('count'),
      sql<number>`count(*) filter (where sh.status = 'open')::int8`.as('open_count'),
      sql<number>`coalesce(sum(sh.difference_paise) filter (where sh.status = 'closed' and sh.difference_paise < 0), 0)::int8`.as(
        'short_paise',
      ),
      sql<number>`coalesce(sum(sh.difference_paise) filter (where sh.status = 'closed' and sh.difference_paise > 0), 0)::int8`.as(
        'excess_paise',
      ),
    ])
    .executeTakeFirstOrThrow()
  const dir = query.sort.direction
  const rows = (await base
    .select(SHIFT_COLUMNS)
    .orderBy(SORT_COLUMNS[query.sort.field], (ob) =>
      dir === 'desc' ? ob.desc().nullsLast() : ob.asc().nullsLast(),
    )
    .orderBy('sh.opened_at', dir)
    .orderBy('sh.id', dir)
    .limit(opts.all ? CSV_MAX_ROWS : query.limit)
    .offset(opts.all ? 0 : query.offset)
    .execute()) as ShiftRow[]
  return {
    data: rows.map(toShift),
    page: { limit: query.limit, offset: query.offset, total: summary.count },
    summary,
  }
}

const CSV_HEADERS = {
  opened_at: { en: 'Opened at', ta: 'திறந்த நேரம்' },
  closed_at: { en: 'Closed at', ta: 'மூடிய நேரம்' },
  store: { en: 'Store', ta: 'கடை' },
  register: { en: 'Counter', ta: 'கவுண்டர்' },
  opened_by: { en: 'Opened by', ta: 'திறந்தவர்' },
  closed_by: { en: 'Closed by', ta: 'மூடியவர்' },
  status: { en: 'Status', ta: 'நிலை' },
  opening: { en: 'Opening cash', ta: 'தொடக்க ரொக்கம்' },
  bills: { en: 'Bills', ta: 'பில்கள்' },
  sales: { en: 'Sales', ta: 'விற்பனை' },
  expected: { en: 'Expected cash', ta: 'இருக்க வேண்டிய ரொக்கம்' },
  counted: { en: 'Counted cash', ta: 'எண்ணிய ரொக்கம்' },
  difference: { en: 'Difference', ta: 'வித்தியாசம்' },
  result: { en: 'Result', ta: 'முடிவு' },
} as const

export function shiftsCsv(list: ShiftListResponse, locale: Locale): string {
  const rows: string[][] = [Object.values(CSV_HEADERS).map((h) => h[locale])]
  for (const s of list.data) {
    rows.push([
      s.opened_at,
      s.closed_at ?? '',
      s.store_name,
      s.register_code,
      s.opened_by_name ?? '',
      s.closed_by_name ?? '',
      SHIFT_STATUS_LABELS[s.status][locale],
      csvAmount(s.opening_cash_paise),
      s.bills_count === null ? '' : String(s.bills_count),
      csvAmount(s.sales_total_paise),
      csvAmount(s.expected_cash_paise),
      csvAmount(s.counted_cash_paise),
      csvAmount(s.difference_paise),
      s.difference_status ? SHIFT_DIFFERENCE_LABELS[s.difference_status][locale] : '',
    ])
  }
  return toCsv(rows)
}
