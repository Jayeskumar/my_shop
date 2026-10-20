/**
 * Contract for the identity module — docs/API.md "identity": members (users), roles &
 * permissions, stores, registers, trusted devices, tenant settings, business profile, number
 * series, audit log and files.
 *
 * It also hosts the small contract helpers the catalog / parties / inventory contracts share:
 * query-string field helpers, PATCH-safe nullable fields, the delete result, CSV helpers, the
 * generic `imports` job schema and the document → web route map (audit-log and ledger links).
 *
 * Conventions (ARCHITECTURE.md §7.3): snake_case JSON; responses in catalogue entries are full
 * envelopes (dataOf / listOf); validation messages of custom rules are snake_case keys (see
 * IDENTITY_VALIDATION_KEYS), translated by the web (errors:validation.* when the key exists
 * there, else the module namespace's validation.*).
 */
import { z } from 'zod'
import { MeTenantSchema, PasswordSchema, PinSchema } from './auth'
import {
  AddressSchema,
  PageQuerySchema,
  dataOf,
  defineRoutes,
  listOf,
  sortQuery,
  zBooleanQuery,
  zDateStr,
  zE164,
  zFy,
  zId,
  zPhone,
  zSearchQuery,
  zStateCode,
  zTimestamp,
} from './common'
import {
  BusinessTypeSchema,
  FilePurposeSchema,
  GstSchemeSchema,
  ImportKindSchema,
  ImportStatusSchema,
  LocaleSchema,
  MembershipStatusSchema,
  type NumberSeriesDocType,
  NumberSeriesDocTypeSchema,
  UserStatusSchema,
} from '../enums'
import { isValidGstin, isValidPan, panFromGstin } from '../gst'
import {
  PERMISSIONS,
  PERMISSION_GROUPS,
  PERMISSION_IMPLIES,
  type Permission,
  type PermissionGroup,
  PermissionSchema,
} from '../permissions'
import { normalizeIndianPhone } from '../phone'
import {
  PrintFormatSchema,
  RegisterSettingsSchema,
  TenantSettingsSchema,
  type TenantSettingsPatch,
} from '../settings'

// =============================================================================================
// Shared contract helpers (also imported by the catalog, parties and inventory contracts)
// =============================================================================================

/** Integer query-string parameter (coerced from the string Fastify parses). */
export function zQueryInt(min: number, max: number) {
  return z.coerce.number().int().min(min).max(max)
}

/**
 * List of ids in a query string: `?ids=a&ids=b` (repeated keys, what the web client sends for
 * arrays) or `?ids=a,b`. At most 500 ids.
 */
export const zQueryIds = z
  .union([z.string(), z.array(z.string())])
  .transform((v) =>
    (Array.isArray(v) ? v : [v])
      .flatMap((s) => s.split(','))
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(zId).max(500))

/** `store_id` filter that may also be 'all' (owners/managers with access to every store). */
export const zStoreScope = z
  .union([z.literal('all'), zId])
  .describe("A store id, or 'all' (aggregate over every store; requires access to all stores)")

/** Optimistic concurrency for PATCH bodies (ARCHITECTURE.md §7.3). */
export const zIfUpdatedAt = zTimestamp
  .optional()
  .describe('updated_at the client last saw; when it differs from the stored row → 409 STALE_WRITE')

/**
 * Optional, clearable text for create/PATCH bodies: missing → undefined (unchanged),
 * null or '' → null (cleared), else trimmed text of at most `max` characters.
 */
export function zNullableText(max: number) {
  return z
    .union([z.null(), z.string().trim().max(max)])
    .optional()
    .transform((v) => (v === '' ? null : v))
}

const EmailSchema = z.email().max(254)

/** Optional, clearable email (trimmed, lower-cased). */
export const zNullableEmail = z
  .union([z.null(), z.string().trim()])
  .optional()
  .refine((v) => v == null || v === '' || EmailSchema.safeParse(v).success, { message: 'email' })
  .transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v.toLowerCase()))

/**
 * Optional, clearable mobile number for create/PATCH bodies (common's zOptionalPhone turns a
 * missing value into null, which would clear the field on PATCH). '' / null → null.
 */
export const zNullablePhone = z
  .union([z.null(), z.string().trim()])
  .optional()
  .refine((v) => v == null || v === '' || normalizeIndianPhone(v) !== null, { message: 'phone' })
  .transform((v) =>
    v === undefined ? undefined : v === null || v === '' ? null : normalizeIndianPhone(v),
  )

/** Optional, clearable GSTIN for create/PATCH bodies (missing stays undefined). */
export const zNullableGstin = z
  .union([z.null(), z.string().trim().toUpperCase()])
  .optional()
  .refine((v) => v == null || v === '' || isValidGstin(v), { message: 'gstin' })
  .transform((v) => (v === '' ? null : v))

/** Optional, clearable PAN (upper-cased, AAAAA9999A). */
export const zNullablePan = z
  .union([z.null(), z.string().trim().toUpperCase()])
  .optional()
  .refine((v) => v == null || v === '' || isValidPan(v), { message: 'pan' })
  .transform((v) => (v === '' ? null : v))

/** Free-form tags: trimmed, lower-cased, de-duplicated; at most 20 of ≤ 30 characters. */
export const zTags = z
  .array(z.string().trim().min(1).max(30))
  .max(20)
  .transform((tags) => [...new Set(tags.map((t) => t.toLowerCase()))])

/** `?format=json|csv` on endpoints that can also stream a CSV (same filters). */
export const ExportFormatSchema = z.enum(['json', 'csv'])
export type ExportFormat = z.infer<typeof ExportFormatSchema>

/**
 * Result of DELETE on master records with history (products, customers, suppliers, doctors,
 * promotions): removed when never used, otherwise deactivated (is_active = false).
 */
export const DeleteResultSchema = z.object({
  id: zId,
  result: z.enum(['deleted', 'deactivated']),
})
export type DeleteResult = z.output<typeof DeleteResultSchema>

/** Validation issue key + path, as returned by the pure rule helpers of the contracts. */
export interface RuleIssue {
  path: string
  /** snake_case validation key (see the module's *_VALIDATION_KEYS). */
  code: string
}

// ---------------------------------------------------------------------------------------------
// CSV (imports, exports, CSV paste in grids)
// ---------------------------------------------------------------------------------------------

export type CsvValue = string | number | boolean | null | undefined

/** Text values that a spreadsheet would execute as a formula (CSV injection). */
const FORMULA_RE = /^[=+@\t\r]|^-[^0-9.]/

/**
 * One CSV line (RFC 4180, comma separated, no line terminator). Text that looks like a
 * spreadsheet formula is prefixed with `'` unless `guardFormulas` is false.
 */
