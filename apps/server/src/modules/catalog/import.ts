/**
 * Product CSV import (POST /products/import, job catalog.import) — plan, then apply.
 *
 *  1. read: the uploaded file (purpose import) as UTF-8 / UTF-16 CSV (XLSX → import_format);
 *     headers normalised; `name` and `sale_price` columns required; unknown columns (or
 *     `attr:<key>`) become product attributes.
 *  2. plan (no writes; dry runs stop here): every row is validated (cell formats, units, HSN,
 *     GST rate, barcodes with check digits, vertical attributes, product rules), matched to an
 *     existing product by SKU / barcode (match_by) or, for variant rows (parent_sku + size /
 *     color), by parent + combination, and becomes create / update / unchanged / skip / error.
 *     Missing categories ("Grocery > Rice") and brands are planned when allowed; duplicates
 *     inside the file are errors; the products plan limit is enforced.
 *  3. apply: new categories and brands first, then the rows in file order, each inside a
 *     savepoint (a failing row is reported, the rest continue). Files above
 *     IMPORT_INLINE_MAX_ROWS are applied by the job in chunks with progress.
 *
 * Re-importing the same file is idempotent in upsert mode (rows become 'unchanged').
 */
import { type Insertable, sql } from 'kysely'
import {
  type BusinessType,
  isDecimalUnit,
  isUnitCode,
  isValidGstRate,
  isValidHsn,
  newId,
  normalizePlu,
  tryParseQty,
  tryParseRupees,
  validateAttributes,
} from '@kadai/shared'
import {
  CATEGORY_PATH_SEPARATOR,
  MAX_CATEGORY_DEPTH,
  type ProductImportColumnDef,
  type ProductImportErrorCode,
  barcodeIssue,
  normalizeProductFlags,
  parsePercentBp,
  parseYesNo,
  productImportColumns,
  productRuleIssues,
  variantKey,
} from '@kadai/shared/api/catalog'
import {
  IMPORT_MAX_ROWS,
  type ImportError,
  type ImportPreviewRow,
  type ImportSummary,
  type CsvTableRow,
  parseCsvTable,
} from '@kadai/shared/api/identity'
import { audit } from '../../core/audit'
import { countForLimit, getEntitlements } from '../../core/entitlements'
import { isAppError } from '../../core/errors'
import type { FileService } from '../../core/files'
import type { Products } from '../../db/schema.generated'
import type { Tx } from '../../db/tenant'
import { type CatalogEnv, catalogEnv, forcedTrackBatches, defaultUnit } from './product-write'
import { PRODUCT_COLUMNS, type ProductRow } from './product-read'
import { type Ctx, jsonObject, pgCode, stringRecord, withSavepoint } from './shared'
import { jsonb } from '../../db/json'

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export interface ProductImportOptions {
  mode: 'create_only' | 'upsert'
  dry_run: boolean
  match_by: 'sku' | 'barcode' | 'sku_or_barcode'
  create_categories: boolean
  create_brands: boolean
}

export interface ParsedImportFile {
  headers: string[]
  rows: CsvTableRow[]
}

export type ReadResult = { ok: true; file: ParsedImportFile } | { ok: false; error: ImportError }

type Writable = Omit<ProductRow, 'id' | 'parent_id' | 'created_by' | 'created_at' | 'updated_at'>

interface NewCategory {
  id: string
  parent_id: string | null
  name: string
  depth: number
}

interface ParentConvert {
  id: string
  axes: string[]
}

export type ImportOp =
  | {
      kind: 'insert'
      line: number
      values: Insertable<Products>
      barcodes: string[]
      parentConvert: ParentConvert | null
      categoryIds: string[]
      brandId: string | null
      isVariant: boolean
    }
  | {
      kind: 'update'
      line: number
      id: string
      before: ProductRow
      patch: Partial<Writable>
      barcodes: string[]
      parentConvert: ParentConvert | null
      categoryIds: string[]
      brandId: string | null
    }

export interface ImportPlan {
  totalRows: number
  ops: ImportOp[]
  /** Row outcome by line ('create' / 'update' / 'unchanged' / 'skip' / 'error'). */
  actions: Map<number, ImportPreviewRow>
  errors: ImportError[]
  errorLines: Set<number>
  newCategories: NewCategory[]
  newBrands: Array<{ id: string; name: string }>
}

export interface ApplyOutcome {
  created: number
  updated: number
  variantsCreated: number
  barcodesAdded: number
  categoriesCreated: number
  brandsCreated: number
  failed: ImportError[]
  /** Price / tax changes for the audit entry (capped). */
  changes: Array<{ id: string; before: Record<string, unknown>; after: Record<string, unknown> }>
}

const err = (
  row: number,
  field: string | null,
  code: ProductImportErrorCode,
  message: string,
): ImportError => ({ row, field, code, message })

// ---------------------------------------------------------------------------------------------
// 1. Read
// ---------------------------------------------------------------------------------------------

function decodeText(data: Buffer): string | null {
  if (
    data.length >= 4 &&
    data[0] === 0x50 &&
    data[1] === 0x4b &&
    data[2] === 0x03 &&
    data[3] === 0x04
  )
    return null // XLSX / zip
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe)
    return data.subarray(2).toString('utf16le')
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    const swapped = Buffer.from(data.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  const text = data.toString('utf8')
  if (text.includes('\u0000')) return null
  return text
}

/** Header key → canonical key: 'attr:color' → 'color', 'gst_rate_' trailing junk stays. */
function canonicalHeader(h: string): string {
  return h.startsWith('attr:') ? h.slice(5) : h
}

export function parseImportText(text: string): ReadResult {
  const table = parseCsvTable(text)
  if (table.headers.length === 0 || table.rows.length === 0)
    return { ok: false, error: err(0, null, 'file_empty', 'The file has no data rows') }
  const headers = table.headers.map(canonicalHeader)
  for (const required of ['name', 'sale_price']) {
    if (!headers.includes(required))
      return {
        ok: false,
        error: err(1, required, 'import_header_missing', `Column "${required}" is missing`),
      }
  }
  const rows = table.rows
    .map((r) => ({
      line: r.line,
      values: Object.fromEntries(Object.entries(r.values).map(([k, v]) => [canonicalHeader(k), v])),
    }))
    .filter((r) => Object.values(r.values).some((v) => v !== ''))
  if (rows.length === 0)
    return { ok: false, error: err(0, null, 'file_empty', 'The file has no data rows') }
  if (rows.length > IMPORT_MAX_ROWS)
    return {
      ok: false,
      error: err(
        0,
        null,
        'import_too_many_rows',
        `At most ${String(IMPORT_MAX_ROWS)} rows per file (found ${String(rows.length)})`,
      ),
    }
  return { ok: true, file: { headers, rows } }
}

