/**
 * Expenses (expenses.write): GST-aware expense vouchers (EXP series) and their cancellation.
 *
 *   create → computeExpenseAmounts() (amount incl. GST as total_paise, or excl. as taxable_paise;
 *            CGST/SGST or IGST by supplier state vs store state) → number 'expense' → journal per
 *            expenseJournalLines(): Dr expense head (taxable with ITC, else the whole bill), Dr
 *            input CGST/SGST/IGST (ITC only), Cr the cash / bank account paid from — or Cr
 *            payable(supplier) on credit (the supplier's balance rises; supplier payments settle
 *            it with allocation target 'expense' through core/payments).
 *   cash paid from a counter (register_id, default the device's register) joins its open shift,
 *   so the drawer's expected cash at close excludes it.
 *   cancel → reverseJournal (audited; 409 expense_has_payments while supplier payments are
 *            allocated to it).
 */
import { type ExpensePaymentMethod, newId, sumSafe } from '@kadai/shared'
import type {
  ExpenseCancelSchema,
  ExpenseCreateSchema,
  ExpenseListQuerySchema,
} from '@kadai/shared/api/accounting'
import {
  EXPENSE_PAYMENT_METHOD_LABELS,
  EXPENSE_STATUS_LABELS,
  type Expense,
  type ExpenseDetail,
  type ExpenseListResponse,
  type ExpenseListSummary,
  computeExpenseAmounts,
  defaultPaidFromKind,
  expenseJournalLines,
} from '@kadai/shared/api/accounting'
import { toCsv } from '@kadai/shared/api/identity'
import { type SqlBool, sql } from 'kysely'
import type { z } from 'zod'
import { audit } from '../../core/audit'
import { canAccessStore } from '../../core/context'
import { AppError, conflict, notFound, unprocessable, validationError } from '../../core/errors'
import { type JournalLineInput, postJournal, reverseJournal } from '../../core/ledger'
import { nextNumber } from '../../core/numbering'
import type { Tx } from '../../db/tenant'
import {
  CSV_MAX_ROWS,
  type Ctx,
  type Locale,
  businessCalendar,
  can,
  csvAmount,
  findAccount,
  likePattern,
  loadChart,
  loadStore,
  localName,
  rupees,
  storeMoneyAccountId,
  storeScopeCondition,
} from './common'

type ExpenseCreateBody = z.output<typeof ExpenseCreateSchema>
type ExpenseListQuery = z.output<typeof ExpenseListQuerySchema>
type ExpenseCancelBody = z.output<typeof ExpenseCancelSchema>

/** Expense-type system accounts that are posting targets of other documents, not categories. */
const NON_CATEGORY_SUBTYPES: ReadonlySet<string> = new Set([
  'cogs',
  'inventory_adjustment',
  'inventory_writeoff',
  'cash_short_excess',
])

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

function expenseBaseQuery(tx: Tx, ctx: Pick<Ctx, 'tenantId'>) {
  return tx
    .selectFrom('expenses as x')
    .innerJoin('stores as s', (j) =>
      j.onRef('s.tenant_id', '=', 'x.tenant_id').onRef('s.id', '=', 'x.store_id'),
    )
    .innerJoin('accounts as ea', (j) =>
      j.onRef('ea.tenant_id', '=', 'x.tenant_id').onRef('ea.id', '=', 'x.expense_account_id'),
    )
    .leftJoin('accounts as pa', (j) =>
      j.onRef('pa.tenant_id', '=', 'x.tenant_id').onRef('pa.id', '=', 'x.paid_from_account_id'),
    )
    .leftJoin('suppliers as sp', (j) =>
      j.onRef('sp.tenant_id', '=', 'x.tenant_id').onRef('sp.id', '=', 'x.supplier_id'),
    )
    .leftJoin('users as cu', 'cu.id', 'x.created_by')
    .leftJoin('users as xu', 'xu.id', 'x.cancelled_by')
    .where('x.tenant_id', '=', ctx.tenantId)
}

