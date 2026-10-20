/**
 * Gapless document numbering (ARCHITECTURE.md §8.1, §12).
 *
 *   const { number, fy, seq } = await nextNumber(tx, ctx, {
 *     docType: 'sales_invoice', storeId, registerId, date: '2026-10-20',
 *   })                                                     // → 'S1-A/2627/00042'
 *
 * * One series per (store, register?, doc type, financial year). The row is created lazily on
 *   first use from the default prefix template and locked `FOR UPDATE` for the rest of the
 *   caller's transaction, so concurrent documents queue on it and a rolled-back document never
 *   consumes a number (gapless).
 * * Only sales invoices and bills of supply use a per-register series (offline POS numbering);
 *   every other document type — and back-office invoices (no registerId) — use the store series.
 * * GST rule 46: invoice numbers are at most 16 characters of `A-Z 0-9 / -`. A new series gets
 *   padding 5, shrunk (down to 3) to fit; a prefix too long even for 3 digits is a CONFLICT, and
 *   a series whose numbers outgrow 16 characters fails with NUMBER_SERIES_EXHAUSTED.
 * * The financial year comes from the business `date` and `tenants.fy_start_month`.
 */
import {
  DEFAULT_FY_START_MONTH,
  DEFAULT_TIMEZONE,
  type NumberSeriesDocType,
  NumberSeriesDocTypeSchema,
  fyOf,
  fyShort,
  isDateStr,
  newId,
} from '@kadai/shared'
import type { Tx } from '../db/tenant'
import type { RequestContext } from './context'
import { AppError, conflict, invalidField, notFound, unprocessable } from './errors'

/** GST: document serial numbers may not exceed 16 characters. */
export const MAX_NUMBER_LENGTH = 16
export const DEFAULT_PADDING = 5
export const MIN_PADDING = 3
/** Characters allowed in a GST document number. */
const NUMBER_RE = /^[A-Z0-9/-]{1,16}$/

/** Document types numbered per register when a register is given (POS / offline numbering). */
export const REGISTER_SERIES_DOC_TYPES: ReadonlySet<NumberSeriesDocType> = new Set([
  'sales_invoice',
  'bill_of_supply',
])

/**
 * Default prefix templates. `{store}` = store code, `{reg}` = register code, `{fy}` = '2627'.
 * Register series separate store and register with '-' (store/register codes are [A-Z0-9]), so
 * store 'S1' + register 'A' ('S1-A/…') can never collide with a store coded 'S1A' ('S1A/…').
 */
export const PREFIX_TEMPLATES: Readonly<
  Record<NumberSeriesDocType, { store: string; register?: string }>
> = {
  sales_invoice: { register: '{store}-{reg}/{fy}/', store: '{store}/{fy}/' },
  bill_of_supply: { register: '{store}-{reg}B/{fy}/', store: '{store}B/{fy}/' },
  credit_note: { store: 'CN{store}/{fy}/' },
  estimate: { store: 'EST{store}/{fy}/' },
  sales_order: { store: 'SO{store}/{fy}/' },
  receipt: { store: 'RC{store}/{fy}/' },
  payment_voucher: { store: 'PV{store}/{fy}/' },
  purchase_order: { store: 'PO{store}/{fy}/' },
  purchase_bill: { store: 'GRN{store}/{fy}/' },
  debit_note: { store: 'DN{store}/{fy}/' },
  stock_adjustment: { store: 'ADJ{store}/{fy}/' },
  stock_transfer: { store: 'TR{store}/{fy}/' },
  expense: { store: 'EXP{store}/{fy}/' },
  journal: { store: 'JV{store}/{fy}/' },
}

type Ctx = Pick<RequestContext, 'tenantId'>

export interface SeriesRequest {
  docType: NumberSeriesDocType
  storeId: string
  /** POS register; only used for sales_invoice / bill_of_supply (ignored otherwise). */
  registerId?: string | null
  /** Business date (YYYY-MM-DD) of the document; selects the financial year. */
  date: string
}

export interface AllocatedNumber {
  number: string
  fy: string
  seq: number
  series_id: string
}

export interface SeriesState {
  /** null when the series has not been used yet (it is created on first allocation). */
  series_id: string | null
  prefix: string
  next_number: number
  padding: number
  fy: string
  /** The number the next allocation will return. */
  next: string
}

// ---------------------------------------------------------------------------------------------
// Tenant calendar (fy_start_month / timezone), memoised per transaction
// ---------------------------------------------------------------------------------------------

export interface TenantCalendar {
  fyStartMonth: number
  timezone: string
}

const calendars = new WeakMap<Tx, TenantCalendar>()

