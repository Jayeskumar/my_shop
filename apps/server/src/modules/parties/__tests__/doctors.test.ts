/**
 * Doctors API (pharmacy prescriptions): CRUD, search, delete vs deactivate when a prescription
 * references the doctor, permissions and tenant isolation.
 */
import { newId } from '@kadai/shared'
import type { Doctor } from '@kadai/shared/api/parties'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jsonb } from '../../../db/json'
import { type TestApp, buildTestApp } from '../../../test/helpers'
import { type TestShop, createTestTenant } from '../../../test/tenants'
import { api, auditActions, expectStatus, insertInvoice } from './fixtures'

type Data<T> = { data: T }
type List<T> = { data: T[]; page: { limit: number; offset: number; total: number } }

describe('parties: doctors', () => {
  let t: TestApp
  let shop: TestShop
  let other: TestShop

  beforeAll(async () => {
    t = await buildTestApp()
    shop = await createTestTenant(t, { business_type: 'pharmacy' })
    other = await createTestTenant(t, { business_type: 'pharmacy' })
  })
  afterAll(() => t.close())

  const create = async (payload: Record<string, unknown>, as: TestShop = shop) =>
    expectStatus<Data<Doctor>>(
      await as.inject({ method: 'POST', url: api('/doctors'), payload }),
      201,
    ).data

  it('creates, reads and updates a doctor', async () => {
    const doc = await create({
      name: 'Dr. S. Lakshmi',
      registration_no: 'TNMC 45678',
      qualification: 'MBBS, MD',
      phone: '9443012345',
      clinic_name: 'Lakshmi Clinic',
      address: { city: 'Madurai' },
    })
    expect(doc).toMatchObject({
      name: 'Dr. S. Lakshmi',
      registration_no: 'TNMC 45678',
      phone: '+919443012345',
      is_active: true,
    })
    expect(doc.address.city).toBe('Madurai')
    expect(await auditActions(t, shop, doc.id)).toEqual(['doctor.create'])
    const got = expectStatus<Data<Doctor>>(
      await shop.inject({ method: 'GET', url: api(`/doctors/${doc.id}`) }),
      200,
    )
    expect(got.data).toEqual(doc)
    const updated = expectStatus<Data<Doctor>>(
      await shop.inject({
        method: 'PATCH',
        url: api(`/doctors/${doc.id}`),
        payload: { clinic_name: 'Lakshmi Children’s Clinic', if_updated_at: doc.updated_at },
      }),
      200,
    ).data
    expect(updated.clinic_name).toBe('Lakshmi Children’s Clinic')
    const stale = await shop.inject({
      method: 'PATCH',
      url: api(`/doctors/${doc.id}`),
      payload: { name: 'X', if_updated_at: doc.updated_at },
    })
    expect(stale.statusCode).toBe(409)
    const empty = await shop.inject({
      method: 'PATCH',
      url: api(`/doctors/${doc.id}`),
      payload: {},
    })
    expect(empty.statusCode).toBe(400)
    const bad = await shop.inject({ method: 'POST', url: api('/doctors'), payload: { name: '' } })
    expect(bad.statusCode).toBe(400)
  })

  it('searches by name, registration number and clinic', async () => {
    const s = await createTestTenant(t, { business_type: 'pharmacy' })
    await create({ name: 'Dr. Arun', registration_no: 'TN-111', clinic_name: 'City Hospital' }, s)
    await create({ name: 'Dr. Banu', registration_no: 'TN-222', clinic_name: 'Banu Clinic' }, s)
    await create({ name: 'Dr. Charles', phone: '9000012345' }, s)
    const search = async (qs: string) =>
      expectStatus<List<Doctor>>(
        await s.inject({ method: 'GET', url: api(`/doctors?${qs}`) }),
        200,
      ).data.map((d) => d.name)
    expect(await search('')).toEqual(['Dr. Arun', 'Dr. Banu', 'Dr. Charles'])
    expect(await search('q=tn-222')).toEqual(['Dr. Banu'])
    expect(await search('q=hospital')).toEqual(['Dr. Arun'])
    expect(await search('q=90000')).toEqual(['Dr. Charles'])
    expect(await search('sort=-name&limit=2')).toEqual(['Dr. Charles', 'Dr. Banu'])
  })

  it('deletes an unused doctor and deactivates one on a prescription', async () => {
    const unused = await create({ name: 'Dr. Unused' })
    expect(
      expectStatus<Data<{ result: string }>>(
        await shop.inject({ method: 'DELETE', url: api(`/doctors/${unused.id}`) }),
        200,
      ).data.result,
    ).toBe('deleted')

    const used = await create({ name: 'Dr. Used', registration_no: 'TN-9' })
    const inv = await insertInvoice(t, shop, {
      customer_id: null,
      invoice_date: '2026-10-01',
      total_paise: 1_000,
    })
    await t.deps.db.systemDb
      .updateTable('sales_invoices')
      .set({
        rx: jsonb({ doctor_id: used.id, doctor_name: used.name, doctor_reg_no: 'TN-9' }),
      })
      .where('id', '=', inv.id)
      .execute()
    expect(
      expectStatus<Data<{ result: string }>>(
        await shop.inject({ method: 'DELETE', url: api(`/doctors/${used.id}`) }),
        200,
      ).data.result,
    ).toBe('deactivated')
    const list = expectStatus<List<Doctor>>(
      await shop.inject({ method: 'GET', url: api('/doctors?is_active=false') }),
      200,
    )
    expect(list.data.map((d) => d.id)).toEqual([used.id])
  })

  it('replays a retried create with the same Idempotency-Key (no duplicate doctor)', async () => {
    const key = `doc-${newId()}`
    const payload = { name: 'Dr. R. Senthil', registration_no: `TNMC ${newId().slice(-5)}` }
    const send = () =>
      shop.inject({
        method: 'POST',
        url: api('/doctors'),
        payload,
        headers: { 'idempotency-key': key },
      })
    const first = expectStatus<Data<Doctor>>(await send(), 201)
    const retry = await send()
    expect(retry.statusCode).toBe(201)
    expect(retry.headers['idempotent-replayed']).toBe('true')
    expect(JSON.parse(retry.body).data.id).toBe(first.data.id)
    const found = expectStatus<List<Doctor>>(
      await shop.inject({
        method: 'GET',
        url: api(`/doctors?q=${encodeURIComponent(payload.registration_no)}`),
      }),
      200,
    )
    expect(found.data.map((d) => d.id)).toEqual([first.data.id])
  })

  it('checks permissions and tenant isolation', async () => {
    const doc = await create({ name: 'Dr. Private' })
    const clerk = await shop.asRole('inventory_clerk')
    for (const [method, url, payload] of [
      ['GET', api('/doctors'), undefined],
      ['GET', api(`/doctors/${doc.id}`), undefined],
      ['POST', api('/doctors'), { name: 'x' }],
      ['PATCH', api(`/doctors/${doc.id}`), { name: 'x' }],
      ['DELETE', api(`/doctors/${doc.id}`), undefined],
    ] as const) {
      const res = await shop.inject({ method, url, payload, as: clerk })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
    }
    const pharmacist = await shop.asRole('pharmacist')
    expect(
      (
        await shop.inject({
          method: 'POST',
          url: api('/doctors'),
          payload: { name: 'Dr. New' },
          as: pharmacist,
        })
      ).statusCode,
    ).toBe(201)
    expect((await other.inject({ method: 'GET', url: api(`/doctors/${doc.id}`) })).statusCode).toBe(
      404,
    )
    expect((await other.inject({ method: 'GET', url: api('/doctors?q=private') })).body).toContain(
      '"total":0',
    )
    expect((await shop.inject({ method: 'GET', url: api(`/doctors/${newId()}`) })).statusCode).toBe(
      404,
    )
  })
})
