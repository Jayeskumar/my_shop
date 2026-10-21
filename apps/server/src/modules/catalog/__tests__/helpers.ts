/**
 * Helpers for the catalog module's integration tests: JSON request shortcuts on a TestShop and
 * small product / file fixtures going through the real API.
 */
import type { LightMyRequestResponse } from 'fastify'
import { newId } from '@kadai/shared'
import type { ProductCreate, ProductDetail } from '@kadai/shared/api/catalog'
import { expect } from 'vitest'
import type { TestApp } from '../../../test/helpers'
import type { TestShop, TestShopMember } from '../../../test/tenants'

export interface ErrorBody {
  error: {
    code: string
    message: string
    details?: {
      issues?: Array<{ path: string; message: string; code?: string }>
      reason?: string
      [k: string]: unknown
    }
  }
}

export const API = '/api/v1'

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export function req(shop: TestShop) {
  const call = (
    method: Method,
    url: string,
    payload?: unknown,
    opts: { as?: TestShopMember | null; headers?: Record<string, string> } = {},
  ): Promise<LightMyRequestResponse> =>
    shop.inject({
      method,
      url: `${API}${url}`,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      ...(opts.headers ? { headers: opts.headers } : {}),
      ...(opts.as !== undefined ? { as: opts.as } : {}),
    })
  return {
    get: (url: string, opts?: { as?: TestShopMember | null }) => call('GET', url, undefined, opts),
    post: (
      url: string,
      body: unknown,
      opts?: { as?: TestShopMember | null; headers?: Record<string, string> },
    ) => call('POST', url, body, opts),
    patch: (url: string, body: unknown, opts?: { as?: TestShopMember | null }) =>
      call('PATCH', url, body, opts),
    put: (url: string, body: unknown, opts?: { as?: TestShopMember | null }) =>
      call('PUT', url, body, opts),
    del: (url: string, opts?: { as?: TestShopMember | null }) =>
      call('DELETE', url, undefined, opts),
  }
}

export function dataOf<T>(res: LightMyRequestResponse, status = 200): T {
  if (res.statusCode !== status) {
    throw new Error(`expected ${String(status)}, got ${String(res.statusCode)}: ${res.body}`)
  }
  return res.json<{ data: T }>().data
}

export function errorOf(res: LightMyRequestResponse): ErrorBody['error'] {
  return res.json<ErrorBody>().error
}

/** Asserts a VALIDATION_ERROR whose issues include `message` (optionally at `path`). */
export function expectIssue(res: LightMyRequestResponse, message: string, path?: string): void {
  expect(res.statusCode, res.body).toBe(400)
  const e = errorOf(res)
  expect(e.code).toBe('VALIDATION_ERROR')
  const issues = e.details?.issues ?? []
  expect(
    issues.some((i) => i.message === message && (path === undefined || i.path === path)),
    `issues: ${JSON.stringify(issues)}`,
  ).toBe(true)
}

export function uniq(prefix = ''): string {
  return `${prefix}${newId().slice(-8)}`
}

export async function createProduct(
  shop: TestShop,
  body: Partial<ProductCreate> & { name?: string; sale_price_paise?: number },
  as?: TestShopMember,
): Promise<ProductDetail> {
  const res = await req(shop).post(
    '/products',
    { name: uniq('Item '), sale_price_paise: 1000, ...body },
    as ? { as } : undefined,
  )
  return dataOf<ProductDetail>(res, 201)
}

/** Stores a CSV as an uploaded import file (what POST /files?purpose=import does). */
export async function uploadCsv(
  t: TestApp,
  shop: TestShop,
  csv: string | Buffer,
  filename = 'products.csv',
  contentType = 'text/csv',
): Promise<string> {
  const row = await shop.tx((tx) =>
    t.deps.files.saveFile(tx, shop.ctx, {
      purpose: 'import',
      filename,
      content_type: contentType,
      data: typeof csv === 'string' ? Buffer.from(csv, 'utf8') : csv,
    }),
  )
  return row.id
}