/** Financial-year start month and timezone of the tenant (read once per transaction). */
export async function tenantCalendar(tx: Tx, ctx: Ctx): Promise<TenantCalendar> {
  const hit = calendars.get(tx)
  if (hit) return hit
  const row = await tx
    .selectFrom('tenants')
    .select(['fy_start_month', 'timezone'])
    .where('id', '=', ctx.tenantId)
    .executeTakeFirst()
  if (!row) throw notFound('tenant', ctx.tenantId)
  const cal = {
    fyStartMonth: row.fy_start_month || DEFAULT_FY_START_MONTH,
    timezone: row.timezone || DEFAULT_TIMEZONE,
  }
  calendars.set(tx, cal)
  return cal
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Renders `prefix` + zero-padded sequence. */
export function formatDocumentNumber(prefix: string, seq: number, padding: number): string {
  return `${prefix}${String(seq).padStart(padding, '0')}`
}

/** Expands a template for the given codes and FY ('2026-27'). */
export function renderPrefix(
  template: string,
  codes: { store: string; register?: string | null; fy: string },
): string {
  return template
    .replaceAll('{store}', codes.store)
    .replaceAll('{reg}', codes.register ?? '')
    .replaceAll('{fy}', fyShort(codes.fy))
}

/** Padding for a new series: the default, shrunk so `prefix + digits` fits 16 characters. */
export function paddingFor(prefix: string): number {
  const room = MAX_NUMBER_LENGTH - prefix.length
  if (room < MIN_PADDING) {
    throw conflict(
      `Document number prefix "${prefix}" is too long for the 16-character GST limit; shorten the store or register code`,
      { prefix, max_length: MAX_NUMBER_LENGTH },
    )
  }
  return Math.min(DEFAULT_PADDING, room)
}

function usesRegister(docType: NumberSeriesDocType, registerId: string | null | undefined): boolean {
  return Boolean(registerId) && REGISTER_SERIES_DOC_TYPES.has(docType)
}

function validate(req: SeriesRequest): void {
  if (!NumberSeriesDocTypeSchema.safeParse(req.docType).success) {
    throw invalidField('docType', `Unknown document type "${String(req.docType)}"`)
  }
  if (!isDateStr(req.date)) throw invalidField('date', 'Expected a date (YYYY-MM-DD)')
}

interface SeriesRow {
  id: string
  prefix: string
  next_number: number
  padding: number
  fy: string
}

async function findSeries(
  tx: Tx,
  ctx: Ctx,
  key: { docType: NumberSeriesDocType; storeId: string; registerId: string | null; fy: string },
  lock: boolean,
): Promise<SeriesRow | undefined> {
  let q = tx
    .selectFrom('number_series')
    .select(['id', 'prefix', 'next_number', 'padding', 'fy'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('store_id', '=', key.storeId)
    .where('doc_type', '=', key.docType)
    .where('fy', '=', key.fy)
  q = key.registerId ? q.where('register_id', '=', key.registerId) : q.where('register_id', 'is', null)
  return lock ? q.forUpdate().executeTakeFirst() : q.executeTakeFirst()
}

/** Default prefix for a not-yet-created series (validates the store / register). */
async function defaultPrefix(
  tx: Tx,
  ctx: Ctx,
  key: { docType: NumberSeriesDocType; storeId: string; registerId: string | null; fy: string },
): Promise<string> {
  const store = await tx
    .selectFrom('stores')
    .select(['code'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', key.storeId)
    .executeTakeFirst()
  if (!store) throw notFound('store', key.storeId)
  const templates = PREFIX_TEMPLATES[key.docType]
  if (key.registerId && templates.register) {
    const register = await tx
      .selectFrom('registers')
      .select(['code', 'store_id'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', key.registerId)
      .executeTakeFirst()
    if (!register) throw notFound('register', key.registerId)
    if (register.store_id !== key.storeId) {
      throw unprocessable('The register belongs to another store', {
        register_id: key.registerId,
        store_id: key.storeId,
      })
    }
    return renderPrefix(templates.register, { store: store.code, register: register.code, fy: key.fy })
  }
  return renderPrefix(templates.store, { store: store.code, fy: key.fy })
}

/** Locks the series row for the rest of the transaction, creating it on first use. */
async function lockSeries(tx: Tx, ctx: Ctx, req: SeriesRequest): Promise<SeriesRow> {
  validate(req)
  const cal = await tenantCalendar(tx, ctx)
  const key = {
    docType: req.docType,
    storeId: req.storeId,
    registerId: usesRegister(req.docType, req.registerId) ? (req.registerId ?? null) : null,
    fy: fyOf(req.date, cal.fyStartMonth),
  }
  const existing = await findSeries(tx, ctx, key, true)
  if (existing) return existing
  const prefix = await defaultPrefix(tx, ctx, key)
  // A concurrent first use may insert the same series: DO NOTHING, then lock whichever row won.
  await tx
    .insertInto('number_series')
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      store_id: key.storeId,
      register_id: key.registerId,
      doc_type: key.docType,
      fy: key.fy,
      prefix,
      next_number: 1,
      padding: paddingFor(prefix),
    })
    .onConflict((oc) => oc.doNothing())
    .execute()
  const created = await findSeries(tx, ctx, key, true)
  if (!created) throw new Error('number series row vanished after insert')
  return created
}

/** Validates the number the series would issue next (length + GST character set). */
function checkIssuable(docType: NumberSeriesDocType, row: SeriesRow): string {
  const number = formatDocumentNumber(row.prefix, row.next_number, row.padding)
  if (number.length > MAX_NUMBER_LENGTH) {
    throw new AppError(
      'NUMBER_SERIES_EXHAUSTED',
      `The ${docType} series "${row.prefix}" has reached the 16-character GST limit; shorten its prefix`,
      { doc_type: docType, prefix: row.prefix, next_number: row.next_number, max_length: MAX_NUMBER_LENGTH },
    )
  }
  if (!NUMBER_RE.test(number)) {
    throw conflict(
      `Document number "${number}" may only contain A-Z, 0-9, "/" and "-"; fix the series prefix`,
      { doc_type: docType, prefix: row.prefix },
    )
  }
  return number
}

async function consume(tx: Tx, ctx: Ctx, row: SeriesRow): Promise<void> {
  await tx
    .updateTable('number_series')
    .set({ next_number: row.next_number + 1 })
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', row.id)
    .execute()
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/**
 * Allocates the next number of the series. Call it inside the transaction that creates the
 * document: the series stays locked until commit, and a rollback returns the number.
 */
export async function nextNumber(tx: Tx, ctx: Ctx, req: SeriesRequest): Promise<AllocatedNumber> {
  const row = await lockSeries(tx, ctx, req)
  const number = checkIssuable(req.docType, row)
  await consume(tx, ctx, row)
  return { number, fy: row.fy, seq: row.next_number, series_id: row.id }
}

/**
 * Current state of a series without locking or creating it (POS bootstrap, settings screen).
 * For an unused series the defaults it would be created with are returned.
 */
export async function peekSeries(tx: Tx, ctx: Ctx, req: SeriesRequest): Promise<SeriesState> {
  validate(req)
  const cal = await tenantCalendar(tx, ctx)
  const key = {
    docType: req.docType,
    storeId: req.storeId,
    registerId: usesRegister(req.docType, req.registerId) ? (req.registerId ?? null) : null,
    fy: fyOf(req.date, cal.fyStartMonth),
  }
  const row = await findSeries(tx, ctx, key, false)
  if (row) {
    return {
      series_id: row.id,
      prefix: row.prefix,
      next_number: row.next_number,
      padding: row.padding,
      fy: row.fy,
      next: formatDocumentNumber(row.prefix, row.next_number, row.padding),
    }
  }
  const prefix = await defaultPrefix(tx, ctx, key)
  const padding = paddingFor(prefix)
  return {
    series_id: null,
    prefix,
    next_number: 1,
    padding,
    fy: key.fy,
    next: formatDocumentNumber(prefix, 1, padding),
  }
}

export interface OfflineNumberRequest extends SeriesRequest {
  registerId: string
  /** The number the offline POS printed. */
  number: string
}

export interface AcceptedNumber extends AllocatedNumber {
  /** True when the offline number was not the series' next one and a new number was issued. */
  renumbered: boolean
  /** The number the device printed (for the audit trail when renumbered). */
  offline_number: string
}

/**
 * Offline sync (§12): keeps the number an offline register printed when it is exactly the
 * series' next number; otherwise issues the next number and reports `renumbered: true` (the
 * caller audits it for review). Invoices must be synced in the order they were created.
 */
export async function acceptOfflineNumber(
  tx: Tx,
  ctx: Ctx,
  req: OfflineNumberRequest,
): Promise<AcceptedNumber> {
  const offline = req.number.trim().toUpperCase()
  const row = await lockSeries(tx, ctx, req)
  const expected = checkIssuable(req.docType, row)
  await consume(tx, ctx, row)
  return {
    number: expected,
    fy: row.fy,
    seq: row.next_number,
    series_id: row.id,
    renumbered: offline !== expected,
    offline_number: req.number,
  }
}
