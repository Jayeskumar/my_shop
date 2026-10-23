/**
 * Audit log (feature audit_log + audit.read; filters; member names) and files (per-purpose type
 * and size limits, upload permissions, metadata, streamed content with caching headers, ETag
 * revalidation, download disposition, cross-tenant access denied).
 */
import { addDays, newId, todayIn } from '@kadai/shared'
import type { AuditLog, FileMeta, Role } from '@kadai/shared/api/identity'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import { contentDisposition, resolveContentType } from '../files'
import {
  type Data,
  type List,
  api,
  expectError,
  expectStatus,
  multipart,
  pdfBytes,
  pngBytes,
} from './fixtures'

const MB = 1024 * 1024

describe('identity: audit log', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop
  const today = todayIn('Asia/Kolkata')

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    other = await createTestTenant(t)
  })
  afterAll(() => t.close())

  const logs = async (query: string, on: TestShop = shop) =>
    expectStatus<List<AuditLog>>(
      await on.inject({ method: 'GET', url: api(`/audit-logs${query}`) }),
      200,
    )

  it('lists the trail newest first with member names and filters', async () => {
    const role = expectStatus<Data<Role>>(
      await shop.inject({
        method: 'POST',
        url: api('/roles'),
        payload: { name: 'Audited role', permissions: ['catalog.read'] },
      }),
      201,
    ).data
    const all = await logs('')
    expect(all.data[0]).toMatchObject({
      action: 'role.create',
      entity_type: 'role',
      entity_id: role.id,
      user_id: shop.owner.user.id,
      user_name: shop.owner.user.full_name,
    })
    expect(all.data.some((r) => r.action === 'tenant.create')).toBe(true)
    const byAction = await logs('?action=role.')
    expect(byAction.data.every((r) => r.action.startsWith('role.'))).toBe(true)
    const byEntity = await logs(`?entity_type=role&entity_id=${role.id}`)
    expect(byEntity.data.map((r) => r.action)).toEqual(['role.create'])
    const byUser = await logs(`?user_id=${shop.owner.user.id}&from=${today}&to=${today}`)
    expect(byUser.data.length).toBeGreaterThan(0)
    const future = await logs(`?from=${addDays(today, 1)}`)
    expect(future.data).toEqual([])
    expectError(
      await shop.inject({
        method: 'GET',
        url: api(`/audit-logs?from=${today}&to=${addDays(today, -1)}`),
      }),
      400,
      'VALIDATION_ERROR',
    )
    const page = await logs('?limit=1&offset=1')
    expect(page.data).toHaveLength(1)
    expect(page.page.total).toBe(all.page.total)
    // Another business sees none of it.
    const theirs = await logs(`?entity_id=${role.id}`, other)
    expect(theirs.data).toEqual([])
  })

  it('needs audit.read and the audit_log feature', async () => {
    const cashier = await shop.asRole('cashier')
    expectError(
      await shop.inject({ method: 'GET', url: api('/audit-logs'), as: cashier }),
      403,
      'FORBIDDEN',
    )
    const free = await createTestTenant(t, { plan_code: 'free' })
    const err = expectError(
      await free.inject({ method: 'GET', url: api('/audit-logs') }),
      402,
      'FEATURE_NOT_IN_PLAN',
    )
    expect(err.details).toMatchObject({ feature: 'audit_log' })
  })
})