/** Loads and parses an uploaded import file of the tenant. */
export async function readImportFile(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  files: FileService,
  fileId: string,
): Promise<{ filename: string; result: ReadResult }> {
  const row = await files.getFileRow(tx, ctx, fileId)
  if (row.purpose !== 'import')
    return {
      filename: row.filename,
      result: {
        ok: false,
        error: err(0, null, 'import_format', 'The file was not uploaded for import'),
      },
    }
  const text = decodeText(await files.readContent(row))
  if (text === null)
    return {
      filename: row.filename,
      result: {
        ok: false,
        error: err(
          0,
          null,
          'import_format',
          'Only CSV files can be imported; save the sheet as CSV',
        ),
      },
    }
  return { filename: row.filename, result: parseImportText(text) }
}

// ---------------------------------------------------------------------------------------------
// 2. Plan
// ---------------------------------------------------------------------------------------------

interface CategoryEntry {
  id: string
  parent_id: string | null
  name: string
  hsn_code: string | null
  gst_rate_bp: number | null
  tax_slab_rule_id: string | null
}

class CategoryIndex {
  private readonly byId = new Map<string, CategoryEntry>()
  private readonly byName = new Map<string, string>()
  readonly created: NewCategory[] = []

  constructor(rows: readonly CategoryEntry[]) {
    for (const r of rows) this.add(r)
  }

  private add(r: CategoryEntry): void {
    this.byId.set(r.id, r)
    this.byName.set(`${r.parent_id ?? '-'}|${r.name.toLowerCase()}`, r.id)
  }

  /** Category id for a path, planning missing levels when `create`; error code otherwise. */
  resolve(
    path: readonly string[],
    create: boolean,
  ): { id: string; ids: string[] } | { error: 'category_not_found' } {
    let parent: string | null = null
    const ids: string[] = []
    for (const [depth, name] of path.entries()) {
      let id = this.byName.get(`${parent ?? '-'}|${name.toLowerCase()}`)
      if (!id) {
        if (!create) return { error: 'category_not_found' }
        id = newId()
        this.add({
          id,
          parent_id: parent,
          name,
          hsn_code: null,
          gst_rate_bp: null,
          tax_slab_rule_id: null,
        })
        this.created.push({ id, parent_id: parent, name, depth: depth + 1 })
      }
      ids.push(id)
      parent = id
    }
    return { id: ids[ids.length - 1]!, ids }
  }

  /** Nearest HSN / GST / slab rule defaults up the tree. */
  defaults(id: string | null): {
    hsn_code: string | null
    gst_rate_bp: number | null
    tax_slab_rule_id: string | null
  } {
    const out = {
      hsn_code: null as string | null,
      gst_rate_bp: null as number | null,
      tax_slab_rule_id: null as string | null,
    }
    const seen = new Set<string>()
    let cur = id ? this.byId.get(id) : undefined
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      out.hsn_code ??= cur.hsn_code
      out.gst_rate_bp ??=
        cur.gst_rate_bp !== null && isValidGstRate(cur.gst_rate_bp) ? cur.gst_rate_bp : null
      out.tax_slab_rule_id ??= cur.tax_slab_rule_id
      cur = cur.parent_id ? this.byId.get(cur.parent_id) : undefined
    }
    return out
  }
}

/** Parsed cells of one row (undefined = empty cell = not provided). */
interface RowValues {
  sku?: string
  barcodes?: string[]
  name?: string
  name_ta?: string
  category_path?: string[]
  brand?: string
  unit?: string
  pack_size?: number
  hsn_code?: string
  gst_rate_bp?: number
  mrp_paise?: number
  sale_price_paise?: number
  purchase_price_paise?: number
  wholesale_price_paise?: number
  price_includes_tax?: boolean
  track_batches?: boolean
  reorder_level_text?: string
  aliases?: string[]
  scale_plu?: string
  parent_sku?: string
  variant: Record<string, string>
  attributes: Record<string, string | number | boolean>
}

const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9\-_./]*$/
const VARIANT_AXES = ['size', 'color'] as const

