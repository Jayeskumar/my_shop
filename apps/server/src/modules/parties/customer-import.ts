/**
 * Customer import (POST /customers/import): a CSV uploaded with POST /files?purpose=import,
 * at most IMPORT_INLINE_MAX_ROWS rows, processed inline in the request transaction.
 *
 * 1. File checks (400 VALIDATION_ERROR on `file_id`): an import file, CSV text (not XLSX/XLS),
 *    a header with `name`, 1..1000 data rows.
 * 2. Planning (dry run and real run alike): every row is parsed into the create / update shape,
 *    validated with the contract schemas, matched to an existing customer (phone or code) and
 *    checked for in-file duplicates, phones of other customers and opening-balance permission.
 * 3. Unless `dry_run`, valid rows are written — each inside its own SAVEPOINT, so an unexpected
 *    failure of one row is reported for that row and never leaves it half written. Opening
 *    balances (and changes of them) are journals through core/ledger, like the single-customer
 *    endpoints.
 * 4. An `imports` row (kind 'customers', dry runs included) records counts, errors and a preview.
 */
import {
  type ImportError,
  type ImportJob,
  type ImportPreviewRow,
  IMPORT_INLINE_MAX_ROWS,
  parseCsvTable,
} from '@kadai/shared/api/identity'
import { parseYesNo } from '@kadai/shared/api/catalog'
import {
  type CustomerCreateParsed,
  CustomerCreateSchema,
  type CustomerImportSchema,
  CustomerUpdateSchema,
  OPENING_BALANCE_EDIT_PERMISSION,
} from '@kadai/shared/api/parties'
import {
  type ImportStatus,
  hasPermission,
  newId,
  normalizeIndianPhone,
  tryParseRupees,
} from '@kadai/shared'
import { type Selectable, sql } from 'kysely'
import type { z } from 'zod'
import type { DB } from '../../db/schema.generated'
import { jsonb } from '../../db/json'
import type { Tx } from '../../db/tenant'
import { audit, diffChanges } from '../../core/audit'
import type { RequestContext } from '../../core/context'
import { type AppError, isAppError, validationError } from '../../core/errors'
import type { FileService } from '../../core/files'
import {
  type CustomerUpdateParsed,
  applyCustomerChanges,
  assertPhoneFree,
  insertCustomer,
  lockCustomerRow,
} from './customers'
import { iso, isoOrNull, readAddress, tenantToday } from './common'

type CustomerImportParsed = z.output<typeof CustomerImportSchema>
type CustomerRow = Selectable<DB['customers']>
type UpdateFields = Omit<CustomerUpdateParsed, 'if_updated_at'>

const MAX_ERRORS = 1000
const MAX_PREVIEW = 50
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** CSV column → body field (address columns go into `address`). */
const ADDRESS_COLUMNS = {
  address_line1: 'line1',
  address_line2: 'line2',
  city: 'city',
  district: 'district',
  pincode: 'pincode',
} as const
const TEXT_COLUMNS = ['name', 'name_ta', 'alt_phone', 'email', 'gstin', 'code'] as const

/** Body field path → CSV column key, for error reporting. */
function columnOf(path: readonly PropertyKey[]): string | null {
  const [head, sub] = path
  if (head === undefined) return null
  if (head === 'address') {
    const entry = Object.entries(ADDRESS_COLUMNS).find(([, field]) => field === sub)
    return entry ? entry[0] : sub === 'state_code' ? 'state_code' : 'address_line1'
  }
  if (head === 'opening_balance_paise') return 'opening_balance'
  if (head === 'credit_limit_paise') return 'credit_limit'
  return String(head)
}

const ROW_KEYS = new Set([
  'phone',
  'alt_phone',
  'email',
  'gstin',
  'gstin_state',
  'pan_gstin_mismatch',
  'empty_patch',
])

function issueCode(issue: z.ZodError['issues'][number]): string {
  if (ROW_KEYS.has(issue.message))
    return issue.message === 'empty_patch' ? 'required' : issue.message
  if (issue.path.at(-1) === 'pincode') return 'pincode'
  switch (issue.code) {
    case 'too_big':
      return 'max_length'
    case 'too_small':
      return 'required'
    case 'invalid_value':
      return 'invalid_value'
    default:
      return 'invalid'
  }
}

