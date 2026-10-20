/**
 * Shared API contract building blocks (ARCHITECTURE.md §7.3): envelopes, pagination and field
 * schemas used by every module's request/response schemas. snake_case JSON; money in integer
 * paise, quantities in milli units, rates in basis points.
 *
 * Input-only field schemas normalise values (zPhone → E.164, zGstin → upper case); use the plain
 * output variants (zE164, z.string()) in response schemas.
 */
import { z } from 'zod'
import { LocaleSchema } from '../enums'
import { isDateStr } from '../fy'
import { GST_RATES_BP, STATE_CODES, isValidGstin, isValidHsn } from '../gst'
import type { Feature } from '../features'
import type { Permission } from '../permissions'
import { normalizeIndianPhone } from '../phone'

// ---------------------------------------------------------------------------------------------
// Envelopes & pagination
// ---------------------------------------------------------------------------------------------

/** Single-resource success envelope: { data: T }. */
export function dataOf<T extends z.ZodType>(schema: T) {
  return z.object({ data: schema })
}

export const PageSchema = z.object({
  limit: z.int().min(1),
  offset: z.int().min(0),
  total: z.int().min(0),
})
export type Page = z.infer<typeof PageSchema>

/** List success envelope: { data: T[], page: { limit, offset, total } }. */
export function listOf<T extends z.ZodType>(schema: T) {
  return z.object({ data: z.array(schema), page: PageSchema })
}

/** ?limit=&offset= (strings coerced; limit 1..200, default 50). */
export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})
export type PageQuery = z.infer<typeof PageQuerySchema>

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    request_id: z.string().optional(),
  }),
})
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>

// ---------------------------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------------------------

export const zId = z.uuid()
/** Non-negative integer paise. */
export const zPaise = z.int().min(0)
/** Signed integer paise (balances, adjustments, round-off). */
export const zSignedPaise = z.int()
/** Positive integer milli quantity. */
export const zQtyMilli = z.int().min(1)
/** Basis points 0..10000. */
export const zBp = z.int().min(0).max(10_000)
/** One of the allowed GST rates (GST_RATES_BP). */
export const zGstRateBp = z.literal(GST_RATES_BP)
/** Business date 'YYYY-MM-DD'. */
export const zDateStr = z.iso.date().refine(isDateStr, { message: 'Invalid date' })
/** Business period 'YYYY-MM'. */
export const zPeriod = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM')
/** Financial year label '2026-27'. */
export const zFy = z.string().regex(/^\d{4}-\d{2}$/, 'Expected a financial year like 2026-27')

/**
 * Instant as an ISO-8601 string with offset. Also accepts a Date (what `pg` returns for
 * timestamptz), so the server can pass rows straight to response serialization; both sides infer
 * `string`.
 */
export const zTimestamp = z
  .union([z.date(), z.iso.datetime({ offset: true })])
  .transform((v) => (v instanceof Date ? v.toISOString() : v))
  .meta({ type: 'string', format: 'date-time' })

const PHONE_MESSAGE = 'Enter a valid 10-digit Indian mobile number'

/** Indian mobile number input (10 digits, 0/+91 prefixes, spaces) → '+91XXXXXXXXXX'. */
export const zPhone = z
  .string()
  .trim()
  .refine((v) => normalizeIndianPhone(v) !== null, { message: PHONE_MESSAGE })
  .transform((v) => normalizeIndianPhone(v) ?? v)

/** Optional mobile input: missing, null or '' → null. */
export const zOptionalPhone = z
  .union([z.null(), z.string().trim()])
  .optional()
  .refine((v) => v == null || v === '' || normalizeIndianPhone(v) !== null, {
    message: PHONE_MESSAGE,
  })
  .transform((v) => (v == null || v === '' ? null : normalizeIndianPhone(v)))

/** E.164 phone in responses. */
export const zE164 = z.string().regex(/^\+[1-9][0-9]{7,14}$/)

const GSTIN_MESSAGE = 'Invalid GSTIN'

/** GSTIN input: trimmed, upper-cased, structure + state code + checksum validated. */
export const zGstin = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isValidGstin, { message: GSTIN_MESSAGE })

/** Optional GSTIN input: missing, null or '' → null. */
export const zOptionalGstin = z
  .union([z.null(), z.string().trim().toUpperCase()])
  .optional()
  .refine((v) => v == null || v === '' || isValidGstin(v), { message: GSTIN_MESSAGE })
  .transform((v) => (v == null || v === '' ? null : v))

/** Known GST state code ('33' = Tamil Nadu). */
export const zStateCode = z.enum(STATE_CODES)

export const zLocale = LocaleSchema

/** HSN / SAC: 4, 6 or 8 digits. */
export const zHsn = z
  .string()
  .trim()
  .refine(isValidHsn, { message: 'HSN/SAC must be 4, 6 or 8 digits' })

export const zPincode = z
  .string()
  .trim()
  .regex(/^[1-9][0-9]{5}$/, 'Enter a valid 6-digit PIN code')

/** Optional trimmed text; '' becomes undefined so forms can post empty inputs. */
export function zOptionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === '' ? undefined : v))
}

