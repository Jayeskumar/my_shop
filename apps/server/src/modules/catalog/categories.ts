/**
 * Categories: a tree of at most MAX_CATEGORY_DEPTH levels with display paths ("Grocery > Rice"),
 * names unique per parent (case-insensitive) and tax defaults (hsn_code / gst_rate_bp /
 * tax_slab_rule_id) that new products inherit from the nearest category that sets them.
 * Delete is a hard delete of an unused category only; otherwise 409 with hint 'deactivate'.
 */
import { sql } from 'kysely'
import { newId } from '@kadai/shared'
import {
  type Category,
  type CategoryCreateSchema,
  type CategoryDetail,
  type CategoryListQuerySchema,
  type CategoryNode,
  type CategoryTreeNode,
  type CategoryUpdateSchema,
  categoryPlacementIssue,
  categoryTree,
  flattenCategoryTree,
} from '@kadai/shared/api/catalog'
import type { z } from 'zod'
import { audit, diffChanges } from '../../core/audit'
import { assertNotStale, notFound } from '../../core/errors'
import type { Tx } from '../../db/tenant'
import { type Ctx, conflictReason, duplicateReason, iso, issue } from './shared'

export interface CategoryRow {
  id: string
  parent_id: string | null
  name: string
  name_ta: string | null
  hsn_code: string | null
  gst_rate_bp: number | null
  tax_slab_rule_id: string | null
  sort_order: number
  is_active: boolean
  product_count: number
  child_count: number
  created_at: Date
  updated_at: Date
}

/** Every category of the tenant with its direct product / child counts. */
export async function loadCategoryRows(tx: Tx, ctx: Pick<Ctx, 'tenantId'>): Promise<CategoryRow[]> {
  const rows = await tx
    .selectFrom('categories as c')
    .select([
      'c.id',
      'c.parent_id',
      'c.name',
      'c.name_ta',
      'c.hsn_code',
      'c.gst_rate_bp',
      'c.tax_slab_rule_id',
      'c.sort_order',
      'c.is_active',
      'c.created_at',
      'c.updated_at',
      sql<number>`(select count(*) from products p where p.tenant_id = c.tenant_id and p.category_id = c.id)::int`.as(
        'product_count',
      ),
      sql<number>`(select count(*) from categories k where k.tenant_id = c.tenant_id and k.parent_id = c.id)::int`.as(
        'child_count',
      ),
    ])
    .where('c.tenant_id', '=', ctx.tenantId)
    .execute()
  return rows.map((r) => ({
    ...r,
    product_count: Number(r.product_count),
    child_count: Number(r.child_count),
  }))
}

/** Display paths of every category (by id), Tamil falling back to English per level. */
export interface CategoryPaths {
  byId: Map<string, CategoryTreeNode<CategoryRow>>
  flat: CategoryTreeNode<CategoryRow>[]
  tree: CategoryTreeNode<CategoryRow>[]
}

export function categoryPaths(rows: readonly CategoryRow[]): CategoryPaths {
  const tree = categoryTree(rows)
  const flat = flattenCategoryTree(tree)
  return { tree, flat, byId: new Map(flat.map((n) => [n.id, n])) }
}

/** Lighter variant for product reads: paths only (no counts). */
export async function loadCategoryPaths(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
): Promise<CategoryPaths> {
  const rows = await tx
    .selectFrom('categories')
    .select([
      'id',
      'parent_id',
      'name',
      'name_ta',
      'hsn_code',
      'gst_rate_bp',
      'tax_slab_rule_id',
      'sort_order',
      'is_active',
      'created_at',
      'updated_at',
    ])
    .where('tenant_id', '=', ctx.tenantId)
    .execute()
  return categoryPaths(rows.map((r) => ({ ...r, product_count: 0, child_count: 0 })))
}

export function toCategory(n: CategoryTreeNode<CategoryRow>): Category {
  return {
    id: n.id,
    parent_id: n.parent_id,
    name: n.name,
    name_ta: n.name_ta,
    hsn_code: n.hsn_code,
    gst_rate_bp: n.gst_rate_bp,
    tax_slab_rule_id: n.tax_slab_rule_id,
    sort_order: n.sort_order,
    is_active: n.is_active,
    depth: n.depth,
    path: n.path,
    path_ta: n.path_ta,
    product_count: n.product_count,
    child_count: n.child_count,
    created_at: iso(n.created_at),
    updated_at: iso(n.updated_at),
  }
}

function toNode(n: CategoryTreeNode<CategoryRow>, children: CategoryNode[]): CategoryNode {
  return { ...toCategory(n), children }
}

/**
 * Tax defaults a new product of `categoryId` inherits: the nearest category up the tree that
 * sets each field (HSN, GST rate, slab rule are resolved independently).
 */
