/**
 * Tax slab rules (price-dependent GST, e.g. garments ≤ ₹2,500 per piece 5%, above 18%). Slabs are
 * validated by the contract (ascending max values, last one open-ended, rates from GST_RATES_BP).
 * A rule referenced by products or categories cannot be deleted (409, deactivate instead).
 */
import { sql } from 'kysely'
import { newId } from '@kadai/shared'
import type {
  TaxSlabRule,
  TaxSlabRuleCreateSchema,
  TaxSlabRuleListQuerySchema,
  TaxSlabRuleUpdateSchema,
} from '@kadai/shared/api/catalog'
import type { z } from 'zod'
import { audit, diffChanges } from '../../core/audit'
import { assertNotStale, notFound } from '../../core/errors'
import { type PageEnvelope, pageResult, parsePage } from '../../core/http'
import { jsonb } from '../../db/json'
import type { Tx } from '../../db/tenant'
import { type Ctx, containsPattern, conflictReason, duplicateReason, iso } from './shared'

export interface StoredSlab {
  max_unit_value_paise: number | null
  gst_rate_bp: number
}

/** Stored slabs JSON → slabs (malformed entries dropped). */
export function readSlabs(v: unknown): StoredSlab[] {
  if (!Array.isArray(v)) return []
  const out: StoredSlab[] = []
  for (const s of v) {
    if (typeof s !== 'object' || s === null) continue
    const max = (s as { max_unit_value_paise?: unknown }).max_unit_value_paise
    const rate = (s as { gst_rate_bp?: unknown }).gst_rate_bp
    if (typeof rate !== 'number' || !Number.isInteger(rate) || rate < 0) continue
    if (max !== null && (typeof max !== 'number' || !Number.isInteger(max))) continue
    out.push({ max_unit_value_paise: max, gst_rate_bp: rate })
  }
  return out
}

function ruleQuery(tx: Tx, ctx: Pick<Ctx, 'tenantId'>) {
  return tx
    .selectFrom('tax_slab_rules as r')
    .select([
      'r.id',
      'r.name',
      'r.description',
      'r.slabs',
      'r.is_active',
      'r.created_at',
      'r.updated_at',
      sql<number>`(select count(*) from products p where p.tenant_id = r.tenant_id and p.tax_slab_rule_id = r.id)::int`.as(
        'product_count',
      ),
      sql<number>`(select count(*) from categories c where c.tenant_id = r.tenant_id and c.tax_slab_rule_id = r.id)::int`.as(
        'category_count',
      ),
    ])
    .where('r.tenant_id', '=', ctx.tenantId)
}

type RuleRow = Awaited<ReturnType<ReturnType<typeof ruleQuery>['executeTakeFirstOrThrow']>>

function toRule(r: RuleRow): TaxSlabRule {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    slabs: readSlabs(r.slabs),
    is_active: r.is_active,
    product_count: Number(r.product_count),
    category_count: Number(r.category_count),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  }
}

export async function listTaxSlabRules(
  tx: Tx,
  ctx: Ctx,
  q: z.output<typeof TaxSlabRuleListQuerySchema>,
): Promise<PageEnvelope<TaxSlabRule>> {
  const page = parsePage(q)
  let qb = ruleQuery(tx, ctx)
  if (q.q)
    qb = qb.where(
      sql<boolean>`(r.name ilike ${containsPattern(q.q)} or coalesce(r.description, '') ilike ${containsPattern(q.q)})`,
    )
  if (q.is_active !== undefined) qb = qb.where('r.is_active', '=', q.is_active)
  const rows = await qb
    .select(sql<number>`count(*) over()`.as('__total'))
    .orderBy('r.name')
    .orderBy('r.id')
    .limit(page.limit)
    .offset(page.offset)
    .execute()
  let total = rows[0] ? Number(rows[0].__total) : 0
  if (!rows[0] && page.offset > 0) {
    const all = await ruleQuery(tx, ctx).execute()
    total = all.length
  }
  return pageResult(rows.map(toRule), page, total)
}

async function ruleOrThrow(tx: Tx, ctx: Ctx, id: string): Promise<RuleRow> {
  const row = await ruleQuery(tx, ctx).where('r.id', '=', id).executeTakeFirst()
  if (!row) throw notFound('tax_slab_rule', id)
  return row
}