export function toCsvRow(values: readonly CsvValue[], guardFormulas = true): string {
  return values
    .map((v) => {
      if (v === null || v === undefined) return ''
      let s = typeof v === 'string' ? v : String(v)
      if (guardFormulas && typeof v === 'string' && FORMULA_RE.test(s)) s = `'${s}`
      return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
    })
    .join(',')
}

/** A whole CSV document with CRLF line endings and a UTF-8 BOM (Excel opens Tamil correctly). */
export function toCsv(
  rows: readonly (readonly CsvValue[])[],
  opts: { bom?: boolean } = {},
): string {
  const body = rows.map((r) => toCsvRow(r)).join('\r\n')
  return `${opts.bom === false ? '' : '\uFEFF'}${body}\r\n`
}

/** Detects the delimiter of pasted/uploaded text from its first line: tab, then ';', else ','. */
export function detectCsvDelimiter(text: string): ',' | ';' | '\t' {
  const first = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? ''
  if (first.includes('\t')) return '\t'
  const semicolons = (first.match(/;/g) ?? []).length
  const commas = (first.match(/,/g) ?? []).length
  return semicolons > commas ? ';' : ','
}

/**
 * Parses CSV / TSV text (RFC 4180 quoting, CRLF or LF, BOM stripped). Returns the records as
 * arrays of cells; completely empty lines are skipped. `delimiter` defaults to auto-detection.
 */
export function parseCsv(text: string, delimiter?: ',' | ';' | '\t'): string[][] {
  const src = text.replace(/^\uFEFF/, '')
  const sep = delimiter ?? detectCsvDelimiter(src)
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let i = 0
  const pushRow = () => {
    row.push(cell)
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []
    cell = ''
  }
  while (i < src.length) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        quoted = false
        i += 1
        continue
      }
      cell += ch
      i += 1
      continue
    }
    if (ch === '"' && cell === '') {
      quoted = true
    } else if (ch === sep) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      pushRow()
      if (ch === '\r' && src[i + 1] === '\n') i += 1
    } else {
      cell += ch
    }
    i += 1
  }
  if (cell !== '' || row.length > 0) pushRow()
  return rows
}

/** Header cell → column key: trimmed, lower case, spaces / dashes → '_' ("GST Rate" → "gst_rate"). */
export function normalizeCsvHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[\s\-/]+/g, '_')
    .replace(/[^a-z0-9_:]/g, '')
}

export interface CsvTableRow {
  /** Line number in the file (the header is line 1). */
  line: number
  values: Record<string, string>
}

/** CSV text → normalised headers + rows keyed by header (cells trimmed; missing cells ''). */
export function parseCsvTable(
  text: string,
  delimiter?: ',' | ';' | '\t',
): { headers: string[]; rows: CsvTableRow[] } {
  const records = parseCsv(text, delimiter)
  const [head, ...body] = records
  if (!head) return { headers: [], rows: [] }
  const headers = head.map(normalizeCsvHeader)
  return {
    headers,
    rows: body.map((cells, index) => ({
      line: index + 2,
      values: Object.fromEntries(headers.map((h, j) => [h, (cells[j] ?? '').trim()])),
    })),
  }
}

// ---------------------------------------------------------------------------------------------
// Bulk imports (`imports` table) — products (catalog), customers (parties), …
// ---------------------------------------------------------------------------------------------

/** Rows above this are processed by a background job (status 'processing', poll GET /imports/:id). */
export const IMPORT_INLINE_MAX_ROWS = 1000
/** Hard cap on rows per file. */
export const IMPORT_MAX_ROWS = 50_000

export const ImportModeSchema = z.enum(['create_only', 'upsert'])
export type ImportMode = z.infer<typeof ImportModeSchema>

export const ImportErrorSchema = z.object({
  row: z.int().min(0).describe('Line number in the file (header = 1); 0 = the whole file'),
  field: z.string().nullable().default(null).describe('Column key, null for the whole row'),
  code: z.string().default('invalid').describe('Validation key, e.g. gst_rate_invalid'),
  message: z.string().describe('English detail for support / logs'),
})
export type ImportError = z.output<typeof ImportErrorSchema>

export const ImportSummarySchema = z.object({
  created: z.int().min(0).default(0),
  updated: z.int().min(0).default(0),
  unchanged: z.int().min(0).default(0),
  skipped: z.int().min(0).default(0),
  /** Kind-specific counters, e.g. { categories_created: 3, brands_created: 1 }. */
  details: z.record(z.string(), z.int()).default({}),
})
export type ImportSummary = z.output<typeof ImportSummarySchema>

export const ImportPreviewRowSchema = z.object({
  row: z.int().min(2),
  action: z.enum(['create', 'update', 'unchanged', 'skip', 'error']),
  /** Matching key (SKU / barcode / phone). */
  key: z.string().nullable(),
  name: z.string().nullable(),
})
export type ImportPreviewRow = z.output<typeof ImportPreviewRowSchema>

/** An `imports` row (dry runs included) as returned by POST …/import and GET /imports/:id. */
export const ImportJobSchema = z.object({
  id: zId,
  kind: ImportKindSchema,
  status: ImportStatusSchema,
  file_id: zId.nullable(),
  filename: z.string().nullable(),
  store_id: zId.nullable(),
  mode: ImportModeSchema,
  dry_run: z.boolean(),
  /** Request options as stored (imports.options) — kind specific. */
  options: z.record(z.string(), z.unknown()),
  total_rows: z.int().min(0),
  success_rows: z.int().min(0),
  error_rows: z.int().min(0),
  /** 0–10000 (basis points of rows processed) for job-based imports. */
  progress_bp: z.int().min(0).max(10_000),
  /** First 1000 errors; `errors_truncated` tells when there are more. */
  errors: z.array(ImportErrorSchema),
  errors_truncated: z.boolean(),
  summary: ImportSummarySchema,
  /** Up to 50 rows showing what the import does / did. */
  preview: z.array(ImportPreviewRowSchema),
  created_by: zId.nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
  finished_at: zTimestamp.nullable(),
})
export type ImportJob = z.output<typeof ImportJobSchema>

/** Common body of POST /products/import, /customers/import. */
export const ImportRequestBaseSchema = z.object({
  file_id: zId.describe('A file uploaded with POST /files?purpose=import (CSV or XLSX)'),
  mode: ImportModeSchema.default('upsert'),
  dry_run: z
    .boolean()
    .default(true)
    .describe('Validate and preview only; send false to write (default true)'),
})

/** Column of an import template (the template CSV header row is `key` in order). */
export interface ImportColumnDef {
  key: string
  required: boolean
  /** Value type, used for validation hints and the template example row. */
  type:
    'text' | 'money' | 'percent' | 'int' | 'qty' | 'boolean' | 'date' | 'enum' | 'list' | 'phone'
  enum_values?: readonly string[]
  example: string
  description_en: string
  description_ta: string
}