const EXPENSE_COLUMNS = [
  'x.id',
  'x.store_id',
  's.name as store_name',
  'x.number',
  'x.fy',
  'x.expense_date',
  'x.expense_account_id',
  'ea.code as expense_account_code',
  'ea.name as expense_account_name',
  'ea.name_ta as expense_account_name_ta',
  'x.supplier_id',
  'sp.name as supplier_name',
  'x.description',
  'x.taxable_paise',
  'x.gst_rate_bp',
  'x.cgst_paise',
  'x.sgst_paise',
  'x.igst_paise',
  'x.itc_eligible',
  'x.total_paise',
  'x.payment_method',
  'x.paid_from_account_id',
  'pa.name as paid_from_account_name',
  'x.reference',
  'x.attachment_file_id',
  'x.status',
  'x.shift_id',
  'x.cancelled_at',
  'x.cancelled_by',
  'xu.full_name as cancelled_by_name',
  'x.cancel_reason',
  'x.created_by',
  'cu.full_name as created_by_name',
  'x.created_at',
  'x.updated_at',
] as const

interface ExpenseRow {
  id: string
  store_id: string
  store_name: string
  number: string | null
  fy: string | null
  expense_date: string
  expense_account_id: string
  expense_account_code: string
  expense_account_name: string
  expense_account_name_ta: string | null
  supplier_id: string | null
  supplier_name: string | null
  description: string | null
  taxable_paise: number
  gst_rate_bp: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
  itc_eligible: boolean
  total_paise: number
  payment_method: string
  paid_from_account_id: string | null
  paid_from_account_name: string | null
  reference: string | null
  attachment_file_id: string | null
  status: string
  shift_id: string | null
  cancelled_at: Date | null
  cancelled_by: string | null
  cancelled_by_name: string | null
  cancel_reason: string | null
  created_by: string | null
  created_by_name: string | null
  created_at: Date
  updated_at: Date
}

function toExpense(r: ExpenseRow): Expense {
  return {
    ...r,
    payment_method: r.payment_method as ExpensePaymentMethod,
    status: r.status === 'cancelled' ? 'cancelled' : 'posted',
    tax_paise: r.cgst_paise + r.sgst_paise + r.igst_paise,
    is_interstate: r.igst_paise > 0,
    cancelled_at: r.cancelled_at ? r.cancelled_at.toISOString() : null,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  }
}

async function loadExpenseRow(
  tx: Tx,
  ctx: Ctx,
  id: string,
  opts: { forUpdate?: boolean } = {},
): Promise<ExpenseRow> {
  if (opts.forUpdate) {
    // Lock the document row first (joins cannot be locked through nullable sides).
    const locked = await tx
      .selectFrom('expenses')
      .select('id')
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst()
    if (!locked) throw notFound('expense', id)
  }
  const row = await expenseBaseQuery(tx, ctx)
    .select(EXPENSE_COLUMNS)
    .where('x.id', '=', id)
    .executeTakeFirst()
  if (!row || !canAccessStore(ctx, row.store_id)) throw notFound('expense', id)
  return row as ExpenseRow
}