function parseRow(
  row: CsvTableRow,
  columns: ReadonlyMap<string, ProductImportColumnDef>,
  headers: readonly string[],
  errors: ImportError[],
): RowValues {
  const v = row.values
  const line = row.line
  const out: RowValues = { variant: {}, attributes: {} }
  const text = (key: string, max: number): string | undefined => {
    const s = (v[key] ?? '').trim()
    if (s === '') return undefined
    if ([...s].length > max) {
      errors.push(err(line, key, 'too_long', `At most ${String(max)} characters`))
      return undefined
    }
    return s
  }
  const money = (key: string): number | undefined => {
    const s = (v[key] ?? '').trim()
    if (s === '') return undefined
    const p = tryParseRupees(s)
    if (p === null || p < 0) {
      errors.push(err(line, key, 'money_invalid', `"${s}" is not an amount in rupees`))
      return undefined
    }
    return p
  }
  const bool = (key: string): boolean | undefined => {
    const s = (v[key] ?? '').trim()
    if (s === '') return undefined
    const b = parseYesNo(s)
    if (b === undefined || b === null) {
      errors.push(err(line, key, 'boolean_invalid', `"${s}" must be yes or no`))
      return undefined
    }
    return b
  }

  const sku = text('sku', 40)
  if (sku !== undefined) {
    if (SKU_RE.test(sku)) out.sku = sku
    else errors.push(err(line, 'sku', 'sku_format', `"${sku}" is not a valid SKU`))
  }
  const codes = (v.barcode ?? '')
    .split('|')
    .map((c) => c.trim())
    .filter(Boolean)
  if (codes.length) {
    const ok: string[] = []
    for (const c of codes) {
      const problem = barcodeIssue(c)
      if (problem) errors.push(err(line, 'barcode', problem, `Barcode "${c}" is not valid`))
      else if (!ok.includes(c)) ok.push(c)
    }
    out.barcodes = ok
  }
  const name = text('name', 200)
  if (name !== undefined) out.name = name
  const nameTa = text('name_ta', 200)
  if (nameTa !== undefined) out.name_ta = nameTa
  const catPath = (v.category_path ?? '').trim()
  if (catPath) {
    const levels = catPath
      .split(/\s*>\s*/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (levels.length > MAX_CATEGORY_DEPTH)
      errors.push(
        err(
          line,
          'category_path',
          'category_depth',
          `At most ${String(MAX_CATEGORY_DEPTH)} levels`,
        ),
      )
    else if (levels.some((l) => [...l].length > 100))
      errors.push(
        err(line, 'category_path', 'too_long', 'Category names have at most 100 characters'),
      )
    else out.category_path = levels
  }
  const brand = text('brand', 100)
  if (brand !== undefined) out.brand = brand
  const unit = (v.unit ?? '').trim().toUpperCase()
  if (unit) {
    if (isUnitCode(unit)) out.unit = unit
    else errors.push(err(line, 'unit', 'unit_unknown', `Unknown unit "${unit}"`))
  }
  const pack = (v.pack_size ?? '').trim()
  if (pack) {
    const n = /^\d{1,6}$/.test(pack) ? Number(pack) : NaN
    if (Number.isInteger(n) && n >= 1 && n <= 100_000) out.pack_size = n
    else errors.push(err(line, 'pack_size', 'int_invalid', `"${pack}" is not a pack size`))
  }
  const hsn = (v.hsn_code ?? '').trim()
  if (hsn) {
    if (isValidHsn(hsn)) out.hsn_code = hsn
    else errors.push(err(line, 'hsn_code', 'hsn', `"${hsn}" is not a 4, 6 or 8 digit HSN code`))
  }
  const gst = (v.gst_rate ?? '').trim()
  if (gst) {
    const bp = parsePercentBp(gst)
    if (bp === null)
      errors.push(err(line, 'gst_rate', 'percent_invalid', `"${gst}" is not a percentage`))
    else if (!isValidGstRate(bp))
      errors.push(err(line, 'gst_rate', 'gst_rate_invalid', `${gst}% is not a GST rate`))
    else out.gst_rate_bp = bp
  }
  const mrp = money('mrp')
  if (mrp !== undefined) out.mrp_paise = mrp
  const sale = money('sale_price')
  if (sale !== undefined) out.sale_price_paise = sale
  const purchase = money('purchase_price')
  if (purchase !== undefined) out.purchase_price_paise = purchase
  const wholesale = money('wholesale_price')
  if (wholesale !== undefined) out.wholesale_price_paise = wholesale
  const pit = bool('price_includes_tax')
  if (pit !== undefined) out.price_includes_tax = pit
  const tb = bool('track_batches')
  if (tb !== undefined) out.track_batches = tb
  const reorder = (v.reorder_level ?? '').trim()
  if (reorder) out.reorder_level_text = reorder
  const aliases = (v.aliases ?? '')
    .split('|')
    .map((a) => a.trim())
    .filter(Boolean)
  if (aliases.length) {
    if (aliases.some((a) => [...a].length > 60) || aliases.length > 20)
      errors.push(err(line, 'aliases', 'too_long', 'At most 20 search words of 60 characters'))
    else out.aliases = [...new Map(aliases.map((a) => [a.toLowerCase(), a])).values()]
  }
  const plu = (v.scale_plu ?? '').trim()
  if (plu) {
    if (/^\d{1,10}$/.test(plu)) out.scale_plu = normalizePlu(plu)
    else
      errors.push(err(line, 'scale_plu', 'scale_plu_format', `"${plu}" is not a scale item code`))
  }
  const parentSku = text('parent_sku', 40)
  if (parentSku !== undefined) out.parent_sku = parentSku

  // Vertical attribute columns and any extra columns.
  for (const key of headers) {
    const def = columns.get(key)
    if (def && def.target !== 'attribute' && def.target !== 'variant') continue
    const raw = (v[key] ?? '').trim()
    if (raw === '') continue
    if (def?.target === 'variant') {
      if ([...raw].length > 30) errors.push(err(line, key, 'too_long', 'At most 30 characters'))
      else out.variant[key] = raw
      continue
    }
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) continue
    if ([...raw].length > 500) {
      errors.push(err(line, key, 'too_long', 'At most 500 characters'))
      continue
    }
    switch (def?.type) {
      case 'boolean': {
        const b = parseYesNo(raw)
        if (b === undefined || b === null)
          errors.push(err(line, key, 'boolean_invalid', `"${raw}" must be yes or no`))
        else out.attributes[key] = b
        break
      }
      case 'int': {
        if (/^\d{1,9}$/.test(raw)) out.attributes[key] = Number(raw)
        else errors.push(err(line, key, 'int_invalid', `"${raw}" is not a whole number`))
        break
      }
      case 'enum': {
        const match = def.enum_values?.find((e) => e.toLowerCase() === raw.toLowerCase())
        if (match) out.attributes[key] = match
        else
          errors.push(
            err(
              line,
              key,
              'enum_invalid',
              `"${raw}" must be one of ${(def.enum_values ?? []).join(', ')}`,
            ),
          )
        break
      }
      default:
        out.attributes[key] = raw
    }
  }
  return out
}

interface PlannedProduct {
  id: string
  kind: string
  isNew: boolean
  /** Snapshot for inheritance (existing row or planned insert). */
  base: Pick<
    Writable,
    | 'unit'
    | 'pack_size'
    | 'allow_loose'
    | 'decimal_qty'
    | 'category_id'
    | 'brand_id'
    | 'hsn_code'
    | 'gst_rate_bp'
    | 'cess_rate_bp'
    | 'tax_slab_rule_id'
    | 'price_includes_tax'
    | 'track_batches'
    | 'mrp_paise'
    | 'purchase_price_paise'
    | 'attributes'
  >
  axes: string[]
  variantKeys: Map<string, string>
  hasMovements: boolean
  insertOp: Extract<ImportOp, { kind: 'insert' }> | null
}