// ---------------------------------------------------------------------------------------------
// Document / entity links (audit log, ledgers, stock movements)
// ---------------------------------------------------------------------------------------------

/**
 * Web route of an entity / source document type (`audit_logs.entity_type`,
 * `stock_movements.ref_type`, `journal_entries.source_type`). `:id` is replaced.
 */
export const DOCUMENT_ROUTES: Readonly<Record<string, string>> = {
  sales_invoice: '/sales/invoices/:id',
  credit_note: '/sales/returns/:id',
  purchase_order: '/purchases/orders/:id',
  purchase_bill: '/purchases/bills/:id',
  debit_note: '/purchases/returns/:id',
  stock_adjustment: '/inventory/adjustments/:id',
  stock_transfer: '/inventory/transfers/:id',
  shift: '/accounting/shifts/:id',
  product: '/catalog/products/:id',
  customer: '/parties/customers/:id',
  supplier: '/parties/suppliers/:id',
}

/** Web path for an entity, or null when it has no detail page. */
export function documentPath(
  type: string | null | undefined,
  id: string | null | undefined,
): string | null {
  if (!type || !id) return null
  const template = DOCUMENT_ROUTES[type]
  return template ? template.replace(':id', encodeURIComponent(id)) : null
}

// =============================================================================================
// Validation keys used by this contract (custom rules only; generic min/max/required come from
// the web's zod error map)
// =============================================================================================

export const IDENTITY_VALIDATION_KEYS = [
  'phone',
  'gstin',
  'gstin_state',
  'gstin_unregistered',
  'gstin_required',
  'pan',
  'pan_gstin_mismatch',
  'pin',
  'email',
  'fssai',
  'store_code',
  'register_code',
  'role_code',
  'duplicate_permission',
  'password_required',
  'password_not_allowed',
  'series_prefix_chars',
  'series_too_long',
  'empty_patch',
  'store_ids_empty',
] as const
export type IdentityValidationKey = (typeof IDENTITY_VALIDATION_KEYS)[number]

const notEmpty = (v: Record<string, unknown>) =>
  Object.entries(v).some(([k, x]) => x !== undefined && k !== 'if_updated_at')

// =============================================================================================
// Users (members of the tenant)
// =============================================================================================

export const MemberSchema = z.object({
  id: zId.describe('User id (users.id); the :id of /users/:id'),
  membership_id: zId,
  full_name: z.string(),
  phone: zE164.nullable(),
  email: z.string().nullable(),
  preferred_locale: LocaleSchema,
  role_id: zId,
  role_code: z.string(),
  role_name: z.string(),
  role_name_ta: z.string().nullable(),
  /** The member holds the owner role. */
  is_owner: z.boolean(),
  /** null = all stores. */
  store_ids: z.array(zId).nullable(),
  /** Membership status: invited until the first sign-in, disabled by an admin. */
  status: MembershipStatusSchema,
  /** Global account status (users.status). */
  user_status: UserStatusSchema,
  has_pin: z.boolean(),
  pin_locked_until: zTimestamp.nullable(),
  last_login_at: zTimestamp.nullable(),
  invited_by: zId.nullable(),
  invited_by_name: z.string().nullable(),
  /** This member is the caller (the UI hides disable / role change on yourself). */
  is_self: z.boolean(),
  created_at: zTimestamp,
  /** memberships.updated_at — the value for if_updated_at. */
  updated_at: zTimestamp,
})
export type Member = z.output<typeof MemberSchema>

export const MemberListQuerySchema = PageQuerySchema.extend({
  q: zSearchQuery.optional().describe('Name or phone digits'),
  role_id: zId.optional(),
  status: MembershipStatusSchema.optional(),
  store_id: zId.optional().describe('Members with access to this store (incl. all-store members)'),
  sort: sortQuery(['full_name', 'last_login_at', 'created_at'] as const).prefault('full_name'),
})
export type MemberListQuery = z.input<typeof MemberListQuerySchema>

const StoreIdsSchema = z
  .array(zId)
  .max(500)
  .nullable()
  .refine((v) => v === null || v.length > 0, { message: 'store_ids_empty' })
  .describe('Stores the member may use; null = all stores')

/**
 * POST /users — invite by mobile number. An existing Kadai user gets a membership; otherwise a
 * user is created whose first sign-in is by temporary password (returned once), a password
 * chosen here, or OTP (needs SMS). Memberships start 'invited' until the first sign-in.
 */
export const MemberCreateSchema = z
  .object({
    phone: zPhone,
    full_name: z.string().trim().min(1).max(120),
    email: zNullableEmail,
    role_id: zId,
    store_ids: StoreIdsSchema.default(null),
    pin: PinSchema.optional().describe('Optional POS PIN (4–6 digits) for quick switch'),
    first_login: z
      .enum(['temporary_password', 'password', 'otp'])
      .default('temporary_password')
      .describe(
        'New users only: temporary_password = generated and returned once (works offline); ' +
          'password = the `password` given here; otp = sign in with an SMS OTP',
      ),
    password: PasswordSchema.optional(),
    preferred_locale: LocaleSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.first_login === 'password' && !v.password)
      ctx.addIssue({ code: 'custom', path: ['password'], message: 'password_required' })
    if (v.first_login !== 'password' && v.password)
      ctx.addIssue({ code: 'custom', path: ['password'], message: 'password_not_allowed' })
  })
export type MemberCreate = z.input<typeof MemberCreateSchema>

export const MemberCreateResultSchema = z.object({
  member: MemberSchema,
  /** The phone already belonged to a Kadai user (no new account, no password). */
  existing_user: z.boolean(),
  /** Shown ONCE (first_login 'temporary_password' for a new user); never retrievable later. */
  temporary_password: z.string().nullable(),
  otp_sent: z.boolean(),
})
export type MemberCreateResult = z.output<typeof MemberCreateResultSchema>

