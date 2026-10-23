/**
 * Customer import: template, dry run, real run with opening balances, upsert / create-only,
 * per-row errors, file-level errors, opening-balance permission, idempotency and permissions.
 */
import { newId } from '@kadai/shared'
import { CUSTOMER_IMPORT_COLUMNS } from '@kadai/shared/api/parties'
import type { ImportJob } from '@kadai/shared/api/identity'
import type { Customer } from '@kadai/shared/api/parties'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, type TestShopMember, createTestTenant } from '../../../test/tenants'
import { api, auditActions, expectStatus, localMobile, partyBalances } from './fixtures'

type Data<T> = { data: T }

describe('parties: customer import', () => {
  let t: TestApp
  let shop: TestShop
  let cashier: TestShopMember

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t)
    cashier = await shop.asRole('cashier')
  })
  afterAll(() => t.close())

  const upload = async (
    content: string | Buffer,
    opts: { purpose?: 'import' | 'attachment'; type?: string; filename?: string } = {},
  ) => {
    const row = await shop.tx((tx) =>
      t.deps.files.saveFile(tx, shop.ctx, {
        purpose: opts.purpose ?? 'import',
        filename: opts.filename ?? 'customers.csv',
        content_type: opts.type ?? 'text/csv',
        data: typeof content === 'string' ? Buffer.from(content, 'utf8') : content,
      }),
    )
    return row.id
  }

  const run = (body: Record<string, unknown>, as?: TestShopMember, key?: string) =>
    shop.inject({
      method: 'POST',
      url: api('/customers/import'),
      payload: body,
      as,
      headers: key ? { 'idempotency-key': key } : {},
    })

  const customerByPhone = async (phone: string) =>
    t.deps.db.systemDb
      .selectFrom('customers')
      .selectAll()
      .where('tenant_id', '=', shop.tenant.id)
      .where('phone', '=', `+91${phone}`)
      .executeTakeFirst()

  it('serves the template CSV with the import columns', async () => {
    const res = await shop.inject({ method: 'GET', url: api('/customers/import/template') })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    const [header] = res.body.replace(/^\uFEFF/, '').split('\r\n')
    expect(header).toBe(CUSTOMER_IMPORT_COLUMNS.map((c) => c.key).join(','))
  })

  it('validates and previews in a dry run without writing', async () => {
    const p1 = localMobile()
    const csv = [
      'Name,Name TA,Phone,Opening Balance,Credit Limit,Tags,WhatsApp Opt In,City,State Code',
      `Murugan,முருகன்,${p1},"1,250.50",5000,regular|street-3,yes,Madurai,33`,
      `Bad Phone,,12345,,,,,,`,
      `,,${localMobile()},,,,,,`,
      `Bad Money,,,abc,,,,,`,
      `Bad Bool,,,,,,maybe,,`,
      `Duplicate,,${p1},,,,,,`,
    ].join('\n')
    const fileId = await upload(csv)
    const job = expectStatus<Data<ImportJob>>(await run({ file_id: fileId }), 201).data
    expect(job).toMatchObject({
      kind: 'customers',
      status: 'completed',
      dry_run: true,
      mode: 'upsert',
      file_id: fileId,
      filename: 'customers.csv',
      total_rows: 6,
      success_rows: 1,
      error_rows: 5,
      progress_bp: 10_000,
      summary: {
        created: 1,
        updated: 0,
        unchanged: 0,
        skipped: 0,
        details: { opening_balances_posted: 1 },
      },
    })
    expect(job.errors.map((e) => [e.row, e.field, e.code])).toEqual([
      [3, 'phone', 'phone'],
      [4, 'name', 'required'],
      [5, 'opening_balance', 'invalid_amount'],
      [6, 'whatsapp_opt_in', 'invalid_boolean'],
      [7, 'phone', 'duplicate_in_file'],
    ])
    expect(job.preview[0]).toEqual({ row: 2, action: 'create', key: `+91${p1}`, name: 'Murugan' })
    expect(job.preview.map((p) => p.action)).toEqual([
      'create',
      'error',
      'error',
      'error',
      'error',
      'error',
    ])
    expect(await customerByPhone(p1)).toBeUndefined()
    const stored = await t.deps.db.systemDb
      .selectFrom('imports')
      .selectAll()
      .where('id', '=', job.id)
      .executeTakeFirstOrThrow()
    expect(stored).toMatchObject({
      kind: 'customers',
      total_rows: 6,
      error_rows: 5,
      options: { mode: 'upsert', dry_run: true, match_by: 'phone' },
      summary: { created: 1 },
    })
    expect(await auditActions(t, shop, job.id)).toEqual([])
  })

  it('imports valid rows with opening balance journals (audited)', async () => {
    const p1 = localMobile()
    const p2 = localMobile()
    const csv = [
      CUSTOMER_IMPORT_COLUMNS.map((c) => c.key).join(','),
      `Selvam,செல்வம்,${p1},,,,wholesale,1 Main Rd,,Salem,Salem,33,636001,1250.50,5000,15,vip|regular,no,C-1`,
      `Revathi,,${p2},,,,,,,,,,,-200,,,,,C-2`,
      `Broken,,${localMobile()},,not-an-email,,,,,,,,,,,,,,`,
    ].join('\r\n')
    const job = expectStatus<Data<ImportJob>>(
      await run({ file_id: await upload(csv), dry_run: false }),
      201,
    ).data
    expect(job.summary).toMatchObject({
      created: 2,
      details: { opening_balances_posted: 2 },
    })
    expect(job.errors).toEqual([expect.objectContaining({ row: 4, field: 'email', code: 'email' })])
    const selvam = (await customerByPhone(p1))!
    expect(selvam).toMatchObject({
      name: 'Selvam',
      name_ta: 'செல்வம்',
      customer_type: 'wholesale',
      price_tier: 'wholesale',
      state_code: '33',
      credit_limit_paise: 500_000,
      credit_days: 15,
      opening_balance_paise: 125_050,
      balance_paise: 125_050,
      tags: ['vip', 'regular'],
      whatsapp_opt_in: false,
      code: 'C-1',
    })
    expect(selvam.address).toMatchObject({ line1: '1 Main Rd', city: 'Salem', pincode: '636001' })
    const revathi = (await customerByPhone(p2))!
    expect(revathi.balance_paise).toBe(-20_000)
    expect(await partyBalances(t, shop, 'customer', selvam.id)).toEqual({
      ledger: 125_050,
      stored: 125_050,
    })
    expect(await auditActions(t, shop, job.id)).toEqual(['customer.import'])
  })

  it('upserts by phone (empty cells keep values) and skips in create-only mode', async () => {
    const phone = localMobile()
    const existing = expectStatus<Data<Customer>>(
      await shop.inject({
        method: 'POST',
        url: api('/customers'),
        payload: {
          name: 'Old Name',
          phone,
          email: 'keep@example.com',
          opening_balance_paise: 1_000,
        },
      }),
      201,
    ).data
    // ₹10 = the stored 1000 paise: unchanged, so no journal and no permission needed.
    const csv = `name,phone,email,opening_balance,credit_days\nNew Name,${phone},,10,10\n`
    const skip = expectStatus<Data<ImportJob>>(
      await run({ file_id: await upload(csv), mode: 'create_only', dry_run: false }),
      201,
    ).data
    expect(skip.summary).toMatchObject({ created: 0, updated: 0, skipped: 1 })
    expect((await customerByPhone(phone))!.name).toBe('Old Name')

    const upsert = expectStatus<Data<ImportJob>>(
      await run({ file_id: await upload(csv), dry_run: false }),
      201,
    ).data
    expect(upsert.summary).toMatchObject({ created: 0, updated: 1 })
    const after = (await customerByPhone(phone))!
    expect(after).toMatchObject({
      id: existing.id,
      name: 'New Name',
      email: 'keep@example.com',
      credit_days: 10,
      opening_balance_paise: 1_000,
      balance_paise: 1_000,
    })
    const again = expectStatus<Data<ImportJob>>(
      await run({ file_id: await upload(csv), dry_run: false }),
      201,
    ).data
    expect(again.summary).toMatchObject({ updated: 0, unchanged: 1 })
  })

  it('needs accounting permission to change opening balances through the import', async () => {
    const phone = localMobile()
    await shop.inject({
      method: 'POST',
      url: api('/customers'),
      payload: { name: 'Guarded', phone, opening_balance_paise: 5_000 },
    })
    const csv = `name,phone,opening_balance\nGuarded,${phone},75\nNewbie,${localMobile()},20\n`
    const byCashier = expectStatus<Data<ImportJob>>(
      await run({ file_id: await upload(csv), dry_run: false }, cashier),
      201,
    ).data
    expect(byCashier.errors).toEqual([
      expect.objectContaining({
        row: 2,
        field: 'opening_balance',
        code: 'opening_balance_permission',
      }),
    ])
    expect(byCashier.summary).toMatchObject({ created: 1 })
    expect((await customerByPhone(phone))!.balance_paise).toBe(5_000)

    const byOwner = expectStatus<Data<ImportJob>>(
      await run({ file_id: await upload(csv), dry_run: false }),
      201,
    ).data
    expect(byOwner.summary).toMatchObject({ updated: 1, unchanged: 1 })
    const updated = (await customerByPhone(phone))!
    expect(updated).toMatchObject({ opening_balance_paise: 7_500, balance_paise: 7_500 })
    expect(await partyBalances(t, shop, 'customer', updated.id)).toEqual({
      ledger: 7_500,
      stored: 7_500,
    })
  })

  it('matches by code and reports ambiguous codes and phones of other customers', async () => {
    const takenPhone = localMobile()
    for (const payload of [
      { name: 'Twin A', code: 'TWIN' },
      { name: 'Twin B', code: 'twin' },
      { name: 'Coded', code: 'K-77' },
      { name: 'Phone owner', phone: takenPhone },
    ])
      await shop.inject({ method: 'POST', url: api('/customers'), payload })
    const csv = [
      'name,code,phone',
      'Twin?,twin,',
      'Coded Renamed,k-77,',
      `Coded Clash,K-77,${takenPhone}`,
    ].join('\n')
    const job = expectStatus<Data<ImportJob>>(
      await run({ file_id: await upload(csv), match_by: 'code' }),
      201,
    ).data
    expect(job.errors.map((e) => [e.row, e.code])).toEqual([
      [2, 'code_ambiguous'],
      [4, 'duplicate_in_file'],
      [4, 'phone_taken'],
    ])
    expect(job.preview[1]).toMatchObject({ row: 3, action: 'update', key: 'k-77' })
  })

  it('rejects unusable files', async () => {
    const issue = async (fileId: string) => {
      const res = await run({ file_id: fileId })
      expect(res.statusCode, res.body).toBe(400)
      return JSON.parse(res.body).error.details.issues[0] as { path: string; code: string }
    }
    expect(await issue(await upload('phone,city\n9876543210,Madurai\n'))).toMatchObject({
      path: 'file_id',
      code: 'import_missing_column',
    })
    expect((await issue(await upload('name,phone\n'))).code).toBe('import_empty')
    const xlsx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)])
    expect(
      (
        await issue(
          await upload(xlsx, {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            filename: 'customers.xlsx',
          }),
        )
      ).code,
    ).toBe('import_file_type')
    const big = ['name', ...Array.from({ length: 1001 }, (_, i) => `Customer ${i}`)].join('\n')
    expect((await issue(await upload(big))).code).toBe('import_too_many_rows')
    const pdf = await shop.tx((tx) =>
      t.deps.files.saveFile(tx, shop.ctx, {
        purpose: 'attachment',
        filename: 'x.pdf',
        content_type: 'application/pdf',
        data: Buffer.from('%PDF-1.4 test'),
      }),
    )
    expect((await issue(pdf.id)).code).toBe('import_file_purpose')
    expect((await run({ file_id: newId() })).statusCode).toBe(404)
  })

  it('accepts Excel-labelled CSV text, replays with the same key and checks permissions', async () => {
    const phone = localMobile()
    const fileId = await upload(`name,phone\nExcel Saved,${phone}\n`, {
      type: 'application/vnd.ms-excel',
    })
    const key = `imp-${newId()}`
    const first = await run({ file_id: fileId, dry_run: false }, undefined, key)
    const second = await run({ file_id: fileId, dry_run: false }, undefined, key)
    expect(first.statusCode).toBe(201)
    expect(second.headers['idempotent-replayed']).toBe('true')
    expect(JSON.parse(second.body).data.id).toBe(JSON.parse(first.body).data.id)
    const count = await t.deps.db.systemDb
      .selectFrom('customers')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('tenant_id', '=', shop.tenant.id)
      .where('phone', '=', `+91${phone}`)
      .executeTakeFirstOrThrow()
    expect(Number(count.n)).toBe(1)

    const accountant = await shop.asRole('accountant')
    expect((await run({ file_id: fileId }, accountant)).statusCode).toBe(403)
    expect(
      (
        await shop.inject({
          method: 'GET',
          url: api('/customers/import/template'),
          as: accountant,
        })
      ).statusCode,
    ).toBe(403)
    // Another tenant cannot use this tenant's file.
    const other = await createTestTenant(t)
    const foreign = await other.inject({
      method: 'POST',
      url: api('/customers/import'),
      payload: { file_id: fileId },
    })
    expect(foreign.statusCode).toBe(404)
  })
})