describe('identity: files', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t, { business_type: 'pharmacy' })
    other = await createTestTenant(t)
  })
  afterAll(() => t.close())

  const upload = (
    purpose: string,
    file: { name: string; type: string; data: Buffer },
    opts: { on?: TestShop; as?: TestShop['owner'] } = {},
  ) => {
    const body = multipart(file.name, file.type, file.data)
    return (opts.on ?? shop).inject({
      method: 'POST',
      url: api(`/files?purpose=${purpose}`),
      payload: body.payload,
      headers: body.headers,
      as: opts.as,
    })
  }

  it('stores a logo and serves metadata and content with caching headers', async () => {
    const data = pngBytes(2048)
    const meta = expectStatus<Data<FileMeta>>(
      await upload('logo', { name: 'கடை லோகோ.png', type: 'image/png', data }),
      201,
    ).data
    expect(meta).toMatchObject({
      purpose: 'logo',
      filename: 'கடை லோகோ.png',
      content_type: 'image/png',
      size_bytes: 2048,
      created_by: shop.owner.user.id,
      content_path: `/files/${meta.id}/content`,
    })
    expect(meta.checksum_sha256).toMatch(/^[0-9a-f]{64}$/)
    expectStatus(await shop.inject({ method: 'GET', url: api(`/files/${meta.id}`) }), 200)

    const content = await shop.inject({ method: 'GET', url: api(meta.content_path) })
    expect(content.statusCode).toBe(200)
    expect(content.headers['content-type']).toBe('image/png')
    expect(content.headers['cache-control']).toBe('private, max-age=31536000, immutable')
    expect(content.headers.etag).toBe(`"${meta.checksum_sha256}"`)
    expect(content.headers['content-disposition']).toMatch(/^inline; filename="/)
    expect(content.rawPayload.equals(data)).toBe(true)

    const revalidated = await shop.inject({
      method: 'GET',
      url: api(meta.content_path),
      headers: { 'if-none-match': `"${meta.checksum_sha256}"` },
    })
    expect(revalidated.statusCode).toBe(304)
    const download = await shop.inject({
      method: 'GET',
      url: api(`${meta.content_path}?download=true`),
    })
    expect(download.headers['content-disposition']).toContain('attachment;')
    expect(download.headers['content-disposition']).toContain(
      `filename*=UTF-8''${encodeURIComponent('கடை லோகோ.png')}`,
    )
  })

  it('enforces the type and size rules of each purpose', async () => {
    const tooBig = expectError(
      await upload('logo', { name: 'big.png', type: 'image/png', data: pngBytes(2 * MB + 1) }),
      400,
      'VALIDATION_ERROR',
    )
    expect(JSON.stringify(tooBig.details)).toContain('file_too_large')
    const wrongType = expectError(
      await upload('logo', { name: 'logo.pdf', type: 'application/pdf', data: pdfBytes() }),
      400,
      'VALIDATION_ERROR',
    )
    expect(JSON.stringify(wrongType.details)).toContain('file_type')
    const svg = expectError(
      await upload('product_image', {
        name: 'x.svg',
        type: 'image/svg+xml',
        data: Buffer.from('<svg/>'),
      }),
      400,
      'VALIDATION_ERROR',
    )
    expect(JSON.stringify(svg.details)).toContain('file_type')
    const fake = expectError(
      await upload('logo', {
        name: 'fake.png',
        type: 'image/png',
        data: Buffer.from('not really a png'),
      }),
      400,
      'VALIDATION_ERROR',
    )
    expect(JSON.stringify(fake.details)).toContain('file_content')
    expectError(
      await upload('logo', { name: 'empty.png', type: 'image/png', data: Buffer.alloc(0) }),
      400,
      'VALIDATION_ERROR',
    )
    // Prescriptions: images or PDF up to 5 MB.
    expectStatus(
      await upload('prescription', {
        name: 'rx.pdf',
        type: 'application/pdf',
        data: pdfBytes(3 * MB),
      }),
      201,
    )
    expectError(
      await upload('prescription', {
        name: 'rx.pdf',
        type: 'application/pdf',
        data: pdfBytes(5 * MB + 10),
      }),
      400,
      'VALIDATION_ERROR',
    )
    // Imports: CSV / XLSX up to 10 MB; a generic browser type is resolved from the extension.
    const csv = expectStatus<Data<FileMeta>>(
      await upload('import', {
        name: 'products.csv',
        type: 'application/octet-stream',
        data: Buffer.from('﻿name,price\r\nஅரிசி,60\r\n'),
      }),
      201,
    ).data
    expect(csv.content_type).toBe('text/csv')
    expectError(
      await upload('import', {
        name: 'huge.csv',
        type: 'text/csv',
        data: Buffer.alloc(10 * MB + 1, 0x41),
      }),
      400,
      'VALIDATION_ERROR',
    )
    expectError(
      await upload('export', { name: 'x.csv', type: 'text/csv', data: Buffer.from('a') }),
      400,
      'VALIDATION_ERROR',
    )
    expectError(
      await shop.inject({
        method: 'POST',
        url: api('/files?purpose=logo'),
        payload: { file: 'nope' },
      }),
      400,
      'VALIDATION_ERROR',
    )
  })

  it('checks the upload permission of each purpose', async () => {
    const cashier = await shop.asRole('cashier')
    expectError(
      await upload('logo', { name: 'l.png', type: 'image/png', data: pngBytes() }, { as: cashier }),
      403,
      'FORBIDDEN',
      'upload_permission',
    )
    const viewer = await shop.asRole('report_viewer', { permissions: ['reports.read'] })
    expectError(
      await upload(
        'import',
        { name: 'c.csv', type: 'text/csv', data: Buffer.from('a,b') },
        { as: viewer },
      ),
      403,
      'FORBIDDEN',
      'upload_permission',
    )
    // Cashiers add customers, so they may upload a customer import file.
    expectStatus(
      await upload(
        'import',
        { name: 'c.csv', type: 'text/csv', data: Buffer.from('a,b') },
        { as: cashier },
      ),
      201,
    )
    // Counter staff attach prescriptions and attachments.
    expectStatus(
      await upload(
        'prescription',
        {
          name: 'rx.jpg',
          type: 'image/jpeg',
          data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
        },
        { as: cashier },
      ),
      201,
    )
    expectStatus(
      await upload(
        'attachment',
        { name: 'bill.pdf', type: 'application/pdf', data: pdfBytes() },
        { as: cashier },
      ),
      201,
    )
  })

  it('never serves another business’s files', async () => {
    const meta = expectStatus<Data<FileMeta>>(
      await upload('attachment', { name: 'secret.pdf', type: 'application/pdf', data: pdfBytes() }),
      201,
    ).data
    expectError(
      await other.inject({ method: 'GET', url: api(`/files/${meta.id}`) }),
      404,
      'NOT_FOUND',
    )
    expectError(
      await other.inject({ method: 'GET', url: api(`/files/${meta.id}/content`) }),
      404,
      'NOT_FOUND',
    )
    expectError(
      await shop.inject({ method: 'GET', url: api(`/files/${newId()}`) }),
      404,
      'NOT_FOUND',
    )
    const anonymous = await shop.inject({
      method: 'GET',
      url: api(`/files/${meta.id}/content`),
      as: null,
    })
    expect(anonymous.statusCode).toBe(401)
  })

  it('resolves content types and builds safe content dispositions', () => {
    expect(resolveContentType('image/PNG; charset=binary', 'a.png')).toBe('image/png')
    expect(resolveContentType('application/octet-stream', 'Stock.XLSX')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    expect(resolveContentType(undefined, 'noext')).toBe('application/octet-stream')
    expect(contentDisposition('a"b\\c.pdf', false)).toBe(
      `inline; filename="a_b_c.pdf"; filename*=UTF-8''a%22b%5Cc.pdf`,
    )
  })
})