async function preload(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  rows: readonly RowValues[],
): Promise<{
  bySku: Map<string, ProductRow>
  byBarcode: Map<string, string>
  byId: Map<string, ProductRow>
  barcodesOf: Map<string, Set<string>>
  variantsOf: Map<string, Map<string, string>>
  withMovements: Set<string>
  byPlu: Map<string, string>
}> {
  const t = ctx.tenantId
  const skus = [
    ...new Set(
      rows.flatMap((r) =>
        [r.sku, r.parent_sku].filter((s): s is string => !!s).map((s) => s.toLowerCase()),
      ),
    ),
  ]
  const codes = [...new Set(rows.flatMap((r) => r.barcodes ?? []))]
  const byId = new Map<string, ProductRow>()
  const chunk = <T>(list: readonly T[], n = 5000): T[][] =>
    Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, (i + 1) * n))
  for (const part of chunk(skus)) {
    const found = await tx
      .selectFrom('products')
      .select(PRODUCT_COLUMNS)
      .where('tenant_id', '=', t)
      .where(sql<boolean>`lower(sku) = any(${part}::text[])`)
      .execute()
    for (const p of found) byId.set(p.id, p)
  }
  const byBarcode = new Map<string, string>()
  for (const part of chunk(codes)) {
    const found = await tx
      .selectFrom('product_barcodes')
      .select(['barcode', 'product_id'])
      .where('tenant_id', '=', t)
      .where('barcode', 'in', part)
      .execute()
    for (const b of found) byBarcode.set(b.barcode, b.product_id)
  }
  const missing = [...new Set(byBarcode.values())].filter((id) => !byId.has(id))
  for (const part of chunk(missing)) {
    const found = await tx
      .selectFrom('products')
      .select(PRODUCT_COLUMNS)
      .where('tenant_id', '=', t)
      .where('id', 'in', part)
      .execute()
    for (const p of found) byId.set(p.id, p)
  }
  const ids = [...byId.keys()]
  const barcodesOf = new Map<string, Set<string>>()
  const variantsOf = new Map<string, Map<string, string>>()
  const withMovements = new Set<string>()
  for (const part of chunk(ids)) {
    const codesRows = await tx
      .selectFrom('product_barcodes')
      .select(['barcode', 'product_id'])
      .where('tenant_id', '=', t)
      .where('product_id', 'in', part)
      .execute()
    for (const b of codesRows) {
      const set = barcodesOf.get(b.product_id) ?? new Set<string>()
      set.add(b.barcode)
      barcodesOf.set(b.product_id, set)
    }
    const children = await tx
      .selectFrom('products')
      .select(PRODUCT_COLUMNS)
      .where('tenant_id', '=', t)
      .where('parent_id', 'in', part)
      .execute()
    for (const c of children) {
      byId.set(c.id, c)
      const parent = byId.get(c.parent_id!)
      const order = parent?.variant_axes ?? Object.keys(stringRecord(c.variant_attributes))
      const map = variantsOf.get(c.parent_id!) ?? new Map<string, string>()
      map.set(variantKey(stringRecord(c.variant_attributes), order), c.id)
      variantsOf.set(c.parent_id!, map)
    }
    const moved = await sql<{ product_id: string }>`
      SELECT DISTINCT product_id FROM stock_movements
       WHERE tenant_id = ${t} AND product_id = ANY(${part}::uuid[])`.execute(tx)
    for (const m of moved.rows) withMovements.add(m.product_id)
  }
  const bySku = new Map<string, ProductRow>()
  for (const p of byId.values()) if (p.sku) bySku.set(p.sku.toLowerCase(), p)
  const plus = [...new Set(rows.map((r) => r.scale_plu).filter((x): x is string => !!x))]
  const byPlu = new Map<string, string>()
  for (const part of chunk(plus)) {
    const found = await tx
      .selectFrom('products')
      .select(['id', 'scale_plu'])
      .where('tenant_id', '=', t)
      .where('scale_plu', 'in', part)
      .execute()
    for (const p of found) if (p.scale_plu) byPlu.set(p.scale_plu, p.id)
  }
  return { bySku, byBarcode, byId, barcodesOf, variantsOf, withMovements, byPlu }
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export async function planProductImport(
  tx: Tx,
  ctx: Ctx,
  file: ParsedImportFile,
  options: ProductImportOptions,
): Promise<ImportPlan> {
  const env = await catalogEnv(tx, ctx)
  const bt: BusinessType = env.tenant.business_type
  const columns = new Map(productImportColumns(bt).map((c) => [c.key, c]))
  const errors: ImportError[] = []
  const errorLines = new Set<number>()
  const actions = new Map<number, ImportPreviewRow>()
  const ops: ImportOp[] = []

  const parsed = file.rows.map((r) => {
    const rowErrors: ImportError[] = []
    const values = parseRow(r, columns, file.headers, rowErrors)
    return { line: r.line, values, rowErrors }
  })
  const data = await preload(
    tx,
    ctx,
    parsed.map((p) => p.values),
  )

  const catRows = await tx
    .selectFrom('categories')
    .select(['id', 'parent_id', 'name', 'hsn_code', 'gst_rate_bp', 'tax_slab_rule_id'])
    .where('tenant_id', '=', ctx.tenantId)
    .execute()
  const categories = new CategoryIndex(catRows)
  const brandRows = await tx
    .selectFrom('brands')
    .select(['id', 'name'])
    .where('tenant_id', '=', ctx.tenantId)
    .execute()
  const brands = new Map(
    brandRows.map((b) => [String(b.name).toLowerCase(), { id: b.id, isNew: false }]),
  )
  const newBrands: Array<{ id: string; name: string }> = []

  const ent = await getEntitlements(ctx)
  const limit = ent.limits.products
  let remaining = limit === null ? null : limit - (await countForLimit(tx, ctx, 'products'))

  const claimedSkus = new Map<string, number>()
  const claimedCodes = new Map<string, number>()
  const claimedPlus = new Map<string, number>()
  const planned = new Map<string, PlannedProduct>()
  const plannedBySku = new Map<string, PlannedProduct>()
  const plannedFor = (p: ProductRow): PlannedProduct => {
    let entry = planned.get(p.id)
    if (!entry) {
      entry = {
        id: p.id,
        kind: p.kind,
        isNew: false,
        base: p,
        axes: [...p.variant_axes],
        variantKeys: new Map(data.variantsOf.get(p.id) ?? []),
        hasMovements: data.withMovements.has(p.id),
        insertOp: null,
      }
      planned.set(p.id, entry)
      if (p.sku) plannedBySku.set(p.sku.toLowerCase(), entry)
    }
    return entry
  }
  for (const p of data.byId.values()) if (!p.parent_id) plannedFor(p)

  const settleError = (
    line: number,
    list: ImportError[],
    key: string | null,
    name: string | null,
  ) => {
    errors.push(...list)
    errorLines.add(line)
    actions.set(line, { row: line, action: 'error', key, name })
  }

  for (const { line, values: v, rowErrors } of parsed) {
    const key = v.sku ?? v.barcodes?.[0] ?? null
    const label = v.name ?? null
    const rowErrs = [...rowErrors]
    if (rowErrs.length) {
      settleError(line, rowErrs, key, label)
      continue
    }
    // In-file duplicates.
    if (v.sku && claimedSkus.has(v.sku.toLowerCase())) {
      settleError(
        line,
        [
          err(
            line,
            'sku',
            'duplicate_in_file',
            `SKU also on row ${String(claimedSkus.get(v.sku.toLowerCase()))}`,
          ),
        ],
        key,
        label,
      )
      continue
    }
    if (v.scale_plu && claimedPlus.has(v.scale_plu)) {
      settleError(
        line,
        [
          err(
            line,
            'scale_plu',
            'duplicate_in_file',
            `Scale item code also on row ${String(claimedPlus.get(v.scale_plu))}`,
          ),
        ],
        key,
        label,
      )
      continue
    }
    const dupCode = (v.barcodes ?? []).find((c) => claimedCodes.has(c))
    if (dupCode) {
      settleError(
        line,
        [
          err(
            line,
            'barcode',
            'duplicate_in_file',
            `Barcode ${dupCode} also on row ${String(claimedCodes.get(dupCode))}`,
          ),
        ],
        key,
        label,
      )
      continue
    }

    // Variant parent.
    let parent: PlannedProduct | null = null
    const variantAttrs: Record<string, string> = {}
    for (const axis of VARIANT_AXES) if (v.variant[axis]) variantAttrs[axis] = v.variant[axis]!
    if (v.parent_sku) {
      parent = plannedBySku.get(v.parent_sku.toLowerCase()) ?? null
      if (!parent) {
        settleError(
          line,
          [err(line, 'parent_sku', 'parent_not_found', `No product with SKU ${v.parent_sku}`)],
          key,
          label,
        )
        continue
      }
      if (
        parent.kind === 'variant' ||
        parent.kind === 'service' ||
        (parent.kind === 'standard' && parent.hasMovements)
      ) {
        settleError(
          line,
          [err(line, 'parent_sku', 'parent_kind', 'This product cannot have variants')],
          key,
          label,
        )
        continue
      }
      if (Object.keys(variantAttrs).length === 0) {
        settleError(
          line,
          [err(line, 'size', 'variant_axis', 'A variant row needs a size or color')],
          key,
          label,
        )
        continue
      }
      const axes = VARIANT_AXES.filter((a) => variantAttrs[a] !== undefined) as string[]
      if (parent.variantKeys.size > 0 || parent.axes.length > 0) {
        const same =
          parent.axes.length === axes.length && axes.every((a) => parent!.axes.includes(a))
        if (!same && parent.variantKeys.size > 0) {
          settleError(
            line,
            [
              err(
                line,
                'size',
                'variant_axes_mismatch',
                `Variants of ${v.parent_sku} use ${parent.axes.join(' / ')}`,
              ),
            ],
            key,
            label,
          )
          continue
        }
      }
    }

    // Match an existing product.
    let match: ProductRow | null = null
    if (v.sku && options.match_by !== 'barcode') match = data.bySku.get(v.sku.toLowerCase()) ?? null
    if (!match && options.match_by !== 'sku') {
      for (const c of v.barcodes ?? []) {
        const pid = data.byBarcode.get(c)
        if (pid) {
          match = data.byId.get(pid) ?? null
          break
        }
      }
    }
    if (!match && parent) {
      const order = parent.axes.length ? parent.axes : Object.keys(variantAttrs)
      const existingId = parent.variantKeys.get(variantKey(variantAttrs, order))
      if (existingId) {
        const row = data.byId.get(existingId)
        if (row) match = row
        else {
          settleError(
            line,
            [err(line, 'size', 'duplicate_in_file', 'This size / color appears twice')],
            key,
            label,
          )
          continue
        }
      }
    }
    // A barcode of another product?
    const foreign = (v.barcodes ?? []).find((c) => {
      const owner = data.byBarcode.get(c)
      return owner !== undefined && owner !== match?.id
    })
    const pluOwner = v.scale_plu ? data.byPlu.get(v.scale_plu) : undefined
    if (pluOwner !== undefined && pluOwner !== match?.id) {
      settleError(
        line,
        [
          err(
            line,
            'scale_plu',
            'scale_plu_taken',
            `Scale item code ${v.scale_plu ?? ''} belongs to another product`,
          ),
        ],
        key,
        label,
      )
      continue
    }
    if (foreign) {
      settleError(
        line,
        [err(line, 'barcode', 'barcode_taken', `Barcode ${foreign} belongs to another product`)],
        key,
        label,
      )
      continue
    }
    if (match && v.sku) {
      const other = data.bySku.get(v.sku.toLowerCase())
      if (other && other.id !== match.id) {
        settleError(
          line,
          [err(line, 'sku', 'sku_taken', `SKU ${v.sku} belongs to another product`)],
          key,
          label,
        )
        continue
      }
    }

    // Category / brand.
    let categoryId: string | null | undefined
    let categoryIds: string[] = []
    if (v.category_path) {
      const res = categories.resolve(v.category_path, options.create_categories)
      if ('error' in res) {
        settleError(
          line,
          [
            err(
              line,
              'category_path',
              'category_not_found',
              `Category "${v.category_path.join(CATEGORY_PATH_SEPARATOR)}" does not exist`,
            ),
          ],
          key,
          label,
        )
        continue
      }
      categoryId = res.id
      categoryIds = res.ids
    }
    let brandId: string | null | undefined
    if (v.brand) {
      const b = brands.get(v.brand.toLowerCase())
      if (b) brandId = b.id
      else if (options.create_brands) {
        const id = newId()
        brands.set(v.brand.toLowerCase(), { id, isNew: true })
        newBrands.push({ id, name: v.brand })
        brandId = id
      } else {
        settleError(
          line,
          [err(line, 'brand', 'brand_not_found', `Brand "${v.brand}" does not exist`)],
          key,
          label,
        )
        continue
      }
    }

    if (match) {
      if (options.mode === 'create_only') {
        actions.set(line, { row: line, action: 'skip', key, name: label ?? match.name })
        claim(v, line)
        continue
      }
      const res = planUpdate(
        env,
        bt,
        match,
        v,
        { categoryId, brandId },
        data.barcodesOf.get(match.id),
        data.withMovements.has(match.id),
        line,
      )
      if ('errors' in res) {
        settleError(line, res.errors, key, label ?? match.name)
        continue
      }
      let parentConvert: ParentConvert | null = null
      if (parent) parentConvert = convertParent(parent, variantAttrs)
      const changed =
        Object.keys(res.patch).length > 0 || res.barcodes.length > 0 || parentConvert !== null
      if (changed) {
        ops.push({
          kind: 'update',
          line,
          id: match.id,
          before: match,
          patch: res.patch,
          barcodes: res.barcodes,
          parentConvert,
          categoryIds,
          brandId: brandId ?? null,
        })
      }
      actions.set(line, {
        row: line,
        action: changed ? 'update' : 'unchanged',
        key,
        name: label ?? match.name,
      })
      claim(v, line)
      continue
    }

    // Create.
    if (v.name === undefined || v.sale_price_paise === undefined) {
      settleError(
        line,
        [
          ...(v.name === undefined
            ? [err(line, 'name', 'required', 'Name is required for a new product')]
            : []),
          ...(v.sale_price_paise === undefined
            ? [err(line, 'sale_price', 'required', 'Selling price is required for a new product')]
            : []),
        ],
        key,
        label,
      )
      continue
    }
    if (v.sku && data.bySku.has(v.sku.toLowerCase())) {
      settleError(
        line,
        [err(line, 'sku', 'sku_taken', `SKU ${v.sku} belongs to another product`)],
        key,
        label,
      )
      continue
    }
    if (remaining !== null && remaining <= 0) {
      settleError(
        line,
        [err(line, null, 'plan_limit', 'The plan’s product limit is reached')],
        key,
        label,
      )
      continue
    }
    const res = planInsert(
      env,
      bt,
      categories,
      v,
      {
        categoryId: categoryId ?? (parent ? parent.base.category_id : null),
        brandId: brandId ?? (parent ? parent.base.brand_id : null),
      },
      parent,
      variantAttrs,
      line,
      ctx,
    )
    if ('errors' in res) {
      settleError(line, res.errors, key, label)
      continue
    }
    let parentConvert: ParentConvert | null = null
    if (parent) parentConvert = convertParent(parent, variantAttrs)
    const op: Extract<ImportOp, { kind: 'insert' }> = {
      kind: 'insert',
      line,
      values: res.values,
      barcodes: v.barcodes ?? [],
      parentConvert,
      categoryIds,
      brandId: brandId ?? null,
      isVariant: parent !== null,
    }
    ops.push(op)
    if (remaining !== null) remaining -= 1
    actions.set(line, { row: line, action: 'create', key, name: v.name })
    claim(v, line)
    const id = res.values.id!
    const entry: PlannedProduct = {
      id,
      kind: parent ? 'variant' : 'standard',
      isNew: true,
      base: {
        unit: res.values.unit!,
        pack_size: res.values.pack_size!,
        allow_loose: res.values.allow_loose ?? false,
        decimal_qty: res.values.decimal_qty ?? false,
        category_id: res.values.category_id ?? null,
        brand_id: res.values.brand_id ?? null,
        hsn_code: res.values.hsn_code ?? null,
        gst_rate_bp: res.values.gst_rate_bp ?? 0,
        cess_rate_bp: 0,
        tax_slab_rule_id: res.values.tax_slab_rule_id ?? null,
        price_includes_tax: res.values.price_includes_tax ?? true,
        track_batches: res.values.track_batches ?? false,
        mrp_paise: (res.values.mrp_paise as number | null | undefined) ?? null,
        purchase_price_paise: Number(res.values.purchase_price_paise ?? 0),
        attributes: v.attributes,
      },
      axes: [],
      variantKeys: new Map(),
      hasMovements: false,
      insertOp: op,
    }
    planned.set(id, entry)
    if (v.sku && !parent) plannedBySku.set(v.sku.toLowerCase(), entry)
    if (parent) {
      const order = parent.axes
      parent.variantKeys.set(variantKey(variantAttrs, order), id)
    }
  }

  function claim(v: RowValues, line: number): void {
    if (v.sku) claimedSkus.set(v.sku.toLowerCase(), line)
    if (v.scale_plu) claimedPlus.set(v.scale_plu, line)
    for (const c of v.barcodes ?? []) claimedCodes.set(c, line)
  }

  /** Turns the parent into a variant parent with the row's axes (first variant row decides). */
  function convertParent(
    parent: PlannedProduct,
    attrs: Record<string, string>,
  ): ParentConvert | null {
    const axes = VARIANT_AXES.filter((a) => attrs[a] !== undefined) as string[]
    const axesChanged = parent.variantKeys.size === 0 && !sameValue(parent.axes, axes)
    if (axesChanged) parent.axes = axes
    if (parent.kind === 'variant_parent' && !axesChanged) return null
    parent.kind = 'variant_parent'
    if (parent.insertOp) {
      parent.insertOp.values.kind = 'variant_parent'
      parent.insertOp.values.track_inventory = false
      parent.insertOp.values.variant_axes = parent.axes
      return null
    }
    return { id: parent.id, axes: parent.axes }
  }

  // Only categories / brands used by valid rows are created.
  const usedCategories = new Set(ops.flatMap((o) => o.categoryIds))
  const usedBrands = new Set(ops.map((o) => o.brandId).filter((b): b is string => b !== null))
  return {
    totalRows: file.rows.length,
    ops,
    actions,
    errors,
    errorLines,
    newCategories: categories.created.filter((c) => usedCategories.has(c.id)),
    newBrands: newBrands.filter((b) => usedBrands.has(b.id)),
  }
}