/** PATCH /users/:id */
export const MemberUpdateSchema = z
  .object({
    full_name: z.string().trim().min(1).max(120).optional(),
    email: zNullableEmail,
    role_id: zId.optional(),
    store_ids: StoreIdsSchema.optional(),
    preferred_locale: LocaleSchema.optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .refine(notEmpty, { message: 'empty_patch' })
export type MemberUpdate = z.input<typeof MemberUpdateSchema>

/** POST /users/:id/disable — also revokes the member's sessions for this business. */
export const MemberDisableSchema = z.object({ reason: zNullableText(200) })
export type MemberDisable = z.input<typeof MemberDisableSchema>

/** POST /users/:id/reset-pin — sets (or with null removes) the POS PIN and clears a PIN lock. */
export const ResetPinSchema = z.object({ pin: PinSchema.nullable() })
export type ResetPin = z.input<typeof ResetPinSchema>

/** POST /users/:id/reset-password — admin reset (no SMS needed on-prem). */
export const ResetPasswordSchema = z.object({
  password: PasswordSchema.optional().describe('New password; omitted = generate a temporary one'),
})
export type ResetPassword = z.input<typeof ResetPasswordSchema>

export const ResetPasswordResultSchema = z.object({
  /** Generated password, shown once (null when the admin chose the password). */
  temporary_password: z.string().nullable(),
  sessions_revoked: z.int().min(0),
})
export type ResetPasswordResult = z.output<typeof ResetPasswordResultSchema>

// =============================================================================================
// Roles & permissions
// =============================================================================================

export const RoleSchema = z.object({
  id: zId,
  code: z.string(),
  name: z.string(),
  name_ta: z.string().nullable(),
  description: z.string().nullable(),
  /** Stored codes (may contain '*' / 'group.*' for system roles). */
  permissions: z.array(z.string()),
  /** Expanded effective permissions (wildcards and implications applied). */
  effective_permissions: z.array(PermissionSchema),
  is_system: z.boolean(),
  /** Custom roles are editable (feature custom_roles); system roles' permissions are fixed. */
  editable: z.boolean(),
  member_count: z.int().min(0),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type Role = z.output<typeof RoleSchema>

export const RoleListQuerySchema = PageQuerySchema.extend({
  q: zSearchQuery.optional(),
  is_system: zBooleanQuery.optional(),
})
export type RoleListQuery = z.input<typeof RoleListQuerySchema>

const RolePermissionsSchema = z
  .array(PermissionSchema)
  .min(1)
  .max(Object.keys(PERMISSIONS).length)
  .refine((v) => new Set(v).size === v.length, { message: 'duplicate_permission' })

/** POST /roles (feature custom_roles). */
export const RoleCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  name_ta: zNullableText(60),
  description: zNullableText(300),
  permissions: RolePermissionsSchema,
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_]{1,39}$/, 'role_code')
    .optional()
    .describe('Defaults to a slug of the name; system role codes are reserved'),
})
export type RoleCreate = z.input<typeof RoleCreateSchema>

/** PATCH /roles/:id — system roles accept name/name_ta/description only (permissions → 409). */
export const RoleUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    name_ta: zNullableText(60),
    description: zNullableText(300),
    permissions: RolePermissionsSchema.optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .refine(notEmpty, { message: 'empty_patch' })
export type RoleUpdate = z.input<typeof RoleUpdateSchema>

export const PermissionEntrySchema = z.object({
  code: PermissionSchema,
  label_en: z.string(),
  label_ta: z.string(),
  /** Permissions granted along with this one (e.g. catalog.write → catalog.read). */
  implies: z.array(PermissionSchema),
})
export const PermissionGroupEntrySchema = z.object({
  code: z.string(),
  label_en: z.string(),
  label_ta: z.string(),
  permissions: z.array(PermissionEntrySchema),
})
export const PermissionCatalogSchema = z.object({ groups: z.array(PermissionGroupEntrySchema) })
export type PermissionCatalog = z.output<typeof PermissionCatalogSchema>

/** The GET /permissions payload, built from the shared catalogue (identical on both sides). */
export function permissionCatalog(): PermissionCatalog {
  const groups = Object.entries(PERMISSION_GROUPS) as Array<
    [PermissionGroup, { label_en: string; label_ta: string }]
  >
  return {
    groups: groups
      .map(([code, g]) => ({
        code,
        label_en: g.label_en,
        label_ta: g.label_ta,
        permissions: (
          Object.entries(PERMISSIONS) as Array<[Permission, (typeof PERMISSIONS)[Permission]]>
        )
          .filter(([, def]) => def.group === code)
          .map(([perm, def]) => ({
            code: perm,
            label_en: def.label_en,
            label_ta: def.label_ta,
            implies: [...(PERMISSION_IMPLIES[perm] ?? [])],
          })),
      }))
      .filter((g) => g.permissions.length > 0),
  }
}

// =============================================================================================
// Stores, registers, devices
// =============================================================================================

const StoreCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{1,4}$/, 'store_code')
  .describe('1–4 characters A-Z 0-9, unique; part of document numbers (S1/2627/00001)')

const FssaiSchema = z
  .union([z.null(), z.string().trim()])
  .optional()
  .refine((v) => v == null || v === '' || /^\d{14}$/.test(v), { message: 'fssai' })
  .transform((v) => (v === '' ? null : v))