export async function getTaxSlabRule(tx: Tx, ctx: Ctx, id: string): Promise<TaxSlabRule> {
  return toRule(await ruleOrThrow(tx, ctx, id))
}

async function assertNameFree(tx: Tx, ctx: Ctx, name: string, exceptId: string | null) {
  let q = tx
    .selectFrom('tax_slab_rules')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where(sql<boolean>`lower(name) = lower(${name})`)
  if (exceptId) q = q.where('id', '<>', exceptId)
  const existing = await q.executeTakeFirst()
  if (existing)
    throw duplicateReason('A tax rule with this name already exists', 'name_taken', {
      field: 'name',
      existing_id: existing.id,
    })
}

export async function createTaxSlabRule(
  tx: Tx,
  ctx: Ctx,
  body: z.output<typeof TaxSlabRuleCreateSchema>,
): Promise<TaxSlabRule> {
  await assertNameFree(tx, ctx, body.name, null)
  const row = await tx
    .insertInto('tax_slab_rules')
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      name: body.name,
      description: body.description ?? null,
      slabs: jsonb(body.slabs),
      is_active: body.is_active,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  await audit(tx, ctx, {
    action: 'tax_slab_rule.create',
    entity_type: 'tax_slab_rule',
    entity_id: row.id,
    summary: body.name,
    changes: { after: { slabs: body.slabs } },
  })
  return getTaxSlabRule(tx, ctx, row.id)
}

export async function updateTaxSlabRule(
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: z.output<typeof TaxSlabRuleUpdateSchema>,
): Promise<TaxSlabRule> {
  const current = await tx
    .selectFrom('tax_slab_rules')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!current) throw notFound('tax_slab_rule', id)
  assertNotStale(current.updated_at, body.if_updated_at, 'tax_slab_rule', id)
  if (body.name !== undefined && body.name.toLowerCase() !== current.name.toLowerCase())
    await assertNameFree(tx, ctx, body.name, id)
  const before = {
    name: current.name,
    description: current.description,
    slabs: readSlabs(current.slabs),
    is_active: current.is_active,
  }
  const after = {
    name: body.name ?? before.name,
    description: body.description === undefined ? before.description : body.description,
    slabs: body.slabs ?? before.slabs,
    is_active: body.is_active ?? before.is_active,
  }
  const changes = diffChanges(before, after)
  if (changes) {
    await tx
      .updateTable('tax_slab_rules')
      .set({
        name: after.name,
        description: after.description,
        slabs: jsonb(after.slabs),
        is_active: after.is_active,
      })
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', id)
      .execute()
    // GST changes are audited (ARCHITECTURE.md §7.7); products using the rule re-price at sale.
    await audit(tx, ctx, {
      action: 'tax_slab_rule.update',
      entity_type: 'tax_slab_rule',
      entity_id: id,
      summary: after.name,
      changes,
    })
    if (body.slabs !== undefined) {
      // POS caches carry the products' rule; bump the products so delta sync re-sends them.
      await tx
        .updateTable('products')
        .set({ updated_at: sql<Date>`now()` })
        .where('tenant_id', '=', ctx.tenantId)
        .where('tax_slab_rule_id', '=', id)
        .execute()
    }
  }
  return getTaxSlabRule(tx, ctx, id)
}

export async function deleteTaxSlabRule(tx: Tx, ctx: Ctx, id: string): Promise<void> {
  const rule = await ruleOrThrow(tx, ctx, id)
  if (Number(rule.product_count) > 0 || Number(rule.category_count) > 0) {
    throw conflictReason(
      'Products or categories use this tax rule; deactivate it instead',
      'in_use_deactivate',
      {
        hint: 'deactivate',
        product_count: Number(rule.product_count),
        category_count: Number(rule.category_count),
      },
    )
  }
  await tx
    .deleteFrom('tax_slab_rules')
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
  await audit(tx, ctx, {
    action: 'tax_slab_rule.delete',
    entity_type: 'tax_slab_rule',
    entity_id: id,
    summary: rule.name,
  })
}