function reorderLevel(
  text: string | undefined,
  unit: string,
  decimal: boolean,
): number | null | 'invalid' {
  if (text === undefined) return null
  if (/^0+(\.0*)?$/.test(text)) return 0
  const q = tryParseQty(text, unit, { allowDecimal: decimal })
  return q === null ? 'invalid' : q
}

function ruleErrors(line: number, list: ReturnType<typeof productRuleIssues>): ImportError[] {
  const fieldOf: Record<string, string> = {
    sale_price_paise: 'sale_price',
    min_sale_price_paise: 'sale_price',
    allow_loose: 'pack_size',
    decimal_qty: 'unit',
    track_inventory: 'track_batches',
  }
  return list.map((i) =>
    err(
      line,
      fieldOf[i.path] ?? i.path,
      i.code as ProductImportErrorCode,
      i.code.replace(/_/g, ' '),
    ),
  )
}

function attributeErrors(
  line: number,
  bt: BusinessType,
  attrs: Record<string, unknown>,
): { ok: Record<string, unknown> } | { errors: ImportError[] } {
  const res = validateAttributes(bt, attrs)
  if (res.success) return { ok: res.data }
  return {
    errors: res.error.issues.map((i) =>
      err(line, String(i.path[0] ?? 'attributes'), 'attribute_invalid', i.message),
    ),
  }
}