export const StoreSchema = z.object({
  id: zId,
  code: z.string(),
  name: z.string(),
  name_ta: z.string().nullable(),
  gstin: z.string().nullable(),
  state_code: z.string(),
  address: AddressSchema,
  phone: z.string().nullable(),
  email: z.string().nullable(),
  /** Pharmacy: drug licence numbers (Form 20/21) printed on invoices. */
  drug_license_numbers: z.string().nullable(),
  fssai_number: z.string().nullable(),
  is_active: z.boolean(),
  register_count: z.int().min(0),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type Store = z.output<typeof StoreSchema>

export const StoreListQuerySchema = PageQuerySchema.extend({
  q: zSearchQuery.optional(),
  is_active: zBooleanQuery.optional(),
})
export type StoreListQuery = z.input<typeof StoreListQuerySchema>

function refineGstinState(
  v: { gstin?: string | null; state_code?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (v.gstin && v.state_code && v.gstin.slice(0, 2) !== v.state_code)
    ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'gstin_state' })
}

/** POST /stores (plan limit `stores`; a second store needs feature multi_store). */
export const StoreCreateSchema = z
  .object({
    code: StoreCodeSchema,
    name: z.string().trim().min(1).max(200),
    name_ta: zNullableText(200),
    gstin: zNullableGstin.describe(
      'Optional store GSTIN; its first two digits must equal state_code',
    ),
    state_code: zStateCode,
    address: AddressSchema.prefault({}),
    phone: zNullablePhone,
    email: zNullableEmail,
    drug_license_numbers: zNullableText(200),
    fssai_number: FssaiSchema,
  })
  .superRefine(refineGstinState)
export type StoreCreate = z.input<typeof StoreCreateSchema>

/**
 * PATCH /stores/:id — `code` can change only while the store has no number series (409);
 * deactivating the last active store → 409.
 */
export const StoreUpdateSchema = z
  .object({
    code: StoreCodeSchema.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    name_ta: zNullableText(200),
    gstin: zNullableGstin,
    state_code: zStateCode.optional(),
    address: AddressSchema.optional(),
    phone: zNullablePhone,
    email: zNullableEmail,
    drug_license_numbers: zNullableText(200),
    fssai_number: FssaiSchema,
    is_active: z.boolean().optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .superRefine(refineGstinState)
  .refine(notEmpty, { message: 'empty_patch' })
export type StoreUpdate = z.input<typeof StoreUpdateSchema>

const RegisterCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{1,2}$/, 'register_code')
  .describe('1–2 characters A-Z 0-9, unique per store; part of POS invoice numbers (S1-A/…)')

export const RegisterSchema = z.object({
  id: zId,
  store_id: zId,
  store_code: z.string(),
  store_name: z.string(),
  code: z.string(),
  name: z.string(),
  is_active: z.boolean(),
  settings: RegisterSettingsSchema,
  last_seen_at: zTimestamp.nullable(),
  /** Active trusted devices bound to this register. */
  device_count: z.int().min(0),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type Register = z.output<typeof RegisterSchema>

export const RegisterListQuerySchema = PageQuerySchema.extend({
  store_id: zId.optional(),
  is_active: zBooleanQuery.optional(),
})
export type RegisterListQuery = z.input<typeof RegisterListQuerySchema>

/** POST /registers (plan limit `registers`). */
export const RegisterCreateSchema = z.object({
  store_id: zId,
  code: RegisterCodeSchema,
  name: z.string().trim().min(1).max(60),
  settings: RegisterSettingsSchema.prefault({}),
})
export type RegisterCreate = z.input<typeof RegisterCreateSchema>

/** Partial register settings without defaults (PATCH merges into the stored settings). */
export const RegisterSettingsPatchSchema = z.object({
  print_format: PrintFormatSchema.nullable().optional(),
  auto_print: z.boolean().optional(),
  customer_display: z.boolean().optional(),
  cash_drawer: z.boolean().optional(),
  printer_name: z.string().trim().max(100).nullable().optional(),
})

/** PATCH /registers/:id */
export const RegisterUpdateSchema = z
  .object({
    code: RegisterCodeSchema.optional(),
    name: z.string().trim().min(1).max(60).optional(),
    is_active: z.boolean().optional(),
    settings: RegisterSettingsPatchSchema.optional(),
    if_updated_at: zIfUpdatedAt,
  })
  .refine(notEmpty, { message: 'empty_patch' })
export type RegisterUpdate = z.input<typeof RegisterUpdateSchema>

export const DeviceStatusSchema = z.enum(['active', 'revoked'])
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>

/** A trusted counter device. The secret hash is never exposed. */
export const DeviceSchema = z.object({
  id: zId,
  name: z.string(),
  store_id: zId,
  store_code: z.string(),
  store_name: z.string(),
  register_id: zId.nullable(),
  register_code: z.string().nullable(),
  register_name: z.string().nullable(),
  user_agent: z.string().nullable(),
  status: DeviceStatusSchema,
  approved_by: zId.nullable(),
  approved_by_name: z.string().nullable(),
  last_seen_at: zTimestamp.nullable(),
  revoked_at: zTimestamp.nullable(),
  created_at: zTimestamp,
  updated_at: zTimestamp,
})
export type Device = z.output<typeof DeviceSchema>

export const DeviceListQuerySchema = PageQuerySchema.extend({
  store_id: zId.optional(),
  register_id: zId.optional(),
  status: z.enum(['active', 'revoked', 'all']).default('active'),
})
export type DeviceListQuery = z.input<typeof DeviceListQuerySchema>

/** POST /devices — "Register this computer as a counter". */
export const DeviceCreateSchema = z.object({
  name: z.string().trim().min(1).max(60).describe('e.g. "Counter 1 PC"'),
  store_id: zId,
  register_id: zId.nullable().default(null).describe('Binds PIN sessions and offline numbering'),
})
export type DeviceCreate = z.input<typeof DeviceCreateSchema>

export const DeviceCreateResultSchema = z.object({
  device: DeviceSchema,
  /**
   * Shown ONCE: the web stores it with saveDeviceCredentials({device_id, device_secret,
   * tenant_id, store_id, register_id, name, registered_at}); only its hash is kept.
   */
  device_secret: z.string().min(16),
})
export type DeviceCreateResult = z.output<typeof DeviceCreateResultSchema>

/** POST /devices/:id/revoke — also revokes every session bound to the device. */
export const DeviceRevokeSchema = z.object({ reason: zNullableText(200) })
export type DeviceRevoke = z.input<typeof DeviceRevokeSchema>

// =============================================================================================
// Settings & business profile
// =============================================================================================

/** GET/PATCH /settings response: tenant profile (as in /me) + full settings with defaults. */
export const SettingsResponseSchema = z.object({
  tenant: MeTenantSchema,
  settings: TenantSettingsSchema,
})
export type SettingsResponse = z.output<typeof SettingsResponseSchema>

/** Deep-partial schema WITHOUT defaults that rejects unknown keys (strict objects). */
function strictPatchOf(schema: z.ZodType): z.ZodType {
  let inner: z.ZodType = schema
  while (inner instanceof z.ZodDefault || inner instanceof z.ZodPrefault)
    inner = inner.unwrap() as z.ZodType
  if (inner instanceof z.ZodObject) {
    const shape = inner.shape as Record<string, z.ZodType>
    return z.strictObject(
      Object.fromEntries(
        Object.entries(shape).map(([key, field]) => [key, strictPatchOf(field).optional()]),
      ),
    )
  }
  return inner
}

/**
 * PATCH /settings body: any subset of sections/fields (arrays replace), unknown keys rejected,
 * nothing defaulted. The server deep-merges (mergeSettings), validates the result in full and
 * audits the changed paths.
 */
export const SettingsPatchSchema = (
  strictPatchOf(TenantSettingsSchema) as z.ZodType<TenantSettingsPatch>
).refine((v) => Object.keys(v as object).length > 0, { message: 'empty_patch' })
export type SettingsPatch = TenantSettingsPatch

export const BusinessProfileSchema = z.object({
  name: z.string(),
  name_ta: z.string().nullable(),
  legal_name: z.string().nullable(),
  business_type: BusinessTypeSchema,
  gst_scheme: GstSchemeSchema,
  gstin: z.string().nullable(),
  pan: z.string().nullable(),
  state_code: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: AddressSchema,
  logo_file_id: zId.nullable(),
  default_locale: LocaleSchema,
  timezone: z.string(),
  fy_start_month: z.int().min(1).max(12),
  current_fy: zFy,
  /** Invoices exist in the current FY: changing gst_scheme needs confirm_gst_scheme_change. */
  gst_scheme_change_requires_confirm: z.boolean(),
  updated_at: zTimestamp,
})
export type BusinessProfile = z.output<typeof BusinessProfileSchema>

/**
 * PATCH /settings/business. Cross-field rules are checked against the body here and against
 * the stored profile on the server (e.g. a new GSTIN vs the stored state_code).
 */
export const BusinessProfileUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    name_ta: zNullableText(200),
    legal_name: zNullableText(200),
    gstin: zNullableGstin,
    pan: zNullablePan,
    gst_scheme: GstSchemeSchema.optional(),
    state_code: zStateCode.optional(),
    phone: zNullablePhone,
    email: zNullableEmail,
    address: AddressSchema.optional(),
    logo_file_id: zId.nullable().optional().describe('A file uploaded with purpose logo'),
    default_locale: LocaleSchema.optional(),
    confirm_gst_scheme_change: z
      .boolean()
      .default(false)
      .describe('Required to change gst_scheme when invoices exist in the current FY (audited)'),
    if_updated_at: zIfUpdatedAt,
  })
  .superRefine((v, ctx) => {
    refineGstinState(v, ctx)
    if (v.gst_scheme === 'unregistered' && v.gstin)
      ctx.addIssue({ code: 'custom', path: ['gst_scheme'], message: 'gstin_unregistered' })
    if ((v.gst_scheme === 'regular' || v.gst_scheme === 'composition') && v.gstin === null)
      ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'gstin_required' })
    if (v.gstin && v.pan && panFromGstin(v.gstin) !== v.pan)
      ctx.addIssue({ code: 'custom', path: ['pan'], message: 'pan_gstin_mismatch' })
  })
  .refine(
    (v) =>
      Object.entries(v).some(
        ([k, x]) => x !== undefined && k !== 'if_updated_at' && k !== 'confirm_gst_scheme_change',
      ),
    { message: 'empty_patch' },
  )