export async function inheritedTaxDefaults(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  categoryId: string | null,
): Promise<{
  hsn_code: string | null
  gst_rate_bp: number | null
  tax_slab_rule_id: string | null
}> {
  const out = {
    hsn_code: null as string | null,
    gst_rate_bp: null as number | null,
    tax_slab_rule_id: null as string | null,
  }
  if (!categoryId) return out
  const chain = await sql<{
    hsn_code: string | null
    gst_rate_bp: number | null
    tax_slab_rule_id: string | null
    level: number
  }>`
    WITH RECURSIVE up AS (
      SELECT id, parent_id, hsn_code, gst_rate_bp, tax_slab_rule_id, 0 AS level
        FROM categories WHERE tenant_id = ${ctx.tenantId} AND id = ${categoryId}
      UNION ALL
      SELECT c.id, c.parent_id, c.hsn_code, c.gst_rate_bp, c.tax_slab_rule_id, up.level + 1
        FROM categories c JOIN up ON c.id = up.parent_id
       WHERE c.tenant_id = ${ctx.tenantId} AND up.level < 5
    )
    SELECT hsn_code, gst_rate_bp, tax_slab_rule_id, level FROM up ORDER BY level`.execute(tx)
  for (const c of chain.rows) {
    out.hsn_code ??= c.hsn_code
    out.gst_rate_bp ??= c.gst_rate_bp
    out.tax_slab_rule_id ??= c.tax_slab_rule_id
  }
  return out
}