function planInsert(
  env: CatalogEnv,
  bt: BusinessType,
  categories: CategoryIndex,
  v: RowValues,
  refs: { categoryId: string | null; brandId: string | null },
  parent: PlannedProduct | null,
  variantAttrs: Record<string, string>,
  line: number,
  ctx: Ctx,
): { values: Insertable<Products> } | { errors: ImportError[] } {
  const base = parent?.base
  const unit = v.unit ?? base?.unit ?? defaultUnit(env.settings)
  const decimal = base?.decimal_qty ?? isDecimalUnit(unit)
  const reorder = reorderLevel(v.reorder_level_text, unit, decimal)
  if (reorder === 'invalid')
    return {
      errors: [
        err(
          line,
          'reorder_level',
          'qty_invalid',
          `"${v.reorder_level_text ?? ''}" is not a quantity in ${unit}`,
        ),
      ],
    }
  const attrsIn = { ...jsonObject(base?.attributes), ...v.attributes }
  const attrs = attributeErrors(line, bt, attrsIn)
  if ('errors' in attrs) return attrs
  const kind = 'standard'
  const flags = normalizeProductFlags({
    kind,
    track_inventory: true,
    track_batches:
      forcedTrackBatches(env, kind, attrs.ok) ||
      (v.track_batches ?? base?.track_batches ?? env.settings.catalog.default_track_batches),
  })
  const inherited = categories.defaults(refs.categoryId)
  const draft = {
    kind,
    unit,
    pack_size: v.pack_size ?? base?.pack_size ?? 1,
    allow_loose: base?.allow_loose ?? false,
    decimal_qty: decimal,
    track_inventory: flags.track_inventory,
    track_batches: flags.track_batches,
    mrp_paise: v.mrp_paise ?? base?.mrp_paise ?? null,
    sale_price_paise: v.sale_price_paise!,
    min_sale_price_paise: null,
  } as const
  const issues = productRuleIssues({ ...draft, allow_mrp_below_sale: false })
  if (issues.length) return { errors: ruleErrors(line, issues) }
  return {
    values: {
      id: newId(),
      tenant_id: ctx.tenantId,
      parent_id: parent ? parent.id : null,
      kind: parent ? 'variant' : 'standard',
      sku: v.sku ?? null,
      name: v.name!,
      name_ta: v.name_ta ?? null,
      aliases: v.aliases ?? [],
      category_id: refs.categoryId,
      brand_id: refs.brandId,
      unit,
      pack_size: draft.pack_size,
      allow_loose: draft.allow_loose,
      decimal_qty: draft.decimal_qty,
      hsn_code: v.hsn_code ?? base?.hsn_code ?? inherited.hsn_code,
      gst_rate_bp:
        v.gst_rate_bp ??
        base?.gst_rate_bp ??
        inherited.gst_rate_bp ??
        env.settings.catalog.default_gst_rate_bp ??
        0,
      cess_rate_bp: base?.cess_rate_bp ?? 0,
      tax_slab_rule_id: base ? base.tax_slab_rule_id : inherited.tax_slab_rule_id,
      price_includes_tax:
        v.price_includes_tax ??
        base?.price_includes_tax ??
        env.settings.invoice.default_price_includes_tax,
      mrp_paise: draft.mrp_paise,
      sale_price_paise: draft.sale_price_paise,
      wholesale_price_paise: v.wholesale_price_paise ?? null,
      purchase_price_paise: v.purchase_price_paise ?? base?.purchase_price_paise ?? 0,
      track_inventory: draft.track_inventory,
      track_batches: draft.track_batches,
      scale_plu: v.scale_plu ?? null,
      reorder_level_milli: reorder,
      variant_attributes: jsonb(parent ? variantAttrs : {}),
      attributes: jsonb(attrs.ok),
      created_by: ctx.userId,
    },
  }
}