export type BusinessProfileUpdate = z.input<typeof BusinessProfileUpdateSchema>

// =============================================================================================
// Number series
// =============================================================================================

/** GST rule 46: numbers of documents issued under GST are at most 16 characters. */
export const SERIES_MAX_LENGTH_GST = 16
/** Internal documents (estimates, orders, GRNs, adjustments, expenses, journals). */
export const SERIES_MAX_LENGTH_INTERNAL = 32
/** Characters allowed in a document number (and its prefix). */
export const SERIES_CHARS_RE = /^[A-Z0-9/-]+$/

/** Document types bound by the 16-character GST limit (mirrors core/numbering.ts). */
export const GST_SERIES_DOC_TYPES: readonly NumberSeriesDocType[] = [
  'sales_invoice',
  'bill_of_supply',
  'credit_note',
  'debit_note',
  'receipt',
  'payment_voucher',
  'stock_transfer',
]

/** Document types that have per-register (POS) series. */
export const REGISTER_SERIES_DOC_TYPES: readonly NumberSeriesDocType[] = [
  'sales_invoice',
  'bill_of_supply',
]

export function seriesMaxLength(docType: NumberSeriesDocType): number {
  return GST_SERIES_DOC_TYPES.includes(docType) ? SERIES_MAX_LENGTH_GST : SERIES_MAX_LENGTH_INTERNAL
}

/** prefix + zero-padded sequence: ('S1/2627/', 42, 5) → 'S1/2627/00042'. */
export function formatSeriesNumber(prefix: string, seq: number, padding: number): string {
  return `${prefix}${String(seq).padStart(padding, '0')}`
}

/**
 * Format problems of a series (live check in the editor, enforced again by the server):
 * prefix characters and the maximum number length for the doc type at `next_number`.
 */
export function seriesFormatIssues(input: {
  doc_type: NumberSeriesDocType
  prefix: string
  padding: number
  next_number: number
}): RuleIssue[] {
  const issues: RuleIssue[] = []
  if (input.prefix !== '' && !SERIES_CHARS_RE.test(input.prefix))
    issues.push({ path: 'prefix', code: 'series_prefix_chars' })
  const sample = formatSeriesNumber(input.prefix, input.next_number, input.padding)
  if (sample.length > seriesMaxLength(input.doc_type))
    issues.push({ path: 'prefix', code: 'series_too_long' })
  return issues
}

export const NumberSeriesSchema = z.object({
  /** null = not used yet in this FY (shown with its default prefix; customise with POST). */
  id: zId.nullable(),
  /** Stable key `${store_id}:${register_id ?? '-'}:${doc_type}:${fy}`. */
  key: z.string(),
  store_id: zId,
  store_code: z.string(),
  register_id: zId.nullable(),
  register_code: z.string().nullable(),
  doc_type: NumberSeriesDocTypeSchema,
  fy: zFy,
  prefix: z.string(),
  padding: z.int().min(1).max(10),
  next_number: z.int().min(1),
  /** The number the next document will get, e.g. 'S1-A/2627/00042'. */
  next: z.string(),
  /** Documents already numbered in this series (next_number − 1). */
  issued_count: z.int().min(0),
  max_length: z.int(),
  is_gst_document: z.boolean(),
  updated_at: zTimestamp.nullable(),
})
export type NumberSeries = z.output<typeof NumberSeriesSchema>

export const NumberSeriesListQuerySchema = z.object({
  fy: zFy.optional().describe('Default: the current financial year'),
  store_id: zId.optional(),
  doc_type: NumberSeriesDocTypeSchema.optional(),
})
export type NumberSeriesListQuery = z.input<typeof NumberSeriesListQuerySchema>

const SeriesPrefixSchema = z
  .string()
  .trim()
  .toUpperCase()
  .max(28)
  .refine((v) => v === '' || SERIES_CHARS_RE.test(v), { message: 'series_prefix_chars' })

/** POST /number-series — customise a series before its first document (e.g. continue numbering). */
export const NumberSeriesCreateSchema = z.object({
  store_id: zId,
  register_id: zId
    .nullable()
    .default(null)
    .describe('Only for sales_invoice / bill_of_supply POS series'),
  doc_type: NumberSeriesDocTypeSchema,
  fy: zFy,
  prefix: SeriesPrefixSchema.optional().describe('Default: the standard template for the doc type'),
  padding: z.int().min(1).max(10).optional(),
  next_number: z.int().min(1).max(9_999_999_999).default(1),
})
export type NumberSeriesCreate = z.input<typeof NumberSeriesCreateSchema>

/**
 * PATCH /number-series/:id — next_number may only increase; the prefix of a series that already
 * issued documents changes only with `force` (audited).
 */
export const NumberSeriesUpdateSchema = z
  .object({
    prefix: SeriesPrefixSchema.optional(),
    padding: z.int().min(1).max(10).optional(),
    next_number: z.int().min(1).max(9_999_999_999).optional(),
    force: z.boolean().default(false),
    if_updated_at: zIfUpdatedAt,
  })
  .refine((v) => v.prefix !== undefined || v.padding !== undefined || v.next_number !== undefined, {
    message: 'empty_patch',
  })
export type NumberSeriesUpdate = z.input<typeof NumberSeriesUpdateSchema>

// =============================================================================================
// Audit log
// =============================================================================================

