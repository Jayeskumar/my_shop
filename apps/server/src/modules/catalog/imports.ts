/**
 * `imports` rows for product imports: POST /products/import (inline up to IMPORT_INLINE_MAX_ROWS
 * rows, otherwise the job catalog.import), the job runner, and GET /imports/:id (products and
 * customers imports; results in the 0100 columns summary / preview / processed_rows /
 * errors_truncated).
 */
import type { Updateable } from 'kysely'
import { hasPermission, newId } from '@kadai/shared'
import type { ProductImportSchema } from '@kadai/shared/api/catalog'
import {
  IMPORT_INLINE_MAX_ROWS,
  type ImportError,
  ImportErrorSchema,
  type ImportJob,
  ImportModeSchema,
  ImportPreviewRowSchema,
  ImportSummarySchema,
} from '@kadai/shared/api/identity'
import { ImportKindSchema, ImportStatusSchema } from '@kadai/shared'
import { z } from 'zod'
import { type RequestContext, systemContext } from '../../core/context'
import { assertWithinLimit } from '../../core/entitlements'
import { forbidden, isAppError, notFound } from '../../core/errors'
import type { FileService } from '../../core/files'
import { enqueue } from '../../core/jobs'
import type { KadaiDeps } from '../../core/runtime'
import { jsonb } from '../../db/json'
import type { Imports } from '../../db/schema.generated'
import { type Tx, withTenant } from '../../db/tenant'
import {
  type ApplyOutcome,
  type ImportOp,
  type ImportPlan,
  type ImportResults,
  type ProductImportOptions,
  applyOps,
  applyTaxonomy,
  auditImport,
  emptyOutcome,
  importResults,
  planProductImport,
  readImportFile,
} from './import'
import { type Ctx, iso, isoOrNull, jsonObject } from './shared'

export const IMPORT_JOB = 'catalog.import'
/** Ops per transaction when a job applies a large file. */
export const IMPORT_CHUNK = 250

export interface ImportJobData {
  tenant_id: string
  import_id: string
  user_id: string | null
}

export const ImportJobDataSchema = z.object({
  tenant_id: z.uuid(),
  import_id: z.uuid(),
  user_id: z.uuid().nullable(),
})

// ---------------------------------------------------------------------------------------------
// Row ↔ ImportJob
// ---------------------------------------------------------------------------------------------

async function loadImportRow(tx: Tx, ctx: Pick<Ctx, 'tenantId'>, id: string) {
  return tx
    .selectFrom('imports as i')
    .leftJoin('files as f', (j) =>
      j.onRef('f.id', '=', 'i.file_id').onRef('f.tenant_id', '=', 'i.tenant_id'),
    )
    .select([
      'i.id',
      'i.kind',
      'i.status',
      'i.file_id',
      'f.filename',
      'i.store_id',
      'i.options',
      'i.total_rows',
      'i.success_rows',
      'i.error_rows',
      'i.errors',
      'i.errors_truncated',
      'i.summary',
      'i.preview',
      'i.processed_rows',
      'i.created_by',
      'i.created_at',
      'i.updated_at',
      'i.finished_at',
    ])
    .where('i.tenant_id', '=', ctx.tenantId)
    .where('i.id', '=', id)
    .executeTakeFirst()
}

type ImportRow = NonNullable<Awaited<ReturnType<typeof loadImportRow>>>

function toImportJob(r: ImportRow): ImportJob {
  const options = jsonObject(r.options)
  const status = ImportStatusSchema.safeParse(r.status)
  const kind = ImportKindSchema.safeParse(r.kind)
  const errors = z.array(ImportErrorSchema).safeParse(r.errors)
  const preview = z.array(ImportPreviewRowSchema).safeParse(r.preview)
  const summary = ImportSummarySchema.safeParse(r.summary ?? {})
  const done = r.status === 'completed'
  return {
    id: r.id,
    kind: kind.success ? kind.data : 'products',
    status: status.success ? status.data : 'failed',
    file_id: r.file_id,
    filename: r.filename,
    store_id: r.store_id,
    mode: ImportModeSchema.catch('upsert').parse(options.mode),
    dry_run: options.dry_run === true,
    options,
    total_rows: r.total_rows,
    success_rows: r.success_rows,
    error_rows: r.error_rows,
    progress_bp: done
      ? 10_000
      : r.total_rows > 0
        ? Math.min(10_000, Math.floor((r.processed_rows * 10_000) / r.total_rows))
        : 0,
    errors: errors.success ? errors.data : [],
    errors_truncated: r.errors_truncated,
    summary: summary.success ? summary.data : ImportSummarySchema.parse({}),
    preview: preview.success ? preview.data : [],
    created_by: r.created_by,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    finished_at: isoOrNull(r.finished_at),
  }
}