function planUpdate(
  env: CatalogEnv,
  bt: BusinessType,
  row: ProductRow,
  v: RowValues,
  refs: { categoryId: string | null | undefined; brandId: string | null | undefined },
  existingCodes: Set<string> | undefined,
  hasMovements: boolean,
  line: number,
): { patch: Partial<Writable>; barcodes: string[] } | { errors: ImportError[] } {
  const patch: Partial<Writable> = {}
  const set = <K extends keyof Writable>(k: K, val: Writable[K] | undefined) => {
    if (val !== undefined && !sameValue(val, row[k])) patch[k] = val
  }
  set('sku', v.sku)
  set('name', v.name)
  set('name_ta', v.name_ta)
  set('aliases', v.aliases)
  set('category_id', refs.categoryId)
  set('brand_id', refs.brandId)
  if (v.unit !== undefined && v.unit !== row.unit) {
    if (hasMovements)
      return {
        errors: [err(line, 'unit', 'unit_in_use', 'The unit cannot change after stock movements')],
      }
    patch.unit = v.unit
  }
  set('pack_size', v.pack_size)
  set('hsn_code', v.hsn_code)
  set('gst_rate_bp', v.gst_rate_bp)
  set('mrp_paise', v.mrp_paise)
  set('sale_price_paise', v.sale_price_paise)
  set('purchase_price_paise', v.purchase_price_paise)
  set('wholesale_price_paise', v.wholesale_price_paise)
  set('price_includes_tax', v.price_includes_tax)
  set('scale_plu', v.scale_plu)
  const merged = { ...row, ...patch }
  const decimalQty = patch.unit !== undefined ? isDecimalUnit(merged.unit) : merged.decimal_qty
  if (decimalQty !== row.decimal_qty) patch.decimal_qty = decimalQty
  const reorder = reorderLevel(v.reorder_level_text, merged.unit, decimalQty)
  if (reorder === 'invalid')
    return {
      errors: [
        err(
          line,
          'reorder_level',
          'qty_invalid',
          `"${v.reorder_level_text ?? ''}" is not a quantity in ${merged.unit}`,
        ),
      ],
    }
  if (v.reorder_level_text !== undefined) set('reorder_level_milli', reorder)
  if (Object.keys(v.attributes).length) {
    const attrs = attributeErrors(line, bt, { ...jsonObject(row.attributes), ...v.attributes })
    if ('errors' in attrs) return attrs
    if (!sameValue(attrs.ok, jsonObject(row.attributes))) patch.attributes = attrs.ok
  }
  let trackBatches = v.track_batches ?? merged.track_batches
  if (forcedTrackBatches(env, row.kind, jsonObject(patch.attributes ?? row.attributes)))
    trackBatches = true
  const flags = normalizeProductFlags({
    kind:
      row.kind === 'service' || row.kind === 'variant_parent' || row.kind === 'variant'
        ? row.kind
        : 'standard',
    track_inventory: merged.track_inventory,
    track_batches: trackBatches,
  })
  if (flags.track_batches !== row.track_batches) patch.track_batches = flags.track_batches
  const priceTouched = v.mrp_paise !== undefined || v.sale_price_paise !== undefined
  const issues = productRuleIssues({
    kind: flags.kind,
    unit: merged.unit,
    pack_size: merged.pack_size,
    allow_loose: merged.allow_loose,
    decimal_qty: decimalQty,
    track_inventory: flags.track_inventory,
    track_batches: flags.track_batches,
    mrp_paise: merged.mrp_paise,
    sale_price_paise: merged.sale_price_paise,
    min_sale_price_paise: merged.min_sale_price_paise,
    allow_mrp_below_sale: !priceTouched,
  })
  if (issues.length) return { errors: ruleErrors(line, issues) }
  const barcodes = (v.barcodes ?? []).filter((c) => !existingCodes?.has(c))
  return { patch, barcodes }
}

// ---------------------------------------------------------------------------------------------
// 3. Apply
// ---------------------------------------------------------------------------------------------

export function emptyOutcome(): ApplyOutcome {
  return {
    created: 0,
    updated: 0,
    variantsCreated: 0,
    barcodesAdded: 0,
    categoriesCreated: 0,
    brandsCreated: 0,
    failed: [],
    changes: [],
  }
}