export const AuditLogSchema = z.object({
  id: z.int(),
  user_id: zId.nullable(),
  user_name: z.string().nullable(),
  action: z.string(),
  entity_type: z.string().nullable(),
  entity_id: zId.nullable(),
  summary: z.string().nullable(),
  /** {before, after} of changed fields (secrets masked) or action-specific details. */
  changes: z.unknown().nullable(),
  ip: z.string().nullable(),
  user_agent: z.string().nullable(),
  request_id: z.string().nullable(),
  created_at: zTimestamp,
})
export type AuditLog = z.output<typeof AuditLogSchema>

export const AuditLogListQuerySchema = PageQuerySchema.extend({
  user_id: zId.optional(),
  action: z
    .string()
    .trim()
    .regex(/^[a-z0-9_.]{1,80}$/)
    .optional()
    .describe("Action prefix: 'product' matches product.create, product.update, …"),
  entity_type: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{1,60}$/)
    .optional(),
  entity_id: zId.optional(),
  from: zDateStr.optional(),
  to: zDateStr.optional(),
}).refine((r) => !r.from || !r.to || r.from <= r.to, { message: 'date_order', path: ['to'] })
export type AuditLogListQuery = z.input<typeof AuditLogListQuerySchema>

// =============================================================================================
// Files
// =============================================================================================

/** Purposes clients may upload ('export' files are produced by the server). */
export const UploadPurposeSchema = FilePurposeSchema.exclude(['export'])
export type UploadPurpose = z.infer<typeof UploadPurposeSchema>