/** Write permission each import kind needs to be read (GET /imports/:id is shared). */
const KIND_PERMISSION = {
  products: 'catalog.write',
  customers: 'customers.write',
  suppliers: 'suppliers.write',
} as const

export async function getImport(tx: Tx, ctx: RequestContext, id: string): Promise<ImportJob> {
  const row = await loadImportRow(tx, ctx, id)
  if (!row) throw notFound('import', id)
  const needed = KIND_PERMISSION[row.kind as keyof typeof KIND_PERMISSION]
  if (needed && !hasPermission(ctx.permissions, needed))
    throw forbidden('You do not have permission to see this import', { required: [needed] })
  return toImportJob(row)
}

function resultColumns(results: ImportResults) {
  return {
    total_rows: results.total_rows,
    success_rows: results.success_rows,
    error_rows: results.error_rows,
    errors: jsonb(results.errors),
    errors_truncated: results.errors_truncated,
    summary: jsonb(results.summary),
    preview: jsonb(results.preview),
  }
}

function failedColumns(error: ImportError) {
  return {
    status: 'failed',
    errors: jsonb([error]),
    error_rows: 0,
    success_rows: 0,
    finished_at: new Date(),
  }
}

// ---------------------------------------------------------------------------------------------
// Apply helpers
// ---------------------------------------------------------------------------------------------

/** Applies ops in one transaction; creates beyond the products plan limit fail as plan_limit. */
async function applyChunk(
  tx: Tx,
  ctx: Ctx,
  ops: readonly ImportOp[],
  out: ApplyOutcome,
): Promise<void> {
  const creates = ops.filter((o) => o.kind === 'insert').length
  let runnable = ops
  if (creates > 0) {
    try {
      await assertWithinLimit(tx, ctx, 'products', { adding: creates })
    } catch (e) {
      if (!isAppError(e) || e.code !== 'PLAN_LIMIT_REACHED') throw e
      runnable = ops.filter((o) => o.kind !== 'insert')
      for (const o of ops)
        if (o.kind === 'insert')
          out.failed.push({
            row: o.line,
            field: null,
            code: 'plan_limit',
            message: 'The plan’s product limit is reached',
          })
    }
  }
  await applyOps(tx, ctx, runnable, out)
}

function optionsOf(body: z.output<typeof ProductImportSchema>): ProductImportOptions {
  return {
    mode: body.mode,
    dry_run: body.dry_run,
    match_by: body.match_by,
    create_categories: body.create_categories,
    create_brands: body.create_brands,
  }
}

// ---------------------------------------------------------------------------------------------
// POST /products/import
// ---------------------------------------------------------------------------------------------

export async function startProductImport(
  tx: Tx,
  ctx: Ctx,
  files: FileService,
  body: z.output<typeof ProductImportSchema>,
): Promise<ImportJob> {
  const options = optionsOf(body)
  const id = newId()
  const { filename, result } = await readImportFile(tx, ctx, files, body.file_id)
  const base = {
    id,
    tenant_id: ctx.tenantId,
    kind: 'products',
    file_id: body.file_id,
    options: jsonb(options),
    created_by: ctx.userId,
  }
  if (!result.ok) {
    await tx
      .insertInto('imports')
      .values({ ...base, ...failedColumns(result.error) })
      .execute()
    return toImportJob((await loadImportRow(tx, ctx, id))!)
  }
  const rows = result.file.rows.length
  if (rows > IMPORT_INLINE_MAX_ROWS) {
    await tx
      .insertInto('imports')
      .values({ ...base, status: 'pending', total_rows: rows })
      .execute()
    const data: ImportJobData = { tenant_id: ctx.tenantId, import_id: id, user_id: ctx.userId }
    await enqueue(IMPORT_JOB, data, { tx, singletonKey: id })
    return toImportJob((await loadImportRow(tx, ctx, id))!)
  }
  const plan = await planProductImport(tx, ctx, result.file, options)
  let outcome: ApplyOutcome | null = null
  if (!options.dry_run) {
    outcome = emptyOutcome()
    await applyTaxonomy(tx, ctx, plan, outcome)
    await applyChunk(tx, ctx, plan.ops, outcome)
  }
  const results = importResults(plan, outcome)
  await tx
    .insertInto('imports')
    .values({
      ...base,
      status: 'completed',
      ...resultColumns(results),
      processed_rows: results.total_rows,
      finished_at: new Date(),
    })
    .execute()
  if (outcome) await auditImport(tx, ctx, id, filename, results, outcome)
  return toImportJob((await loadImportRow(tx, ctx, id))!)
}