/** Inserts the planned categories (parents first) and brands. */
export async function applyTaxonomy(
  tx: Tx,
  ctx: Ctx,
  plan: ImportPlan,
  out: ApplyOutcome,
): Promise<void> {
  const cats = [...plan.newCategories].sort((a, b) => a.depth - b.depth)
  for (const c of cats) {
    await tx
      .insertInto('categories')
      .values({ id: c.id, tenant_id: ctx.tenantId, parent_id: c.parent_id, name: c.name })
      .execute()
    out.categoriesCreated += 1
  }
  if (plan.newBrands.length) {
    await tx
      .insertInto('brands')
      .values(plan.newBrands.map((b) => ({ id: b.id, tenant_id: ctx.tenantId, name: b.name })))
      .execute()
    out.brandsCreated += plan.newBrands.length
  }
}

const AUDITED_FIELDS = [
  'mrp_paise',
  'sale_price_paise',
  'purchase_price_paise',
  'wholesale_price_paise',
  'gst_rate_bp',
  'hsn_code',
] as const
const MAX_AUDITED_CHANGES = 500

function failure(line: number, e: unknown): ImportError {
  const code = pgCode(e)
  if (code === '23505') {
    const constraint = String((e as { constraint?: unknown }).constraint ?? '')
    if (constraint.includes('barcode'))
      return err(line, 'barcode', 'barcode_taken', 'Barcode is used by another product')
    if (constraint.includes('scale_plu'))
      return err(line, 'scale_plu', 'scale_plu_taken', 'Scale item code is used by another product')
    if (constraint.includes('sku'))
      return err(line, 'sku', 'sku_taken', 'SKU is used by another product')
  }
  const message = isAppError(e) ? e.message : e instanceof Error ? e.message : 'write failed'
  return err(line, null, 'write_failed', message.slice(0, 300))
}

/** Applies ops (one savepoint each); failed rows are collected in `out.failed`. */
export async function applyOps(
  tx: Tx,
  ctx: Ctx,
  ops: readonly ImportOp[],
  out: ApplyOutcome,
): Promise<void> {
  for (const op of ops) {
    try {
      await withSavepoint(tx, async () => {
        if (op.parentConvert) {
          await tx
            .updateTable('products')
            .set({
              kind: 'variant_parent',
              track_inventory: false,
              variant_axes: op.parentConvert.axes,
            })
            .where('tenant_id', '=', ctx.tenantId)
            .where('id', '=', op.parentConvert.id)
            .execute()
        }
        let productId: string
        if (op.kind === 'insert') {
          const row = await tx
            .insertInto('products')
            .values(op.values)
            .returning('id')
            .executeTakeFirstOrThrow()
          productId = row.id
        } else {
          productId = op.id
          if (Object.keys(op.patch).length) {
            const { attributes, variant_attributes: _variantAttributes, ...rest } = op.patch
            await tx
              .updateTable('products')
              .set({
                ...rest,
                ...(attributes !== undefined ? { attributes: jsonb(attributes) } : {}),
              })
              .where('tenant_id', '=', ctx.tenantId)
              .where('id', '=', op.id)
              .execute()
          }
        }
        if (op.barcodes.length) {
          await tx
            .insertInto('product_barcodes')
            .values(
              op.barcodes.map((b) => ({
                id: newId(),
                tenant_id: ctx.tenantId,
                product_id: productId,
                barcode: b,
                qty_milli: 1000,
              })),
            )
            .execute()
          if (op.kind === 'update' && Object.keys(op.patch).length === 0)
            await tx
              .updateTable('products')
              .set({ updated_at: sql<Date>`now()` })
              .where('tenant_id', '=', ctx.tenantId)
              .where('id', '=', productId)
              .execute()
        }
      })
      out.barcodesAdded += op.barcodes.length
      if (op.kind === 'insert') {
        out.created += 1
        if (op.isVariant) out.variantsCreated += 1
      } else {
        out.updated += 1
        const before: Record<string, unknown> = {}
        const after: Record<string, unknown> = {}
        for (const k of AUDITED_FIELDS) {
          if (op.patch[k] !== undefined) {
            before[k] = op.before[k]
            after[k] = op.patch[k]
          }
        }
        if (Object.keys(after).length && out.changes.length < MAX_AUDITED_CHANGES)
          out.changes.push({ id: op.id, before, after })
      }
    } catch (e) {
      out.failed.push(failure(op.line, e))
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

export const MAX_STORED_ERRORS = 1000
export const MAX_PREVIEW_ROWS = 50

export interface ImportResults {
  total_rows: number
  success_rows: number
  error_rows: number
  errors: ImportError[]
  errors_truncated: boolean
  summary: ImportSummary
  preview: ImportPreviewRow[]
}

/** Row counts, errors and preview from a plan (dry run) or a plan + apply outcome. */
export function importResults(plan: ImportPlan, outcome: ApplyOutcome | null): ImportResults {
  const actions = new Map(plan.actions)
  const errors = [...plan.errors]
  for (const f of outcome?.failed ?? []) {
    const a = actions.get(f.row)
    if (a) actions.set(f.row, { ...a, action: 'error' })
    errors.push(f)
  }
  errors.sort((a, b) => a.row - b.row)
  const counts = { create: 0, update: 0, unchanged: 0, skip: 0, error: 0 }
  for (const a of actions.values()) counts[a.action] += 1
  const preview = [...actions.values()].sort((a, b) => a.row - b.row).slice(0, MAX_PREVIEW_ROWS)
  const details: Record<string, number> = outcome
    ? {
        categories_created: outcome.categoriesCreated,
        brands_created: outcome.brandsCreated,
        barcodes_added: outcome.barcodesAdded,
        variants_created: outcome.variantsCreated,
      }
    : {
        categories_created: plan.newCategories.length,
        brands_created: plan.newBrands.length,
        barcodes_added: plan.ops.reduce((n, o) => n + o.barcodes.length, 0),
        variants_created: plan.ops.filter((o) => o.kind === 'insert' && o.isVariant).length,
      }
  return {
    total_rows: plan.totalRows,
    success_rows: plan.totalRows - counts.error,
    error_rows: counts.error,
    errors: errors.slice(0, MAX_STORED_ERRORS),
    errors_truncated: errors.length > MAX_STORED_ERRORS,
    summary: {
      created: counts.create,
      updated: counts.update,
      unchanged: counts.unchanged,
      skipped: counts.skip,
      details,
    },
    preview,
  }
}

/** Audit entry of a (non-dry-run) import. */
export async function auditImport(
  tx: Tx,
  ctx: Ctx,
  importId: string,
  filename: string,
  results: ImportResults,
  outcome: ApplyOutcome,
): Promise<void> {
  await audit(tx, ctx, {
    action: 'product.import',
    entity_type: 'import',
    entity_id: importId,
    summary: `${filename}: ${String(results.summary.created)} created, ${String(results.summary.updated)} updated, ${String(results.error_rows)} errors`,
    changes: { summary: results.summary, price_tax_changes: outcome.changes },
  })
}