const MB = 1024 * 1024
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
const SHEET_TYPES = [
  'text/csv',
  'text/plain',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const

export interface UploadRule {
  max_bytes: number
  content_types: readonly string[]
  /** Value for <input type="file" accept>. */
  accept: string
}

/**
 * Upload limits per purpose enforced by POST /files (stricter than the storage layer's
 * FILE_RULES); the web checks them before uploading.
 */
export const FILE_UPLOAD_RULES: Readonly<Record<UploadPurpose, UploadRule>> = {
  logo: {
    max_bytes: 2 * MB,
    content_types: IMAGE_TYPES,
    accept: 'image/png,image/jpeg,image/webp',
  },
  product_image: {
    max_bytes: 2 * MB,
    content_types: IMAGE_TYPES,
    accept: 'image/png,image/jpeg,image/webp',
  },
  prescription: {
    max_bytes: 5 * MB,
    content_types: [...IMAGE_TYPES, 'application/pdf'],
    accept: 'image/png,image/jpeg,image/webp,application/pdf',
  },
  import: { max_bytes: 10 * MB, content_types: SHEET_TYPES, accept: '.csv,.xlsx,text/csv' },
  attachment: {
    max_bytes: 10 * MB,
    content_types: [...IMAGE_TYPES, 'application/pdf'],
    accept: 'image/png,image/jpeg,image/webp,application/pdf',
  },
}

/** Client/server pre-check: 'file_empty' | 'file_type' | 'file_too_large' | null (ok). */
export function fileUploadIssue(
  purpose: UploadPurpose,
  file: { size: number; type: string },
): 'file_empty' | 'file_type' | 'file_too_large' | null {
  const rule = FILE_UPLOAD_RULES[purpose]
  const type = file.type.split(';')[0]!.trim().toLowerCase()
  if (file.size <= 0) return 'file_empty'
  if (!rule.content_types.includes(type)) return 'file_type'
  if (file.size > rule.max_bytes) return 'file_too_large'
  return null
}

export const FileSchema = z.object({
  id: zId,
  purpose: FilePurposeSchema,
  filename: z.string(),
  content_type: z.string(),
  size_bytes: z.int().min(0),
  checksum_sha256: z.string(),
  created_by: zId.nullable(),
  created_at: zTimestamp,
  /**
   * Path of the content relative to /api/v1 ('/files/<id>/content'). It needs the bearer token:
   * the web fetches it as a blob (object URL); responses are immutable and privately cacheable.
   */
  content_path: z.string(),
})
export type FileMeta = z.output<typeof FileSchema>

/** POST /files?purpose= (multipart/form-data with one `file` part). */
export const FileUploadQuerySchema = z.object({ purpose: UploadPurposeSchema })
export type FileUploadQuery = z.input<typeof FileUploadQuerySchema>

/** GET /files/:id/content — `download=true` → Content-Disposition attachment. */
export const FileContentQuerySchema = z.object({ download: zBooleanQuery.optional() })

// =============================================================================================
// Route catalogue (docs/API.md "identity")
// =============================================================================================

const UserIdParams = z.object({ id: zId.describe('User id') })
const IdParams = z.object({ id: zId })

export const identityRoutes = defineRoutes({
  // ---- users ---------------------------------------------------------------------------------
  listUsers: {
    method: 'GET',
    path: '/users',
    permission: 'users.manage',
    query: MemberListQuerySchema,
    response: listOf(MemberSchema),
    summary: 'Members of the business with role, stores, status and last sign-in',
  },
  createUser: {
    method: 'POST',
    path: '/users',
    permission: 'users.manage',
    idempotent: true,
    body: MemberCreateSchema,
    response: dataOf(MemberCreateResultSchema),
    status: 201,
    summary: 'Invite a member by mobile number (plan limit users)',
  },
  getUser: {
    method: 'GET',
    path: '/users/:id',
    permission: 'users.manage',
    params: UserIdParams,
    response: dataOf(MemberSchema),
  },
  updateUser: {
    method: 'PATCH',
    path: '/users/:id',
    permission: 'users.manage',
    params: UserIdParams,
    body: MemberUpdateSchema,
    response: dataOf(MemberSchema),
    summary: 'Change name, role or store access (cannot demote the last owner)',
  },
  disableUser: {
    method: 'POST',
    path: '/users/:id/disable',
    permission: 'users.manage',
    params: UserIdParams,
    body: MemberDisableSchema.prefault({}),
    response: dataOf(MemberSchema),
    summary: 'Disable a member and revoke their sessions (not yourself, not the last owner)',
  },
  enableUser: {
    method: 'POST',
    path: '/users/:id/enable',
    permission: 'users.manage',
    params: UserIdParams,
    response: dataOf(MemberSchema),
  },
  resetUserPin: {
    method: 'POST',
    path: '/users/:id/reset-pin',
    permission: 'users.manage',
    params: UserIdParams,
    body: ResetPinSchema,
    response: dataOf(MemberSchema),
    summary: 'Set or remove the POS PIN and clear a PIN lock',
  },
  resetUserPassword: {
    method: 'POST',
    path: '/users/:id/reset-password',
    permission: 'users.manage',
    params: UserIdParams,
    body: ResetPasswordSchema.prefault({}),
    response: dataOf(ResetPasswordResultSchema),
    summary: "Admin password reset (revokes the member's sessions; not for yourself)",
  },

  // ---- roles & permissions -------------------------------------------------------------------
  listRoles: {
    method: 'GET',
    path: '/roles',
    permission: 'users.manage',
    query: RoleListQuerySchema,
    response: listOf(RoleSchema),
  },
  createRole: {
    method: 'POST',
    path: '/roles',
    permission: 'users.manage',
    feature: 'custom_roles',
    body: RoleCreateSchema,
    response: dataOf(RoleSchema),
    status: 201,
  },
  getRole: {
    method: 'GET',
    path: '/roles/:id',
    permission: 'users.manage',
    params: IdParams,
    response: dataOf(RoleSchema),
  },
  updateRole: {
    method: 'PATCH',
    path: '/roles/:id',
    permission: 'users.manage',
    params: IdParams,
    body: RoleUpdateSchema,
    response: dataOf(RoleSchema),
    summary: 'Rename a role or edit a custom role (feature custom_roles checked for custom roles)',
  },
  deleteRole: {
    method: 'DELETE',
    path: '/roles/:id',
    permission: 'users.manage',
    params: IdParams,
    summary: 'Delete a custom role (409 when system or assigned to members)',
  },
  listPermissions: {
    method: 'GET',
    path: '/permissions',
    permission: 'users.manage',
    response: dataOf(PermissionCatalogSchema),
    summary: 'Permission catalogue grouped by area with Tamil/English labels',
  },

  // ---- stores, registers, devices ------------------------------------------------------------
  listStores: {
    method: 'GET',
    path: '/stores',
    query: StoreListQuerySchema,
    response: listOf(StoreSchema),
    summary: 'All stores of the business (any member: store pickers, transfer destinations)',
  },
  createStore: {
    method: 'POST',
    path: '/stores',
    permission: 'settings.manage',
    body: StoreCreateSchema,
    response: dataOf(StoreSchema),
    status: 201,
    summary: 'Add a store (plan limit stores; more than one needs multi_store)',
  },
  getStore: {
    method: 'GET',
    path: '/stores/:id',
    params: IdParams,
    response: dataOf(StoreSchema),
  },
  updateStore: {
    method: 'PATCH',
    path: '/stores/:id',
    permission: 'settings.manage',
    params: IdParams,
    body: StoreUpdateSchema,
    response: dataOf(StoreSchema),
  },
  listRegisters: {
    method: 'GET',
    path: '/registers',
    permission: 'settings.manage',
    query: RegisterListQuerySchema,
    response: listOf(RegisterSchema),
  },
  createRegister: {
    method: 'POST',
    path: '/registers',
    permission: 'settings.manage',
    body: RegisterCreateSchema,
    response: dataOf(RegisterSchema),
    status: 201,
    summary: 'Add a billing counter (plan limit registers)',
  },
  getRegister: {
    method: 'GET',
    path: '/registers/:id',
    permission: 'settings.manage',
    params: IdParams,
    response: dataOf(RegisterSchema),
  },
  updateRegister: {
    method: 'PATCH',
    path: '/registers/:id',
    permission: 'settings.manage',
    params: IdParams,
    body: RegisterUpdateSchema,
    response: dataOf(RegisterSchema),
  },
  listDevices: {
    method: 'GET',
    path: '/devices',
    permission: 'settings.manage',
    query: DeviceListQuerySchema,
    response: listOf(DeviceSchema),
  },
  createDevice: {
    method: 'POST',
    path: '/devices',
    permission: 'settings.manage',
    body: DeviceCreateSchema,
    response: dataOf(DeviceCreateResultSchema),
    status: 201,
    summary: 'Trust this computer as a counter; returns device_secret once',
  },
  revokeDevice: {
    method: 'POST',
    path: '/devices/:id/revoke',
    permission: 'settings.manage',
    params: IdParams,
    body: DeviceRevokeSchema.prefault({}),
    response: dataOf(DeviceSchema),
    summary: 'Revoke a device and every session bound to it',
  },

  // ---- settings ------------------------------------------------------------------------------
  getSettings: {
    method: 'GET',
    path: '/settings',
    response: dataOf(SettingsResponseSchema),
    summary: 'Tenant profile and typed settings (defaults filled); any member',
  },
  updateSettings: {
    method: 'PATCH',
    path: '/settings',
    permission: 'settings.manage',
    body: SettingsPatchSchema,
    response: dataOf(SettingsResponseSchema),
    summary: 'Deep-partial settings update (unknown keys rejected; audited diff)',
  },
  getBusinessProfile: {
    method: 'GET',
    path: '/settings/business',
    permission: 'settings.manage',
    response: dataOf(BusinessProfileSchema),
  },
  updateBusinessProfile: {
    method: 'PATCH',
    path: '/settings/business',
    permission: 'settings.manage',
    body: BusinessProfileUpdateSchema,
    response: dataOf(BusinessProfileSchema),
    summary: 'Business name, GSTIN, PAN, scheme, address, logo (audited)',
  },

  // ---- number series -------------------------------------------------------------------------
  listNumberSeries: {
    method: 'GET',
    path: '/number-series',
    permission: 'settings.manage',
    query: NumberSeriesListQuerySchema,
    response: dataOf(z.array(NumberSeriesSchema)),
    summary: 'Every series of a FY (unused ones with id null and their default prefix)',
  },
  createNumberSeries: {
    method: 'POST',
    path: '/number-series',
    permission: 'settings.manage',
    body: NumberSeriesCreateSchema,
    response: dataOf(NumberSeriesSchema),
    status: 201,
    summary: 'Customise a series before its first document (409 when it exists)',
  },
  updateNumberSeries: {
    method: 'PATCH',
    path: '/number-series/:id',
    permission: 'settings.manage',
    params: IdParams,
    body: NumberSeriesUpdateSchema,
    response: dataOf(NumberSeriesSchema),
  },

  // ---- audit log -----------------------------------------------------------------------------
  listAuditLogs: {
    method: 'GET',
    path: '/audit-logs',
    permission: 'audit.read',
    feature: 'audit_log',
    query: AuditLogListQuerySchema,
    response: listOf(AuditLogSchema),
    summary: 'Audit trail, newest first',
  },

  // ---- files ---------------------------------------------------------------------------------
  uploadFile: {
    method: 'POST',
    path: '/files',
    query: FileUploadQuerySchema,
    response: dataOf(FileSchema),
    status: 201,
    summary: 'Upload one file (multipart/form-data, part `file`); limits per purpose',
  },
  getFile: {
    method: 'GET',
    path: '/files/:id',
    params: IdParams,
    response: dataOf(FileSchema),
  },
  getFileContent: {
    method: 'GET',
    path: '/files/:id/content',
    params: IdParams,
    query: FileContentQuerySchema,
    stream: 'file',
    summary: 'File content (Content-Type, Content-Disposition, private immutable caching)',
  },
})