/** A row whose write failed (re-validated under lock, or an unexpected database error). */
function executionError(line: number, err: unknown): ImportError {
  const message = err instanceof Error ? err.message : String(err)
  if (!isAppError(err)) return { row: line, field: null, code: 'invalid', message }
  const issue = (err.details?.issues as Array<{ path?: string; message?: string }> | undefined)?.[0]
  const field = issue?.path ? columnOf(issue.path.split('.')) : null
  switch (err.code) {
    case 'DUPLICATE':
      return { row: line, field: 'phone', code: 'phone_taken', message }
    case 'FORBIDDEN':
      return { row: line, field: 'opening_balance', code: 'opening_balance_permission', message }
    case 'VALIDATION_ERROR':
      return {
        row: line,
        field,
        code: issue?.message && /^[a-z][a-z0-9_]*$/.test(issue.message) ? issue.message : 'invalid',
        message,
      }
    default:
      return { row: line, field, code: 'invalid', message }
  }
}

function fileError(code: string, message: string): AppError {
  return validationError([{ path: 'file_id', message: code, code }], message)
}

// ---------------------------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------------------------

interface ParsedCells {
  /** Body fields present in the row (non-empty cells only). */
  fields: Record<string, unknown>
  errors: ImportError[]
  phone: string | null
  code: string | null
  name: string | null
}

function parseCells(line: number, values: Record<string, string>): ParsedCells {
  const errors: ImportError[] = []
  const fields: Record<string, unknown> = {}
  const cell = (key: string) => (values[key] ?? '').trim()
  const fail = (field: string, code: string, message: string) =>
    errors.push({ row: line, field, code, message })

  for (const key of TEXT_COLUMNS) if (cell(key)) fields[key] = cell(key)

  let phone: string | null = null
  if (cell('phone')) {
    phone = normalizeIndianPhone(cell('phone'))
    if (phone) fields.phone = phone
    else fail('phone', 'phone', `Not a valid Indian mobile number: ${cell('phone')}`)
  }
  if (cell('customer_type')) fields.customer_type = cell('customer_type').toLowerCase()
  if (cell('state_code')) fields.state_code = cell('state_code').padStart(2, '0')

  const address: Record<string, string> = {}
  for (const [column, field] of Object.entries(ADDRESS_COLUMNS))
    if (cell(column)) address[field] = cell(column)
  if (cell('state_code')) address.state_code = cell('state_code').padStart(2, '0')
  if (Object.keys(address).length) fields.address = address

  if (cell('opening_balance')) {
    const paise = tryParseRupees(cell('opening_balance'), { allowNegative: true })
    if (paise === null)
      fail('opening_balance', 'invalid_amount', `Not an amount: ${cell('opening_balance')}`)
    else fields.opening_balance_paise = paise
  }
  if (cell('credit_limit')) {
    const paise = tryParseRupees(cell('credit_limit'))
    if (paise === null)
      fail('credit_limit', 'invalid_amount', `Not an amount: ${cell('credit_limit')}`)
    else fields.credit_limit_paise = paise
  }
  if (cell('credit_days')) {
    if (/^\d{1,3}$/.test(cell('credit_days'))) fields.credit_days = Number(cell('credit_days'))
    else fail('credit_days', 'invalid_number', `Not a whole number: ${cell('credit_days')}`)
  }
  if (cell('tags')) {
    fields.tags = cell('tags')
      .split('|')
      .map((t) => t.trim())
      .filter(Boolean)
  }
  if (cell('whatsapp_opt_in')) {
    const yes = parseYesNo(cell('whatsapp_opt_in'))
    if (yes === undefined || yes === null)
      fail('whatsapp_opt_in', 'invalid_boolean', `Expected yes or no: ${cell('whatsapp_opt_in')}`)
    else fields.whatsapp_opt_in = yes
  }
  return {
    fields,
    errors,
    phone,
    code: cell('code') ? cell('code').toLowerCase() : null,
    name: cell('name') || null,
  }
}

