/**
 * Helpers for the identity integration tests: URL prefix, status assertions, audit lookups,
 * session rows (system-only table), multipart bodies and tiny valid image / PDF payloads.
 */
import { randomInt } from 'node:crypto'
import type { LightMyRequestResponse } from 'fastify'
import { newId } from '@kadai/shared'
import { expect } from 'vitest'
import type { TestApp } from '../../../test/helpers'
import type { TestShop } from '../../../test/tenants'

export const api = (path: string) => `/api/v1${path}`

export type Data<T> = { data: T }
export type List<T> = { data: T[]; page: { limit: number; offset: number; total: number } }
export interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

/** Parses a JSON response and asserts the status (prints the body on mismatch). */
export function expectStatus<T = unknown>(res: LightMyRequestResponse, status: number): T {
  expect(res.statusCode, res.body).toBe(status)
  return (res.body ? JSON.parse(res.body) : null) as T
}

/** Asserts an error response: status, code and (optionally) details.reason. */
export function expectError(
  res: LightMyRequestResponse,
  status: number,
  code: string,
  reason?: string,
): ErrorBody['error'] {
  const body = expectStatus<ErrorBody>(res, status)
  expect(body.error.code).toBe(code)
  if (reason !== undefined) expect(body.error.details?.reason).toBe(reason)
  return body.error
}

/** Audit rows of a tenant (newest first), optionally for one entity. */
export async function auditRows(
  t: TestApp,
  shop: TestShop,
  filter: { action?: string; entity_id?: string } = {},
) {
  let q = t.deps.db.systemDb
    .selectFrom('audit_logs')
    .select(['action', 'entity_type', 'entity_id', 'user_id', 'summary', 'changes'])
    .where('tenant_id', '=', shop.tenant.id)
  if (filter.action) q = q.where('action', '=', filter.action)
  if (filter.entity_id) q = q.where('entity_id', '=', filter.entity_id)
  return q.orderBy('id', 'desc').execute()
}

/** Live (not revoked) sessions of a user (auth_sessions is system-only). */
export async function liveSessions(t: TestApp, userId: string, tenantId?: string) {
  let q = t.deps.db.systemDb
    .selectFrom('auth_sessions')
    .select(['id', 'tenant_id', 'device_id', 'revoked_reason'])
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
  if (tenantId) q = q.where('tenant_id', '=', tenantId)
  return q.execute()
}

/** A distinct client IP per call, so per-IP auth rate limits never interfere. */
export function randomIp(): string {
  return `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`
}

/** multipart/form-data body with one `file` part (plus optional extra fields). */
export function multipart(
  filename: string,
  contentType: string,
  data: Buffer,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----kadai${newId().replace(/-/g, '')}`
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    payload: Buffer.concat([head, data, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

/** A PNG-signature payload of `size` bytes (core/files checks the magic bytes). */
export function pngBytes(size = 256): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([signature, Buffer.alloc(Math.max(0, size - signature.length), 7)])
}

export function pdfBytes(size = 512): Buffer {
  const head = Buffer.from('%PDF-1.4\n')
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 0x20)])
}