// ---------------------------------------------------------------------------------------------
// Job catalog.import
// ---------------------------------------------------------------------------------------------

/** Line count before which a chunk's ops end (progress in rows). */
function processedRows(plan: ImportPlan, doneOps: number): number {
  if (plan.ops.length === 0) return plan.totalRows
  const lastLine = plan.ops[Math.min(doneOps, plan.ops.length) - 1]?.line ?? 1
  // Lines are file lines (header = 1); data rows before lastLine are processed.
  return Math.min(plan.totalRows, Math.max(0, lastLine - 1))
}

export async function runProductImportJob(
  deps: Pick<KadaiDeps, 'db' | 'files' | 'logger'>,
  input: ImportJobData,
): Promise<void> {
  const data = ImportJobDataSchema.parse(input)
  const ctx = systemContext(data.tenant_id, { userId: data.user_id })
  const db = deps.db.appDb
  const claimed = await withTenant(db, ctx, async (tx) => {
    const row = await tx
      .selectFrom('imports')
      .select(['id', 'status', 'file_id', 'options', 'kind'])
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', data.import_id)
      .forUpdate()
      .executeTakeFirst()
    if (
      !row ||
      row.kind !== 'products' ||
      (row.status !== 'pending' && row.status !== 'processing')
    )
      return null
    await tx
      .updateTable('imports')
      .set({ status: 'processing', processed_rows: 0 })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', row.id)
      .execute()
    return row
  })
  if (!claimed) return
  const stored = jsonObject(claimed.options)
  const options: ProductImportOptions = {
    mode: stored.mode === 'create_only' ? 'create_only' : 'upsert',
    dry_run: stored.dry_run === true,
    match_by:
      stored.match_by === 'sku' || stored.match_by === 'barcode'
        ? stored.match_by
        : 'sku_or_barcode',
    create_categories: stored.create_categories !== false,
    create_brands: stored.create_brands !== false,
  }
  const finish = (columns: Updateable<Imports>) =>
    withTenant(db, ctx, (tx) =>
      tx
        .updateTable('imports')
        .set(columns)
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', data.import_id)
        .execute(),
    )
  try {
    if (!claimed.file_id) {
      await finish(failedColumns({ row: 0, field: null, code: 'file_empty', message: 'No file' }))
      return
    }
    const prepared = await withTenant(db, ctx, async (tx) => {
      const { filename, result } = await readImportFile(tx, ctx, deps.files, claimed.file_id!)
      if (!result.ok) return { ok: false, error: result.error } as const
      const plan = await planProductImport(tx, ctx, result.file, options)
      await tx
        .updateTable('imports')
        .set({ total_rows: plan.totalRows })
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', data.import_id)
        .execute()
      return { ok: true, plan, filename } as const
    })
    if (!prepared.ok) {
      await finish(failedColumns(prepared.error))
      return
    }
    const { plan, filename } = prepared
    if (options.dry_run) {
      const results = importResults(plan, null)
      await finish({
        status: 'completed',
        ...resultColumns(results),
        processed_rows: results.total_rows,
        finished_at: new Date(),
      })
      return
    }
    const outcome = emptyOutcome()
    await withTenant(db, ctx, (tx) => applyTaxonomy(tx, ctx, plan, outcome))
    for (let i = 0; i < plan.ops.length; i += IMPORT_CHUNK) {
      const chunk = plan.ops.slice(i, i + IMPORT_CHUNK)
      await withTenant(db, ctx, async (tx) => {
        await applyChunk(tx, ctx, chunk, outcome)
        await tx
          .updateTable('imports')
          .set({ processed_rows: processedRows(plan, i + chunk.length) })
          .where('tenant_id', '=', ctx.tenantId)
          .where('id', '=', data.import_id)
          .execute()
      })
    }
    const results = importResults(plan, outcome)
    await withTenant(db, ctx, async (tx) => {
      await tx
        .updateTable('imports')
        .set({
          status: 'completed',
          ...resultColumns(results),
          processed_rows: results.total_rows,
          finished_at: new Date(),
        })
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', data.import_id)
        .execute()
      await auditImport(tx, ctx, data.import_id, filename, results, outcome)
    })
  } catch (e) {
    deps.logger.error({ err: e, import_id: data.import_id }, 'product import failed')
    await finish(
      failedColumns({
        row: 0,
        field: null,
        code: 'write_failed',
        message: e instanceof Error ? e.message.slice(0, 300) : 'Import failed',
      }),
    )
  }
}