/** Schema issues as row errors, skipping columns that already have an error. */
function zodErrors(line: number, error: z.ZodError, known: readonly ImportError[]): ImportError[] {
  const reported = new Set(known.map((e) => e.field))
  return error.issues
    .map((issue) => ({
      row: line,
      field: columnOf(issue.path),
      code: issueCode(issue),
      message: issue.message,
    }))
    .filter((e) => !reported.has(e.field))
}

// ---------------------------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------------------------

type Plan =
  | {
      kind: 'create'
      line: number
      key: string | null
      name: string
      body: CustomerCreateParsed
      /** Posts an opening-balance journal. */
      opening: boolean
    }
  | {
      kind: 'update'
      line: number
      key: string | null
      name: string
      id: string
      body: UpdateFields
      /** Changes the opening balance (delta journal). */
      opening: boolean
    }
  | { kind: 'unchanged' | 'skip'; line: number; key: string | null; name: string }
  | { kind: 'error'; line: number; key: string | null; name: string | null }

async function loadMatches(
  tx: Tx,
  ctx: RequestContext,
  phones: string[],
  codes: string[],
): Promise<{ byPhone: Map<string, CustomerRow>; byCode: Map<string, CustomerRow[]> }> {
  const byPhone = new Map<string, CustomerRow>()
  const byCode = new Map<string, CustomerRow[]>()
  if (phones.length) {
    const rows = await tx
      .selectFrom('customers')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantId)
      .where('phone', 'in', phones)
      .execute()
    for (const r of rows) if (r.phone) byPhone.set(r.phone, r)
  }
  if (codes.length) {
    const rows = await tx
      .selectFrom('customers')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantId)
      .where(sql<boolean>`lower(code) = any(${codes}::text[])`)
      .execute()
    for (const r of rows) {
      const key = (r.code ?? '').toLowerCase()
      byCode.set(key, [...(byCode.get(key) ?? []), r])
    }
  }
  return { byPhone, byCode }
}