/** Postal address stored in `address` jsonb columns. */
export const AddressSchema = z.object({
  line1: zOptionalText(200),
  line2: zOptionalText(200),
  city: zOptionalText(100),
  district: zOptionalText(100),
  state_code: zStateCode.optional(),
  pincode: z
    .union([z.literal(''), zPincode])
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
})
export type Address = z.output<typeof AddressSchema>

/** Query-string boolean: true/false/1/0/yes/no/on/off (or a real boolean). */
export const zBooleanQuery = z.union([z.boolean(), z.stringbool()])

/** Free-text search query (?q=). */
export const zSearchQuery = z.string().trim().min(1).max(100)

/** Idempotency-Key header / body client_ref (same bounds as idempotency_keys.key). */
export const zIdempotencyKey = z.string().trim().min(8).max(200)

export const IdParamsSchema = z.object({ id: zId })

/** ?from=&to= business-date range (inclusive) with from ≤ to. */
export const DateRangeQuerySchema = z
  .object({ from: zDateStr.optional(), to: zDateStr.optional() })
  .refine((r) => !r.from || !r.to || r.from <= r.to, {
    message: '`from` must not be after `to`',
    path: ['to'],
  })

/**
 * ?sort= parameter for a fixed set of fields: 'name' / '-created_at' →
 * { field: 'created_at', direction: 'desc' }.
 */
export function sortQuery<const F extends readonly [string, ...string[]]>(fields: F) {
  const pattern = new RegExp(`^-?(${fields.map((f) => f.replace(/[^a-z0-9_]/gi, '')).join('|')})$`)
  return z
    .string()
    .regex(pattern, `sort must be one of: ${fields.join(', ')} (prefix - for descending)`)
    .transform((s) => ({
      field: (s.startsWith('-') ? s.slice(1) : s) as F[number],
      direction: s.startsWith('-') ? ('desc' as const) : ('asc' as const),
    }))
}

// ---------------------------------------------------------------------------------------------
// Route catalogues — the single source of truth for every module's endpoints. The server
// registers routes from these definitions (method, path, schemas, permission, feature) and the
// web calls them through a typed client, so paths and payloads cannot drift apart.
// ---------------------------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** api → /api/v1, public → /public/v1 (no auth), webhook → /webhooks (signature-verified). */
export type RouteScope = 'api' | 'public' | 'webhook'

export const ROUTE_SCOPE_PREFIX: Record<RouteScope, string> = {
  api: '/api/v1',
  public: '/public/v1',
  webhook: '/webhooks',
}

export interface RouteDef {
  method: HttpMethod
  /** Path relative to the scope prefix, with :params, e.g. '/products/:id'. */
  path: string
  /** Default 'api'. */
  scope?: RouteScope
  /** Any-of permission check; omitted = any authenticated member. */
  permission?: Permission | readonly Permission[]
  feature?: Feature
  /** Route exists only in this deployment mode (404 in the other). */
  mode?: 'cloud' | 'onprem'
  /** 'public' = no authentication (always true for public/webhook scopes). */
  auth?: 'required' | 'public'
  /** Accepts an Idempotency-Key header (financial creates). */
  idempotent?: boolean
  params?: z.ZodType
  query?: z.ZodType
  body?: z.ZodType
  /** Success response schema; omitted = 204 No Content (or a stream, see `stream`). */
  response?: z.ZodType
  /** Default 200 (201 for creates is set explicitly). */
  status?: 200 | 201 | 202 | 204
  /** Non-JSON responses: server-sent events, CSV download or a file stream. */
  stream?: 'sse' | 'csv' | 'file'
  summary?: string
}

/** Identity helper that keeps literal types of a module's route map. */
export function defineRoutes<const T extends Record<string, RouteDef>>(routes: T): T {
  return routes
}

type InputOf<S> = S extends z.ZodType ? z.input<S> : undefined
type OutputOf<S> = S extends z.ZodType ? z.output<S> : undefined

export type RouteParams<R extends RouteDef> = InputOf<R['params']>
export type RouteQuery<R extends RouteDef> = InputOf<R['query']>
export type RouteBody<R extends RouteDef> = InputOf<R['body']>
export type RouteResponse<R extends RouteDef> = R['response'] extends z.ZodType
  ? z.output<R['response']>
  : void
export type RouteParsedQuery<R extends RouteDef> = OutputOf<R['query']>
export type RouteParsedBody<R extends RouteDef> = OutputOf<R['body']>

/** Full URL path for a route, e.g. routeUrl(r, { id }) → '/api/v1/products/0192…'. */
export function routeUrl(route: RouteDef, params?: Record<string, string | number>): string {
  const path = route.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
    const value = params?.[name]
    if (value === undefined || value === '')
      throw new Error(`missing route param :${name} for ${route.path}`)
    return encodeURIComponent(String(value))
  })
  return ROUTE_SCOPE_PREFIX[route.scope ?? 'api'] + path
}

/** Permissions of a route as an array (empty = any authenticated member). */
export function routePermissions(route: RouteDef): readonly Permission[] {
  if (!route.permission) return []
  return typeof route.permission === 'string' ? [route.permission] : route.permission
}