export async function getExpense(tx: Tx, ctx: Ctx, id: string): Promise<ExpenseDetail> {
  const row = await loadExpenseRow(tx, ctx, id)
  const expense = toExpense(row)
  const entries = await tx
    .selectFrom('journal_entries')
    .select(['id', 'reverses_entry_id'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('source_type', '=', 'expense')
    .where('source_id', '=', row.id)
    .orderBy('created_at')
    .execute()
  const original = entries.find((e) => e.reverses_entry_id === null) ?? null
  const reversal = entries.find((e) => e.reverses_entry_id !== null) ?? null
  const payments =
    row.payment_method === 'credit'
      ? await tx
          .selectFrom('payment_allocations as pa')
          .innerJoin('payments as p', (j) =>
            j.onRef('p.tenant_id', '=', 'pa.tenant_id').onRef('p.id', '=', 'pa.payment_id'),
          )
          .select([
            'p.id as payment_id',
            'p.number',
            'p.payment_date',
            'p.method',
            'pa.amount_paise',
          ])
          .where('pa.tenant_id', '=', ctx.tenantId)
          .where('pa.target_type', '=', 'expense')
          .where('pa.target_id', '=', row.id)
          .where('p.status', '=', 'completed')
          .orderBy('p.payment_date')
          .orderBy('p.created_at')
          .execute()
      : []
  const cancelled = expense.status === 'cancelled'
  const paid =
    row.payment_method === 'credit'
      ? sumSafe(payments.map((p) => p.amount_paise))
      : cancelled
        ? 0
        : row.total_paise
  return {
    ...expense,
    journal_entry_id: original?.id ?? null,
    reversal_entry_id: reversal?.id ?? null,
    paid_paise: paid,
    due_paise: cancelled ? 0 : Math.max(0, row.total_paise - paid),
    payments: payments.map((p) => ({
      ...p,
      method: p.method as ExpenseDetail['payments'][number]['method'],
    })),
    can_cancel: !cancelled && payments.length === 0 && can(ctx, 'expenses.write'),
  }
}

// ---------------------------------------------------------------------------------------------
// List (GET /expenses)
// ---------------------------------------------------------------------------------------------

function filteredExpenses(tx: Tx, ctx: Ctx, query: ExpenseListQuery) {
  let q = expenseBaseQuery(tx, ctx)
  if (query.from) q = q.where('x.expense_date', '>=', query.from)
  if (query.to) q = q.where('x.expense_date', '<=', query.to)
  if (query.store_id) q = q.where('x.store_id', '=', query.store_id)
  const scope = storeScopeCondition('x.store_id', ctx)
  if (scope) q = q.where(scope)
  if (query.expense_account_id?.length) {
    q = q.where('x.expense_account_id', 'in', query.expense_account_id)
  }
  if (query.payment_method?.length) q = q.where('x.payment_method', 'in', query.payment_method)
  if (query.status) q = q.where('x.status', '=', query.status)
  if (query.supplier_id) q = q.where('x.supplier_id', '=', query.supplier_id)
  if (query.shift_id) q = q.where('x.shift_id', '=', query.shift_id)
  if (query.itc_eligible !== undefined) q = q.where('x.itc_eligible', '=', query.itc_eligible)
  if (query.q) {
    const p = likePattern(query.q)
    q = q.where(
      sql<SqlBool>`(x.number ilike ${p} or x.description ilike ${p} or x.reference ilike ${p})`,
    )
  }
  return q
}

const SORT_COLUMNS = {
  expense_date: 'x.expense_date',
  created_at: 'x.created_at',
  total_paise: 'x.total_paise',
  number: 'x.number',
} as const

export async function listExpenses(
  tx: Tx,
  ctx: Ctx,
  query: ExpenseListQuery,
  opts: { all?: boolean } = {},
): Promise<ExpenseListResponse> {
  if (query.store_id) await loadStore(tx, ctx, query.store_id)
  const base = filteredExpenses(tx, ctx, query)
  const count = await base.select(sql<number>`count(*)::int8`.as('n')).executeTakeFirstOrThrow()
  const dir = query.sort.direction
  const rows = (await base
    .select(EXPENSE_COLUMNS)
    .orderBy(SORT_COLUMNS[query.sort.field], dir)
    .orderBy('x.created_at', dir)
    .orderBy('x.id', dir)
    .limit(opts.all ? CSV_MAX_ROWS : query.limit)
    .offset(opts.all ? 0 : query.offset)
    .execute()) as ExpenseRow[]
  const summary = await expenseSummary(tx, ctx, query)
  return {
    data: rows.map(toExpense),
    page: { limit: query.limit, offset: query.offset, total: count.n },
    summary,
  }
}

async function expenseSummary(
  tx: Tx,
  ctx: Ctx,
  query: ExpenseListQuery,
): Promise<ExpenseListSummary> {
  const posted = filteredExpenses(tx, ctx, query).where('x.status', '=', 'posted')
  const totals = await posted
    .select([
      sql<number>`count(*)::int8`.as('count'),
      sql<number>`coalesce(sum(x.taxable_paise), 0)::int8`.as('taxable_paise'),
      sql<number>`coalesce(sum(x.cgst_paise + x.sgst_paise + x.igst_paise), 0)::int8`.as(
        'tax_paise',
      ),
      sql<number>`coalesce(sum(x.cgst_paise + x.sgst_paise + x.igst_paise)
        filter (where x.itc_eligible), 0)::int8`.as('itc_paise'),
      sql<number>`coalesce(sum(x.total_paise), 0)::int8`.as('total_paise'),
    ])
    .executeTakeFirstOrThrow()
  const byCategory = await posted
    .select([
      'x.expense_account_id',
      'ea.code',
      'ea.name',
      'ea.name_ta',
      sql<number>`count(*)::int8`.as('count'),
      sql<number>`coalesce(sum(x.total_paise), 0)::int8`.as('total_paise'),
    ])
    .groupBy(['x.expense_account_id', 'ea.code', 'ea.name', 'ea.name_ta'])
    .orderBy(sql`total_paise`, 'desc')
    .orderBy('ea.code')
    .execute()
  const byMethod = await posted
    .select([
      'x.payment_method',
      sql<number>`count(*)::int8`.as('count'),
      sql<number>`coalesce(sum(x.total_paise), 0)::int8`.as('total_paise'),
    ])
    .groupBy('x.payment_method')
    .orderBy(sql`total_paise`, 'desc')
    .execute()
  return {
    ...totals,
    by_category: byCategory,
    by_method: byMethod.map((m) => ({
      ...m,
      payment_method: m.payment_method as ExpensePaymentMethod,
    })),
  }
}

const CSV_HEADERS = {
  date: { en: 'Date', ta: 'தேதி' },
  number: { en: 'Number', ta: 'எண்' },
  store: { en: 'Store', ta: 'கடை' },
  category: { en: 'Category', ta: 'செலவு வகை' },
  description: { en: 'Description', ta: 'விவரம்' },
  supplier: { en: 'Supplier', ta: 'சப்ளையர்' },
  method: { en: 'Paid by', ta: 'செலுத்திய முறை' },
  paid_from: { en: 'Paid from', ta: 'எந்தக் கணக்கிலிருந்து' },
  reference: { en: 'Reference', ta: 'குறிப்பு எண்' },
  taxable: { en: 'Taxable value', ta: 'வரி விதிக்கத்தக்க மதிப்பு' },
  gst_rate: { en: 'GST %', ta: 'GST %' },
  cgst: { en: 'CGST', ta: 'CGST' },
  sgst: { en: 'SGST', ta: 'SGST' },
  igst: { en: 'IGST', ta: 'IGST' },
  itc: { en: 'ITC', ta: 'ITC' },
  total: { en: 'Total', ta: 'மொத்தம்' },
  status: { en: 'Status', ta: 'நிலை' },
} as const

export function expensesCsv(list: ExpenseListResponse, locale: Locale): string {
  const yes = locale === 'ta' ? 'ஆம்' : 'Yes'
  const no = locale === 'ta' ? 'இல்லை' : 'No'
  const rows: string[][] = [Object.values(CSV_HEADERS).map((h) => h[locale])]
  for (const e of list.data) {
    rows.push([
      e.expense_date,
      e.number ?? '',
      e.store_name,
      localName({ name: e.expense_account_name, name_ta: e.expense_account_name_ta }, locale),
      e.description ?? '',
      e.supplier_name ?? '',
      EXPENSE_PAYMENT_METHOD_LABELS[e.payment_method][locale],
      e.paid_from_account_name ?? '',
      e.reference ?? '',
      csvAmount(e.taxable_paise),
      String(e.gst_rate_bp / 100),
      csvAmount(e.cgst_paise),
      csvAmount(e.sgst_paise),
      csvAmount(e.igst_paise),
      e.itc_eligible ? yes : no,
      csvAmount(e.total_paise),
      EXPENSE_STATUS_LABELS[e.status][locale],
    ])
  }
  return toCsv(rows)
}

// ---------------------------------------------------------------------------------------------
// Create (POST /expenses)
// ---------------------------------------------------------------------------------------------

/** The open shift of the register paying a cash expense (locked), or null. */
async function openShiftFor(
  tx: Tx,
  ctx: Ctx,
  storeId: string,
  registerId: string,
): Promise<string | null> {
  const register = await tx
    .selectFrom('registers')
    .select(['id', 'store_id'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', registerId)
    .executeTakeFirst()
  if (!register) throw notFound('register', registerId)
  if (register.store_id !== storeId) {
    throw unprocessable('The counter belongs to another store', {
      register_id: registerId,
      path: 'register_id',
    })
  }
  const shift = await tx
    .selectFrom('register_shifts')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('register_id', '=', registerId)
    .where('status', '=', 'open')
    .forUpdate()
    .executeTakeFirst()
  return shift?.id ?? null
}

export async function createExpense(
  tx: Tx,
  ctx: Ctx,
  body: ExpenseCreateBody,
): Promise<ExpenseDetail> {
  const store = await loadStore(tx, ctx, body.store_id)
  const chart = await loadChart(tx, ctx)

  const head = findAccount(chart, ctx, body.expense_account_id)
  if (head.type !== 'expense' || (head.subtype && NON_CATEGORY_SUBTYPES.has(head.subtype))) {
    throw unprocessable('Choose an expense category (an expense account)', {
      reason: 'expense_account_required',
      path: 'expense_account_id',
    })
  }
  if (!head.is_active) {
    throw unprocessable(`The expense category ${head.name} is inactive`, {
      reason: 'account_inactive',
      path: 'expense_account_id',
    })
  }

  if (body.itc_eligible) {
    const tenant = await tx
      .selectFrom('tenants')
      .select('gst_scheme')
      .where('id', '=', ctx.tenantId)
      .executeTakeFirstOrThrow()
    if (tenant.gst_scheme !== 'regular') {
      throw unprocessable('Input tax credit is only for regular GST registrations', {
        reason: 'itc_not_allowed',
        path: 'itc_eligible',
        gst_scheme: tenant.gst_scheme,
      })
    }
  }

  const supplier = body.supplier_id
    ? await tx
        .selectFrom('suppliers')
        .select(['id', 'name', 'state_code', 'is_active'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', body.supplier_id)
        .executeTakeFirst()
    : null
  if (body.supplier_id && !supplier) throw notFound('supplier', body.supplier_id)

  const isInterstate =
    body.is_interstate ?? Boolean(supplier?.state_code && supplier.state_code !== store.state_code)
  const amounts = computeExpenseAmounts({
    taxable_paise: body.taxable_paise ?? null,
    total_paise: body.total_paise ?? null,
    gst_rate_bp: body.gst_rate_bp,
    is_interstate: isInterstate,
  })
  if (amounts.total_paise <= 0 || amounts.taxable_paise < 0) {
    throw validationError([{ path: 'total_paise', message: 'expense_amount_required' }])
  }

  // Paid from: the chosen cash / bank account (of the method's kind), else the store default.
  let paidFrom: string | null = null
  const kind = defaultPaidFromKind(body.payment_method)
  if (kind) {
    if (body.paid_from_account_id) {
      const acc = findAccount(chart, ctx, body.paid_from_account_id)
      if (acc.money_kind !== kind) {
        throw unprocessable(`Choose a ${kind} account to pay from`, {
          reason: 'money_account_required',
          path: 'paid_from_account_id',
          expected_kind: kind,
        })
      }
      if (!acc.is_active) {
        throw unprocessable(`The account ${acc.name} is inactive`, {
          reason: 'account_inactive',
          path: 'paid_from_account_id',
        })
      }
      paidFrom = acc.id
    } else {
      paidFrom = await storeMoneyAccountId(tx, ctx, chart, store.id, kind)
    }
  }

  // Cash paid from a counter's drawer joins that counter's open shift.
  let shiftId: string | null = null
  if (body.payment_method === 'cash') {
    const registerId = body.register_id ?? ctx.registerId
    if (registerId) {
      const fromDevice = body.register_id === undefined
      shiftId = fromDevice
        ? await openShiftFor(tx, ctx, store.id, registerId).catch((err: unknown) => {
            // The device's own register is a default only: another store's counter is ignored.
            if (err instanceof AppError && err.code === 'UNPROCESSABLE') return null
            throw err
          })
        : await openShiftFor(tx, ctx, store.id, registerId)
    }
  }

  const numbered = await nextNumber(tx, ctx, {
    docType: 'expense',
    storeId: store.id,
    date: body.expense_date,
  })
  const id = newId()
  await tx
    .insertInto('expenses')
    .values({
      id,
      tenant_id: ctx.tenantId,
      store_id: store.id,
      number: numbered.number,
      fy: numbered.fy,
      expense_date: body.expense_date,
      expense_account_id: head.id,
      supplier_id: supplier?.id ?? null,
      description: body.description ?? null,
      taxable_paise: amounts.taxable_paise,
      gst_rate_bp: body.gst_rate_bp,
      cgst_paise: amounts.cgst_paise,
      sgst_paise: amounts.sgst_paise,
      igst_paise: amounts.igst_paise,
      itc_eligible: body.itc_eligible,
      total_paise: amounts.total_paise,
      payment_method: body.payment_method,
      paid_from_account_id: paidFrom,
      reference: body.reference ?? null,
      attachment_file_id: body.attachment_file_id ?? null,
      status: 'posted',
      shift_id: shiftId,
      created_by: ctx.userId,
    })
    .execute()

  const planned = expenseJournalLines({
    expense_account_id: head.id,
    amounts,
    itc_eligible: body.itc_eligible,
    payment_method: body.payment_method,
    paid_from_account_id: paidFrom,
    supplier_id: supplier?.id ?? null,
  })
  const memo = body.reference ?? null
  const lines: JournalLineInput[] = planned.map((l) => ({
    account: l.account,
    debit_paise: l.debit_paise,
    credit_paise: l.credit_paise,
    party: l.party ?? null,
    memo,
  }))
  const narration = [`Expense ${numbered.number}`, head.name, body.description]
    .filter(Boolean)
    .join(' — ')
  await postJournal(tx, ctx, {
    entry_date: body.expense_date,
    store_id: store.id,
    source_type: 'expense',
    source_id: id,
    narration,
    lines,
  })
  await audit(tx, ctx, {
    action: 'expense.create',
    entity_type: 'expense',
    entity_id: id,
    summary: `Expense ${numbered.number} ${head.name} ${rupees(amounts.total_paise)} (${body.payment_method})`,
    changes: {
      number: numbered.number,
      expense_account_id: head.id,
      total_paise: amounts.total_paise,
      tax_paise: amounts.tax_paise,
      itc_eligible: body.itc_eligible,
      payment_method: body.payment_method,
      supplier_id: supplier?.id ?? null,
      shift_id: shiftId,
    },
  })
  return getExpense(tx, ctx, id)
}

// ---------------------------------------------------------------------------------------------
// Cancel (POST /expenses/:id/cancel)
// ---------------------------------------------------------------------------------------------

export async function cancelExpense(
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: ExpenseCancelBody,
): Promise<ExpenseDetail> {
  const row = await loadExpenseRow(tx, ctx, id, { forUpdate: true })
  if (row.status !== 'posted') {
    throw conflict('This expense is already cancelled', { reason: 'expense_cancelled' })
  }
  if (row.payment_method === 'credit') {
    const paid = await tx
      .selectFrom('payment_allocations as pa')
      .innerJoin('payments as p', (j) =>
        j.onRef('p.tenant_id', '=', 'pa.tenant_id').onRef('p.id', '=', 'pa.payment_id'),
      )
      .select(sql<number>`count(*)::int8`.as('n'))
      .where('pa.tenant_id', '=', ctx.tenantId)
      .where('pa.target_type', '=', 'expense')
      .where('pa.target_id', '=', row.id)
      .where('p.status', '=', 'completed')
      .executeTakeFirstOrThrow()
    if (paid.n > 0) {
      throw conflict('Supplier payments are allocated to this expense; cancel them first', {
        reason: 'expense_has_payments',
        payments: paid.n,
      })
    }
  }
  const cal = await businessCalendar(tx, ctx)
  // Default: today, or the expense's own (future) date — a reversal never precedes it.
  const date = body.date ?? (cal.today > row.expense_date ? cal.today : row.expense_date)
  if (date < row.expense_date) {
    throw validationError([{ path: 'date', message: 'date_order' }])
  }
  const reversal = await reverseJournal(tx, ctx, {
    source_type: 'expense',
    source_id: row.id,
    entry_date: date,
    narration: `Cancelled expense ${row.number ?? row.id.slice(-8)}: ${body.reason}`,
  })
  await tx
    .updateTable('expenses')
    .set({
      status: 'cancelled',
      cancelled_at: new Date(),
      cancelled_by: ctx.userId,
      cancel_reason: body.reason,
      updated_at: new Date(),
    })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', row.id)
    .execute()
  await audit(tx, ctx, {
    action: 'expense.cancel',
    entity_type: 'expense',
    entity_id: row.id,
    summary: `Expense ${row.number ?? row.id.slice(-8)} of ${rupees(row.total_paise)} cancelled: ${body.reason}`,
    changes: { reason: body.reason, date, reversal_entry_id: reversal.entry_id },
  })
  return getExpense(tx, ctx, row.id)
}