/** Ids of a category and all its descendants (product filter). */
export async function categorySubtreeIds(
  tx: Tx,
  ctx: Pick<Ctx, 'tenantId'>,
  categoryId: string,
): Promise<string[]> {
  const res = await sql<{ id: string }>`
    WITH RECURSIVE sub AS (
      SELECT id, 0 AS level FROM categories WHERE tenant_id = ${ctx.tenantId} AND id = ${categoryId}
      UNION ALL
      SELECT c.id, sub.level + 1 FROM categories c JOIN sub ON c.parent_id = sub.id
       WHERE c.tenant_id = ${ctx.tenantId} AND sub.level < 5
    )
    SELECT id FROM sub`.execute(tx)
  return res.rows.map((r) => r.id)
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

type ListQuery = z.output<typeof CategoryListQuerySchema>

export async function listCategories(tx: Tx, ctx: Ctx, q: ListQuery): Promise<CategoryNode[]> {
  const paths = categoryPaths(await loadCategoryRows(tx, ctx))
  if (q.flat || q.q) {
    const needle = q.q?.toLowerCase()
    return paths.flat
      .filter((n) => q.is_active === undefined || n.is_active === q.is_active)
      .filter(
        (n) =>
          !needle ||
          n.name.toLowerCase().includes(needle) ||
          (n.name_ta ?? '').toLowerCase().includes(needle) ||
          n.path.toLowerCase().includes(needle),
      )
      .map((n) => toNode(n, []))
  }
  const build = (nodes: readonly CategoryTreeNode<CategoryRow>[]): CategoryNode[] => {
    const out: CategoryNode[] = []
    for (const n of nodes) {
      if (q.is_active === true && !n.is_active) continue // an inactive category hides its subtree
      const children = build(n.children)
      if (q.is_active === false && n.is_active && children.length === 0) continue
      out.push(toNode(n, children))
    }
    return out
  }
  return build(paths.tree)
}

async function categoryOrThrow(
  tx: Tx,
  ctx: Ctx,
  id: string,
): Promise<CategoryTreeNode<CategoryRow>> {
  const paths = categoryPaths(await loadCategoryRows(tx, ctx))
  const node = paths.byId.get(id)
  if (!node) throw notFound('category', id)
  return node
}

export async function getCategory(tx: Tx, ctx: Ctx, id: string): Promise<CategoryDetail> {
  const rows = await loadCategoryRows(tx, ctx)
  const paths = categoryPaths(rows)
  const node = paths.byId.get(id)
  if (!node) throw notFound('category', id)
  const ancestors: CategoryDetail['ancestors'] = []
  let cur = node.parent_id ? paths.byId.get(node.parent_id) : undefined
  const seen = new Set<string>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    ancestors.unshift({ id: cur.id, name: cur.name, name_ta: cur.name_ta })
    cur = cur.parent_id ? paths.byId.get(cur.parent_id) : undefined
  }
  const rule = node.tax_slab_rule_id
    ? await tx
        .selectFrom('tax_slab_rules')
        .select(['id', 'name'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', node.tax_slab_rule_id)
        .executeTakeFirst()
    : undefined
  return { ...toCategory(node), ancestors, tax_slab_rule: rule ?? null }
}

async function assertSlabRuleExists(
  tx: Tx,
  ctx: Ctx,
  id: string | null | undefined,
): Promise<void> {
  if (!id) return
  const row = await tx
    .selectFrom('tax_slab_rules')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .executeTakeFirst()
  if (!row) throw issue('tax_slab_rule_id', 'reference_not_found')
}

async function assertNameFree(
  tx: Tx,
  ctx: Ctx,
  parentId: string | null,
  name: string,
  exceptId: string | null,
): Promise<void> {
  let q = tx
    .selectFrom('categories')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where(sql<boolean>`lower(name) = lower(${name})`)
  q = parentId === null ? q.where('parent_id', 'is', null) : q.where('parent_id', '=', parentId)
  if (exceptId) q = q.where('id', '<>', exceptId)
  const existing = await q.executeTakeFirst()
  if (existing) {
    throw duplicateReason('A category with this name already exists here', 'name_taken', {
      field: 'name',
      existing_id: existing.id,
    })
  }
}

export async function createCategory(
  tx: Tx,
  ctx: Ctx,
  body: z.output<typeof CategoryCreateSchema>,
): Promise<Category> {
  // Serialise tree changes of the tenant (cycle / depth checks read the whole tree).
  await lockTree(tx, ctx)
  const rows = await loadCategoryRows(tx, ctx)
  if (body.parent_id && !rows.some((r) => r.id === body.parent_id))
    throw issue('parent_id', 'reference_not_found')
  const placement = categoryPlacementIssue(rows, null, body.parent_id)
  if (placement) throw issue('parent_id', placement)
  await assertNameFree(tx, ctx, body.parent_id, body.name, null)
  await assertSlabRuleExists(tx, ctx, body.tax_slab_rule_id)
  const row = await tx
    .insertInto('categories')
    .values({
      id: newId(),
      tenant_id: ctx.tenantId,
      parent_id: body.parent_id,
      name: body.name,
      name_ta: body.name_ta ?? null,
      hsn_code: body.hsn_code ?? null,
      gst_rate_bp: body.gst_rate_bp,
      tax_slab_rule_id: body.tax_slab_rule_id,
      sort_order: body.sort_order,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  const node = await categoryOrThrow(tx, ctx, row.id)
  await audit(tx, ctx, {
    action: 'category.create',
    entity_type: 'category',
    entity_id: row.id,
    summary: node.path,
  })
  return toCategory(node)
}

async function lockTree(tx: Tx, ctx: Pick<Ctx, 'tenantId'>): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`kadai_categories:${ctx.tenantId}`}, 0))`.execute(
    tx,
  )
}

export async function updateCategory(
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: z.output<typeof CategoryUpdateSchema>,
): Promise<Category> {
  await lockTree(tx, ctx)
  const current = await tx
    .selectFrom('categories')
    .selectAll()
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!current) throw notFound('category', id)
  assertNotStale(current.updated_at, body.if_updated_at, 'category', id)
  const parentId = body.parent_id === undefined ? current.parent_id : body.parent_id
  const name = body.name ?? current.name
  if (body.parent_id !== undefined && body.parent_id !== current.parent_id) {
    const rows = await loadCategoryRows(tx, ctx)
    if (parentId && !rows.some((r) => r.id === parentId))
      throw issue('parent_id', 'reference_not_found')
    if (parentId === id) throw issue('parent_id', 'category_cycle')
    const placement = categoryPlacementIssue(rows, id, parentId)
    if (placement) throw issue('parent_id', placement)
  }
  if (body.name !== undefined || body.parent_id !== undefined)
    await assertNameFree(tx, ctx, parentId, name, id)
  await assertSlabRuleExists(tx, ctx, body.tax_slab_rule_id)
  const patch = {
    ...(body.parent_id !== undefined ? { parent_id: body.parent_id } : {}),
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.name_ta !== undefined ? { name_ta: body.name_ta } : {}),
    ...(body.hsn_code !== undefined ? { hsn_code: body.hsn_code } : {}),
    ...(body.gst_rate_bp !== undefined ? { gst_rate_bp: body.gst_rate_bp } : {}),
    ...(body.tax_slab_rule_id !== undefined ? { tax_slab_rule_id: body.tax_slab_rule_id } : {}),
    ...(body.sort_order !== undefined ? { sort_order: body.sort_order } : {}),
    ...(body.is_active !== undefined ? { is_active: body.is_active } : {}),
  }
  const before = {
    parent_id: current.parent_id,
    name: current.name,
    name_ta: current.name_ta,
    hsn_code: current.hsn_code,
    gst_rate_bp: current.gst_rate_bp,
    tax_slab_rule_id: current.tax_slab_rule_id,
    sort_order: current.sort_order,
    is_active: current.is_active,
  }
  const changes = diffChanges(before, { ...before, ...patch })
  if (changes) {
    await tx
      .updateTable('categories')
      .set(patch)
      .where('tenant_id', '=', ctx.tenantId)
      .where('id', '=', id)
      .execute()
    await audit(tx, ctx, {
      action:
        body.is_active === false && current.is_active ? 'category.deactivate' : 'category.update',
      entity_type: 'category',
      entity_id: id,
      summary: name,
      changes,
    })
  }
  return toCategory(await categoryOrThrow(tx, ctx, id))
}

export async function deleteCategory(tx: Tx, ctx: Ctx, id: string): Promise<void> {
  await lockTree(tx, ctx)
  const node = await categoryOrThrow(tx, ctx, id)
  if (node.product_count > 0 || node.child_count > 0) {
    throw conflictReason(
      'This category has products or sub-categories; deactivate it instead',
      'in_use_deactivate',
      { hint: 'deactivate', product_count: node.product_count, child_count: node.child_count },
    )
  }
  await tx
    .deleteFrom('categories')
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .execute()
  await audit(tx, ctx, {
    action: 'category.delete',
    entity_type: 'category',
    entity_id: id,
    summary: node.path,
  })
}