/** Stored values a PATCH-shaped body would change (null = nothing). */
function wouldChange(existing: CustomerRow, body: UpdateFields): boolean {
  const before: Record<string, unknown> = {
    name: existing.name,
    name_ta: existing.name_ta,
    code: existing.code,
    phone: existing.phone,
    alt_phone: existing.alt_phone,
    email: existing.email,
    gstin: existing.gstin,
    state_code: existing.state_code,
    address: readAddress(existing.address),
    customer_type: existing.customer_type,
    credit_limit_paise: existing.credit_limit_paise,
    credit_days: existing.credit_days,
    opening_balance_paise: existing.opening_balance_paise,
    tags: existing.tags,
    whatsapp_opt_in: existing.whatsapp_opt_in,
  }
  const after: Record<string, unknown> = { ...before }
  for (const [k, v] of Object.entries(body)) if (v !== undefined && k in before) after[k] = v
  return diffChanges(before, after) !== null
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export async function importCustomers(
  tx: Tx,
  ctx: RequestContext,
  files: FileService,
  body: CustomerImportParsed,
): Promise<ImportJob> {
  const file = await files.getFileRow(tx, ctx, body.file_id)
  if (file.purpose !== 'import')
    throw fileError('import_file_purpose', 'The file was not uploaded as an import file')
  const data = await files.readContent(file)
  const binary =
    file.content_type === XLSX_TYPE ||
    (data[0] === 0x50 && data[1] === 0x4b) ||
    (data[0] === 0xd0 && data[1] === 0xcf && data[2] === 0x11 && data[3] === 0xe0)
  if (binary)
    throw fileError('import_file_type', 'Only CSV files can be imported; save the sheet as CSV')

  const table = parseCsvTable(data.toString('utf8'))
  if (table.headers.length === 0 || table.rows.length === 0)
    throw fileError('import_empty', 'The file has no customer rows')
  if (!table.headers.includes('name'))
    throw fileError('import_missing_column', 'The header row must have a "name" column')
  if (table.rows.length > IMPORT_INLINE_MAX_ROWS) {
    throw fileError(
      'import_too_many_rows',
      `At most ${IMPORT_INLINE_MAX_ROWS} customers per file (this file has ${table.rows.length})`,
    )
  }

  const parsed = table.rows.map((r) => ({ line: r.line, ...parseCells(r.line, r.values) }))
  const { byPhone, byCode } = await loadMatches(
    tx,
    ctx,
    [...new Set(parsed.flatMap((p) => (p.phone ? [p.phone] : [])))],
    [...new Set(parsed.flatMap((p) => (p.code ? [p.code] : [])))],
  )
  const canEditOpening = hasPermission(ctx.permissions, OPENING_BALANCE_EDIT_PERMISSION)
  const seenPhones = new Set<string>()
  const seenCodes = new Set<string>()
  const errors: ImportError[] = []
  const plans: Plan[] = []

  for (const p of parsed) {
    const key = body.match_by === 'phone' ? p.phone : p.code
    const rowErrors = [...p.errors]
    const fail = (field: string, code: string, message: string) =>
      rowErrors.push({ row: p.line, field, code, message })
    if (p.phone) {
      if (seenPhones.has(p.phone))
        fail('phone', 'duplicate_in_file', 'Phone repeats an earlier row')
      seenPhones.add(p.phone)
    }
    if (p.code && body.match_by === 'code') {
      if (seenCodes.has(p.code)) fail('code', 'duplicate_in_file', 'Code repeats an earlier row')
      seenCodes.add(p.code)
    }

    let existing: CustomerRow | null = null
    if (body.match_by === 'phone' && p.phone) existing = byPhone.get(p.phone) ?? null
    if (body.match_by === 'code' && p.code) {
      const matches = byCode.get(p.code) ?? []
      if (matches.length > 1) fail('code', 'code_ambiguous', 'Several customers have this code')
      else existing = matches[0] ?? null
    }
    // A phone that belongs to another customer than the matched / new one.
    if (p.phone) {
      const owner = byPhone.get(p.phone)
      if (owner && owner.id !== existing?.id)
        fail('phone', 'phone_taken', `Phone belongs to customer ${owner.name}`)
    }

    if (!existing) {
      if (!p.name) fail('name', 'required', 'The name is missing')
      const res = CustomerCreateSchema.safeParse(p.fields)
      if (!res.success) rowErrors.push(...zodErrors(p.line, res.error, rowErrors))
      if (rowErrors.length || !res.success) {
        errors.push(...rowErrors)
        plans.push({ kind: 'error', line: p.line, key, name: p.name })
        continue
      }
      plans.push({
        kind: 'create',
        line: p.line,
        key,
        name: res.data.name,
        body: res.data,
        opening: res.data.opening_balance_paise !== 0,
      })
      continue
    }

    if (body.mode === 'create_only') {
      errors.push(...rowErrors)
      plans.push(
        rowErrors.length
          ? { kind: 'error', line: p.line, key, name: p.name }
          : { kind: 'skip', line: p.line, key, name: existing.name },
      )
      continue
    }
    const res = CustomerUpdateSchema.safeParse(p.fields)
    if (!res.success) rowErrors.push(...zodErrors(p.line, res.error, rowErrors))
    else {
      const { if_updated_at: _ignored, ...fields } = res.data
      const gstin = fields.gstin !== undefined ? fields.gstin : existing.gstin
      const state = fields.state_code !== undefined ? fields.state_code : existing.state_code
      if (gstin && state && gstin.slice(0, 2) !== state)
        fail('gstin', 'gstin_state', 'GSTIN does not belong to the state')
      if (
        fields.opening_balance_paise !== undefined &&
        fields.opening_balance_paise !== existing.opening_balance_paise &&
        !canEditOpening
      )
        fail(
          'opening_balance',
          'opening_balance_permission',
          'Changing an opening balance needs accounting permission',
        )
      if (!rowErrors.length) {
        plans.push(
          wouldChange(existing, fields)
            ? {
                kind: 'update',
                line: p.line,
                key,
                name: existing.name,
                id: existing.id,
                body: fields,
                opening:
                  fields.opening_balance_paise !== undefined &&
                  fields.opening_balance_paise !== existing.opening_balance_paise,
              }
            : { kind: 'unchanged', line: p.line, key, name: existing.name },
        )
        continue
      }
    }
    errors.push(...rowErrors)
    plans.push({ kind: 'error', line: p.line, key, name: p.name ?? existing.name })
  }

  // ---- execution ---------------------------------------------------------------------------
  const today = await tenantToday(tx, ctx)
  if (!body.dry_run) {
    for (const [i, plan] of plans.entries()) {
      if (plan.kind !== 'create' && plan.kind !== 'update') continue
      const savepoint = sql.raw(`customer_import_${i}`)
      await sql`savepoint ${savepoint}`.execute(tx)
      try {
        if (plan.kind === 'create') {
          if (plan.body.phone) await assertPhoneFree(tx, ctx, plan.body.phone)
          await insertCustomer(tx, ctx, plan.body, today)
        } else {
          const row = await lockCustomerRow(tx, ctx, plan.id)
          const diff = await applyCustomerChanges(tx, ctx, row, plan.body, today)
          if (!diff)
            plans[i] = { kind: 'unchanged', line: plan.line, key: plan.key, name: plan.name }
        }
        await sql`release savepoint ${savepoint}`.execute(tx)
      } catch (err) {
        await sql`rollback to savepoint ${savepoint}`.execute(tx)
        errors.push(executionError(plan.line, err))
        plans[i] = { kind: 'error', line: plan.line, key: plan.key, name: plan.name }
      }
    }
  }

  const count = (k: Plan['kind']) => plans.filter((p) => p.kind === k).length
  const errorRows = new Set(errors.map((e) => e.row)).size
  const summary = {
    created: count('create'),
    updated: count('update'),
    unchanged: count('unchanged'),
    skipped: count('skip'),
    // Opening-balance journals posted (or, in a dry run, that would be posted).
    details: {
      opening_balances_posted: plans.filter(
        (p) => (p.kind === 'create' || p.kind === 'update') && p.opening,
      ).length,
    },
  }
  const preview: ImportPreviewRow[] = plans.slice(0, MAX_PREVIEW).map((p) => ({
    row: p.line,
    action: p.kind,
    key: p.key,
    name: p.name,
  }))
  errors.sort((a, b) => a.row - b.row)
  const status: ImportStatus = 'completed'
  const options = { mode: body.mode, dry_run: body.dry_run, match_by: body.match_by }
  const row = await tx
    .insertInto('imports')
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      kind: 'customers',
      status,
      file_id: file.id,
      options: jsonb(options),
      total_rows: plans.length,
      success_rows: plans.length - errorRows,
      error_rows: errorRows,
      processed_rows: plans.length,
      errors: jsonb(errors.slice(0, MAX_ERRORS)),
      errors_truncated: errors.length > MAX_ERRORS,
      summary: jsonb(summary),
      preview: jsonb(preview),
      created_by: ctx.userId,
      finished_at: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  if (!body.dry_run) {
    await audit(tx, ctx, {
      action: 'customer.import',
      entity_type: 'import',
      entity_id: row.id,
      summary: `Customer import ${file.filename}: ${summary.created} created, ${summary.updated} updated, ${errorRows} with errors`,
      changes: { file_id: file.id, ...summary },
    })
  }

  return {
    id: row.id,
    kind: 'customers',
    status,
    file_id: file.id,
    filename: file.filename,
    store_id: null,
    mode: body.mode,
    dry_run: body.dry_run,
    options,
    total_rows: row.total_rows,
    success_rows: row.success_rows,
    error_rows: row.error_rows,
    progress_bp: 10_000,
    errors: errors.slice(0, MAX_ERRORS),
    errors_truncated: errors.length > MAX_ERRORS,
    summary,
    preview,
    created_by: row.created_by,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    finished_at: isoOrNull(row.finished_at),
  }
}
