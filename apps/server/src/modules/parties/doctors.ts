/**
 * Prescribing doctors (pharmacy Schedule H / H1 records; used by the pharmacy POS). Invoices keep
 * a prescription snapshot in sales_invoices.rx ({doctor_id, doctor_name, doctor_reg_no, …}), so a
 * doctor that appears on one is deactivated instead of deleted.
 */
import { newId } from '@kadai/shared'
import type {
  Doctor,
  DoctorCreateSchema,
  DoctorListQuerySchema,
  DoctorUpdateSchema,
} from '@kadai/shared/api/parties'
import { type Selectable, type SqlBool, type Updateable, sql } from 'kysely'
import type { z } from 'zod'
import type { DB } from '../../db/schema.generated'
import { jsonb } from '../../db/json'
import type { Tx } from '../../db/tenant'
import { audit, diffChanges } from '../../core/audit'
import type { RequestContext } from '../../core/context'
import { assertNotStale, notFound } from '../../core/errors'
import { type PageEnvelope, paginate, parsePage } from '../../core/http'
import { anyOf, escapeLike, iso, phoneSearchDigits, readAddress } from './common'

type Ctx = RequestContext
type DoctorRow = Selectable<DB['doctors']>

function toDoctor(r: DoctorRow): Doctor {
  return {
    id: r.id,
    name: r.name,
    registration_no: r.registration_no,
    qualification: r.qualification,
    phone: r.phone,
    clinic_name: r.clinic_name,
    address: readAddress(r.address),
    is_active: r.is_active,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  }
}

async function findDoctor(tx: Tx, ctx: Ctx, id: string, forUpdate = false): Promise<DoctorRow> {
  let q = tx
    .selectFrom('doctors')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
  if (forUpdate) q = q.forUpdate()
  const row = await q.executeTakeFirst()
  if (!row) throw notFound('doctor', id)
  return row
}

export async function getDoctor(tx: Tx, ctx: Ctx, id: string): Promise<Doctor> {
  return toDoctor(await findDoctor(tx, ctx, id))
}

export async function listDoctors(
  tx: Tx,
  ctx: Ctx,
  query: z.output<typeof DoctorListQuerySchema>,
): Promise<PageEnvelope<Doctor>> {
  let qb = tx.selectFrom('doctors').selectAll().where('tenant_id', '=', ctx.tenantId)
  if (query.q) {
    const lower = escapeLike(query.q.toLowerCase())
    const parts = [
      // Same expression as the trigram index doctors_search_trgm_idx.
      sql<SqlBool>`lower(name || ' ' || coalesce(registration_no, '') || ' ' || coalesce(clinic_name, '')) like ${`%${lower}%`}`,
    ]
    const digits = phoneSearchDigits(query.q)
    if (digits) parts.push(sql<SqlBool>`phone like ${`%${digits}%`}`)
    qb = qb.where(anyOf(parts))
  }
  if (query.is_active !== undefined) qb = qb.where('is_active', '=', query.is_active)
  qb =
    query.sort.field === 'name'
      ? qb.orderBy(sql`lower(name)`, query.sort.direction)
      : qb.orderBy('created_at', query.sort.direction)
  const page = await paginate(qb.orderBy('id'), parsePage(query))
  return { data: page.data.map(toDoctor), page: page.page }
}

export async function createDoctor(
  tx: Tx,
  ctx: Ctx,
  body: z.output<typeof DoctorCreateSchema>,
): Promise<Doctor> {
  const row = await tx
    .insertInto('doctors')
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      name: body.name,
      registration_no: body.registration_no ?? null,
      qualification: body.qualification ?? null,
      phone: body.phone ?? null,
      clinic_name: body.clinic_name ?? null,
      address: jsonb(body.address),
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  await audit(tx, ctx, {
    action: 'doctor.create',
    entity_type: 'doctor',
    entity_id: row.id,
    summary: `Doctor ${row.name}${row.registration_no ? ` (${row.registration_no})` : ''} added`,
  })
  return toDoctor(row)
}

function editable(r: DoctorRow): Record<string, unknown> {
  return {
    name: r.name,
    registration_no: r.registration_no,
    qualification: r.qualification,
    phone: r.phone,
    clinic_name: r.clinic_name,
    address: readAddress(r.address),
    is_active: r.is_active,
  }
}

export async function updateDoctor(
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: z.output<typeof DoctorUpdateSchema>,
): Promise<Doctor> {
  const existing = await findDoctor(tx, ctx, id, true)
  assertNotStale(existing.updated_at, body.if_updated_at, 'doctor', id)
  const patch: Updateable<DB['doctors']> = {}
  const view: Record<string, unknown> = {}
  const set = <K extends keyof Updateable<DB['doctors']> & string>(
    key: K,
    value: Updateable<DB['doctors']>[K] | undefined,
  ) => {
    if (value === undefined) return
    patch[key] = value
    view[key] = value
  }
  set('name', body.name)
  set('registration_no', body.registration_no)
  set('qualification', body.qualification)
  set('phone', body.phone)
  set('clinic_name', body.clinic_name)
  set('is_active', body.is_active)
  if (body.address !== undefined) {
    patch.address = jsonb(body.address)
    view.address = body.address
  }
  const before = editable(existing)
  const changes = diffChanges(before, { ...before, ...view })
  if (!changes) return toDoctor(existing)
  const row = await tx
    .updateTable('doctors')
    .set(patch)
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow()
  await audit(tx, ctx, {
    action: 'doctor.update',
    entity_type: 'doctor',
    entity_id: id,
    summary: `Doctor ${existing.name} updated: ${Object.keys(changes.after).join(', ')}`,
    changes,
  })
  return toDoctor(row)
}

export async function deleteDoctor(
  tx: Tx,
  ctx: Ctx,
  id: string,
): Promise<{ id: string; result: 'deleted' | 'deactivated' }> {
  const existing = await findDoctor(tx, ctx, id, true)
  const used = await tx
    .selectFrom('sales_invoices')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where(sql<SqlBool>`rx ->> 'doctor_id' = ${id}`)
    .limit(1)
    .executeTakeFirst()
  if (used) {
    if (existing.is_active) {
      await tx
        .updateTable('doctors')
        .set({ is_active: false })
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', id)
        .execute()
    }
    await audit(tx, ctx, {
      action: 'doctor.deactivate',
      entity_type: 'doctor',
      entity_id: id,
      summary: `Doctor ${existing.name} deactivated (on prescriptions)`,
    })
    return { id, result: 'deactivated' }
  }
  await tx
    .deleteFrom('doctors')
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
  await audit(tx, ctx, {
    action: 'doctor.delete',
    entity_type: 'doctor',
    entity_id: id,
    summary: `Doctor ${existing.name} deleted`,
    changes: { before: editable(existing) },
  })
  return { id, result: 'deleted' }
}
